/**
 * Static import closure of TypeScript sources: every file reached through
 * relative `import`, `export ... from`, type-only and dynamic string imports,
 * read with TypeScript's preprocessor so type-only edges count, plus
 * runtime file URLs (a relative string literal passed to `new URL` with
 * `import.meta.url`). Bare
 * specifiers (packages, `node:` and `bun:` builtins) are external and not
 * followed. Text imports (`.md`, `.txt`) are members but not followed.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";

const CODE = new Set([".ts", ".tsx", ".mts", ".cts"]);
const CANDIDATES = ["", ".ts", ".tsx", ".d.ts", "/index.ts", "/index.d.ts"];

export interface ClosureResult {
	/** Absolute paths of every member, the entry files included. */
	files: string[];
	/** External specifiers seen, sorted. */
	external: string[];
	/** Relative specifiers that resolved to nothing, as `from -> specifier`. */
	unresolved: string[];
}

function isRelative(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

function resolveRelative(from: string, specifier: string): string | undefined {
	const base = resolve(dirname(from), specifier);
	for (const suffix of CANDIDATES) {
		const path = `${base}${suffix}`;
		if (existsSync(path) && statSync(path).isFile()) return path;
	}
	return undefined;
}

const RUNTIME_URL = /new URL\(\s*"(\.\.?\/[^"]+)",\s*import\.meta\.url\s*\)/g;

/** The specifiers one file imports, type-only and dynamic ones included. */
export function importsOf(file: string): string[] {
	const text = readFileSync(file, "utf8");
	const info = ts.preProcessFile(text, true, true);
	return [
		...[...text.matchAll(RUNTIME_URL)].map((match) => match[1] as string),
		...info.importedFiles.map((ref) => ref.fileName),
		...info.referencedFiles.map((ref) => ref.fileName),
		...info.typeReferenceDirectives.map((ref) => ref.fileName),
	];
}

export function importClosure(entries: readonly string[]): ClosureResult {
	const files = new Set<string>();
	const external = new Set<string>();
	const unresolved: string[] = [];
	const queue = entries.map((entry) => resolve(entry));
	while (queue.length > 0) {
		const file = queue.shift() as string;
		if (files.has(file)) continue;
		files.add(file);
		const ext = file.endsWith(".d.ts") ? ".ts" : extname(file);
		if (!CODE.has(ext)) continue;
		for (const specifier of importsOf(file)) {
			if (!isRelative(specifier) && !specifier.startsWith("/")) {
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
