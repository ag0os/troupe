#!/usr/bin/env bun
/**
 * Stage Troupe's allowlisted distribution into a folder a consumer installs
 * as `"troupe": "file:<folder>"`.
 *
 * Bun 1.2.22 treats a folder dependency as a live view of that folder: it
 * ignores `files` and exposes everything inside (spike S-1). So the stage
 * holds exactly the export map's import closure, the type entry and a
 * generated `package.json` with no lifecycle scripts, and it must sit outside
 * any consumer's tree. Restaging rewrites members in place and removes stale
 * ones, so an installed consumer sees the new bytes without reinstalling.
 *
 * Usage:
 *   bun scripts/stage-troupe.ts [--out <dir>]
 *   (default: extractions/.troupe-dist/troupe)
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { relativeClosure } from "./import-closure";

/** The marker and inventory written into every stage. */
export const STAGE_MANIFEST = "troupe-stage.json";

/**
 * Members allowed although they are not framework library code. The legacy
 * Shepherd source module is reached from the compiler until the stamp seam
 * lands; it is the distribution's one temporary policy exception.
 */
export const TEMPORARY_MEMBERS = {
	"scripts/shepherd-source.ts":
		"legacy Shepherd stamp module reached from the compiler; removed when the stamp policy seam lands",
} as const;

const LIBRARY = "lib/";
const BUILTIN = /^(node:|bun:|bun$)/;

export class StageError extends Error {
	constructor(readonly problems: string[]) {
		super(`stage-troupe: ${problems.join("; ")}`);
		this.name = "StageError";
	}
}

export interface StagedMember {
	path: string;
	bytes: number;
	sha256: string;
	temporary?: string;
}

export interface StageResult {
	out: string;
	members: StagedMember[];
	/** Digest over every staged file, package.json and manifest included. */
	digest: string;
}

type Exports = Record<string, string | { types: string }>;

function targets(exports: Exports): string[] {
	return Object.values(exports).map((target) =>
		typeof target === "string" ? target : target.types,
	);
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isTestPath(path: string): boolean {
	const parts = path.split("/");
	return (
		path.endsWith(".test.ts") ||
		parts.includes("__fixtures__") ||
		parts.includes("__snapshots__")
	);
}

/** The members the export map needs, checked against the allowlist. */
export function planStage(root: string): {
	pkg: Record<string, unknown>;
	members: string[];
} {
	const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const exports = source.exports as Exports | undefined;
	if (!exports || Object.keys(exports).length === 0) {
		throw new StageError(["package.json declares no exports"]);
	}
	const dependencies = (source.dependencies ?? {}) as Record<string, string>;
	const entries = targets(exports).map((target) => target.replace(/^\.\//, ""));
	const problems: string[] = [];
	for (const entry of entries) {
		if (!existsSync(join(root, entry))) {
			problems.push(`missing closure member ${entry}`);
		}
	}
	if (problems.length > 0) throw new StageError(problems);

	const closure = relativeClosure(root, entries);
	for (const line of closure.unresolved) {
		problems.push(`missing closure member: ${relative(root, line)}`);
	}
	for (const line of closure.opaque) {
		problems.push(`opaque reference ${relative(root, line)}`);
	}
	for (const specifier of closure.external) {
		if (BUILTIN.test(specifier)) continue;
		const name = specifier.startsWith("@")
			? specifier.split("/").slice(0, 2).join("/")
			: (specifier.split("/")[0] as string);
		if (!(name in dependencies)) {
			problems.push(`import of undeclared dependency ${specifier}`);
		}
	}
	for (const path of closure.files) {
		if (path.startsWith("..") || isAbsolute(path)) {
			problems.push(`closure leaves the root: ${path}`);
			continue;
		}
		const temporary = path in TEMPORARY_MEMBERS;
		if (!temporary && (!path.startsWith(LIBRARY) || isTestPath(path))) {
			problems.push(`unexpected file ${path}`);
		}
		const full = join(root, path);
		if (lstatSync(full).isSymbolicLink()) {
			problems.push(`symlink ${path}`);
		} else if (realpathSync(full) !== join(realpathSync(root), path)) {
			problems.push(`${path} resolves through a symlinked directory`);
		}
	}
	if (problems.length > 0) throw new StageError(problems);

	const members = closure.files;
	const pkg: Record<string, unknown> = {
		name: source.name,
		version: source.version,
		type: "module",
		private: true,
		description:
			"Troupe's agent format, compiler, runner and testing helpers (staged distribution).",
		exports,
		files: members,
		dependencies,
	};
	return { pkg, members };
}

function listFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((name) => !lstatSync(join(dir, name)).isDirectory())
		.sort();
}

function removeEmptyDirs(dir: string): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (!lstatSync(path).isDirectory()) continue;
		removeEmptyDirs(path);
		if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
	}
}

/**
 * Every symlink in an existing destination, the destination itself, members,
 * metadata and directories included, found with lstat before any write.
 */
function symlinksIn(out: string): string[] {
	const found: string[] = [];
	const stat = lstatSync(out, { throwIfNoEntry: false });
	if (!stat) return found;
	if (stat.isSymbolicLink()) return [out];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const entry = lstatSync(path);
			if (entry.isSymbolicLink()) found.push(relative(out, path));
			else if (entry.isDirectory()) walk(path);
		}
	};
	if (stat.isDirectory()) walk(out);
	return found.sort();
}

/** Refuse a destination that is not a previous stage or holds the root. */
function checkDestination(root: string, out: string): void {
	const realRoot = realpathSync(root);
	let probe = out;
	while (!existsSync(probe)) probe = dirname(probe);
	const realOut = join(realpathSync(probe), relative(probe, out));
	if (realOut === realRoot || !relative(realOut, realRoot).startsWith("..")) {
		throw new StageError([`destination ${out} contains the source root`]);
	}
	const links = symlinksIn(out);
	if (links.length > 0) {
		throw new StageError(
			links.map((path) => `destination holds a symlink: ${path}`),
		);
	}
	if (existsSync(out)) {
		const files = listFiles(out);
		if (files.length > 0 && !files.includes(STAGE_MANIFEST)) {
			throw new StageError([
				`destination ${out} is not empty and holds no ${STAGE_MANIFEST}`,
			]);
		}
	}
}

export function stageTroupe(root: string, out: string): StageResult {
	const { pkg, members } = planStage(root);
	checkDestination(root, out);
	mkdirSync(out, { recursive: true });

	const staged: StagedMember[] = [];
	for (const path of members) {
		const bytes = readFileSync(join(root, path));
		const target = join(out, path);
		mkdirSync(dirname(target), { recursive: true });
		const current = existsSync(target) ? readFileSync(target) : undefined;
		if (!current?.equals(bytes)) writeFileSync(target, bytes);
		const temporary = (TEMPORARY_MEMBERS as Record<string, string>)[path];
		staged.push({
			path,
			bytes: bytes.length,
			sha256: sha256(bytes),
			...(temporary ? { temporary } : {}),
		});
	}
	const pkgText = `${JSON.stringify(pkg, null, "\t")}\n`;
	writeFileSync(join(out, "package.json"), pkgText);
	const manifestText = `${JSON.stringify(
		{
			note: "Generated by scripts/stage-troupe.ts; do not edit.",
			bun: Bun.version,
			members: staged,
		},
		null,
		"\t",
	)}\n`;
	writeFileSync(join(out, STAGE_MANIFEST), manifestText);

	const expected = new Set([...members, "package.json", STAGE_MANIFEST]);
	for (const file of listFiles(out)) {
		if (!expected.has(file)) rmSync(join(out, file));
	}
	removeEmptyDirs(out);

	const present = listFiles(out);
	const missing = [...expected].filter((file) => !present.includes(file));
	const extra = present.filter((file) => !expected.has(file));
	if (missing.length > 0 || extra.length > 0) {
		throw new StageError([
			...missing.map((file) => `stage lacks ${file}`),
			...extra.map((file) => `stage holds unexpected ${file}`),
		]);
	}
	const hash = createHash("sha256");
	for (const file of present) {
		const bytes = readFileSync(join(out, file));
		hash.update(`${file}\0${bytes.length}\0`).update(bytes);
	}
	return { out, members: staged, digest: hash.digest("hex") };
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	const args = process.argv.slice(2);
	let out = join(root, "extractions/.troupe-dist/troupe");
	if (args[0] === "--out" && args[1] && args.length === 2) {
		out = resolve(args[1]);
	} else if (args.length > 0) {
		console.error("Usage: bun scripts/stage-troupe.ts [--out <dir>]");
		process.exit(2);
	}
	try {
		const result = stageTroupe(root, out);
		console.log(
			`staged ${result.members.length} members into ${result.out}\nsha256 ${result.digest}`,
		);
		for (const member of result.members) {
			if (member.temporary) {
				console.log(`temporary: ${member.path} (${member.temporary})`);
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
