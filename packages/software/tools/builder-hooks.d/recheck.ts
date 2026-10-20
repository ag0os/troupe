// recheck: the Stop gate's evaluator after a session ends, whatever ended
// it, with no counter and no exemption, every phase run, exhale added, and a
// check that no checker changed tracked content, the index or refs.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../contract.d/repo";
import { type Evaluation, evaluate } from "./evaluate";
import { logLine } from "./log";
import type { Manifest } from "./manifest";

export type Finding = {
	code: string;
	severity: "error" | "warning";
	file: string;
	message: string;
};

/** Status, index, refs and the bytes of every dirty or untracked file. */
export function snapshot(repo: string): string {
	const status = git(repo, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
	]);
	const index = git(repo, ["ls-files", "-s", "-z"]);
	const refs = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
	const head = git(repo, ["rev-parse", "--symbolic-full-name", "HEAD", "HEAD"]);
	if (!status.ok || !index.ok || !refs.ok)
		throw new Error("git cannot report the worktree's state");
	const hashes = status.stdout
		.split("\0")
		.filter((e) => e.length > 3)
		.map((e) => e.slice(3))
		.map((p) => {
			try {
				const s = lstatSync(join(repo, p));
				return `${p} ${
					s.isFile()
						? createHash("sha256")
								.update(readFileSync(join(repo, p)))
								.digest("hex")
						: s.mode
				}`;
			} catch {
				return `${p} absent`;
			}
		});
	return [
		status.stdout,
		index.stdout,
		refs.stdout,
		head.stdout,
		...hashes,
	].join("\n--\n");
}

export async function recheck(
	m: Manifest,
	budgetMs: number,
): Promise<{
	exit: number;
	findings: Finding[];
	result: Record<string, unknown>;
	text: string;
}> {
	const started = performance.now();
	const before = snapshot(m.repo);
	let e: Evaluation;
	try {
		e = await evaluate(m, {
			deadline: Date.now() + budgetMs,
			budget: "120 s",
			all: true,
			exhale: true,
		});
	} catch (error) {
		e = {
			scope: [],
			excluded: [],
			systemTests: [],
			checks: [
				{
					check: "scope",
					status: "could-not-run",
					files: [],
					lines: [],
					why: (error as Error).message,
				},
			],
			failure: null,
		};
	}
	const after = snapshot(m.repo);
	const findings: Finding[] = [];
	for (const c of e.checks) {
		if (c.status === "fail")
			findings.push({
				code: "check-failed",
				severity: "error",
				file: c.files.join(", "),
				message: `${c.check}: ${c.why}${c.lines.length ? `\n${c.lines.join("\n")}` : ""}`,
			});
		if (c.status === "could-not-run")
			findings.push({
				code: "check-could-not-run",
				severity: "warning",
				file: c.files.join(", "),
				message: `${c.check}: ${c.why}`,
			});
	}
	if (before !== after)
		findings.push({
			code: "worktree-changed",
			severity: "error",
			file: m.repo,
			message:
				"a checker changed tracked content, the index, refs or nonignored files",
		});
	for (const p of e.systemTests)
		findings.push({
			code: "system-test-not-run",
			severity: "warning",
			file: p,
			message: "not run here; the host runs it at step 6",
		});
	const gaps = [
		...e.checks
			.filter((c) => c.status === "skipped")
			.map((c) => `${c.check}: ${c.why}`),
		...(e.systemTests.length
			? [
					`not run here: ${e.systemTests.join(", ")}; the host runs them at step 6`,
				]
			: []),
	];
	const failing = findings.some((f) => f.severity === "error");
	const unable = findings.some((f) => f.severity === "warning");
	const exit = failing ? 1 : unable ? 2 : 0;
	const status = failing ? "FINDING" : unable ? "COULD-NOT-RUN" : "CLEAN";
	logLine(
		m.log,
		"recheck",
		"evaluator",
		`${e.scope.length} paths`,
		performance.now() - started,
		status,
		`${findings.length} findings; ${gaps.join("; ") || "no gaps"}`,
	);
	const result = {
		complete: !unable,
		base: m.base,
		scope: e.scope,
		excluded: e.excluded,
		systemTests: e.systemTests,
		checks: e.checks.map(({ check, status, files, why }) => ({
			check,
			status,
			files,
			why,
		})),
		gaps,
	};
	const text = [
		`recheck: ${e.scope.length} changed paths against ${m.base}`,
		...(e.excluded.length
			? [`excluded paths changed: ${e.excluded.join(", ")}`]
			: []),
		...e.checks.map(
			(c) => `${c.check}: ${c.status}${c.why ? ` (${c.why})` : ""}`,
		),
		...gaps.map((g) => `gap: ${g}`),
		...findings.map((f) => `${f.code}: ${f.file}: ${f.message}`),
	].join("\n");
	return { exit, findings, result, text: `${text}\n` };
}
