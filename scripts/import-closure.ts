/**
 * Static import closure of TypeScript and JavaScript sources, read from the
 * syntax tree so comments and ordinary strings never count. Edges are:
 * import and export declarations (type-only and `export * as` included),
 * import-equals, `import("...")` types and calls with a literal argument,
 * literal `require`, triple-slash references, and a literal first argument
 * of `new URL(..., import.meta.url)`. Anything the walker cannot follow
 * statically is reported as opaque, never dropped: a computed `import()`, a
 * non-literal URL against `import.meta.url`, and any `import.meta.dir` or
 * `import.meta.dirname`. Bare specifiers (packages, `node:` and `bun:`
 * builtins) are external and not followed. Other files (`.md`, `.json`) are
 * members but not followed.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const KINDS: Record<string, ts.ScriptKind> = {
	".ts": ts.ScriptKind.TS,
	".mts": ts.ScriptKind.TS,
	".cts": ts.ScriptKind.TS,
	".tsx": ts.ScriptKind.TSX,
	".js": ts.ScriptKind.JS,
	".mjs": ts.ScriptKind.JS,
	".cjs": ts.ScriptKind.JS,
	".jsx": ts.ScriptKind.JSX,
};
const CANDIDATES = ["", ".ts", ".tsx", ".d.ts", "/index.ts", "/index.d.ts"];

export interface ClosureResult {
	/** Absolute paths of every member, the entry files included. */
	files: string[];
	/** External specifiers seen, sorted. */
	external: string[];
	/** Relative specifiers that resolved to nothing, as `from -> specifier`. */
	unresolved: string[];
	/** Dynamic references the walker cannot follow, as `file:line: what`. */
	opaque: string[];
}

export interface FileEdges {
	specifiers: string[];
	opaque: string[];
}

function scriptKind(file: string): ts.ScriptKind | undefined {
	if (file.endsWith(".d.ts")) return ts.ScriptKind.TS;
	const dot = file.lastIndexOf(".");
	return dot === -1 ? undefined : KINDS[file.slice(dot)];
}

function literalText(node: ts.Node | undefined): string | undefined {
	if (
		node &&
		(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
	) {
		return node.text;
	}
	return undefined;
}

function isImportMeta(node: ts.Node, name?: string): boolean {
	if (!ts.isPropertyAccessExpression(node)) return false;
	const target = node.expression;
	return (
		ts.isMetaProperty(target) &&
		target.keywordToken === ts.SyntaxKind.ImportKeyword &&
		(name === undefined || node.name.text === name)
	);
}

/** The edges and opaque references of one source file. */
export function edgesOf(file: string): FileEdges {
	const kind = scriptKind(file);
	if (kind === undefined) return { specifiers: [], opaque: [] };
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		kind,
	);
	const specifiers: string[] = [];
	const opaque: string[] = [];
	const at = (node: ts.Node) =>
		`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

	for (const ref of source.referencedFiles) specifiers.push(ref.fileName);
	for (const ref of source.typeReferenceDirectives) {
		specifiers.push(ref.fileName);
	}

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			const text = literalText(node.moduleSpecifier);
			if (text !== undefined) specifiers.push(text);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		) {
			const text = literalText(node.moduleReference.expression);
			if (text !== undefined) specifiers.push(text);
		} else if (ts.isImportTypeNode(node)) {
			const argument = node.argument;
			const text = ts.isLiteralTypeNode(argument)
				? literalText(argument.literal)
				: undefined;
			if (text !== undefined) specifiers.push(text);
			else opaque.push(`${at(node)}: computed import() type`);
		} else if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
			const required = ts.isIdentifier(callee) && callee.text === "require";
			if (dynamic || required) {
				const text = literalText(node.arguments[0]);
				if (text !== undefined) specifiers.push(text);
				else {
					opaque.push(
						`${at(node)}: computed ${dynamic ? "import()" : "require()"}`,
					);
				}
			}
		} else if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "URL"
		) {
			const base = node.arguments?.[1];
			if (base && isImportMeta(base, "url")) {
				const text = literalText(node.arguments?.[0]);
				if (text !== undefined) specifiers.push(text);
				else opaque.push(`${at(node)}: non-literal URL with import.meta.url`);
			}
		} else if (isImportMeta(node, "dir") || isImportMeta(node, "dirname")) {
			opaque.push(
				`${at(node)}: import.meta.${(node as ts.PropertyAccessExpression).name.text}`,
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { specifiers, opaque };
}

function isRelative(specifier: string): boolean {
	return (
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		specifier.startsWith("/")
	);
}

function resolveRelative(from: string, specifier: string): string | undefined {
	const base = resolve(dirname(from), specifier);
	for (const suffix of CANDIDATES) {
		const path = `${base}${suffix}`;
		if (existsSync(path) && statSync(path).isFile()) return path;
	}
	return undefined;
}

export function importClosure(entries: readonly string[]): ClosureResult {
	const files = new Set<string>();
	const external = new Set<string>();
	const unresolved: string[] = [];
	const opaque: string[] = [];
	const queue = entries.map((entry) => resolve(entry));
	while (queue.length > 0) {
		const file = queue.shift() as string;
		if (files.has(file)) continue;
		files.add(file);
		const edges = edgesOf(file);
		opaque.push(...edges.opaque);
		for (const specifier of edges.specifiers) {
			if (!isRelative(specifier)) {
				external.add(specifier);
				continue;
			}
			const target = resolveRelative(file, specifier);
			if (target === undefined) {
				unresolved.push(`${file} -> ${specifier}`);
				continue;
			}
			if (!files.has(target)) queue.push(target);
		}
	}
	return {
		files: [...files].sort(),
		external: [...external].sort(),
		unresolved,
		opaque,
	};
}

/** Closure members as root-relative POSIX paths, sorted. */
export function relativeClosure(
	root: string,
	entries: readonly string[],
): ClosureResult {
	const result = importClosure(entries.map((entry) => resolve(root, entry)));
	return {
		...result,
		files: result.files.map((file) => relative(root, file)).sort(),
	};
}
