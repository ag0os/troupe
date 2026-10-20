// Git queries and worktree reads for the contract tool. Every git call is an
// argument array run in the repository with drivers, pagers, optional locks
// and lazy fetches off, so neither the caller's configuration nor the target's
// can run anything or write anything.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
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

const GIT_ENV = {
	...process.env,
	GIT_NO_LAZY_FETCH: "1",
	GIT_OPTIONAL_LOCKS: "0",
	GIT_TERMINAL_PROMPT: "0",
	GIT_PAGER: "cat",
};

export function git(
	cwd: string,
	args: string[],
): { ok: boolean; stdout: string; stderr: string } {
	const child = Bun.spawnSync(["git", ...GIT_CONFIG, ...args], {
		cwd,
		env: GIT_ENV,
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

/** Every Markdown file beneath docs/contracts/, README excluded, sorted. */
export function contractFiles(top: string): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		let names: string[];
		try {
			names = readdirSync(join(top, rel));
		} catch {
			return;
		}
		for (const name of names) {
			const path = `${rel}/${name}`;
			const stat = lstatSync(join(top, path));
			if (stat.isDirectory()) walk(path);
			else if (name.endsWith(".md") && path !== README) out.push(path);
		}
	};
	if (isDirectory(top, CONTRACTS_DIR)) walk(CONTRACTS_DIR);
	return out.sort();
}

export function isDirectory(top: string, rel: string): boolean {
	return !!lstatSync(join(top, rel), { throwIfNoEntry: false })?.isDirectory();
}

export function readText(top: string, rel: string): string | undefined {
	const stat = lstatSync(join(top, rel), { throwIfNoEntry: false });
	if (!stat?.isFile()) return undefined;
	return readFileSync(join(top, rel), "utf8");
}
