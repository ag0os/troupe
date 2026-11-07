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
 * ones. Bun links each staged file into the consumer at install time, so
 * changed bytes in an existing member need no reinstall, but an added member
 * appears in the consumer only after it reinstalls.
 *
 * Do not restage while a consumer build runs. A stamp policy that hashes the
 * installed distribution compares identity once, after every binary is built
 * and before the first rename: a change still present then refuses
 * publication, but one reverted earlier or made later goes undetected.
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
import { dirname, join, relative, resolve } from "node:path";
import { relativeClosure } from "./import-closure";
import { isWithin } from "./path-within";

/** The default stage, relative to the repository root. */
export const DEFAULT_STAGE = "extractions/.troupe-dist/troupe";

/** The marker and inventory written into every stage. */
export const STAGE_MANIFEST = "troupe-stage.json";

/**
 * Any member path naming Shepherd is refused, even inside an allowed
 * directory: the distribution holds no Shepherd policy or asset.
 */
const SHEPHERD_PATH = /shepherd/i;

/** The library members the distribution may hold: directories and files. */
const ALLOWED_DIRS = ["lib/agent-format/", "lib/entries/"] as const;
const ALLOWED_FILES = ["lib/index.ts", "lib/text-imports.d.ts"] as const;

function isAllowed(path: string): boolean {
	return (
		(ALLOWED_FILES as readonly string[]).includes(path) ||
		ALLOWED_DIRS.some((dir) => path.startsWith(dir))
	);
}
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
		path.endsWith(".spec.ts") ||
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
		if (!isWithin(root, join(root, path))) {
			problems.push(`closure leaves the root: ${path}`);
			continue;
		}
		if (!isAllowed(path) || isTestPath(path)) {
			problems.push(`unexpected file ${path}`);
		} else if (SHEPHERD_PATH.test(path)) {
			problems.push(`Shepherd member ${path}`);
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
	if (isWithin(realOut, realRoot)) {
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
		staged.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
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
	let out = join(root, DEFAULT_STAGE);
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
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
