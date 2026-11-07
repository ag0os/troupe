/**
 * Where the evaluated package, its repository and a run's subject live. Run,
 * verifier, recovery, trend and export read every location from one
 * `EvalLayout`; nothing guesses the repository from the evals directory or a
 * subject's `bin/`. `defaultLayout` is the only place a default is chosen:
 * the package holding this directory, in whatever repository holds it.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type GitRunner, runGit, type SourceLayout } from "./build-source";
import { EVALUATION_DIR } from "./identity";

export interface EvalLayout {
	/** The package directory: `agents/`, `packages/` and `evals/shepherd/` sit in it. */
	packageRoot: string;
	/** The top level of the Git repository that holds the package. */
	gitRoot: string;
	/** `packageRoot` relative to `gitRoot`, with `/` separators; `""` when they are one directory. */
	prefix: string;
	/** `<packageRoot>/evals/shepherd`: policy, rubric, results, artifacts and validation output. */
	evalsDir: string;
	/**
	 * A run's subject installation, relative to its run directory: the
	 * binary at `<subject>/bin/shepherd` with the runtime package snapshot
	 * at `<subject>/packages/`, where the binary reads it. `""` is the run
	 * directory itself.
	 */
	subject: string;
}

/** A layout that cannot be used: no Git root, a package outside it, a bad subject path. */
export class EvalLayoutError extends Error {
	override name = "EvalLayoutError";
}

/** The package that holds this module: the directory `evals/shepherd/` sits in. */
const DEFAULT_PACKAGE_ROOT = resolve(
	import.meta.dir,
	...EVALUATION_DIR.split("/").map(() => ".."),
);

const noGit = (dir: string, detail: string) =>
	new EvalLayoutError(
		`Shepherd eval checks require a Git root: ${dir} ${detail}. Initialize a repository holding the package and commit it first.`,
	);

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** The top level of the repository holding `dir`, from Git. */
function gitTop(dir: string, git: GitRunner): string {
	let result: ReturnType<GitRunner>;
	try {
		result = git(["rev-parse", "--show-toplevel"], dir);
	} catch (error) {
		throw noGit(dir, `cannot run Git (${(error as Error).message})`);
	}
	const top = new TextDecoder().decode(result.stdout).trim();
	if (result.code !== 0 || top === "")
		throw noGit(dir, "is not inside a Git repository");
	return top;
}

function subjectPath(subject: string): string {
	const parts = subject
		.split("/")
		.filter((part) => part !== "" && part !== ".");
	if (isAbsolute(subject) || parts.includes("..")) {
		throw new EvalLayoutError(
			`The subject directory must be relative to the run directory, without "..": ${subject}`,
		);
	}
	return parts.join("/");
}

/**
 * A layout from explicit locations. Without `gitRoot`, Git names the
 * repository that holds `packageRoot`, and a package outside Git is refused.
 */
export function evalLayout(options: {
	packageRoot: string;
	gitRoot?: string;
	subject?: string;
	git?: GitRunner;
}): EvalLayout {
	const packageRoot = resolve(options.packageRoot);
	const gitRoot =
		options.gitRoot === undefined
			? gitTop(packageRoot, options.git ?? runGit)
			: resolve(options.gitRoot);
	const prefix = relative(real(gitRoot), real(packageRoot))
		.split(sep)
		.join("/");
	if (prefix === ".." || prefix.startsWith("../") || isAbsolute(prefix)) {
		throw new EvalLayoutError(
			`The package ${packageRoot} is not inside the repository ${gitRoot}`,
		);
	}
	return {
		packageRoot,
		gitRoot,
		prefix,
		evalsDir: join(packageRoot, EVALUATION_DIR),
		subject: subjectPath(options.subject ?? ""),
	};
}

/**
 * The layout entry points use: the package holding this directory, unless
 * a flag names another, in the repository Git finds for it.
 */
export function defaultLayout(
	options: {
		packageRoot?: string;
		gitRoot?: string;
		subject?: string;
		git?: GitRunner;
	} = {},
): EvalLayout {
	return evalLayout({
		...options,
		packageRoot: options.packageRoot ?? DEFAULT_PACKAGE_ROOT,
	});
}

/** A layout as given, or a bare root: a repository top that is the package. */
export function toLayout(at: string | EvalLayout): EvalLayout {
	return typeof at === "string"
		? evalLayout({ packageRoot: at, gitRoot: at })
		: at;
}

/** Refuse a layout whose `gitRoot` is not the top of a Git repository. */
export function requireGitRoot(
	layout: EvalLayout,
	git: GitRunner = runGit,
): void {
	const top = gitTop(layout.gitRoot, git);
	if (real(top) !== real(layout.gitRoot))
		throw noGit(layout.gitRoot, `is not the top of its repository (${top})`);
}

/** The Git root and prefix the source and evaluation readers take. */
export function sourceLayout(layout: EvalLayout): SourceLayout {
	return { gitRoot: layout.gitRoot, prefix: layout.prefix };
}

/** A repository-relative path as a package path; undefined outside the package. */
export function packagePath(
	layout: EvalLayout,
	path: string,
): string | undefined {
	if (layout.prefix === "") return path;
	return path.startsWith(`${layout.prefix}/`)
		? path.slice(layout.prefix.length + 1)
		: undefined;
}

/** A package path as Git names it from the repository's top level. */
export function repositoryPath(layout: EvalLayout, path: string): string {
	return layout.prefix === "" ? path : `${layout.prefix}/${path}`;
}

/** The roots export and recovery redact: both, when they differ. */
export function redactedRoots(layout: EvalLayout): {
	repoRoot: string;
	packageRoot: string;
} {
	return { repoRoot: layout.gitRoot, packageRoot: layout.packageRoot };
}
