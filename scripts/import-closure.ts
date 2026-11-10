/**
 * Static import closure of TypeScript and JavaScript sources, read from the
 * syntax tree so comments and ordinary strings never count. Edges are:
 * import and export declarations (type-only and `export * as` included),
 * import-equals, `import("...")` types and calls with a literal argument,
 * literal `require`, and triple-slash references, all module specifiers; and
 * a literal first argument of `new URL(..., import.meta.url)`, a file URL
 * kept apart from specifiers and resolved with URL semantics, so a bare path
 * such as `helper.ts` names a local file, never a package. Parentheses, type
 * assertions and `import.meta["url"]` are seen through. Anything the walker
 * cannot follow statically is reported as opaque with its kind, never
 * dropped: a computed `import()` or `require()` (module), a non-literal or
 * non-file URL or a computed `import.meta` read (url), and any
 * `import.meta.dir` or `import.meta.dirname` in either spelling (directory).
 * Bare module specifiers (packages, `node:` and `bun:` builtins) are
 * external and not followed. Other files (`.md`, `.json`) are members but
 * not followed.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** What an opaque reference may hide: a module, a file URL or a directory. */
export type OpaqueKind = "module" | "url" | "directory";

export interface OpaqueRef {
	file: string;
	line: number;
	kind: OpaqueKind;
	what: string;
}

export interface ClosureResult {
	/** Absolute paths of every member, the entry files included. */
	files: string[];
	/** External specifiers seen, sorted. */
	external: string[];
	/** Local references that resolved to nothing, as `from -> specifier`. */
	unresolved: string[];
	/** Dynamic references the walker cannot follow, as `file:line: what`. */
	opaque: string[];
	/** The same references, classified. */
	opaqueRefs: OpaqueRef[];
}

export interface FileEdges {
	/** Module specifiers: relative ones are local, bare ones external. */
	specifiers: string[];
	/** Absolute paths named by file URLs resolved against the module. */
	urls: string[];
	opaque: OpaqueRef[];
}

function formatOpaque(ref: OpaqueRef): string {
	return `${ref.file}:${ref.line}: ${ref.what}`;
}

function scriptKind(file: string): ts.ScriptKind | undefined {
	if (file.endsWith(".d.ts")) return ts.ScriptKind.TS;
	const dot = file.lastIndexOf(".");
	return dot === -1 ? undefined : KINDS[file.slice(dot)];
}

/** Strip parentheses and type assertions that do not change the value. */
function unwrap(node: ts.Node | undefined): ts.Node | undefined {
	let current = node;
	while (
		current &&
		(ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isSatisfiesExpression(current) ||
			ts.isNonNullExpression(current) ||
			ts.isTypeAssertionExpression(current))
	) {
		current = current.expression;
	}
	return current;
}

function literalText(node: ts.Node | undefined): string | undefined {
	const inner = unwrap(node);
	if (
		inner &&
		(ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner))
	) {
		return inner.text;
	}
	return undefined;
}

function isImportMetaProperty(node: ts.Node): boolean {
	const inner = unwrap(node);
	return (
		inner !== undefined &&
		ts.isMetaProperty(inner) &&
		inner.keywordToken === ts.SyntaxKind.ImportKeyword
	);
}

/**
 * The member an `import.meta` access reads: `url` for `import.meta.url` or
 * `import.meta["url"]`, `null` for a computed key, `undefined` when the node
 * is not an `import.meta` access.
 */
function importMetaMember(
	node: ts.Node | undefined,
): string | null | undefined {
	const inner = unwrap(node);
	if (!inner) return undefined;
	if (
		ts.isPropertyAccessExpression(inner) &&
		isImportMetaProperty(inner.expression)
	) {
		return inner.name.text;
	}
	if (
		ts.isElementAccessExpression(inner) &&
		isImportMetaProperty(inner.expression)
	) {
		return literalText(inner.argumentExpression) ?? null;
	}
	return undefined;
}

function isUrlConstructor(node: ts.Node): boolean {
	const inner = unwrap(node);
	if (!inner) return false;
	if (ts.isIdentifier(inner)) return inner.text === "URL";
	return (
		ts.isPropertyAccessExpression(inner) &&
		inner.name.text === "URL" &&
		ts.isIdentifier(inner.expression) &&
		inner.expression.text === "globalThis"
	);
}

/** The edges and opaque references of one source file. */
export function edgesOf(file: string): FileEdges {
	const kind = scriptKind(file);
	if (kind === undefined) return { specifiers: [], urls: [], opaque: [] };
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		kind,
	);
	const specifiers: string[] = [];
	const urls: string[] = [];
	const opaque: OpaqueRef[] = [];
	const report = (node: ts.Node, kind: OpaqueKind, what: string) =>
		opaque.push({
			file,
			line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
			kind,
			what,
		});

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
			else report(node, "module", "computed import() type");
		} else if (ts.isCallExpression(node)) {
			const callee = unwrap(node.expression) as ts.Node;
			const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
			const required = ts.isIdentifier(callee) && callee.text === "require";
			if (dynamic || required) {
				const text = literalText(node.arguments[0]);
				if (text !== undefined) specifiers.push(text);
				else {
					report(
						node,
						"module",
						`computed ${dynamic ? "import()" : "require()"}`,
					);
				}
			}
		} else if (ts.isNewExpression(node) && isUrlConstructor(node.expression)) {
			const base = importMetaMember(node.arguments?.[1]);
			if (base === "url" || base === null) {
				const text = literalText(node.arguments?.[0]);
				if (base === null || text === undefined) {
					report(node, "url", "non-literal URL with import.meta.url");
				} else {
					const url = new URL(text, pathToFileURL(file));
					if (url.protocol !== "file:") {
						report(node, "url", `non-file URL ${url.protocol}`);
					} else {
						urls.push(fileURLToPath(url));
					}
				}
			}
		} else {
			const member = importMetaMember(node);
			if (member === null) {
				report(node, "url", "computed import.meta access");
			} else if (member === "dir" || member === "dirname") {
				report(node, "directory", `import.meta.${member}`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { specifiers, urls, opaque };
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
	const opaqueRefs: OpaqueRef[] = [];
	const queue = entries.map((entry) => resolve(entry));
	const follow = (target: string) => {
		if (!files.has(target)) queue.push(target);
	};
	while (queue.length > 0) {
		const file = queue.shift() as string;
		if (files.has(file)) continue;
		files.add(file);
		const edges = edgesOf(file);
		opaqueRefs.push(...edges.opaque);
		for (const specifier of edges.specifiers) {
			if (!isRelative(specifier)) {
				external.add(specifier);
				continue;
			}
			const target = resolveRelative(file, specifier);
			if (target === undefined) unresolved.push(`${file} -> ${specifier}`);
			else follow(target);
		}
		// A file URL names one exact local file: no extension search, never a
		// package, whatever its spelling.
		for (const target of edges.urls) {
			const stat = statSync(target, { throwIfNoEntry: false });
			if (!stat) unresolved.push(`${file} -> url ${target}`);
			else if (stat.isDirectory()) {
				opaqueRefs.push({
					file,
					line: 0,
					kind: "directory",
					what: `URL to the directory ${target}`,
				});
			} else follow(target);
		}
	}
	return {
		files: [...files].sort(),
		external: [...external].sort(),
		unresolved,
		opaque: opaqueRefs.map(formatOpaque),
		opaqueRefs,
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
