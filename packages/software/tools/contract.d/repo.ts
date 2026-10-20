// Git queries and worktree reads for the contract tool. Every git call is an
// argument array run in the repository with drivers, pagers, optional locks
// and lazy fetches off, so neither the caller's configuration nor the target's
// can run anything or write anything.
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";

export class ToolError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const GIT_CONFIG = [
	"--no-pager",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.quotepath=off",
	"-c",
	"core.untrackedCache=false",
];

export const GIT_ENV: Record<string, string | undefined> = {
	...process.env,
	GIT_NO_LAZY_FETCH: "1",
	GIT_OPTIONAL_LOCKS: "0",
	GIT_TERMINAL_PROMPT: "0",
	GIT_PAGER: "cat",
};

export function git(
	cwd: string,
	args: string[],
	env = GIT_ENV,
): { ok: boolean; stdout: string; stderr: string } {
	const child = Bun.spawnSync(["git", ...GIT_CONFIG, ...args], {
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		ok: child.exitCode === 0,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

/** The repository root holding `cwd`, or a not-a-repository error. */
export function repositoryRoot(cwd: string): string {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top.ok)
		throw new ToolError("not-a-repository", `not a git repository: ${cwd}`);
	return top.stdout.trim();
}

export const CONTRACTS_DIR = "docs/contracts";
export const PRODUCT = "PRODUCT.md";
export const README = "docs/contracts/README.md";

function unreadable(rel: string, error: unknown): ToolError {
	const code = (error as { code?: string }).code ?? String(error);
	return new ToolError("unreadable", `cannot read ${rel}: ${code}`);
}

/**
 * lstat of a repository-relative path: undefined when it is absent, an
 * unreadable error when it cannot be inspected (a permission on the way).
 */
export function lstat(top: string, rel: string): Stats | undefined {
	try {
		return lstatSync(join(top, rel), { throwIfNoEntry: false });
	} catch (error) {
		if ((error as { code?: string }).code === "ENOTDIR") return undefined;
		throw unreadable(rel, error);
	}
}

/** Paths the index records as gitlinks (mode 160000): submodule roots. */
export function gitlinks(top: string): Set<string> {
	const listed = git(top, ["ls-files", "-z", "-s", "--full-name"]);
	if (!listed.ok)
		throw new ToolError("git", "git could not list the index's entries");
	const out = new Set<string>();
	for (const entry of listed.stdout.split("\0"))
		if (entry.startsWith("160000 "))
			out.add(entry.slice(entry.indexOf("\t") + 1));
	return out;
}

/** Why a directory may not be entered: a gitlink or a nested repository. */
function repositoryBoundary(
	top: string,
	rel: string,
	links: Set<string>,
): string | null {
	if (links.has(rel)) return "a submodule recorded in the index";
	return lstat(top, `${rel}/.git`) ? "a nested repository" : null;
}

/**
 * Why `rel` may not be read: a symlink, a gitlink or a nested repository on
 * the way from the repository root, or null when every component is safe.
 */
export function boundary(
	top: string,
	rel: string,
	links: Set<string>,
): { code: "path-symlink" | "path-invalid"; message: string } | null {
	let walked = "";
	for (const segment of rel.split("/")) {
		walked = walked ? `${walked}/${segment}` : segment;
		if (links.has(walked))
			return {
				code: "path-invalid",
				message: `${walked} is a submodule recorded in the index; ${rel} is not read inside it`,
			};
		const stat = lstat(top, walked);
		if (!stat) return null;
		if (stat.isSymbolicLink())
			return {
				code: "path-symlink",
				message: `${walked} is a symlink; ${rel} is not read through it`,
			};
		const nested = stat.isDirectory() && repositoryBoundary(top, walked, links);
		if (nested)
			return {
				code: "path-invalid",
				message: `${walked} is ${nested}; ${rel} is not read inside it`,
			};
	}
	return null;
}

/**
 * Every Markdown file beneath docs/contracts/, README excluded, sorted. A
 * gitlink or nested repository inside is reported through `refuse` and not
 * entered.
 */
export function contractFiles(
	top: string,
	links: Set<string>,
	refuse: (path: string, message: string) => void,
): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		let names: string[];
		try {
			names = readdirSync(join(top, rel));
		} catch (error) {
			throw unreadable(rel, error);
		}
		for (const name of names) {
			const path = `${rel}/${name}`;
			if (links.has(path)) {
				refuse(
					path,
					`${path} is a submodule recorded in the index and is not read`,
				);
				continue;
			}
			const stat = lstat(top, path);
			if (!stat) continue;
			const nested = stat.isDirectory() && repositoryBoundary(top, path, links);
			if (nested) refuse(path, `${path} is ${nested} and is not read`);
			else if (stat.isDirectory()) walk(path);
			else if (name.endsWith(".md") && path !== README) out.push(path);
		}
	};
	if (isDirectory(top, CONTRACTS_DIR)) walk(CONTRACTS_DIR);
	return out.sort();
}

export function isDirectory(top: string, rel: string): boolean {
	return !!lstat(top, rel)?.isDirectory();
}

export function readText(top: string, rel: string): string | undefined {
	if (!lstat(top, rel)?.isFile()) return undefined;
	try {
		return readFileSync(join(top, rel), "utf8");
	} catch (error) {
		throw unreadable(rel, error);
	}
}
