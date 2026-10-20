// Git for the hooks: the contract tool's argument-array runner, plus every
// filter driver named in the effective configuration (system, global, local)
// neutralized by name, since git diff and git status run a clean filter on a
// dirty file. External diff and textconv drivers are off by flag where diff
// runs.
import { git } from "../contract.d/repo";

const neutralizers = new Map<string, string[]>();

function filterNames(repo: string): string[] {
	const listed = git(repo, ["config", "--get-regexp", "^filter\\."]);
	const names = new Set<string>();
	for (const line of listed.stdout.split("\n")) {
		const key = line.split(/\s/)[0] ?? "";
		const name = key.slice("filter.".length, key.lastIndexOf("."));
		if (key.startsWith("filter.") && name) names.add(name);
	}
	return [...names];
}

export function hookGit(
	repo: string,
	args: string[],
): { ok: boolean; stdout: string; stderr: string } {
	let prefix = neutralizers.get(repo);
	if (!prefix) {
		prefix = filterNames(repo).flatMap((name) => [
			"-c",
			`filter.${name}.clean=`,
			"-c",
			`filter.${name}.smudge=`,
			"-c",
			`filter.${name}.process=`,
			"-c",
			`filter.${name}.required=false`,
		]);
		neutralizers.set(repo, prefix);
	}
	return git(repo, [...prefix, ...args]);
}
