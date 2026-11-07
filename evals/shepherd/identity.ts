/**
 * Evaluation identity (spec 6.2): which harness, rubric and policy judged a
 * Shepherd build. It hashes every file beneath `evals/shepherd/` except
 * results, artifacts, validation output and Python bytecode, and each
 * always gated module the build identity does not select (the eval seam),
 * with section 1's framing under its own domain. Membership follows the
 * source manifest: Git's tracked and nonignored untracked files, read from
 * the working tree.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	compareUtf8,
	framedDigest,
	GATED_MODULES,
	type GitRunner,
	isSourcePath,
	type ManifestEntry,
	runGit,
	ShepherdSourceError,
	type SourceFile,
	type SourceLayout,
} from "./build-source";

export const EVALUATION_DOMAIN = "troupe-shepherd-evals-v1";
export const HARNESS_VERSION = 1;
export const EVALUATION_DIR = "evals/shepherd";

/**
 * Gated modules outside the build identity, such as the package's eval
 * seam: what they change is how the evals build and judge, so the
 * evaluation identity hashes them.
 */
export const EVALUATION_MODULES: readonly string[] = GATED_MODULES.filter(
	(path) => !isSourcePath(path),
);

/** Directories directly beneath `evals/shepherd/` that hold outputs. */
const OUTPUT_DIRS = ["results", "artifacts", "validation"];

export interface EvaluationIdentity {
	harnessVersion: typeof HARNESS_VERSION;
	/** `sha256:<hex>` over the framed entries. */
	hash: string;
	entries: ManifestEntry[];
}

export function isEvaluationPath(path: string): boolean {
	if (!path.startsWith(`${EVALUATION_DIR}/`)) return false;
	const parts = path.slice(EVALUATION_DIR.length + 1).split("/");
	const name = parts.at(-1) ?? "";
	return !(
		OUTPUT_DIRS.includes(parts[0] ?? "") ||
		parts.slice(0, -1).includes("__pycache__") ||
		name.endsWith(".pyc")
	);
}

function gitPaths(git: GitRunner, args: string[], cwd: string): string[] {
	const result = git(args, cwd);
	if (result.code !== 0) {
		throw new ShepherdSourceError([
			`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`,
		]);
	}
	return new TextDecoder("utf-8", { fatal: true })
		.decode(result.stdout)
		.split("\0")
		.filter((path) => path !== "");
}

/**
 * The evaluation identity of the package at `root`: by default the
 * repository's top level; with `layout`, the `prefix` directory of the
 * repository at `gitRoot`, with package-relative paths. A listed file
 * missing from the working tree is a deletion; symlinks at or above a
 * selected file and nonregular entries are errors.
 */
export function evaluationIdentity(
	root: string,
	options: { git?: GitRunner; layout?: SourceLayout } = {},
): EvaluationIdentity {
	const git = options.git ?? runGit;
	const prefix = (options.layout?.prefix ?? "").replace(/^\/+|\/+$/g, "");
	const gitRoot = options.layout?.gitRoot ?? root;
	const top = git(["rev-parse", "--show-toplevel"], gitRoot);
	const topPath = new TextDecoder().decode(top.stdout).trim();
	if (top.code !== 0 || realpathSync(topPath) !== realpathSync(gitRoot)) {
		throw new ShepherdSourceError([`${gitRoot} is not the repository root`]);
	}
	if (
		prefix.split("/").some((part) => part === ".." || part === ".") ||
		realpathSync(prefix === "" ? topPath : join(topPath, prefix)) !==
			realpathSync(root)
	) {
		throw new ShepherdSourceError([
			`${root} is not ${prefix || "the root"} of the repository at ${topPath}`,
		]);
	}
	const strip = (paths: string[]) =>
		prefix === ""
			? paths
			: paths
					.filter((path) => path.startsWith(`${prefix}/`))
					.map((path) => path.slice(prefix.length + 1));
	const selection = [
		"--exclude-standard",
		"-z",
		"--",
		...[EVALUATION_DIR, ...EVALUATION_MODULES].map((path) =>
			prefix === "" ? path : `${prefix}/${path}`,
		),
	];
	const untracked = new Set(
		strip(gitPaths(git, ["ls-files", "--others", ...selection], topPath)),
	);
	const listed = new Set(
		strip(
			gitPaths(
				git,
				["ls-files", "--cached", "--others", ...selection],
				topPath,
			),
		),
	);
	const problems: string[] = listed.has(EVALUATION_DIR)
		? [`${EVALUATION_DIR}: expected a directory of evaluation files`]
		: [];
	const files: SourceFile[] = [];
	for (const path of [...listed].filter(
		(path) => isEvaluationPath(path) || EVALUATION_MODULES.includes(path),
	)) {
		const parts = path.split("/");
		const linked = parts
			.map((_, i) => parts.slice(0, i + 1).join("/"))
			.find((prefix) =>
				lstatSync(join(root, prefix), {
					throwIfNoEntry: false,
				})?.isSymbolicLink(),
			);
		if (linked) {
			problems.push(`${path}: a symlink at ${linked} holds evaluation files`);
			continue;
		}
		const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
		if (!stat) continue;
		if (!stat.isFile()) {
			problems.push(`${path}: evaluation files must be regular files`);
			continue;
		}
		files.push({
			path,
			content: readFileSync(join(root, path)),
			untracked: untracked.has(path),
		});
	}
	if (problems.length > 0) throw new ShepherdSourceError(problems);
	return {
		harnessVersion: HARNESS_VERSION,
		hash: `sha256:${framedDigest(EVALUATION_DOMAIN, files)}`,
		entries: files
			.sort((a, b) => compareUtf8(a.path, b.path))
			.map((file) => ({
				path: file.path,
				bytes: file.content.byteLength,
				sha256: createHash("sha256").update(file.content).digest("hex"),
				untracked: file.untracked ?? false,
			})),
	};
}
