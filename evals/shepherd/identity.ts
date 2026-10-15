/**
 * Evaluation identity (spec 6.2): which harness, rubric and policy judged a
 * Shepherd build. It hashes every file beneath `evals/shepherd/` except
 * results, artifacts, validation output and Python bytecode, with section
 * 1's framing under its own domain. Membership follows the source manifest:
 * Git's tracked and nonignored untracked files, read from the working tree.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	compareUtf8,
	framedDigest,
	type GitRunner,
	type ManifestEntry,
	runGit,
	ShepherdSourceError,
	type SourceFile,
} from "../../scripts/shepherd-source";

export const EVALUATION_DOMAIN = "troupe-shepherd-evals-v1";
export const HARNESS_VERSION = 1;
export const EVALUATION_DIR = "evals/shepherd";

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
 * The evaluation identity of the repository at `root`, its top level. A
 * listed file missing from the working tree is a deletion; symlinks at or
 * above a selected file and nonregular entries are errors.
 */
export function evaluationIdentity(
	root: string,
	options: { git?: GitRunner } = {},
): EvaluationIdentity {
	const git = options.git ?? runGit;
	const top = git(["rev-parse", "--show-toplevel"], root);
	const topPath = new TextDecoder().decode(top.stdout).trim();
	if (top.code !== 0 || realpathSync(topPath) !== realpathSync(root)) {
		throw new ShepherdSourceError([`${root} is not the repository root`]);
	}
	const selection = ["--exclude-standard", "-z", "--", EVALUATION_DIR];
	const untracked = new Set(
		gitPaths(git, ["ls-files", "--others", ...selection], root),
	);
	const listed = new Set(
		gitPaths(git, ["ls-files", "--cached", "--others", ...selection], root),
	);
	const problems: string[] = listed.has(EVALUATION_DIR)
		? [`${EVALUATION_DIR}: expected a directory of evaluation files`]
		: [];
	const files: SourceFile[] = [];
	for (const path of [...listed].filter(isEvaluationPath)) {
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
