/**
 * Shared agent compiler: reads a Markdown declaration, resolves and reads its
 * includes, statically inspects a paired `.ts` extension, and builds one
 * binary. Roster discovery and publication are not here yet.
 */

import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { AgentSourceError, type SourceIssue } from "../lib/agent-format/errors";
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

export interface ExtensionInspection {
	/** Reserved extension exports the module declares statically. */
	exports: ExtensionExport[];
	/**
	 * `prepare`/`finish` shapes that cannot be resolved statically. Always
	 * fatal, so a hook is never silently dropped or left to a build failure.
	 */
	exportProblems: SourceIssue[];
	/** Statements that would run code on import. Fatal for extensions. */
	sideEffects: SourceIssue[];
}

export interface InspectOptions {
	/** True when a relative specifier resolves under `lib/agent-format/`. */
	isFrameworkImport?: (specifier: string) => boolean;
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
		},
	);
	if (inspection.exportProblems.length > 0) {
		throw new AgentSourceError(inspection.exportProblems);
	}
	// A sibling without reserved exports is not an extension; mode handling
	// for legacy siblings belongs to discovery.
	if (inspection.exports.length === 0) return { id, file: display, spec };
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
 * builtins and the framework module, local exports, type/interface
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
	const isFrameworkImport = options.isFrameworkImport ?? (() => false);
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
	for (const statement of sourceFile.statements) {
		const shape = exportShape(statement, values);
		for (const name of shape.names) exported.add(name);
		for (const problem of shape.problems) {
			exportProblems.push(issueAt(problem.node, "exports", problem.message));
		}
		const problem = topLevelProblem(statement, isFrameworkImport);
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
	problems: { node: ts.Node; message: string }[];
}

const BY_NAME = "export prepare/finish by name from a local declaration";

function exportShape(
	statement: ts.Statement,
	values: ReadonlySet<string>,
): ExportShape {
	const shape: ExportShape = { names: [], problems: [] };
	const problem = (node: ts.Node, message: string) =>
		shape.problems.push({ node, message: `${message}; ${BY_NAME}` });

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
		);
		return shape;
	}
	if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return shape;
	if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
		problem(statement, "export default is not supported");
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

function importProblem(
	statement: ts.Statement,
	isFrameworkImport: (specifier: string) => boolean,
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
	if (isBareSpecifier(specifier) || isFrameworkImport(specifier)) {
		return undefined;
	}
	return `value import from "${specifier}" (only packages, builtins and ${FRAMEWORK_DIR} may be imported)`;
}

function topLevelProblem(
	statement: ts.Statement,
	isFrameworkImport: (specifier: string) => boolean,
): string | undefined {
	const imported = importProblem(statement, isFrameworkImport);
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
 * and parse errors exit there) and serves `--show-prompt` through the
 * runner's preview; until execution lands it otherwise prints the embedded
 * definition and the parsed invocation as JSON.
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
		`import { previewAndExit } from ${JSON.stringify(run)};`,
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
		"process.stdout.write(`${JSON.stringify({ spec, extension: Object.keys(extension), invocation: cli.invocation })}\\n`);",
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
		const child = Bun.spawn(
			[process.execPath, "build", "--compile", entry, "--outfile", built],
			{ cwd: workDir, stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) {
			throw new Error(
				`bun build failed for ${agent.file} (exit ${exitCode}):\n${stderr}`,
			);
		}
		await rename(built, outFile);
		return agent;
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
