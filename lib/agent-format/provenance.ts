/**
 * Generic source identity (`troupe/provenance`): framed SHA-256 manifests
 * under an explicit domain, and explicit, table-driven input reading for
 * builds whose sources come from more than one origin. Nothing here knows a
 * consumer's layout; a policy names its origins, files and trees.
 *
 * Membership is what a `SourceInputDefinition` names, read from the
 * filesystem. Git ignore rules play no part, so a host's global excludes
 * cannot change it. Symlinks and nonregular entries are refused.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ManifestEntry {
	path: string;
	bytes: number;
	sha256: string;
	untracked: boolean;
	/** Present only in manifests that frame executable status. */
	executable?: boolean;
}

export interface SourceManifest {
	/** `sha256:<hex>` over the framed entries. */
	source: string;
	/** Sorted by unsigned UTF-8 path bytes. */
	entries: ManifestEntry[];
}

export interface SourceFile {
	path: string;
	content: Uint8Array;
	untracked?: boolean;
	/** Executable status, framed only when the manifest frames modes. */
	executable?: boolean;
}

export type GitRunner = (
	args: readonly string[],
	cwd: string,
	input?: Uint8Array,
) => { code: number; stdout: Uint8Array; stderr: string };

/** Problems that leave a source identity undefined. */
export class SourceInputError extends Error {
	constructor(readonly problems: string[]) {
		super(problems.join("\n"));
		this.name = "SourceInputError";
	}
}

/**
 * A Git runner that drops inherited `GIT_*` routing variables, so the
 * repository is always the one at `cwd`, then applies `env`.
 */
export function createGitRunner(env: Record<string, string> = {}): GitRunner {
	return (args, cwd, input) => {
		const clean: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && !key.startsWith("GIT_")) clean[key] = value;
		}
		const child = spawnSync("git", ["--no-optional-locks", ...args], {
			cwd,
			env: { ...clean, ...env },
			input,
			maxBuffer: 1 << 30,
		});
		return {
			code: child.error ? 127 : (child.status ?? 1),
			stdout: child.stdout ?? new Uint8Array(),
			stderr: child.error?.message ?? child.stderr?.toString() ?? "",
		};
	};
}

const encoder = new TextEncoder();

/** Order by unsigned UTF-8 bytes. */
export function compareUtf8(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function uint64(value: number): Buffer {
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64BE(BigInt(value));
	return buffer;
}

export interface FramingOptions {
	/**
	 * Frame each file's executable status as one byte (1 or 0) after its
	 * path. Off by default, which is the v1 framing.
	 */
	modes?: boolean;
}

/**
 * SHA-256, as lowercase hex, of `UTF8(domain + "\0")` followed by each file
 * in UTF-8 path order as a big-endian uint64 path length, the path bytes,
 * (with `modes`, one executable-status byte,) a big-endian uint64 content
 * length and the raw content.
 */
export function framedDigest(
	domain: string,
	files: readonly SourceFile[],
	options: FramingOptions = {},
): string {
	const sorted = [...files].sort((a, b) => compareUtf8(a.path, b.path));
	const hash = createHash("sha256").update(encoder.encode(`${domain}\0`));
	sorted.forEach((file, i) => {
		if (i > 0 && sorted[i - 1]?.path === file.path) {
			throw new Error(`duplicate source path ${file.path}`);
		}
		const path = encoder.encode(file.path);
		hash.update(uint64(path.byteLength));
		hash.update(path);
		if (options.modes) hash.update(Uint8Array.of(file.executable ? 1 : 0));
		hash.update(uint64(file.content.byteLength));
		hash.update(file.content);
	});
	return hash.digest("hex");
}

/**
 * The manifest of `files` under `domain`. The domain is explicit: each
 * identity family names its own, and historical identities keep theirs.
 */
export function buildManifest(
	domain: string,
	files: readonly SourceFile[],
	options: FramingOptions = {},
): SourceManifest {
	return {
		source: `sha256:${framedDigest(domain, files, options)}`,
		entries: [...files]
			.sort((a, b) => compareUtf8(a.path, b.path))
			.map((file) => ({
				path: file.path,
				bytes: file.content.byteLength,
				sha256: createHash("sha256").update(file.content).digest("hex"),
				untracked: file.untracked ?? false,
				...(options.modes ? { executable: file.executable ?? false } : {}),
			})),
	};
}

/**
 * Same source identity: the same paths with the same content hashes and,
 * where recorded, the same executable status. The `untracked` mark is
 * reported, never compared.
 */
export function sameSource(a: SourceManifest, b: SourceManifest): boolean {
	if (a.entries.length !== b.entries.length) return false;
	const byPath = new Map(a.entries.map((entry) => [entry.path, entry]));
	return b.entries.every((entry) => {
		const other = byPath.get(entry.path);
		return (
			other?.sha256 === entry.sha256 && other.executable === entry.executable
		);
	});
}

/** A directory selected recursively, relative to the origin root. */
export interface SourceTree {
	dir: string;
	/** Paths (relative to the origin root) left out of this tree. */
	exclude?: (path: string) => boolean;
}

/**
 * One origin's explicit membership. Paths are relative to `root` and use
 * `/`. Every listed file must exist; trees may be absent.
 */
export interface SourceInputDefinition {
	/** Logical namespace, such as `framework/troupe` or `package/shepherd`. */
	origin: string;
	/** The origin's directory on disk. */
	root: string;
	files?: readonly string[];
	trees?: readonly SourceTree[];
	/** Paths left out of every tree, such as outputs and evidence. */
	exclude?: (path: string) => boolean;
	/** Paths whose executable status is part of the identity. */
	executables?: (path: string) => boolean;
	/** Revision metadata, when known. Never guessed. */
	revision?: { gitRoot: string; prefix?: string; git?: GitRunner };
	/** Dependency identity as the consumer's lockfile records it. */
	dependency?: { requested?: string; resolved?: string };
}

/** Serializable description of one origin, for stamps and evidence. */
export interface InputProvenance {
	origin: string;
	/** Full commit, or `"unknown"` when no revision metadata was given or found. */
	revision: string;
	/** Package prefix inside its repository, or `"unknown"`. */
	prefix: string;
	/** `sha256:<hex>` over this origin's files alone. */
	digest: string;
	dependency?: { requested?: string; resolved?: string };
}

export interface SourceInput {
	origin: string;
	/** Paths relative to the origin root. */
	files: SourceFile[];
	provenance: InputProvenance;
}

/** Domain of one origin's own digest inside `InputProvenance`. */
export const ORIGIN_DOMAIN = "troupe-agent-origin-v2";

function revisionOf(
	revision: SourceInputDefinition["revision"],
): Pick<InputProvenance, "revision" | "prefix"> {
	if (!revision) return { revision: "unknown", prefix: "unknown" };
	const git = revision.git ?? createGitRunner();
	const result = git(
		["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
		revision.gitRoot,
	);
	const sha = new TextDecoder().decode(result.stdout).trim();
	return {
		revision:
			result.code === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)
				? sha
				: "unknown",
		prefix: revision.prefix ?? "",
	};
}

/**
 * Read one origin's explicit membership from disk. Symlinks at or below a
 * selected path, nonregular entries, missing listed files and unreadable
 * files are errors.
 */
export function readSourceInputs(
	definition: SourceInputDefinition,
): SourceInput {
	const problems: string[] = [];
	const files = new Map<string, SourceFile>();
	const executable = definition.executables ?? (() => false);
	const add = (path: string) => {
		const full = join(definition.root, path);
		const stat = lstatSync(full, { throwIfNoEntry: false });
		if (!stat) return problems.push(`${path}: required input is missing`);
		if (stat.isSymbolicLink()) {
			return problems.push(`${path}: an input must not be a symlink`);
		}
		if (!stat.isFile()) {
			return problems.push(`${path}: an input must be a regular file`);
		}
		try {
			files.set(path, {
				path,
				content: readFileSync(full),
				executable: executable(path) && (stat.mode & 0o111) !== 0,
			});
		} catch (error) {
			problems.push(`${path}: unreadable: ${(error as Error).message}`);
		}
	};
	const linkAbove = (path: string): string | undefined => {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			const stat = lstatSync(join(definition.root, prefix), {
				throwIfNoEntry: false,
			});
			if (stat?.isSymbolicLink()) return prefix;
		}
		return undefined;
	};
	for (const path of definition.files ?? []) {
		const linked = linkAbove(path);
		if (linked) problems.push(`${path}: a symlink at ${linked} holds an input`);
		else add(path);
	}
	const walk = (dir: string, tree: SourceTree) => {
		for (const entry of readdirSync(join(definition.root, dir), {
			withFileTypes: true,
		}).sort((a, b) => compareUtf8(a.name, b.name))) {
			const path = `${dir}/${entry.name}`;
			if (definition.exclude?.(path) || tree.exclude?.(path)) continue;
			if (entry.isDirectory()) walk(path, tree);
			else add(path);
		}
	};
	for (const tree of definition.trees ?? []) {
		const linked = linkAbove(`${tree.dir}/x`);
		if (linked) {
			problems.push(`${tree.dir}: a symlink at ${linked} holds inputs`);
			continue;
		}
		const stat = lstatSync(join(definition.root, tree.dir), {
			throwIfNoEntry: false,
		});
		if (!stat) continue;
		if (!stat.isDirectory()) {
			problems.push(`${tree.dir}: expected a directory of inputs`);
			continue;
		}
		walk(tree.dir, tree);
	}
	if (problems.length > 0) throw new SourceInputError(problems);
	const selected = [...files.values()];
	return {
		origin: definition.origin,
		files: selected,
		provenance: {
			origin: definition.origin,
			...revisionOf(definition.revision),
			digest: `sha256:${framedDigest(ORIGIN_DOMAIN, selected, { modes: true })}`,
			...(definition.dependency ? { dependency: definition.dependency } : {}),
		},
	};
}

/**
 * One manifest over several origins under `domain`, each file named
 * `<origin>/<path>` so equal relative paths in two origins never collide.
 * Executable status is framed.
 */
export interface CombinedSourceInputs {
	manifest: SourceManifest;
	origins: InputProvenance[];
}

export function combineSourceInputs(
	domain: string,
	inputs: readonly SourceInput[],
): CombinedSourceInputs {
	const names = inputs.map((input) => input.origin);
	for (const name of names) {
		if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(name)) {
			throw new SourceInputError([`${name}: not a valid origin name`]);
		}
		const nested = names.some(
			(other) => other !== name && other.startsWith(`${name}/`),
		);
		if (nested || names.indexOf(name) !== names.lastIndexOf(name)) {
			throw new SourceInputError([
				`${name}: origin names must be distinct and not nested`,
			]);
		}
	}
	const files = inputs.flatMap((input) =>
		input.files.map((file) => ({
			...file,
			path: `${input.origin}/${file.path}`,
		})),
	);
	return {
		manifest: buildManifest(domain, files, { modes: true }),
		origins: inputs.map((input) => input.provenance),
	};
}
