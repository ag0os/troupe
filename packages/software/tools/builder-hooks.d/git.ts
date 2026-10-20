// Git for the hooks: the contract tool's argument-array runner, plus every
// filter driver named in the effective configuration (system, global, local)
// neutralized by name, since git diff and git status run a clean filter on a
// dirty file. External diff and textconv drivers are off by flag where diff
// runs.
import { git } from "../contract.d/repo";
import { ToolError } from "./manifest";

const cache = new Map<string, string[]>();

function filterNames(repo: string): string[] {
	const listed = git(repo, ["config", "-z", "--get-regexp", "^filter\\."]);
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
