// Git for the hooks: the contract tool's argument-array runner, plus every
// filter driver named in the effective configuration (system, global, local)
// neutralized by name, since git diff and git status run a clean filter on a
// dirty file. External diff and textconv drivers are off by flag where diff
// runs. The calls ignore GIT_* repository variables from the environment.
import { git as contractGit, GIT_ENV } from "../contract.d/repo";
import { ToolError } from "./manifest";

// Kept: the contract runner's fixed settings, and the variables that only
// choose which configuration files form the effective configuration, whose
// filters are neutralized by name like any other.
const KEPT = new Set([
	"GIT_NO_LAZY_FETCH",
	"GIT_OPTIONAL_LOCKS",
	"GIT_TERMINAL_PROMPT",
	"GIT_PAGER",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
]);
const HOOK_ENV = Object.fromEntries(
	Object.entries(GIT_ENV).filter(([k]) => !k.startsWith("GIT_") || KEPT.has(k)),
);

const git = (repo: string, args: string[]) => contractGit(repo, args, HOOK_ENV);

const cache = new Map<string, string[]>();

/** Every filter name configured; a listing that fails is an inability. */
function filterNames(repo: string): string[] {
	const listed = git(repo, ["config", "-z", "--get-regexp", "^filter\\."]);
	// Exit 1 with no output is git's "no such key", an empty listing.
	const none =
		listed.code === 1 && listed.stdout === "" && listed.stderr === "";
	if (!listed.ok && !none)
		throw new ToolError(
			"filter-list",
			`the git configuration cannot be listed (${listed.stderr.trim().split("\n")[0] || `git exited ${listed.code}`})`,
		);
	const names = new Set<string>();
	for (const entry of listed.stdout.split("\0")) {
		const key = entry.split("\n")[0] ?? "";
		const name = key.slice("filter.".length, key.lastIndexOf("."));
		if (key.startsWith("filter.") && name) names.add(name);
	}
	return [...names];
}

/**
 * The -c arguments that switch off every configured filter driver. A name
 * the -c form cannot carry exactly cannot be switched off: that is an
 * inability, never a filter left to run.
 */
export function neutralizers(repo: string): string[] {
	const cached = cache.get(repo);
	if (cached) return cached;
	const names = filterNames(repo);
	const unsafe = names.find((n) => !/^[A-Za-z0-9._-]+$/.test(n));
	if (unsafe !== undefined)
		throw new ToolError(
			"filter-unsafe",
			`the git filter ${JSON.stringify(unsafe)} cannot be neutralized`,
		);
	const prefix = names.flatMap((name) => [
		"-c",
		`filter.${name}.clean=`,
		"-c",
		`filter.${name}.smudge=`,
		"-c",
		`filter.${name}.process=`,
		"-c",
		`filter.${name}.required=false`,
	]);
	cache.set(repo, prefix);
	return prefix;
}

export function hookGit(
	repo: string,
	args: string[],
): { ok: boolean; stdout: string; stderr: string } {
	return git(repo, [...neutralizers(repo), ...args]);
}
