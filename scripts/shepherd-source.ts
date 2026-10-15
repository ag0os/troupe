/**
 * Shepherd source identity: which repository files a Shepherd build is made
 * from, their manifest, the framed SHA-256 over them, and the Git revision
 * and dirty flags a build is stamped with. Shared by the compiler, the eval
 * wrapper and CI, so every reader computes the same identity.
 *
 * Membership comes from `git ls-files --cached --others --exclude-standard`:
 * tracked files stay selected even when an ignore pattern matches them, and
 * ignored untracked files (`.DS_Store`) never count. Contents are the
 * working-tree bytes, unnormalized.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** The binary name whose builds are stamped. */
export const SHEPHERD_ID = "shepherd";

/** Domain prefix of the framed source hash. */
export const SOURCE_DOMAIN = "troupe-shepherd-source-v1";

/** Files every Shepherd build reads; each must exist. */
export const SOURCE_FILES = [
	"agents/shepherd.md",
	"agents/shepherd.ts",
	"scripts/compile.ts",
	"scripts/compile-all.ts",
	"scripts/agent-compiler.ts",
	"scripts/binary-name.ts",
	"scripts/shepherd-source.ts",
	"package.json",
	"bun.lock",
	"tsconfig.json",
] as const;

/**
 * Directories whose files are selected recursively. Where `tests` is false,
 * `*.test.ts`, `*.spec.ts` and paths beneath `__fixtures__` or
 * `__snapshots__` are left out.
 */
export const SOURCE_TREES = [
	{ dir: "system-prompts/shepherd", tests: true },
	{ dir: "lib/shepherd", tests: false },
	{ dir: "lib/agent-format", tests: false },
] as const;

export interface ManifestEntry {
	path: string;
	bytes: number;
	sha256: string;
	untracked: boolean;
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
}

export interface BuildProvenance {
	/** Full build-time `HEAD`. */
	revision: string;
	/** Staged, unstaged or nonignored untracked changes anywhere. */
	dirty: boolean;
	/** The selected source paths or bytes differ from `HEAD`. */
	sourceDirty: boolean;
	manifest: SourceManifest;
}

/**
 * How the compiler stamps Shepherd: provenance captured before any
 * temporary build file exists, and the manifest again before publication.
 */
export interface StampSource {
	capture(root: string): BuildProvenance | Promise<BuildProvenance>;
	recheck(root: string): SourceManifest | Promise<SourceManifest>;
}

/** Problems that leave a Shepherd source identity undefined. */
export class ShepherdSourceError extends Error {
	constructor(readonly problems: string[]) {
		super(problems.join("\n"));
		this.name = "ShepherdSourceError";
	}
}

export type GitRunner = (
	args: readonly string[],
	cwd: string,
	input?: Uint8Array,
) => { code: number; stdout: Uint8Array; stderr: string };

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

export const runGit = createGitRunner();

export function gitStamp(git: GitRunner = runGit): StampSource {
	return {
		capture: (root) => captureProvenance(root, { git }),
		recheck: (root) => readWorktreeSource(root, { git }),
	};
}

/** The one line `shepherd --version` prints, without its newline. */
export function versionLine(provenance: BuildProvenance): string {
	return `shepherd revision=${provenance.revision} dirty=${provenance.dirty} source=${provenance.manifest.source}`;
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

/**
 * SHA-256, as lowercase hex, of `UTF8(domain + "\0")` followed by each file
 * in UTF-8 path order as a big-endian uint64 path length, the path bytes, a
 * big-endian uint64 content length and the raw content.
 */
export function framedDigest(
	domain: string,
	files: readonly { path: string; content: Uint8Array }[],
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
		hash.update(uint64(file.content.byteLength));
		hash.update(file.content);
	});
	return hash.digest("hex");
}

export function buildManifest(files: readonly SourceFile[]): SourceManifest {
	return {
		source: `sha256:${framedDigest(SOURCE_DOMAIN, files)}`,
		entries: [...files]
			.sort((a, b) => compareUtf8(a.path, b.path))
			.map((file) => ({
				path: file.path,
				bytes: file.content.byteLength,
				sha256: createHash("sha256").update(file.content).digest("hex"),
				untracked: file.untracked ?? false,
			})),
	};
}

/**
 * Same source identity: the same paths with the same content hashes. The
 * `untracked` mark is reported, never compared.
 */
export function sameSource(a: SourceManifest, b: SourceManifest): boolean {
	if (a.entries.length !== b.entries.length) return false;
	const hashes = new Map(a.entries.map((entry) => [entry.path, entry.sha256]));
	return b.entries.every((entry) => hashes.get(entry.path) === entry.sha256);
}

/** Whether a repository-relative path is part of the Shepherd source. */
export function isSourcePath(path: string): boolean {
	if ((SOURCE_FILES as readonly string[]).includes(path)) return true;
	for (const tree of SOURCE_TREES) {
		if (!path.startsWith(`${tree.dir}/`)) continue;
		if (tree.tests) return true;
		const parts = path.slice(tree.dir.length + 1).split("/");
		const name = parts.pop() ?? "";
		return !(
			name.endsWith(".test.ts") ||
			name.endsWith(".spec.ts") ||
			parts.includes("__fixtures__") ||
			parts.includes("__snapshots__")
		);
	}
	return false;
}

/** Directories that hold a selection: tree roots and file parents. */
function selectionDirs(): string[] {
	const dirs = new Set<string>();
	const add = (path: string) => {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			dirs.add(parts.slice(0, i).join("/"));
		}
	};
	for (const file of SOURCE_FILES) add(file);
	for (const tree of SOURCE_TREES) {
		add(tree.dir);
		dirs.add(tree.dir);
	}
	return [...dirs];
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function splitNul(bytes: Uint8Array): string[] {
	return decoder
		.decode(bytes)
		.split("\0")
		.filter((path) => path !== "");
}

function gitOk(
	git: GitRunner,
	args: readonly string[],
	cwd: string,
	input?: Uint8Array,
): Uint8Array {
	const result = git(args, cwd, input);
	if (result.code !== 0) {
		throw new ShepherdSourceError([
			`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`,
		]);
	}
	return result.stdout;
}

/** The repository root, which must be `root` itself. */
function repositoryRoot(root: string, git: GitRunner): string {
	const result = git(["rev-parse", "--show-toplevel"], root);
	if (result.code !== 0) {
		throw new ShepherdSourceError([
			`${root} is not in a Git repository: ${result.stderr.trim()}`,
		]);
	}
	const top = new TextDecoder().decode(result.stdout).trim();
	if (realpathSync(top) !== realpathSync(root)) {
		throw new ShepherdSourceError([
			`${root} is not the repository root (${top})`,
		]);
	}
	return top;
}

function lstatOrUndefined(path: string) {
	return lstatSync(path, { throwIfNoEntry: false });
}

/**
 * The current content manifest of the working tree at `root`, the
 * repository root. An index entry missing from the working tree is a
 * deletion in a recursive selection and an error for a required file.
 * Symlinks at or above a selected path, within the repository, nonregular
 * entries and unreadable files are errors.
 */
export function readWorktreeSource(
	root: string,
	options: { git?: GitRunner } = {},
): SourceManifest {
	const git = options.git ?? runGit;
	const top = repositoryRoot(root, git);
	const listed = [
		...new Set(
			splitNul(
				gitOk(
					git,
					["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
					top,
				),
			),
		),
	];
	const untracked = new Set(
		splitNul(
			gitOk(git, ["ls-files", "--others", "--exclude-standard", "-z"], top),
		),
	);
	const problems = new Set<string>();
	const present = new Set(listed);
	for (const file of SOURCE_FILES) {
		if (!present.has(file)) {
			problems.add(`${file}: required Shepherd source file is missing`);
		}
	}

	const checkedDirs = new Map<string, boolean>();
	const linkedDir = (dir: string): boolean => {
		const known = checkedDirs.get(dir);
		if (known !== undefined) return known;
		const stat = lstatOrUndefined(join(top, dir));
		const linked = stat?.isSymbolicLink() ?? false;
		if (linked) problems.add(`${dir}: a symlink holds Shepherd source`);
		checkedDirs.set(dir, linked);
		return linked;
	};
	for (const dir of selectionDirs()) {
		if (linkedDir(dir)) continue;
		const stat = lstatOrUndefined(join(top, dir));
		if (stat && !stat.isDirectory()) {
			problems.add(`${dir}: expected a directory of Shepherd source`);
		}
	}

	const files: SourceFile[] = [];
	for (const path of listed.filter(isSourcePath)) {
		const parts = path.split("/");
		let underLink = false;
		for (let i = 1; i < parts.length; i++) {
			if (linkedDir(parts.slice(0, i).join("/"))) underLink = true;
		}
		if (underLink) continue;
		const full = join(top, path);
		const stat = lstatOrUndefined(full);
		if (!stat) {
			if ((SOURCE_FILES as readonly string[]).includes(path)) {
				problems.add(`${path}: required Shepherd source file is missing`);
			}
			continue;
		}
		if (stat.isSymbolicLink()) {
			problems.add(`${path}: Shepherd source must not be a symlink`);
			continue;
		}
		if (!stat.isFile()) {
			problems.add(`${path}: Shepherd source must be a regular file`);
			continue;
		}
		try {
			files.push({
				path,
				content: readFileSync(full),
				untracked: untracked.has(path),
			});
		} catch (error) {
			problems.add(`${path}: unreadable: ${(error as Error).message}`);
		}
	}
	if (problems.size > 0) throw new ShepherdSourceError([...problems]);
	return buildManifest(files);
}

const REGULAR_MODES = new Set(["100644", "100755"]);

/**
 * The content manifest of `revision`. With `strict` (the default), the
 * rules of `readWorktreeSource` apply; without it, missing required files
 * and nonregular entries are left out instead, for comparison with `HEAD`.
 */
export function readCommitSource(
	root: string,
	revision: string,
	options: { git?: GitRunner; strict?: boolean } = {},
): SourceManifest {
	const git = options.git ?? runGit;
	const strict = options.strict ?? true;
	const top = repositoryRoot(root, git);
	const holders = new Set(selectionDirs());
	const problems: string[] = [];
	const blobs: { path: string; oid: string }[] = [];
	for (const record of splitNul(
		gitOk(git, ["ls-tree", "-r", "-z", "--full-tree", revision], top),
	)) {
		const tab = record.indexOf("\t");
		const [mode = "", , oid = ""] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (!isSourcePath(path) && !holders.has(path)) continue;
		if (mode === "120000") {
			problems.push(`${path}: Shepherd source must not be a symlink`);
		} else if (holders.has(path)) {
			problems.push(`${path}: expected a directory of Shepherd source`);
		} else if (!REGULAR_MODES.has(mode)) {
			problems.push(`${path}: Shepherd source must be a regular file`);
		} else {
			blobs.push({ path, oid });
		}
	}
	const present = new Set(blobs.map((blob) => blob.path));
	for (const file of SOURCE_FILES) {
		if (!present.has(file)) {
			problems.push(`${file}: required Shepherd source file is missing`);
		}
	}
	if (strict && problems.length > 0) throw new ShepherdSourceError(problems);

	const output = gitOk(
		git,
		["cat-file", "--batch"],
		top,
		encoder.encode(blobs.map((blob) => `${blob.oid}\n`).join("")),
	);
	const files: SourceFile[] = [];
	let offset = 0;
	for (const blob of blobs) {
		const newline = output.indexOf(10, offset);
		const header = new TextDecoder().decode(output.subarray(offset, newline));
		const size = Number(header.split(" ")[2]);
		if (!header.startsWith(`${blob.oid} blob `) || !Number.isFinite(size)) {
			throw new ShepherdSourceError([
				`${blob.path}: unexpected object header "${header}"`,
			]);
		}
		files.push({
			path: blob.path,
			content: output.slice(newline + 1, newline + 1 + size),
		});
		offset = newline + 1 + size + 1;
	}
	return buildManifest(files);
}

/** Full `HEAD`; a repository without one cannot stamp a build. */
function headRevision(top: string, git: GitRunner): string {
	const result = git(
		["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
		top,
	);
	const revision = new TextDecoder().decode(result.stdout).trim();
	if (result.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(revision)) {
		throw new ShepherdSourceError([
			`${top} has no Git revision: HEAD does not name a commit`,
		]);
	}
	return revision;
}

/**
 * Revision, dirty flags and current manifest of the repository at `root`.
 * Call it before any temporary build file exists.
 */
export function captureProvenance(
	root: string,
	options: { git?: GitRunner } = {},
): BuildProvenance {
	const git = options.git ?? runGit;
	const top = repositoryRoot(root, git);
	const revision = headRevision(top, git);
	const status = gitOk(
		git,
		["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
		top,
	);
	const manifest = readWorktreeSource(top, { git });
	const head = readCommitSource(top, revision, { git, strict: false });
	return {
		revision,
		dirty: status.byteLength > 0,
		sourceDirty: !sameSource(manifest, head),
		manifest,
	};
}
