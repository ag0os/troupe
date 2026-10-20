// Git queries and worktree reads for the contract tool. Every git call is an
// argument array run in the repository with drivers, pagers, optional locks
// and lazy fetches off, so neither the caller's configuration nor the target's
// can run anything or write anything.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
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

function unreadable(rel: string, error: unknown): ToolError {
	const code = (error as { code?: string }).code ?? String(error);
	return new ToolError("unreadable", `cannot read ${rel}: ${code}`);
}

/**
 * Why `rel` may not be read: a symlink or a nested repository on the way
 * from the repository root, or null when every component is safe.
 */
export function boundary(
	top: string,
	rel: string,
): { code: "path-symlink" | "path-invalid"; message: string } | null {
	let current = top;
	let walked = "";
	for (const segment of rel.split("/")) {
		current = join(current, segment);
		walked = walked ? `${walked}/${segment}` : segment;
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat) return null;
		if (stat.isSymbolicLink())
			return {
				code: "path-symlink",
				message: `${walked} is a symlink; ${rel} is not read through it`,
			};
		if (stat.isDirectory() && existsSync(join(current, ".git")))
			return {
				code: "path-invalid",
				message: `${walked} is a nested repository; ${rel} is not read inside it`,
			};
	}
	return null;
}

/**
 * Every Markdown file beneath docs/contracts/, README excluded, sorted. A
 * nested repository inside is reported through `refuse` and not entered.
 */
export function contractFiles(
	top: string,
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
			const stat = lstatSync(join(top, path));
			if (stat.isDirectory() && existsSync(join(top, path, ".git")))
				refuse(path, `${path} is a nested repository and is not read`);
			else if (stat.isDirectory()) walk(path);
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
	try {
		return readFileSync(join(top, rel), "utf8");
	} catch (error) {
		throw unreadable(rel, error);
	}
}
