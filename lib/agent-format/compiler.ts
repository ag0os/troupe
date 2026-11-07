/**
 * Shared agent compiler (formerly `scripts/agent-compiler.ts`, now a
 * re-export wrapper) used by `compile`, `compile:all` and the watcher:
 * reads Markdown declarations, resolves and reads their includes, statically
 * inspects paired `.ts` extensions, checks the sources against the exact
 * roster, and publishes binaries by temp-dir build then rename.
 */

import {
	existsSync,
	lstatSync,
	watch as nodeWatch,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	delimiter,
	dirname,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { toBinaryName } from "./binary-name";
import { AgentSourceError, formatIssue, type SourceIssue } from "./errors";
import { canonical, isWithin } from "./path-within";
import type { SourceManifest } from "./provenance";
import {
	type IncludeText,
	materializeAgentSpec,
	parseAgentMarkdown,
} from "./schema";
import {
	type AgentSpec,
	EXTENSION_EXPORTS,
	type ExtensionExport,
} from "./types";

/** Roots an include's realpath must stay under (D-027). */
export const INCLUDE_ROOTS = ["agents", "system-prompts"] as const;

/** Directory whose files extensions may import as text. */
export const TEXT_IMPORT_DIR = "system-prompts";

export interface ExtensionInspection {
	/** Reserved extension exports the module declares statically. */
	exports: ExtensionExport[];
	/**
	 * `prepare`/`finish` shapes that cannot be resolved statically. Always
	 * fatal, so a hook is never silently dropped or left to a build failure.
	 */
	exportProblems: SourceIssue[];
	/**
	 * The subset of `exportProblems` that could hide a reserved export
	 * (`export *`, or a shape tied to `prepare`/`finish`). `export default`
	 * and `export =` cannot, so a sibling using them only has no hooks.
	 */
	hidingExportProblems: SourceIssue[];
	/** Statements that would run code on import. Fatal for extensions. */
	sideEffects: SourceIssue[];
}

export interface InspectOptions {
	/** True when a relative specifier resolves under an allowed library. */
	isFrameworkImport?: (specifier: string) => boolean;
	/**
	 * Why a well-formed default text import of `specifier` is not allowed, or
	 * undefined when it resolves to a file under `system-prompts/`. Without
	 * it, every text import is rejected.
	 */
	textImportProblem?: (specifier: string) => string | undefined;
	/**
	 * Why a relative value import must be refused whatever its root, such as
	 * a module inside the compiler's own output, or undefined.
	 */
	importProblem?: (specifier: string) => string | undefined;
	/** Code roots named in import diagnostics. Defaults to none. */
	codeRoots?: readonly string[];
	/** Text roots named in import diagnostics. Defaults to `TEXT_IMPORT_DIR`. */
	textRoots?: readonly string[];
}

export interface LoadedAgent {
	id: string;
	file: string;
	spec: AgentSpec;
	extension?: { file: string; exports: ExtensionExport[] };
}

/**
 * Where a consumer's agents and their inputs live, what is built and where it
 * goes. Relative paths resolve against `consumerRoot`, and every root except
 * `outDir` must lie within it. An agent is stamped only when `stamps`
 * names its ID.
 */
export interface AgentBuildDefinition {
	/** The consumer package root. Relative to the working directory if relative. */
	consumerRoot: string;
	/** Declarations and their same-stem extensions. Defaults to `agents`. */
	declarationRoot?: string;
	/** Roots an include's realpath must stay under. Defaults to the declaration root and `system-prompts`. */
	includeRoots?: readonly string[];
	/** Roots whose modules an extension may import by relative path. Defaults to none. */
	extensionCodeRoots?: readonly string[];
	/** Roots whose Markdown files an extension may import as text. Defaults to `system-prompts`. */
	extensionTextRoots?: readonly string[];
	/** The exact set of agent names a full build publishes. */
	roster: readonly string[];
	/** Output directory. Defaults to `bin`. */
	outDir?: string;
	/** Names in the output directory that pruning never removes. */
	protectedOutputs?: readonly string[];
	/** Directories the watcher watches. Defaults to every root above except `outDir`. */
	watchRoots?: readonly string[];
	/** Per-agent stamp policies by binary name. Unnamed agents are unstamped. */
	stamps?: Readonly<Record<string, BuildStampPolicy>>;
}

/** A JSON value: what a captured stamp's provenance may hold. */
export type StampJson =
	| string
	| number
	| boolean
	| null
	| StampJson[]
	| { [key: string]: StampJson };

/** What a stamp policy sees: the agent and the resolved consumer locations. */
export interface StampContext {
	agentId: string;
	consumerRoot: string;
	declarationRoot: string;
	outDir: string;
}

/** A stamp captured before any declaration is read. */
export interface CapturedBuildStamp {
	/** The source identity the build is made from. */
	manifest: SourceManifest;
	/** Serializable revision and origin facts the policy records. */
	provenance: { [key: string]: StampJson };
}

/**
 * How one agent is stamped. `capture` runs before the declaration is read;
 * `recheck` returns the current identity before the first output is
 * renamed into place, and publication is refused unless its `source`
 * equals the captured one; `versionLine` is the text `--version` prints.
 * The compiler interprets nothing else.
 */
export interface BuildStampPolicy {
	capture(
		context: StampContext,
	): CapturedBuildStamp | Promise<CapturedBuildStamp>;
	recheck(
		context: StampContext,
		captured: CapturedBuildStamp,
	): SourceManifest | Promise<SourceManifest>;
	versionLine(agentId: string, captured: CapturedBuildStamp): string;
}

/** What loading and direct compilation need: a definition without a roster. */
export type AgentSourceDefinition = Omit<AgentBuildDefinition, "roster"> & {
	roster?: readonly string[];
};

/** A configured root, absolute, with the name diagnostics give it. */
interface ConfiguredRoot {
	path: string;
	label: string;
	/** `canonical(path)`: the coordinate membership and naming use. */
	real: string;
}

/** Temporary build directory names the compiler creates beside its outputs. */
const TEMPORARY_BUILD = /^\.(troupe|agent)-build-/;

/**
 * The parent `publish` really creates its `.troupe-build-*` directory in:
 * `mkdtemp(join(dirname(outDir), ...))` resolves `dirname(outDir)`, so the
 * parent is the canonical form of that, not the parent of the canonical
 * output directory (they differ when `outDir` itself is a symlink).
 */
function temporaryParent(outDir: string): string {
	return canonical(dirname(outDir));
}

/**
 * The compiler's own locations, in canonical coordinates: the output
 * directory, which pruning empties of every non-roster entry, and the
 * temporary build directories beside it. Inputs there would be destroyed
 * or their changes ignored by the watcher.
 */
interface OwnedLocations {
	realOut: string;
	tempParent: string;
	outLabel: string;
}

/** Why `real` (a canonical path) is the compiler's own, or undefined. */
function ownedProblem(owned: OwnedLocations, real: string): string | undefined {
	if (isWithin(owned.realOut, real)) {
		return `lies inside the output directory "${owned.outLabel}"`;
	}
	if (!isInside(owned.tempParent, real)) return undefined;
	const first = relative(owned.tempParent, real).split(sep)[0] ?? "";
	return TEMPORARY_BUILD.test(first)
		? `lies inside the temporary build directory ${first} beside the output directory "${owned.outLabel}"`
		: undefined;
}

/** An `AgentBuildDefinition` with every path absolute and every default applied. */
interface ResolvedDefinition {
	root: string;
	declarationRoot: ConfiguredRoot;
	includeRoots: ConfiguredRoot[];
	extensionCodeRoots: ConfiguredRoot[];
	extensionTextRoots: ConfiguredRoot[];
	roster?: readonly string[];
	outDir: string;
	owned: OwnedLocations;
	/** `canonical(<declarationRoot>/local)`: never discovered, compiled or watched. */
	realLocal: string;
	watchRoots: string[];
	stamps: Readonly<Record<string, BuildStampPolicy>>;
	/** Read when pruning is decided, not when the definition is resolved. */
	protectedOutputs(): ReadonlySet<string>;
}

const RESOLVED = Symbol("resolved build definition");

/**
 * Resolve a definition once. Configured roots are refused, naming the root
 * and field, when they lie outside the consumer root, lexically or through a
 * symlink (compared in canonical coordinates, so an absent root beneath a
 * link that leads outside is refused too). The output directory may be
 * anywhere, but never where publication would destroy or ignore inputs:
 * pruning removes every non-roster entry of `outDir`, and the watcher drops
 * events under it and under the temporary build directories beside it.
 */
function resolveDefinition(
	definition: AgentSourceDefinition | ResolvedDefinition,
): ResolvedDefinition {
	if (RESOLVED in definition) return definition as ResolvedDefinition;
	const source = definition as AgentSourceDefinition;
	const root = resolve(source.consumerRoot);
	const realRoot = canonical(root);
	const issues: SourceIssue[] = [];
	const checked: { field: string; path: string; real: string }[] = [];
	const configured = (field: string, path: string): ConfiguredRoot => {
		const absolute = resolve(root, path);
		const real = canonical(absolute);
		if (!isWithin(root, absolute)) {
			issues.push({
				file: path,
				field,
				message: `root "${path}" lies outside the consumer root ${root}`,
			});
		} else if (!isWithin(realRoot, real)) {
			issues.push({
				file: path,
				field,
				message: `root "${path}" resolves to ${real}, outside the consumer root ${realRoot}`,
			});
		} else {
			checked.push({ field, path, real });
		}
		return { path: absolute, label: relative(root, absolute) || ".", real };
	};
	const declarationRoot = configured(
		"declarationRoot",
		source.declarationRoot ?? "agents",
	);
	// The default reuses the declaration root as already checked.
	const includeRoots = source.includeRoots
		? source.includeRoots.map((path) => configured("includeRoots", path))
		: [declarationRoot, configured("includeRoots", "system-prompts")];
	const extensionCodeRoots = (source.extensionCodeRoots ?? []).map((path) =>
		configured("extensionCodeRoots", path),
	);
	const extensionTextRoots = (
		source.extensionTextRoots ?? ["system-prompts"]
	).map((path) => configured("extensionTextRoots", path));
	const watchRoots = source.watchRoots
		? source.watchRoots.map((path) => configured("watchRoots", path).path)
		: [
				...new Set(
					[
						declarationRoot,
						...includeRoots,
						...extensionCodeRoots,
						...extensionTextRoots,
					].map((entry) => entry.path),
				),
			];
	const outDir = resolve(root, source.outDir ?? "bin");
	const owned: OwnedLocations = {
		realOut: canonical(outDir),
		tempParent: temporaryParent(outDir),
		outLabel: source.outDir ?? "bin",
	};
	const { realOut, outLabel } = owned;
	// The declaration root's local/ is never compiled or watched, so a
	// configured input or watch root there would be read but never rebuilt.
	const realLocal = canonical(join(declarationRoot.path, "local"));
	if (isWithin(realOut, realRoot)) {
		issues.push({
			file: outLabel,
			field: "outDir",
			message: `output directory "${outLabel}" contains the consumer root ${realRoot}; pruning would remove its sources`,
		});
	} else {
		for (const entry of checked) {
			const problem =
				ownedProblem(owned, entry.real) ??
				(entry.field !== "declarationRoot" && isWithin(realLocal, entry.real)
					? `lies inside ${declarationRoot.label}/local/, which is never compiled or watched`
					: undefined);
			if (problem) {
				issues.push({
					file: entry.path,
					field: entry.field,
					message: `root "${entry.path}" ${problem}`,
				});
			}
		}
	}
	if (issues.length > 0) throw new AgentSourceError(issues);
	const resolved: ResolvedDefinition & { [RESOLVED]: true } = {
		[RESOLVED]: true,
		root,
		declarationRoot,
		includeRoots,
		extensionCodeRoots,
		extensionTextRoots,
		roster: source.roster,
		outDir,
		owned,
		realLocal,
		watchRoots,
		stamps: { ...(source.stamps ?? {}) },
		protectedOutputs: () => new Set(source.protectedOutputs ?? []),
	};
	return resolved;
}

/** The roster a full build needs; the package-facing planner has no default. */
function requireRoster(definition: ResolvedDefinition): readonly string[] {
	if (!Array.isArray(definition.roster)) {
		throw new TypeError("the build definition must name its roster");
	}
	return definition.roster;
}

/**
 * Realpaths of the configured roots that exist. Resolution already refused
 * any root whose real location is outside the real consumer root.
 */
function realRoots(
	repoRoot: string,
	roots: readonly ConfiguredRoot[],
): string[] {
	return roots
		.map((entry) => join(repoRoot, entry.label))
		.filter((dir) => existsSync(dir))
		.map((dir) => realpathSync(dir));
}

/** `a/`, `a/ and b/`, `a/, b/ and c/`. */
function listRoots(
	roots: readonly ConfiguredRoot[],
	conjunction: "and" | "or",
): string {
	return joinList(
		roots.map((entry) => `${entry.label}/`),
		conjunction,
	);
}

function joinList(items: readonly string[], conjunction: string): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

/**
 * Read and validate one declaration without importing any TypeScript.
 * Throws `AgentSourceError` naming the file, line and field.
 */
export async function loadAgentDefinition(
	definition: AgentSourceDefinition,
	file: string,
): Promise<LoadedAgent> {
	return loadResolved(resolveDefinition(definition), file);
}

async function loadResolved(
	definition: ResolvedDefinition,
	file: string,
): Promise<LoadedAgent> {
	const root = definition.root;
	const repoRoot = realpathSync(root);
	if (
		lstatSync(resolve(root, file), { throwIfNoEntry: false })?.isSymbolicLink()
	) {
		throw new AgentSourceError([
			{
				file: relative(root, resolve(root, file)),
				field: "path",
				message: "a declaration must not be a symlink",
			},
		]);
	}
	const declaration = realpathOrSelf(resolve(root, file));
	const display = relative(repoRoot, declaration);

	const declarationLabel = definition.declarationRoot.label;
	const agentsRoot = realpathSync(join(repoRoot, declarationLabel));
	if (!isInside(agentsRoot, declaration)) {
		throw new AgentSourceError([
			{
				file: display,
				field: "path",
				message: `declarations live under ${declarationLabel}/`,
			},
		]);
	}
	if (isWithin(definition.realLocal, declaration)) {
		throw new AgentSourceError([
			{
				file: display,
				field: "path",
				message: `declaration lies inside ${declarationLabel}/local/, which is never compiled`,
			},
		]);
	}
	const declarationOwned = ownedProblem(definition.owned, declaration);
	if (declarationOwned) {
		throw new AgentSourceError([
			{
				file: display,
				field: "path",
				message: `declaration ${declarationOwned}`,
			},
		]);
	}

	const parsed = parseAgentMarkdown(
		display,
		await readFile(declaration, "utf8"),
	);
	const includes = await readIncludes(
		definition,
		repoRoot,
		declaration,
		display,
		parsed,
	);
	// Named in the same real coordinates the containment check used.
	const id = toBinaryName(declaration, repoRoot, agentsRoot);
	const spec = materializeAgentSpec(parsed, { id, includes });

	const sibling = declaration.replace(/\.md$/, ".ts");
	if (!existsSync(sibling)) return { id, file: display, spec };

	const siblingDisplay = relative(repoRoot, sibling);
	const siblingOwned = ownedProblem(definition.owned, realpathSync(sibling));
	if (siblingOwned) {
		throw new AgentSourceError([
			{
				file: siblingDisplay,
				field: "path",
				message: `extension ${siblingOwned}`,
			},
		]);
	}
	// Bun resolves an extension's imports from its real location, so the
	// checks do too; a symlinked extension is judged where it really lives.
	const importBase = dirname(realpathSync(sibling));
	const frameworkDirs = realRoots(repoRoot, definition.extensionCodeRoots);
	const inspection = inspectExtension(
		siblingDisplay,
		await readFile(sibling, "utf8"),
		{
			// Both checks judge the one file the import really loads.
			isFrameworkImport: (specifier) => {
				const file = moduleFile(resolve(importBase, specifier));
				return (
					file !== undefined && frameworkDirs.some((dir) => isInside(dir, file))
				);
			},
			textImportProblem: (specifier) =>
				textImportProblem(definition, repoRoot, importBase, specifier),
			importProblem: (specifier) => {
				const unknown = unestablishedModule(resolve(importBase, specifier));
				if (unknown) {
					return `value import "${specifier}": its selected module cannot be established (${unknown}); name the file explicitly`;
				}
				const file = moduleFile(resolve(importBase, specifier));
				const owned = file && ownedProblem(definition.owned, file);
				return owned ? `value import "${specifier}" ${owned}` : undefined;
			},
			codeRoots: definition.extensionCodeRoots.map((entry) => entry.label),
			textRoots: definition.extensionTextRoots.map((entry) => entry.label),
		},
	);
	// A sibling without reserved exports is not an extension, unless an
	// unresolvable export could be hiding one; discovery rejects it.
	if (inspection.exports.length === 0) {
		if (inspection.hidingExportProblems.length > 0) {
			throw new AgentSourceError(inspection.hidingExportProblems);
		}
		return { id, file: display, spec };
	}
	if (inspection.exportProblems.length > 0) {
		throw new AgentSourceError(inspection.exportProblems);
	}
	if (inspection.sideEffects.length > 0) {
		throw new AgentSourceError(inspection.sideEffects);
	}
	const transitive = helperClosureProblems(
		definition,
		repoRoot,
		realpathSync(sibling),
		frameworkDirs,
	);
	if (transitive.length > 0) {
		throw new AgentSourceError(
			transitive.map((message) => ({
				file: siblingDisplay,
				field: "import",
				message,
			})),
		);
	}
	return {
		id,
		file: display,
		spec,
		extension: { file: sibling, exports: inspection.exports },
	};
}

async function readIncludes(
	definition: ResolvedDefinition,
	repoRoot: string,
	declaration: string,
	display: string,
	parsed: ReturnType<typeof parseAgentMarkdown>,
): Promise<IncludeText[]> {
	const roots = realRoots(repoRoot, definition.includeRoots);
	const localIsLink =
		definition.realLocal !== join(definition.declarationRoot.real, "local");
	const issues: SourceIssue[] = [];
	const texts: IncludeText[] = [];

	for (const [i, include] of (parsed.source.includes ?? []).entries()) {
		const issue = (message: string) =>
			issues.push({
				file: display,
				line: parsed.lineOf(["includes", i]),
				field: `includes[${i}]`,
				message,
			});
		const target = resolve(dirname(declaration), include);
		if (!existsSync(target)) {
			issue(`"${include}" does not exist`);
			continue;
		}
		let real: string;
		try {
			// Bun's realpath opens the file, so an unreadable include fails here.
			real = realpathSync(target);
		} catch (error) {
			issue(`"${include}" could not be read: ${(error as Error).message}`);
			continue;
		}
		if (!roots.some((dir) => isInside(dir, real))) {
			issue(
				`"${include}" resolves outside ${listRoots(definition.includeRoots, "and")}`,
			);
			continue;
		}
		const owned = ownedProblem(definition.owned, real);
		if (owned) {
			issue(`"${include}" ${owned}`);
			continue;
		}
		// A symlinked local/ is excluded at its target, so an include there
		// would build but never rebuild. The ordinary local/ directory keeps
		// its legacy exception.
		if (localIsLink && isWithin(definition.realLocal, real)) {
			issue(
				`"${include}" lies inside ${definition.declarationRoot.label}/local/, a symlink whose target is never watched`,
			);
			continue;
		}
		try {
			texts.push({
				path: relative(repoRoot, real),
				text: await readFile(real, "utf8"),
			});
		} catch (error) {
			issue(`"${include}" could not be read: ${(error as Error).message}`);
		}
	}
	if (issues.length > 0) throw new AgentSourceError(issues);
	return texts;
}

/**
 * A text import must name a relative path, from the extension's real
 * directory, to an existing regular file whose realpath is under a configured
 * text root (legacy: `system-prompts/`, the same root the watcher covers,
 * D-027). A directory is refused: Bun would apply module resolution
 * (`index.*`, `package.json`) to it and embed whatever that finds.
 */
function textImportProblem(
	definition: ResolvedDefinition,
	repoRoot: string,
	importBase: string,
	specifier: string,
): string | undefined {
	const roots = definition.extensionTextRoots;
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
		return `text import "${specifier}" must be a relative path into ${listRoots(roots, "or")}`;
	}
	const target = resolve(importBase, specifier);
	if (!existsSync(target)) {
		return `text import "${specifier}" does not exist`;
	}
	if (!statSync(target).isFile()) {
		return `text import "${specifier}" is not a file`;
	}
	const real = realpathSync(target);
	if (!realRoots(repoRoot, roots).some((dir) => isInside(dir, real))) {
		return `text import "${specifier}" resolves outside ${listRoots(roots, "and")}`;
	}
	const owned = ownedProblem(definition.owned, real);
	if (owned) return `text import "${specifier}" ${owned}`;
	return undefined;
}

function realpathOrSelf(path: string): string {
	return existsSync(path) ? realpathSync(path) : path;
}

function moduleCandidates(path: string): string[] {
	return [path, `${path}.ts`, join(path, "index.ts")];
}

/**
 * The real path of the file a relative value import loads: the first
 * candidate that is a regular file, so a directory import is judged by its
 * `index.ts`, wherever that really lives. Undefined when none is a file.
 */
function moduleFile(path: string): string | undefined {
	for (const candidate of moduleCandidates(path)) {
		if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
			return realpathSync(candidate);
		}
	}
	return undefined;
}

/**
 * Why the module a relative value import selects cannot be established by
 * `moduleFile`'s search, or undefined when it can: the path is a file, or
 * `<path>.ts` is, or the path is a directory holding `index.ts` and no
 * `package.json`. Bun would follow a directory's `package.json` entry, or
 * other extensions, to a file the checks never see, so those are refused.
 */
function unestablishedModule(path: string): string | undefined {
	const stat = (candidate: string) =>
		statSync(candidate, { throwIfNoEntry: false });
	if (stat(path)?.isFile() || stat(`${path}.ts`)?.isFile()) return undefined;
	if (!stat(path)?.isDirectory()) {
		return "no such file, .ts file or directory";
	}
	if (existsSync(join(path, "package.json"))) {
		return "the directory has a package.json";
	}
	return stat(join(path, "index.ts"))?.isFile()
		? undefined
		: "the directory has no index.ts";
}

/**
 * The relative module specifiers a file's code loads, as written: static
 * imports and re-exports that are not type-only, and literal dynamic
 * `import()` or `require()`. A dynamic load whose specifier is not a
 * string literal cannot be established and is reported in `opaque`.
 */
interface ModuleLoad {
	specifier: string;
	/** The import, when it carries attributes: judged as a text import. */
	attributed?: ts.ImportDeclaration;
}

/** The callee with parentheses, type assertions and `!` removed. */
function bareCallee(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function relativeLoads(
	file: string,
	text: string,
): { loads: ModuleLoad[]; opaque: string[] } {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const loads: ModuleLoad[] = [];
	const opaque: string[] = [];
	const visit = (node: ts.Node) => {
		const callee = ts.isCallExpression(node)
			? bareCallee(node.expression)
			: undefined;
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			!node.importClause?.isTypeOnly
		) {
			loads.push({
				specifier: node.moduleSpecifier.text,
				...(node.attributes ? { attributed: node } : {}),
			});
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			!node.isTypeOnly &&
			ts.isExternalModuleReference(node.moduleReference) &&
			ts.isStringLiteralLike(node.moduleReference.expression)
		) {
			loads.push({ specifier: node.moduleReference.expression.text });
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			!node.isTypeOnly
		) {
			loads.push({ specifier: node.moduleSpecifier.text });
		} else if (
			ts.isCallExpression(node) &&
			callee &&
			(callee.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(callee) && callee.text === "require"))
		) {
			const [first] = node.arguments;
			if (first && ts.isStringLiteralLike(first)) {
				loads.push({ specifier: first.text });
			} else {
				const { line } = source.getLineAndCharacterOfPosition(node.getStart());
				opaque.push(`${file}:${line + 1}`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return {
		// Attributed imports are judged whatever their specifier, so a bare
		// text specifier is refused rather than dropped.
		loads: loads.filter(
			(load) =>
				load.attributed !== undefined ||
				load.specifier.startsWith("./") ||
				load.specifier.startsWith("../") ||
				load.specifier.startsWith("/") ||
				load.specifier.startsWith("file:"),
		),
		opaque,
	};
}

/**
 * Problems in the transitive relative import closure of an accepted
 * extension (C13). Every module an accepted helper loads by path is judged
 * by the rules its direct imports are: one of the three established forms,
 * real location under an extension code root, never in the compiler's own
 * locations; text imports by the text-import rules. Absolute and `file:`
 * specifiers and non-literal dynamic loads cannot be established and are
 * refused. Bare package imports are not checked.
 */
/** Inspection rules a helper's text import does not consult. */
const HELPER_RULES: ImportRules = {
	isFrameworkImport: () => false,
	textImportProblem: () => undefined,
	importProblem: () => undefined,
	codeRoots: [],
	textRoots: [],
};

function helperClosureProblems(
	definition: ResolvedDefinition,
	repoRoot: string,
	extension: string,
	codeRoots: readonly string[],
): string[] {
	const problems: string[] = [];
	const seen = new Set<string>([extension]);
	const queue = [extension];
	const label = (path: string) => relative(repoRoot, path);
	while (queue.length > 0) {
		const file = queue.shift() as string;
		const base = dirname(file);
		const { loads, opaque } = relativeLoads(file, readFileSync(file, "utf8"));
		for (const where of opaque) {
			problems.push(
				`${label(where)}: a dynamic load whose module cannot be established`,
			);
		}
		for (const load of loads) {
			const from = label(file);
			if (load.attributed) {
				// The extension's own text imports were judged by inspection.
				if (file === extension) continue;
				const text = load.attributed.importClause
					? textImportShapeProblem(load.attributed, load.specifier, {
							...HELPER_RULES,
							textRoots: definition.extensionTextRoots.map(
								(entry) => entry.label,
							),
							textImportProblem: (specifier) =>
								textImportProblem(definition, repoRoot, base, specifier),
						})
					: `text import "${load.specifier}" must be a single default import`;
				if (text) problems.push(`${from}: ${text}`);
				continue;
			}
			if (!load.specifier.startsWith(".")) {
				problems.push(
					`${from}: import "${load.specifier}" names an absolute location; use a relative path`,
				);
				continue;
			}
			const target = resolve(base, load.specifier);
			const unknown = unestablishedModule(target);
			if (unknown) {
				problems.push(
					`${from}: value import "${load.specifier}": its selected module cannot be established (${unknown}); name the file explicitly`,
				);
				continue;
			}
			const module = moduleFile(target) as string;
			if (!codeRoots.some((dir) => isInside(dir, module))) {
				problems.push(
					`${from}: value import "${load.specifier}" resolves outside ${listRoots(definition.extensionCodeRoots, "and")}`,
				);
				continue;
			}
			const owned = ownedProblem(definition.owned, module);
			if (owned) {
				problems.push(`${from}: value import "${load.specifier}" ${owned}`);
				continue;
			}
			if (!seen.has(module)) {
				seen.add(module);
				queue.push(module);
			}
		}
	}
	return problems;
}

/** Strictly beneath `dir`; `dir` itself is not inside. */
function isInside(dir: string, path: string): boolean {
	return relative(dir, path) !== "" && isWithin(dir, path);
}

/**
 * Read an extension's syntax without importing it.
 *
 * The rule guards against accidentally pairing a legacy launcher or any module
 * that does work on import; it is not a sandbox against a hostile author.
 * Allowed at the top level: `import type`, value imports from packages,
 * builtins and the framework module, default imports carrying exactly
 * `with { type: "text" }` of a `.md` file under `system-prompts/`
 * (importing text runs no code), local exports, type/interface
 * declarations, function declarations, classes extending a plain identifier,
 * enums with literal initializers, and `const` declarations with
 * side-effect-free initializers. Relative imports outside the framework,
 * side-effect imports, re-exports, `import x =`, decorators and `const enum`
 * are rejected, because importing a module runs it.
 */
export function inspectExtension(
	file: string,
	text: string,
	options: InspectOptions = {},
): ExtensionInspection {
	const rules: ImportRules = {
		codeRoots: options.codeRoots ?? [],
		importProblem: options.importProblem ?? (() => undefined),
		textRoots: options.textRoots ?? [TEXT_IMPORT_DIR],
		isFrameworkImport: options.isFrameworkImport ?? (() => false),
		textImportProblem:
			options.textImportProblem ??
			((specifier) =>
				`text import "${specifier}" cannot be resolved without a repository`),
	};
	const sourceFile = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const lineOf = (node: ts.Node) =>
		sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
		1;
	const issueAt = (node: ts.Node, field: string, message: string) => ({
		file,
		line: lineOf(node),
		field,
		message,
	});

	const syntax = ts.transpileModule(text, {
		fileName: file,
		reportDiagnostics: true,
		compilerOptions: {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
		},
	}).diagnostics;
	const sideEffects: SourceIssue[] = (syntax ?? []).map((diagnostic) => ({
		file,
		line:
			diagnostic.start === undefined
				? undefined
				: sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
		field: "syntax",
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
	}));

	const values = localValueNames(sourceFile);
	const exported = new Set<string>();
	const exportProblems: SourceIssue[] = [];
	const hidingExportProblems: SourceIssue[] = [];
	for (const statement of sourceFile.statements) {
		const shape = exportShape(statement, values);
		for (const name of shape.names) exported.add(name);
		for (const problem of shape.problems) {
			const issue = issueAt(problem.node, "exports", problem.message);
			exportProblems.push(issue);
			if (problem.mayHideReserved) hidingExportProblems.push(issue);
		}
		const problem = topLevelProblem(statement, rules);
		if (problem) {
			sideEffects.push(
				issueAt(
					statement,
					"top-level",
					`${problem}; extensions must not run code on import`,
				),
			);
		}
	}
	const visit = (node: ts.Node) => {
		if (ts.isDecorator(node)) {
			sideEffects.push(
				issueAt(
					node,
					"top-level",
					"a decorator runs code at definition time; extensions must not run code on import",
				),
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	sideEffects.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

	return {
		exports: EXTENSION_EXPORTS.filter((name) => exported.has(name)),
		exportProblems,
		hidingExportProblems,
		sideEffects,
	};
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
	);
}

function isReserved(name: string): boolean {
	return (EXTENSION_EXPORTS as readonly string[]).includes(name);
}

/** Top-level names that exist at runtime (not `declare`, not type-only). */
function localValueNames(sourceFile: ts.SourceFile): Set<string> {
	const names = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isEnumDeclaration(statement)) &&
			statement.name
		) {
			names.add(statement.name.text);
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				for (const name of bindingNames(declaration.name)) names.add(name);
			}
		} else if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			if (!clause || clause.isTypeOnly) continue;
			if (clause.name) names.add(clause.name.text);
			const bindings = clause.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) {
				names.add(bindings.name.text);
			} else if (bindings) {
				for (const element of bindings.elements) {
					if (!element.isTypeOnly) names.add(element.name.text);
				}
			}
		}
	}
	return names;
}

function bindingNames(name: ts.BindingName): string[] {
	if (ts.isIdentifier(name)) return [name.text];
	return name.elements.flatMap((element) =>
		ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
	);
}

interface ExportShape {
	names: string[];
	problems: { node: ts.Node; message: string; mayHideReserved: boolean }[];
}

const BY_NAME = "export prepare/finish by name from a local declaration";

function exportShape(
	statement: ts.Statement,
	values: ReadonlySet<string>,
): ExportShape {
	const shape: ExportShape = { names: [], problems: [] };
	const problem = (node: ts.Node, message: string, mayHideReserved = true) =>
		shape.problems.push({
			node,
			message: `${message}; ${BY_NAME}`,
			mayHideReserved,
		});

	if (ts.isExportDeclaration(statement)) {
		const clause = statement.exportClause;
		if (!clause || ts.isNamespaceExport(clause)) {
			problem(statement, "export * cannot be resolved statically");
			return shape;
		}
		for (const element of clause.elements) {
			const name = element.name.text;
			if (!isReserved(name)) continue;
			if (statement.isTypeOnly || element.isTypeOnly) {
				problem(element, `type-only export "${name}" has no runtime value`);
				continue;
			}
			const local = (element.propertyName ?? element.name).text;
			if (!statement.moduleSpecifier && !values.has(local)) {
				problem(
					element,
					`"${name}" exports "${local}", which has no runtime declaration`,
				);
				continue;
			}
			shape.names.push(name);
		}
		return shape;
	}
	if (ts.isExportAssignment(statement)) {
		problem(
			statement,
			statement.isExportEquals
				? "export = is not supported"
				: "export default is not supported",
			false,
		);
		return shape;
	}
	if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return shape;
	if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
		problem(statement, "export default is not supported", false);
		return shape;
	}
	const declared = hasModifier(statement, ts.SyntaxKind.DeclareKeyword);
	const names = declaredNames(statement);
	const reserved = names.filter(isReserved);
	if (
		reserved.length > 0 &&
		(declared ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement))
	) {
		problem(statement, `"${reserved[0]}" is declared without a runtime value`);
		return shape;
	}
	if (
		reserved.length > 0 &&
		ts.isVariableStatement(statement) &&
		statement.declarationList.declarations.some(
			(declaration) => !ts.isIdentifier(declaration.name),
		)
	) {
		problem(
			statement,
			`destructured export of "${reserved[0]}" cannot be resolved statically`,
		);
		return shape;
	}
	shape.names.push(...names);
	return shape;
}

function declaredNames(statement: ts.Statement): string[] {
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.flatMap((declaration) =>
			bindingNames(declaration.name),
		);
	}
	if (
		(ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isEnumDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement)) &&
		statement.name
	) {
		return [statement.name.text];
	}
	return [];
}

function isBareSpecifier(specifier: string): boolean {
	if (specifier.startsWith("node:") || specifier.startsWith("bun:"))
		return true;
	return !/^(\.|\/|[A-Za-z][A-Za-z0-9+.-]*:)/.test(specifier);
}

type ImportRules = Required<InspectOptions>;

/** The only file type a text import may name: prompt Markdown. */
const TEXT_EXTENSION = ".md";

function importProblem(
	statement: ts.Statement,
	rules: ImportRules,
): string | undefined {
	if (ts.isImportEqualsDeclaration(statement)) {
		return `"import ${statement.name.text} =" is not supported`;
	}
	if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
		const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
		return `re-export from "${specifier}" imports and runs that module`;
	}
	if (!ts.isImportDeclaration(statement)) return undefined;
	const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
	const clause = statement.importClause;
	if (!clause) return `side-effect import "${specifier}"`;
	if (clause.isTypeOnly) return undefined;
	if (statement.attributes) {
		return textImportShapeProblem(statement, specifier, rules);
	}
	if (isBareSpecifier(specifier)) return undefined;
	const owned = rules.importProblem(specifier);
	if (owned) return owned;
	if (rules.isFrameworkImport(specifier)) return undefined;
	return `value import from "${specifier}" (only ${joinList(["packages", "builtins", ...rules.codeRoots], "and")} may be imported)`;
}

/**
 * The one import form that carries attributes: `import name from "<file>"
 * with { type: "text" }`, nothing more, of a `.md` file the repository rules
 * accept. Any other attribute use is rejected, packages included.
 */
function textImportShapeProblem(
	statement: ts.ImportDeclaration,
	specifier: string,
	rules: ImportRules,
): string | undefined {
	const attributes = statement.attributes;
	const clause = statement.importClause;
	if (!attributes || !clause) return undefined;
	const [only, ...extra] = attributes.elements;
	const isTextType =
		attributes.token === ts.SyntaxKind.WithKeyword &&
		only !== undefined &&
		extra.length === 0 &&
		(ts.isIdentifier(only.name) || ts.isStringLiteral(only.name)) &&
		only.name.text === "type" &&
		ts.isStringLiteral(only.value) &&
		only.value.text === "text";
	if (!isTextType) {
		return `import attributes on "${specifier}" must be exactly with { type: "text" }`;
	}
	if (!clause.name || clause.namedBindings) {
		return `text import "${specifier}" must be a single default import`;
	}
	if (!specifier.endsWith(TEXT_EXTENSION)) {
		return `text import "${specifier}" must name a ${TEXT_EXTENSION} file under ${joinList(
			rules.textRoots.map((root) => `${root}/`),
			"or",
		)}`;
	}
	return rules.textImportProblem(specifier);
}

function topLevelProblem(
	statement: ts.Statement,
	rules: ImportRules,
): string | undefined {
	const imported = importProblem(statement, rules);
	if (imported) return imported;
	if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
		const reserved = declaredNames(statement).filter(isReserved);
		return reserved.length > 0
			? `a declare statement names "${reserved[0]}"`
			: undefined;
	}
	if (
		ts.isImportDeclaration(statement) ||
		ts.isExportDeclaration(statement) ||
		ts.isInterfaceDeclaration(statement) ||
		ts.isTypeAliasDeclaration(statement) ||
		ts.isFunctionDeclaration(statement) ||
		ts.isEmptyStatement(statement)
	) {
		return undefined;
	}
	if (ts.isEnumDeclaration(statement)) return enumProblem(statement);
	if (ts.isClassDeclaration(statement)) return classProblem(statement);
	if (ts.isExportAssignment(statement)) {
		return isSideEffectFree(statement.expression)
			? undefined
			: "an export assignment with a side-effecting expression";
	}
	if (ts.isVariableStatement(statement)) {
		const list = statement.declarationList;
		if (!(list.flags & ts.NodeFlags.Const) || list.flags & ts.NodeFlags.Using) {
			return "only const declarations are allowed at the top level";
		}
		for (const declaration of list.declarations) {
			if (!ts.isIdentifier(declaration.name)) {
				return "a destructuring const declaration";
			}
			if (
				!declaration.initializer ||
				!isSideEffectFree(declaration.initializer)
			) {
				return `const "${declaration.name.text}" has an initializer that may run code`;
			}
		}
		return undefined;
	}
	if (ts.isExpressionStatement(statement))
		return "a top-level expression statement";
	return `a top-level ${ts.SyntaxKind[statement.kind]}`;
}

function enumProblem(node: ts.EnumDeclaration): string | undefined {
	const name = node.name.text;
	if (hasModifier(node, ts.SyntaxKind.ConstKeyword)) {
		return `const enum "${name}" is not supported`;
	}
	for (const member of node.members) {
		const value = member.initializer;
		if (!value) continue;
		const literal =
			ts.isStringLiteral(value) ||
			ts.isNumericLiteral(value) ||
			ts.isNoSubstitutionTemplateLiteral(value) ||
			(ts.isPrefixUnaryExpression(value) &&
				value.operator === ts.SyntaxKind.MinusToken &&
				ts.isNumericLiteral(value.operand));
		if (!literal) return `enum "${name}" has a non-literal initializer`;
	}
	return undefined;
}

function classProblem(node: ts.ClassDeclaration): string | undefined {
	const name = node.name?.text ?? "anonymous";
	for (const clause of node.heritageClauses ?? []) {
		if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
		for (const type of clause.types) {
			if (!ts.isIdentifier(type.expression)) {
				return `class "${name}" extends something other than a plain identifier`;
			}
		}
	}
	for (const member of node.members) {
		if (ts.isClassStaticBlockDeclaration(member)) {
			return `class "${name}" has a static block`;
		}
		if (member.name && ts.isComputedPropertyName(member.name)) {
			return `class "${name}" has a computed member name`;
		}
		if (
			ts.isPropertyDeclaration(member) &&
			hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
			member.initializer &&
			!isSideEffectFree(member.initializer)
		) {
			return `class "${name}" has a static initializer that may run code`;
		}
	}
	return undefined;
}

/** Literals, function expressions, and object/array literals of those. */
function isSideEffectFree(expression: ts.Expression): boolean {
	if (
		ts.isParenthesizedExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isSatisfiesExpression(expression) ||
		ts.isTypeAssertionExpression(expression) ||
		ts.isNonNullExpression(expression)
	) {
		return isSideEffectFree(expression.expression);
	}
	if (
		ts.isStringLiteral(expression) ||
		ts.isNumericLiteral(expression) ||
		ts.isBigIntLiteral(expression) ||
		ts.isNoSubstitutionTemplateLiteral(expression) ||
		ts.isRegularExpressionLiteral(expression) ||
		ts.isArrowFunction(expression) ||
		ts.isFunctionExpression(expression)
	) {
		return true;
	}
	switch (expression.kind) {
		case ts.SyntaxKind.TrueKeyword:
		case ts.SyntaxKind.FalseKeyword:
		case ts.SyntaxKind.NullKeyword:
			return true;
	}
	if (ts.isPrefixUnaryExpression(expression)) {
		return (
			(expression.operator === ts.SyntaxKind.MinusToken ||
				expression.operator === ts.SyntaxKind.PlusToken) &&
			(ts.isNumericLiteral(expression.operand) ||
				ts.isBigIntLiteral(expression.operand))
		);
	}
	if (ts.isArrayLiteralExpression(expression)) {
		return expression.elements.every(
			(element) =>
				ts.isOmittedExpression(element) ||
				(!ts.isSpreadElement(element) && isSideEffectFree(element)),
		);
	}
	if (ts.isObjectLiteralExpression(expression)) {
		return expression.properties.every((property) => {
			if (property.name && ts.isComputedPropertyName(property.name))
				return false;
			if (ts.isPropertyAssignment(property))
				return isSideEffectFree(property.initializer);
			return (
				ts.isMethodDeclaration(property) ||
				ts.isGetAccessorDeclaration(property) ||
				ts.isSetAccessorDeclaration(property)
			);
		});
	}
	return false;
}

/**
 * The CLI and runner files a generated entry imports: the implementation
 * behind `troupe/cli` and `troupe/runtime`, found beside this compiler in
 * its own installed distribution, never through the consumer's working
 * directory. A missing file fails here, before any build starts.
 */
function runtimeFiles(): { cli: string; run: string } {
	const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
	const run = fileURLToPath(new URL("./run.ts", import.meta.url));
	for (const file of [cli, run]) {
		if (!existsSync(file)) {
			throw new Error(
				`the troupe runtime file ${file} is missing from the installed distribution; reinstall troupe`,
			);
		}
	}
	return { cli, run };
}

/**
 * Entry source for a compiled agent. It embeds the spec and imports only the
 * reserved extension exports. A `dispatch` export sees the raw argv first
 * and may claim the run (D1). Otherwise it parses its argv with the shared CLI (help
 * and parse errors exit there), serves `--show-prompt` through the runner's
 * preview and otherwise hands the invocation to the runner's lifecycle.
 * Given a version line (from the agent's stamp policy), the entry answers
 * `--version` with it after any dispatch and before parsing.
 */
export function generateEntry(
	agent: LoadedAgent,
	versionLine?: string,
): string {
	const { cli, run } = runtimeFiles();
	const stamped = versionLine !== undefined;
	const names = agent.extension?.exports ?? [];
	const dispatched = names.includes("dispatch");
	const lines: string[] = [
		'import { statSync } from "node:fs";',
		`import { ${stamped ? "resolveCli, resolveVersion" : "resolveCli"} } from ${JSON.stringify(cli)};`,
		`import { ${dispatched ? "dispatchAndExit, " : ""}previewAndExit, runAndExit } from ${JSON.stringify(run)};`,
	];
	if (agent.extension && names.length > 0) {
		lines.push(
			`import { ${names.join(", ")} } from ${JSON.stringify(agent.extension.file)};`,
		);
	}
	lines.push(
		`const spec = ${JSON.stringify(agent.spec, null, "\t")};`,
		`const extension = { ${names.join(", ")} };`,
	);
	if (dispatched) {
		lines.push(
			"await dispatchAndExit(spec, extension, process.argv.slice(2));",
		);
	}
	if (stamped) {
		lines.push(
			`const versioned = resolveVersion(spec.id, ${JSON.stringify(versionLine)}, process.argv.slice(2), {`,
			"\tstdout: (text) => process.stdout.write(text),",
			"\tstderr: (text) => process.stderr.write(text),",
			"});",
			"if (versioned) process.exit(versioned.exitCode);",
		);
	}
	lines.push(
		"const io = {",
		"\tcwd: process.cwd(),",
		"\tstdout: (text) => process.stdout.write(text),",
		"\tstderr: (text) => process.stderr.write(text),",
		'\tisDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? "missing",',
		"};",
		"const cli = resolveCli(spec, process.argv.slice(2), io);",
		'if ("exitCode" in cli) process.exit(cli.exitCode);',
		"if (cli.invocation.showPrompt) await previewAndExit(spec, extension, cli.invocation, io);",
		"await runAndExit(spec, extension, cli.invocation, io);",
		"",
	);
	return lines.join("\n");
}

/**
 * Validate one declaration and build its binary at `outFile`. The binary is
 * built in a temporary directory beside `outFile` and renamed into place, so
 * any failure or abort leaves `outFile` untouched. An agent the definition
 * stamps is stamped as `publish` stamps it.
 */
export async function compileAgent(options: {
	/** Roster-independent: any declaration under the declaration root builds. */
	definition: AgentSourceDefinition;
	/** Relative to the consumer root. */
	file: string;
	/** Relative to the consumer root. */
	outFile: string;
	build?: Builder;
	signal?: AbortSignal;
}): Promise<LoadedAgent & { stamp?: CapturedBuildStamp }> {
	const definition = resolveDefinition(options.definition);
	const root = definition.root;
	const early = await captureStamps(definition, [
		toBinaryName(
			declarationCoordinate(resolve(root, options.file)),
			root,
			definition.declarationRoot.real,
		),
	]);
	const agent = await loadResolved(definition, options.file);
	const outFile = resolve(root, options.outFile);
	const stamps = await settleStamps(definition, [agent.id], early);
	const captured = stamps.get(agent.id);
	const workDir = await mkdtemp(join(dirname(outFile), ".agent-build-"));
	try {
		const entry = join(workDir, "entry.ts");
		const built = join(workDir, "binary");
		await writeFile(entry, generateEntry(agent, captured?.line));
		await (options.build ?? bunBuild)({
			entry,
			outFile: built,
			cwd: workDir,
			label: agent.file,
			signal: options.signal,
			...dependencyRoot(root),
		});
		await recheckStamps(stamps);
		options.signal?.throwIfAborted();
		await rename(built, outFile);
		return captured ? { ...agent, stamp: captured.stamp } : agent;
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

type Settled<T> = { value: T } | { error: unknown };

/**
 * A stamp is captured before its sources are read, so it covers what is
 * built; a capture error is reported only after any source error.
 */
async function settle<T>(capture: () => T | Promise<T>): Promise<Settled<T>> {
	try {
		return { value: await capture() };
	} catch (error) {
		return { error };
	}
}

function unwrap<T>(settled: Settled<T>): T {
	if ("error" in settled) throw settled.error;
	return settled.value;
}

interface SettledStamp {
	policy: BuildStampPolicy;
	context: StampContext;
	stamp: CapturedBuildStamp;
	line: string;
}

function stampContext(
	definition: ResolvedDefinition,
	agentId: string,
): StampContext {
	return {
		agentId,
		consumerRoot: definition.root,
		declarationRoot: definition.declarationRoot.path,
		outDir: definition.outDir,
	};
}

function policyFor(
	definition: ResolvedDefinition,
	id: string,
): BuildStampPolicy | undefined {
	return Object.hasOwn(definition.stamps, id)
		? definition.stamps[id]
		: undefined;
}

/** Capture, without throwing, every stamp the named agents select. */
async function captureStamps(
	definition: ResolvedDefinition,
	ids: readonly string[],
): Promise<Map<string, Settled<CapturedBuildStamp>>> {
	const early = new Map<string, Settled<CapturedBuildStamp>>();
	for (const id of ids) {
		const policy = policyFor(definition, id);
		if (!policy || early.has(id)) continue;
		early.set(
			id,
			await settle(() => policy.capture(stampContext(definition, id))),
		);
	}
	return early;
}

/**
 * The stamps of the agents being built, from the early captures (an agent
 * not captured early is captured now), each with its version line. The
 * first capture error is thrown.
 */
async function settleStamps(
	definition: ResolvedDefinition,
	ids: readonly string[],
	early: Map<string, Settled<CapturedBuildStamp>>,
): Promise<Map<string, SettledStamp>> {
	const stamps = new Map<string, SettledStamp>();
	for (const id of ids) {
		const policy = policyFor(definition, id);
		if (!policy) continue;
		const context = stampContext(definition, id);
		const stamp = unwrap(
			early.get(id) ?? (await settle(() => policy.capture(context))),
		);
		stamps.set(id, {
			policy,
			context,
			stamp,
			line: policy.versionLine(id, stamp),
		});
	}
	return stamps;
}

/** Refuse publication when any stamped source changed during the build. */
async function recheckStamps(stamps: Map<string, SettledStamp>): Promise<void> {
	for (const [id, { policy, context, stamp }] of stamps) {
		const now = await policy.recheck(context, stamp);
		if (now.source !== stamp.manifest.source) {
			throw new Error(
				`${id} source changed during the build (captured ${stamp.manifest.source}, now ${now.source})`,
			);
		}
	}
}

export interface BuildRequest {
	entry: string;
	outFile: string;
	cwd: string;
	label: string;
	signal?: AbortSignal;
	/**
	 * Set when the runtime is installed outside the consumer root, as Bun
	 * installs a `file:` folder dependency (per-file symlinks into the
	 * folder): the runtime's own package imports resolve from this root's
	 * `node_modules`, which the default builder puts on `NODE_PATH`.
	 */
	dependencyRoot?: string;
}

/**
 * The consumer root a build must resolve the runtime's packages from, when
 * the runtime's real location lies outside it. Inside the consumer (the
 * repository's own builds) ordinary resolution already finds them.
 */
function dependencyRoot(root: string): { dependencyRoot?: string } {
	const runtime = realpathSync(runtimeFiles().run);
	const real = realpathOrSelf(root);
	return isWithin(real, runtime) ? {} : { dependencyRoot: real };
}

/** Builds one entry into one binary; `bun build --compile` by default. */
export type Builder = (request: BuildRequest) => Promise<void>;

async function bunBuild(options: BuildRequest): Promise<void> {
	options.signal?.throwIfAborted();
	const child = Bun.spawn(
		[
			process.execPath,
			"build",
			"--compile",
			options.entry,
			"--outfile",
			options.outFile,
		],
		{
			cwd: options.cwd,
			stdout: "pipe",
			stderr: "pipe",
			...(options.dependencyRoot
				? {
						env: {
							...process.env,
							NODE_PATH: [
								join(options.dependencyRoot, "node_modules"),
								process.env.NODE_PATH,
							]
								.filter(Boolean)
								.join(delimiter),
						},
					}
				: {}),
		},
	);
	const kill = () => child.kill("SIGTERM");
	options.signal?.addEventListener("abort", kill, { once: true });
	try {
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		options.signal?.throwIfAborted();
		if (exitCode !== 0) {
			throw new Error(
				`bun build failed for ${options.label} (exit ${exitCode}):\n${stderr}`,
			);
		}
	} finally {
		options.signal?.removeEventListener("abort", kill);
	}
}

// ---------------------------------------------------------------------------
// Roster discovery, strict source selection and publication (D-011, D-017,
// D-023).

/** The only directories the watcher watches and includes may resolve into. */
export const WATCH_ROOTS = INCLUDE_ROOTS;

export const LOCAL_AGENTS_WARNING = localWarning("agents");

function localWarning(label: string): string {
	return `warning: ${label}/local/ is not compiled; private agents are not supported`;
}

export interface CompilerOptions {
	/** Roots, roster and output; resolved once per call. */
	definition: AgentBuildDefinition;
	/** Defaults to `bun build --compile`; tests pass a fake. */
	build?: Builder;
}

export interface BuildEntry {
	id: string;
	source: string;
	agent: LoadedAgent;
}

export interface BuildPlan {
	entries: BuildEntry[];
	warnings: string[];
}

interface DiscoveredSources {
	markdown: Map<string, string>;
	typescript: Map<string, string>;
	issues: SourceIssue[];
	localPresent: boolean;
}

/**
 * Every declaration and non-test TypeScript file under the declaration root,
 * keyed by binary name. Its `local/` is never read (D-011).
 */
function discoverSources(definition: ResolvedDefinition): DiscoveredSources {
	const root = definition.root;
	const agentsDir = definition.declarationRoot.path;
	const realAgents = definition.declarationRoot.real;
	const found: DiscoveredSources = {
		markdown: new Map(),
		typescript: new Map(),
		issues: [],
		localPresent: existsSync(join(agentsDir, "local")),
	};
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (dir === agentsDir && entry.name === "local") continue;
				// Nor its real target, if local/ is a link to another directory.
				if (isWithin(definition.realLocal, canonical(full))) continue;
				// The compiler's own output and temporary directories hold no
				// sources, even under a declaration root that contains them.
				if (ownedProblem(definition.owned, canonical(full))) continue;
				walk(full);
				continue;
			}
			const kind = /\.md$/.test(entry.name)
				? found.markdown
				: /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)
					? found.typescript
					: undefined;
			if (!kind) continue;
			const file = relative(root, full);
			if (kind === found.markdown && entry.isSymbolicLink()) {
				found.issues.push({
					file,
					field: "path",
					message: "a declaration must not be a symlink",
				});
				continue;
			}
			const id = toBinaryName(declarationCoordinate(full), root, realAgents);
			const previous = kind.get(id);
			if (previous) {
				found.issues.push({
					file,
					field: "path",
					message: `"${id}" is also defined by ${previous}`,
				});
				continue;
			}
			kind.set(id, file);
		}
	};
	if (existsSync(agentsDir)) walk(agentsDir);
	return found;
}

/**
 * A source path in the declaration root's canonical coordinate: its
 * directory canonicalized, its own name kept. Naming and membership compare
 * this with the canonical declaration root. A declaration file that is
 * itself a symlink is refused by discovery and loading.
 */
function declarationCoordinate(path: string): string {
	return join(canonical(dirname(path)), basename(path));
}

function expectedSource(definition: ResolvedDefinition, id: string): string {
	return join(
		definition.declarationRoot.label,
		`${id.split(":").join("/")}.md`,
	);
}

/**
 * Resolve a single-compile argument, a roster name or a source path, to a
 * binary name.
 */
export function resolveAgentName(
	definition: AgentSourceDefinition,
	argument: string,
	cwd = process.cwd(),
): string {
	if (!/\.(md|tsx?)$/.test(argument) && !argument.includes("/")) {
		return argument;
	}
	const resolved = resolveDefinition(definition);
	const root = resolved.root;
	const realAgents = resolved.declarationRoot.real;
	// A path outside the declaration root is not an agent source: keep it as
	// given so the roster check rejects it instead of mapping it to a
	// same-named agent. Both the configured alias and its real target count.
	const path = resolve(cwd, argument);
	const coordinate = declarationCoordinate(path);
	if (!isInside(realAgents, coordinate)) {
		return relative(root, path);
	}
	return toBinaryName(coordinate, root, realAgents);
}

/**
 * Discover and validate sources without building anything. With `only`, the
 * plan covers that one roster name; otherwise it covers the exact roster.
 * The rule that every .ts under agents/ is a same-stem extension applies
 * either way.
 * Throws `AgentSourceError` naming every offending file and field.
 */
export async function planBuild(options: {
	definition: AgentBuildDefinition;
	only?: string;
}): Promise<BuildPlan> {
	return planResolved(resolveDefinition(options.definition), options.only);
}

async function planResolved(
	definition: ResolvedDefinition,
	only: string | undefined,
): Promise<BuildPlan> {
	const root = definition.root;
	const roster = new Set(requireRoster(definition));
	const found = discoverSources(definition);
	const issues = [...found.issues];
	const ids = new Set(found.markdown.keys());

	// Checked for every entry point, single compile included (D-017).
	for (const [id, file] of found.typescript) {
		if (!found.markdown.has(id)) {
			issues.push({
				file,
				field: "path",
				message: `only Markdown declarations are built; a .ts under ${definition.declarationRoot.label}/ must be the same-stem extension of a declaration`,
			});
		}
	}

	let selected: string[];
	if (only) {
		const id = only;
		if (!roster.has(id)) {
			issues.push({
				file: found.markdown.get(id) ?? found.typescript.get(id) ?? id,
				field: "roster",
				message: `"${id}" is not a roster agent`,
			});
		} else if (!ids.has(id)) {
			issues.push(missingIssue(definition, id));
		}
		selected = ids.has(id) && roster.has(id) ? [id] : [];
	} else {
		for (const id of ids) {
			if (!roster.has(id)) {
				issues.push({
					file: found.markdown.get(id) as string,
					field: "roster",
					message: `"${id}" is not a roster agent`,
				});
			}
		}
		for (const id of roster) {
			if (!ids.has(id)) issues.push(missingIssue(definition, id));
		}
		selected = [...ids].filter((id) => roster.has(id));
	}

	const entries: BuildEntry[] = [];
	for (const id of selected.sort()) {
		const markdown = found.markdown.get(id) as string;
		try {
			const agent = await loadResolved(definition, markdown);
			const sibling = found.typescript.get(id);
			if (sibling?.endsWith(".tsx")) {
				issues.push(tsxSiblingIssue(sibling));
			} else if (sibling && !agent.extension) {
				issues.push(hooklessSiblingIssue(sibling));
			}
			entries.push({ id, source: markdown, agent });
		} catch (error) {
			if (!(error instanceof AgentSourceError)) throw error;
			issues.push(...error.issues);
		}
	}

	// A single compile does not load the other declarations, but their
	// same-stem siblings must still be extensions.
	for (const [id, sibling] of found.typescript) {
		if (selected.includes(id) || !found.markdown.has(id)) continue;
		if (sibling.endsWith(".tsx")) {
			issues.push(tsxSiblingIssue(sibling));
		} else if (
			inspectExtension(sibling, readFileSync(join(root, sibling), "utf8"))
				.exports.length === 0
		) {
			issues.push(hooklessSiblingIssue(sibling));
		}
	}

	if (issues.length > 0) throw new AgentSourceError(issues);
	return {
		entries,
		warnings: found.localPresent
			? [localWarning(definition.declarationRoot.label)]
			: [],
	};
}

/**
 * Only a same-stem .ts is read as an extension; a .tsx hook would otherwise
 * be dropped without a word.
 */
function tsxSiblingIssue(file: string): SourceIssue {
	return {
		file,
		field: "path",
		message:
			"an extension must be a same-stem .ts file; a .tsx beside a declaration is not read",
	};
}

function hooklessSiblingIssue(file: string): SourceIssue {
	return {
		file,
		field: "exports",
		message: "a same-stem .ts must export prepare or finish",
	};
}

function missingIssue(definition: ResolvedDefinition, id: string): SourceIssue {
	return {
		file: expectedSource(definition, id),
		field: "roster",
		message: `roster agent "${id}" has no declaration`,
	};
}

/**
 * Binaries owned by the other package `compile:*` scripts, found by their
 * `--outfile`/`-o` value `bin/<name>` or `./bin/<name>`, quoted or not. They
 * are never pruned.
 */
export function protectedBinaries(root: string): Set<string> {
	const names = new Set<string>();
	const manifest = join(root, "package.json");
	if (!existsSync(manifest)) return names;
	const pkg = JSON.parse(readFileSync(manifest, "utf8"));
	for (const [script, command] of Object.entries(pkg.scripts ?? {})) {
		if (!script.startsWith("compile:")) continue;
		const pattern =
			/(?:^|\s)(?:--outfile|-o)(?:\s+|=)["']?(?:\.\/)?bin\/([^\s"'/]+)/g;
		for (const match of String(command).matchAll(pattern)) {
			if (match[1]) names.add(match[1]);
		}
	}
	return names;
}

/** Every output entry outside the roster, except protected binaries. */
function orphansIn(
	outDir: string,
	roster: ReadonlySet<string>,
	keep: ReadonlySet<string>,
): string[] {
	if (!existsSync(outDir)) return [];
	return readdirSync(outDir)
		.filter((entry) => !roster.has(entry) && !keep.has(entry))
		.sort();
}

export interface PublishOptions extends CompilerOptions {
	/** Build only this roster name and skip pruning. */
	only?: string;
	/** Validate and report, write nothing. */
	dryRun?: boolean;
	/** Remove orphans after publishing. Defaults to true; ignored with `only`. */
	prune?: boolean;
	signal?: AbortSignal;
	log?: (line: string) => void;
	warn?: (line: string) => void;
}

export interface PublishResult {
	built: string[];
	pruned: string[];
	dryRun: boolean;
	/** The stamps embedded in the built agents, by ID, when any were stamped. */
	stamps?: Record<string, CapturedBuildStamp>;
}

/**
 * The shared compile used by `compile`, `compile:all` and the watcher.
 *
 * Every source is validated first. Every binary is then built into one
 * temporary directory beside the output directory (same filesystem); only
 * after all builds succeed is each renamed into place, and then orphans are
 * pruned. Builds run one at a time: concurrent `bun build --compile`
 * children were seen to lose and corrupt outputs under load. A validation
 * error, build failure, failed output check or abort removes the temporary
 * directory and leaves the output directory untouched. Each stamped agent's
 * stamp is captured before any source is read or temporary directory exists,
 * and publication is refused if its source changed by the end of the builds. An error after the
 * first rename throws `PartialPublishError`; a prune error after every rename
 * throws `PruneError`. There is no cross-process lock (D-023).
 */
export async function publish(options: PublishOptions): Promise<PublishResult> {
	return publishResolved(resolveDefinition(options.definition), options);
}

async function publishResolved(
	definition: ResolvedDefinition,
	options: Omit<PublishOptions, "definition">,
): Promise<PublishResult> {
	const root = definition.root;
	const outDir = definition.outDir;
	const roster = new Set(requireRoster(definition));
	const log = options.log ?? (() => {});
	const warn = options.warn ?? log;
	const prune = options.prune !== false && !options.only;
	const early = options.dryRun
		? new Map<string, Settled<CapturedBuildStamp>>()
		: await captureStamps(
				definition,
				options.only ? [options.only] : [...roster],
			);

	const plan = await planResolved(definition, options.only);
	for (const warning of plan.warnings) warn(warning);
	const orphans = prune
		? orphansIn(outDir, roster, definition.protectedOutputs())
		: [];

	if (options.dryRun) {
		for (const entry of plan.entries) {
			log(`would build ${entry.id} (${entry.source})`);
		}
		for (const orphan of orphans) log(`would prune ${orphan}`);
		return {
			built: plan.entries.map((entry) => entry.id),
			pruned: orphans,
			dryRun: true,
		};
	}

	options.signal?.throwIfAborted();
	const stamps = await settleStamps(
		definition,
		plan.entries.map((entry) => entry.id),
		early,
	);
	const workDir = await mkdtemp(join(dirname(outDir), ".troupe-build-"));
	try {
		if (
			existsSync(outDir) &&
			internalDeviceProbe.device(outDir) !== internalDeviceProbe.device(workDir)
		) {
			throw new Error(
				`${workDir} is not on the same filesystem as ${outDir}; cannot publish by rename`,
			);
		}
		const builtDir = join(workDir, "bin");
		const entryDir = join(workDir, "entries");
		await mkdir(builtDir);
		await mkdir(entryDir);

		for (const entry of plan.entries) {
			options.signal?.throwIfAborted();
			const file = join(entryDir, `${entry.id}.ts`);
			await writeFile(
				file,
				generateEntry(entry.agent, stamps.get(entry.id)?.line),
			);
			await (options.build ?? bunBuild)({
				entry: file,
				outFile: join(builtDir, entry.id),
				cwd: entryDir,
				label: entry.source,
				signal: options.signal,
				...dependencyRoot(root),
			});
			log(`built ${entry.id}`);
		}

		await recheckStamps(stamps);
		options.signal?.throwIfAborted();
		preflightPublish(plan.entries, builtDir, outDir);
		await mkdir(outDir, { recursive: true });
		const label = `${basename(outDir)}/`;
		let renamed = 0;
		try {
			for (const entry of plan.entries) {
				await rename(join(builtDir, entry.id), join(outDir, entry.id));
				renamed++;
			}
		} catch (error) {
			if (renamed === 0) throw error;
			throw new PartialPublishError(
				label,
				renamed,
				plan.entries.length,
				error as Error,
			);
		}
		for (const orphan of orphans) {
			try {
				await rm(join(outDir, orphan), { recursive: true, force: true });
			} catch (error) {
				throw new PruneError(
					label,
					plan.entries.length,
					orphan,
					error as Error,
				);
			}
			log(`pruned ${orphan}`);
		}
		return {
			built: plan.entries.map((entry) => entry.id),
			pruned: orphans,
			dryRun: false,
			...(stamps.size > 0
				? {
						stamps: Object.fromEntries(
							[...stamps].map(([id, { stamp }]) => [id, stamp]),
						),
					}
				: {}),
		};
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

/**
 * Internal, not part of `troupe/compiler`: the device a path lives on, read
 * by the same-filesystem check before publication. Tests replace `device`
 * to simulate an output directory on another filesystem.
 */
export const internalDeviceProbe = {
	device: (path: string): number => statSync(path).dev,
};

/**
 * Checks made before the first rename, so a failure here still leaves the
 * output directory untouched: every built output is a non-empty regular file
 * and no target is a directory.
 */
export function preflightPublish(
	entries: readonly BuildEntry[],
	builtDir: string,
	outDir: string,
): void {
	const problems: string[] = [];
	for (const entry of entries) {
		const built = statSync(join(builtDir, entry.id), { throwIfNoEntry: false });
		if (!built?.isFile() || built.size === 0) {
			problems.push(
				`build of ${entry.id} reported success but produced ${built ? (built.isFile() ? "an empty file" : "no regular file") : "no file"}`,
			);
		}
		const target = lstatSync(join(outDir, entry.id), {
			throwIfNoEntry: false,
		});
		if (target?.isDirectory()) {
			problems.push(
				`${join(basename(outDir), entry.id)} is a directory; remove it and rerun`,
			);
		}
	}
	if (problems.length > 0) throw new Error(problems.join("\n"));
}

/** Some binaries were renamed into place before an error. */
export class PartialPublishError extends Error {
	constructor(
		label: string,
		readonly renamed: number,
		readonly total: number,
		cause: Error,
	) {
		super(
			`${label} partly updated (${renamed} of ${total}); rerun compile:all\n${cause.message}`,
		);
		this.name = "PartialPublishError";
	}
}

/** Every binary was published, but removing an orphan failed. */
export class PruneError extends Error {
	constructor(label: string, total: number, orphan: string, cause: Error) {
		super(
			`${label} updated (${total} of ${total}), but pruning ${orphan} failed: ${cause.message}`,
		);
		this.name = "PruneError";
	}
}

/**
 * What a caller prints for a failed publish: the cause, and whether the
 * output directory was left untouched.
 */
export function describePublishFailure(error: unknown, label = "bin/"): string {
	if (error instanceof PartialPublishError || error instanceof PruneError) {
		return error.message;
	}
	const cause =
		error instanceof AgentSourceError
			? error.issues.map(formatIssue).join("\n")
			: String((error as Error)?.message ?? error);
	return `${cause}\nNothing published; ${label} left untouched.`;
}

/**
 * Runs `task` one at a time. A request during a run is coalesced into one
 * follow-up run, so a burst of changes never builds concurrently and the last
 * change is always built.
 */
export function createSerialQueue(task: () => Promise<void>): {
	request(): Promise<void>;
	idle(): Promise<void>;
} {
	let running: Promise<void> | undefined;
	let pending: Promise<void> | undefined;
	const start = (): Promise<void> => {
		running = task()
			.catch(() => {})
			.finally(() => {
				running = undefined;
			});
		return running;
	};
	return {
		request() {
			if (pending) return pending;
			if (!running) return start();
			pending ??= running.then(() => {
				pending = undefined;
				return start();
			});
			return pending;
		},
		async idle() {
			while (running || pending) await (pending ?? running);
		},
	};
}

type WatchFn = (
	dir: string,
	options: { recursive: boolean },
	listener: (event: string, filename: string | null) => void,
) => { close(): void };

export interface WatcherOptions extends CompilerOptions {
	/** Replaces `fs.watch`; tests inject one. */
	watch?: WatchFn;
	debounceMs?: number;
	log?: (line: string) => void;
	warn?: (line: string) => void;
	/** Aborts a rebuild in progress. */
	signal?: AbortSignal;
	/** Runs one full rebuild. Defaults to `publish`. */
	rebuild?: () => Promise<void>;
}

/**
 * Watch exactly the definition's watch roots (legacy: `agents/` and
 * `system-prompts/`, D-027) and rebuild the definition's roster through the
 * shared compiler on any change, one rebuild at a time. Changes under the
 * declaration root's `local/` are ignored, and so are the compiler's own
 * writes (the output directory and its temporary build siblings) when a
 * watch root contains them, so a rebuild cannot schedule another.
 */
export function startWatcher(options: WatcherOptions): {
	close(): void;
	queue: ReturnType<typeof createSerialQueue>;
	roots: string[];
} {
	const definition = resolveDefinition(options.definition);
	const root = definition.root;
	const outDir = definition.outDir;
	requireRoster(definition);
	const log = options.log ?? (() => {});
	const watch = options.watch ?? (nodeWatch as unknown as WatchFn);
	const {
		definition: _,
		watch: __,
		rebuild: custom,
		...publishOptions
	} = options;
	const rebuild =
		custom ??
		(async () => {
			try {
				const result = await publishResolved(definition, publishOptions);
				log(`rebuilt ${result.built.length} agents`);
			} catch (error) {
				log(
					`rebuild failed:\n${describePublishFailure(error, `${basename(outDir)}/`)}`,
				);
			}
		});
	// Events are judged in canonical coordinates, so a watch root reached
	// through a symlink filters the same paths as the real one.
	// The same owned locations resolution refuses inputs in, and the whole
	// local/ path canonicalized, so a symlinked local/ is excluded too.
	const realLocal = definition.realLocal;
	const ignored = (path: string) =>
		ownedProblem(definition.owned, path) !== undefined ||
		isWithin(realLocal, path);
	const queue = createSerialQueue(rebuild);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void queue.request();
		}, options.debounceMs ?? 100);
	};

	const roots = definition.watchRoots.filter((dir) => existsSync(dir));
	const watchers = roots.map((dir) => {
		const real = realpathSync(dir);
		return watch(dir, { recursive: true }, (_event, filename) => {
			const name = filename?.toString() ?? "";
			if (ignored(canonical(join(real, name)))) return;
			log(`change: ${relative(root, join(dir, name))}`);
			schedule();
		});
	});
	return {
		queue,
		roots,
		close() {
			if (timer) clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
		},
	};
}

/**
 * Abort on SIGINT, SIGTERM or SIGHUP so a build in progress cleans up its temp
 * directory. The handlers stay installed, so a repeated signal cannot end the
 * process before that cleanup runs.
 */
export function abortOnSignals(): { signal: AbortSignal; exitCode(): number } {
	const controller = new AbortController();
	let code = 1;
	const on = (name: NodeJS.Signals, exit: number) =>
		process.on(name, () => {
			if (controller.signal.aborted) return;
			code = exit;
			controller.abort(new Error(`interrupted by ${name}`));
		});
	on("SIGINT", 130);
	on("SIGTERM", 143);
	on("SIGHUP", 129);
	return { signal: controller.signal, exitCode: () => code };
}
