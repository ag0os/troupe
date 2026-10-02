/**
 * Shared agent compiler used by `compile`, `compile:all` and the watcher:
 * reads Markdown declarations, resolves and reads their includes, statically
 * inspects paired `.ts` extensions, selects mixed or strict sources against
 * the roster, and publishes binaries by temp-dir build then rename.
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
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
	AgentSourceError,
	formatIssue,
	type SourceIssue,
} from "../lib/agent-format/errors";
import {
	type IncludeText,
	materializeAgentSpec,
	parseAgentMarkdown,
} from "../lib/agent-format/schema";
import {
	type AgentSpec,
	EXTENSION_EXPORTS,
	type ExtensionExport,
} from "../lib/agent-format/types";
import { toBinaryName } from "./binary-name";

/** Roots an include's realpath must stay under (D-027). */
export const INCLUDE_ROOTS = ["agents", "system-prompts"] as const;

/** Directory whose modules extensions may import by relative path. */
export const FRAMEWORK_DIR = "lib/agent-format";

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
	 * and `export =` cannot, so a legacy sibling using them is not a hook.
	 */
	hidingExportProblems: SourceIssue[];
	/** Statements that would run code on import. Fatal for extensions. */
	sideEffects: SourceIssue[];
}

export interface InspectOptions {
	/** True when a relative specifier resolves under `lib/agent-format/`. */
	isFrameworkImport?: (specifier: string) => boolean;
	/**
	 * Why a well-formed default text import of `specifier` is not allowed, or
	 * undefined when it resolves to a file under `system-prompts/`. Without
	 * it, every text import is rejected.
	 */
	textImportProblem?: (specifier: string) => string | undefined;
}

export interface LoadedAgent {
	id: string;
	file: string;
	spec: AgentSpec;
	extension?: { file: string; exports: ExtensionExport[] };
}

/**
 * Read and validate one declaration without importing any TypeScript.
 * Throws `AgentSourceError` naming the file, line and field.
 */
export async function loadAgentDefinition(
	root: string,
	file: string,
): Promise<LoadedAgent> {
	const repoRoot = realpathSync(root);
	const declaration = realpathOrSelf(resolve(root, file));
	const display = relative(repoRoot, declaration);

	const agentsRoot = realpathSync(join(repoRoot, "agents"));
	if (!isInside(agentsRoot, declaration)) {
		throw new AgentSourceError([
			{
				file: display,
				field: "path",
				message: "declarations live under agents/",
			},
		]);
	}

	const parsed = parseAgentMarkdown(
		display,
		await readFile(declaration, "utf8"),
	);
	const includes = await readIncludes(repoRoot, declaration, display, parsed);
	const id = toBinaryName(declaration, repoRoot);
	const spec = materializeAgentSpec(parsed, { id, includes });

	const sibling = declaration.replace(/\.md$/, ".ts");
	if (!existsSync(sibling)) return { id, file: display, spec };

	const siblingDisplay = relative(repoRoot, sibling);
	const frameworkDir = join(repoRoot, FRAMEWORK_DIR);
	const inspection = inspectExtension(
		siblingDisplay,
		await readFile(sibling, "utf8"),
		{
			isFrameworkImport: (specifier) =>
				existsSync(frameworkDir) &&
				moduleCandidates(resolve(dirname(sibling), specifier)).some(
					(candidate) =>
						existsSync(candidate) &&
						isInside(realpathSync(frameworkDir), realpathSync(candidate)),
				),
			textImportProblem: (specifier) =>
				textImportProblem(repoRoot, sibling, specifier),
		},
	);
	// A sibling without reserved exports is not an extension, unless an
	// unresolvable export could be hiding one; mode handling for legacy
	// siblings belongs to discovery.
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
	return {
		id,
		file: display,
		spec,
		extension: { file: sibling, exports: inspection.exports },
	};
}

async function readIncludes(
	repoRoot: string,
	declaration: string,
	display: string,
	parsed: ReturnType<typeof parseAgentMarkdown>,
): Promise<IncludeText[]> {
	const roots = INCLUDE_ROOTS.map((name) => join(repoRoot, name))
		.filter((dir) => existsSync(dir))
		.map((dir) => realpathSync(dir));
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
		const real = realpathSync(target);
		if (!roots.some((dir) => isInside(dir, real))) {
			issue(`"${include}" resolves outside agents/ and system-prompts/`);
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
 * A text import must name a relative path to an existing file whose realpath
 * is under `system-prompts/`, the same root the watcher covers (D-027).
 */
function textImportProblem(
	repoRoot: string,
	extension: string,
	specifier: string,
): string | undefined {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
		return `text import "${specifier}" must be a relative path into ${TEXT_IMPORT_DIR}/`;
	}
	const target = resolve(dirname(extension), specifier);
	if (!existsSync(target)) {
		return `text import "${specifier}" does not exist`;
	}
	const textRoot = join(repoRoot, TEXT_IMPORT_DIR);
	if (
		!existsSync(textRoot) ||
		!isInside(realpathSync(textRoot), realpathSync(target))
	) {
		return `text import "${specifier}" resolves outside ${TEXT_IMPORT_DIR}/`;
	}
	return undefined;
}

function realpathOrSelf(path: string): string {
	return existsSync(path) ? realpathSync(path) : path;
}

function moduleCandidates(path: string): string[] {
	return [path, `${path}.ts`, join(path, "index.ts")];
}

function isInside(dir: string, path: string): boolean {
	const rel = relative(dir, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Read an extension's syntax without importing it.
 *
 * The rule guards against accidentally pairing a legacy launcher or any module
 * that does work on import; it is not a sandbox against a hostile author.
 * Allowed at the top level: `import type`, value imports from packages,
 * builtins and the framework module, default imports carrying exactly
 * `with { type: "text" }` of a non-script file under `system-prompts/`
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

/** File types a text import may not name: their text is code. */
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/i;

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
	if (isBareSpecifier(specifier) || rules.isFrameworkImport(specifier)) {
		return undefined;
	}
	return `value import from "${specifier}" (only packages, builtins and ${FRAMEWORK_DIR} may be imported)`;
}

/**
 * The one import form that carries attributes: `import name from "<file>"
 * with { type: "text" }`, nothing more, of a non-script file the repository
 * rules accept. Any other attribute use is rejected, packages included.
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
	if (SCRIPT_EXTENSION.test(specifier)) {
		return `text import "${specifier}" names a script; only prompt text may be imported as text`;
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
 * Entry source for a compiled agent. It embeds the spec and imports only the
 * reserved extension exports. It parses its argv with the shared CLI (help
 * and parse errors exit there), serves `--show-prompt` through the runner's
 * preview and otherwise hands the invocation to the runner's lifecycle.
 */
export function generateEntry(agent: LoadedAgent): string {
	const cli = fileURLToPath(
		new URL("../lib/agent-format/cli.ts", import.meta.url),
	);
	const run = fileURLToPath(
		new URL("../lib/agent-format/run.ts", import.meta.url),
	);
	const lines: string[] = [
		'import { statSync } from "node:fs";',
		`import { resolveCli } from ${JSON.stringify(cli)};`,
		`import { previewAndExit, runAndExit } from ${JSON.stringify(run)};`,
	];
	const names = agent.extension?.exports ?? [];
	if (agent.extension && names.length > 0) {
		lines.push(
			`import { ${names.join(", ")} } from ${JSON.stringify(agent.extension.file)};`,
		);
	}
	lines.push(
		`const spec = ${JSON.stringify(agent.spec, null, "\t")};`,
		`const extension = { ${names.join(", ")} };`,
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
 * any failure leaves `outFile` untouched.
 */
export async function compileAgent(options: {
	root: string;
	file: string;
	outFile: string;
}): Promise<LoadedAgent> {
	const agent = await loadAgentDefinition(options.root, options.file);
	const outFile = resolve(options.outFile);
	const workDir = await mkdtemp(join(dirname(outFile), ".agent-build-"));
	try {
		const entry = join(workDir, "entry.ts");
		const built = join(workDir, "binary");
		await writeFile(entry, generateEntry(agent));
		await bunBuild({ entry, outFile: built, cwd: workDir, label: agent.file });
		await rename(built, outFile);
		return agent;
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

async function bunBuild(options: {
	entry: string;
	outFile: string;
	cwd: string;
	label: string;
	signal?: AbortSignal;
}): Promise<void> {
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
		{ cwd: options.cwd, stdout: "pipe", stderr: "pipe" },
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
// Roster discovery, mixed/strict source selection and publication (D-011,
// D-017, D-023).

/** The fixed 23-agent roster (D-008). */
export const ROSTER = [
	"analyze:orient",
	"build:builder",
	"build:comment-review",
	"build:refactor",
	"build:tdd",
	"design:architect",
	"design:audit",
	"design:designer",
	"design:diagram:all",
	"design:diagram:consolidate",
	"design:diagram:topic",
	"git:fix",
	"meta:prompt",
	"modes:contain",
	"personas:github",
	"plan:planner",
	"plan:riff",
	"rails:backlog",
	"resume:tailor",
	"review:pr",
	"shepherd",
	"tools:webfetch",
	"tutors:coach",
] as const;

/**
 * `mixed` is the migration mode: Markdown and legacy TypeScript launchers
 * side by side. `strict` is the final mode: Markdown declarations only.
 */
export const COMPILE_MODES = ["mixed", "strict"] as const;
export type CompileMode = (typeof COMPILE_MODES)[number];

/** The only directories the watcher watches and includes may resolve into. */
export const WATCH_ROOTS = INCLUDE_ROOTS;

export const LOCAL_AGENTS_WARNING =
	"warning: agents/local/ is not compiled; private agents are not supported";

export interface CompilerOptions {
	root: string;
	mode: CompileMode;
	/** Output directory. Defaults to `<root>/bin`. */
	outDir?: string;
	/** Defaults to `ROSTER`. */
	roster?: readonly string[];
}

export type BuildEntry =
	| { kind: "declaration"; id: string; source: string; agent: LoadedAgent }
	| { kind: "legacy"; id: string; source: string };

export interface BuildPlan {
	mode: CompileMode;
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
 * Every declaration and non-test TypeScript file under `agents/`, keyed by
 * binary name. `agents/local/` is never read (D-011).
 */
function discoverSources(root: string): DiscoveredSources {
	const agentsDir = join(root, "agents");
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
			const id = toBinaryName(full, root);
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

function expectedSource(id: string): string {
	return `agents/${id.split(":").join("/")}.md`;
}

/**
 * Resolve a single-compile argument, a roster name or a source path, to a
 * binary name.
 */
export function resolveAgentName(
	root: string,
	argument: string,
	cwd = process.cwd(),
): string {
	if (!/\.(md|tsx?)$/.test(argument) && !argument.includes("/")) {
		return argument;
	}
	// A path outside agents/ is not an agent source: keep it as given so the
	// roster check rejects it instead of mapping it to a same-named agent.
	const path = resolve(cwd, argument);
	if (!isInside(join(resolve(root), "agents"), path)) {
		return relative(resolve(root), path);
	}
	return toBinaryName(path, resolve(root));
}

/**
 * Discover and validate sources without building anything. With `only`, the
 * plan covers that one roster name; otherwise it covers the exact roster.
 * Throws `AgentSourceError` naming every offending file and field.
 */
export async function planBuild(
	options: CompilerOptions & { only?: string },
): Promise<BuildPlan> {
	const root = resolve(options.root);
	const roster = new Set(options.roster ?? ROSTER);
	const found = discoverSources(root);
	const issues = [...found.issues];
	const strict = options.mode === "strict";

	const ids = new Set(found.markdown.keys());
	if (!strict) for (const id of found.typescript.keys()) ids.add(id);
	const sourceOf = (id: string) =>
		found.markdown.get(id) ?? found.typescript.get(id) ?? expectedSource(id);

	if (strict && !options.only) {
		for (const [id, file] of found.typescript) {
			if (!found.markdown.has(id)) {
				issues.push({
					file,
					field: "path",
					message:
						"strict mode builds Markdown declarations only; a .ts under agents/ must be the same-stem extension of a declaration",
				});
			}
		}
	}

	let selected: string[];
	if (options.only) {
		const id = options.only;
		if (!roster.has(id)) {
			issues.push({
				file: found.markdown.get(id) ?? found.typescript.get(id) ?? id,
				field: "roster",
				message: `"${id}" is not a roster agent`,
			});
		} else if (!ids.has(id)) {
			issues.push(missingIssue(id, strict));
		}
		selected = ids.has(id) && roster.has(id) ? [id] : [];
	} else {
		for (const id of ids) {
			if (!roster.has(id)) {
				issues.push({
					file: sourceOf(id),
					field: "roster",
					message: `"${id}" is not a roster agent`,
				});
			}
		}
		for (const id of roster) {
			if (!ids.has(id)) issues.push(missingIssue(id, strict));
		}
		selected = [...ids].filter((id) => roster.has(id));
	}

	const entries: BuildEntry[] = [];
	for (const id of selected.sort()) {
		const markdown = found.markdown.get(id);
		if (!markdown) {
			entries.push({
				kind: "legacy",
				id,
				source: found.typescript.get(id) as string,
			});
			continue;
		}
		try {
			const agent = await loadAgentDefinition(root, markdown);
			const sibling = found.typescript.get(id);
			if (sibling?.endsWith(".tsx")) {
				// Only a same-stem .ts is read as an extension; a .tsx hook would
				// otherwise be dropped without a word.
				issues.push({
					file: sibling,
					field: "path",
					message:
						"an extension must be a same-stem .ts file; a .tsx beside a declaration is not read",
				});
			} else if (strict && sibling && !agent.extension) {
				issues.push({
					file: sibling,
					field: "exports",
					message:
						"strict mode requires a same-stem .ts to export prepare or finish",
				});
			}
			entries.push({ kind: "declaration", id, source: markdown, agent });
		} catch (error) {
			if (!(error instanceof AgentSourceError)) throw error;
			issues.push(...error.issues);
		}
	}

	if (issues.length > 0) throw new AgentSourceError(issues);
	return {
		mode: options.mode,
		entries,
		warnings: found.localPresent ? [LOCAL_AGENTS_WARNING] : [],
	};
}

function missingIssue(id: string, strict: boolean): SourceIssue {
	const file = expectedSource(id);
	return {
		file,
		field: "roster",
		message: strict
			? `roster agent "${id}" has no declaration`
			: `roster agent "${id}" has no declaration or legacy launcher (${file.replace(/\.md$/, ".ts")})`,
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
 * directory and leaves the output directory untouched. An error after the
 * first rename throws `PartialPublishError`; a prune error after every rename
 * throws `PruneError`. There is no cross-process lock (D-023).
 */
export async function publish(options: PublishOptions): Promise<PublishResult> {
	const root = resolve(options.root);
	const outDir = resolve(options.outDir ?? join(root, "bin"));
	const roster = new Set(options.roster ?? ROSTER);
	const log = options.log ?? (() => {});
	const warn = options.warn ?? log;
	const prune = options.prune !== false && !options.only;

	const plan = await planBuild({ ...options, root });
	for (const warning of plan.warnings) warn(warning);
	const orphans = prune
		? orphansIn(outDir, roster, protectedBinaries(root))
		: [];

	if (options.dryRun) {
		for (const entry of plan.entries) {
			log(`would build ${entry.id} (${entry.kind}: ${entry.source})`);
		}
		for (const orphan of orphans) log(`would prune ${orphan}`);
		return {
			built: plan.entries.map((entry) => entry.id),
			pruned: orphans,
			dryRun: true,
		};
	}

	options.signal?.throwIfAborted();
	const workDir = await mkdtemp(join(dirname(outDir), ".troupe-build-"));
	try {
		if (existsSync(outDir) && statSync(outDir).dev !== statSync(workDir).dev) {
			throw new Error(
				`${workDir} is not on the same filesystem as ${outDir}; cannot publish by rename`,
			);
		}
		const builtDir = join(workDir, "bin");
		const entryDir = join(workDir, "entries");
		await mkdir(builtDir);
		await mkdir(entryDir);

		const generateAssets = join(root, "scripts", "gen-assets.ts");
		if (
			plan.entries.some((entry) => entry.kind === "legacy") &&
			existsSync(generateAssets)
		) {
			// Legacy launchers read their prompts through the generated asset map.
			await bunRun([generateAssets], root, options.signal);
		}

		for (const entry of plan.entries) {
			options.signal?.throwIfAborted();
			const outFile = join(builtDir, entry.id);
			if (entry.kind === "legacy") {
				await bunBuild({
					entry: entry.source,
					outFile,
					cwd: root,
					label: entry.source,
					signal: options.signal,
				});
			} else {
				const file = join(entryDir, `${entry.id}.ts`);
				await writeFile(file, generateEntry(entry.agent));
				await bunBuild({
					entry: file,
					outFile,
					cwd: entryDir,
					label: entry.source,
					signal: options.signal,
				});
			}
			log(`built ${entry.id}`);
		}

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
		};
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

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

async function bunRun(
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const child = Bun.spawn([process.execPath, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const kill = () => child.kill("SIGTERM");
	signal?.addEventListener("abort", kill, { once: true });
	try {
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		signal?.throwIfAborted();
		if (exitCode !== 0) {
			throw new Error(
				`bun ${args.join(" ")} failed (exit ${exitCode}):\n${stderr}`,
			);
		}
	} finally {
		signal?.removeEventListener("abort", kill);
	}
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
 * Watch exactly `agents/` and `system-prompts/` (D-027) and rebuild every
 * agent through the shared compiler on any change, one rebuild at a time.
 * Changes under `agents/local/` are ignored.
 */
export function startWatcher(options: WatcherOptions): {
	close(): void;
	queue: ReturnType<typeof createSerialQueue>;
	roots: string[];
} {
	const root = resolve(options.root);
	const log = options.log ?? (() => {});
	const watch = options.watch ?? (nodeWatch as unknown as WatchFn);
	const rebuild =
		options.rebuild ??
		(async () => {
			try {
				const result = await publish({ ...options, root });
				log(`rebuilt ${result.built.length} agents`);
			} catch (error) {
				log(
					`rebuild failed:\n${describePublishFailure(error, `${basename(resolve(options.outDir ?? join(root, "bin")))}/`)}`,
				);
			}
		});
	const queue = createSerialQueue(rebuild);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void queue.request();
		}, options.debounceMs ?? 100);
	};

	const roots = WATCH_ROOTS.map((name) => join(root, name)).filter((dir) =>
		existsSync(dir),
	);
	const watchers = roots.map((dir) =>
		watch(dir, { recursive: true }, (_event, filename) => {
			const name = filename?.toString() ?? "";
			if (
				dir === join(root, "agents") &&
				(name === "local" || name.startsWith("local/"))
			) {
				return;
			}
			log(`change: ${relative(root, join(dir, name))}`);
			schedule();
		}),
	);
	return {
		queue,
		roots,
		close() {
			if (timer) clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
		},
	};
}

/** Parse `--mode=<mixed|strict>` (or `--mode <value>`); the rest is returned. */
export function takeModeArg(argv: readonly string[]): {
	mode?: CompileMode;
	rest: string[];
	error?: string;
} {
	const rest: string[] = [];
	let mode: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--mode") {
			mode = argv[++i];
		} else if (arg.startsWith("--mode=")) {
			mode = arg.slice("--mode=".length);
		} else {
			rest.push(arg);
		}
	}
	if (mode === undefined) {
		return { rest, error: "--mode=mixed or --mode=strict is required" };
	}
	if (!(COMPILE_MODES as readonly string[]).includes(mode)) {
		return { rest, error: `unknown --mode "${mode}" (mixed or strict)` };
	}
	return { mode: mode as CompileMode, rest };
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
