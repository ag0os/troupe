import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGitRunner } from "../../scripts/shepherd-source";
import {
	git,
	TEST_GIT_ENV,
	testGit,
	writeAt,
} from "../../scripts/shepherd-source-fixture";
import { parseOptions, REPO_ROOT } from "./run";
import type { Result } from "./schema";
import { behavioral, result } from "./testing";
import { trendLines } from "./trend";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "shepherd-trend-"));
	git(root, "init", "-q", "-b", "main");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Git with author and committer date `date`, when given. */
const gitAt = (date: string | undefined, ...args: string[]) => {
	const run = date
		? createGitRunner({
				...TEST_GIT_ENV,
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_DATE: date,
			})
		: testGit;
	const out = run(args, root);
	if (out.code !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
	return new TextDecoder().decode(out.stdout);
};

const commit = (message: string, date?: string) => {
	// One file per commit, so a merge never conflicts.
	writeAt(root, `work/${message.replace(/\W/g, "-")}.txt`, `${message}\n`);
	git(root, "add", "-A");
	gitAt(date, "commit", "-q", "-m", message);
	return git(root, "rev-parse", "HEAD").trim();
};

/** `value` evaluated at `revision`, starting at `startedAt`. */
function at(value: Result, revision: string, startedAt: string): Result {
	const copy = structuredClone(value);
	const build = copy.evaluation.invocations[0]?.build;
	if (build) build.revision = revision;
	copy.evaluation.startedAt = startedAt;
	return copy;
}

const publish = (digit: string, value: Result | string, date?: string) => {
	writeAt(
		root,
		`evals/shepherd/results/${digit.repeat(64)}.json`,
		typeof value === "string" ? value : JSON.stringify(value),
	);
	return commit(`result ${digit}`, date);
};

const trend = () => trendLines(root, { git: testGit });
/** The table's data rows, each split into its cells. */
const rows = (lines: string[]) =>
	lines
		.slice(
			2,
			lines.findIndex((line) => line.startsWith("Must cells")),
		)
		.map((line) => line.split(/ {2,}/));

describe("the trend view (H2)", () => {
	test("an empty or missing results directory prints that nothing is committed", () => {
		commit("first");
		expect(trend()).toEqual(["No result is committed at HEAD."]);
		writeAt(root, "evals/shepherd/results/.gitkeep", "");
		commit("an empty results directory");
		expect(trend()).toEqual(["No result is committed at HEAD."]);
	});

	test("rows follow commit order of the evaluated revisions, not file names or when results were committed", () => {
		const first = commit("first");
		const second = commit("second");
		publish(
			"a",
			at(result({ "G-neg.M2": "fail" }), second, "2026-10-02T10:00:00.000Z"),
		);
		publish("b", at(result(), first, "2026-10-03T10:00:00.000Z"));
		const lines = trend();
		expect(lines[0]).toMatch(
			/^Shepherd evals trend at [0-9a-f]{12}: 2 evaluations in 2 result files, oldest revision first\.$/,
		);
		expect(lines[1]).toMatch(
			/^revision +date +outcome +cost +A\.M1 +A\.M2 +D\.M1 .* G-neg\.M3 +note$/,
		);
		const [older, newer] = rows(lines);
		expect(older?.slice(0, 4)).toEqual([
			first.slice(0, 12),
			"2026-10-03",
			"pass",
			"$4.20",
		]);
		expect(newer?.slice(0, 4)).toEqual([
			second.slice(0, 12),
			"2026-10-02",
			"blocked",
			"$4.20",
		]);
		// Thirteen Must columns, in rubric order; G-neg.M2 is the twelfth.
		expect(older?.slice(4)).toEqual(Array(13).fill("p"));
		expect(newer?.[4 + 11]).toBe("F");
		expect(lines.at(-1)).toContain("p pass, F fail, ? inconclusive, - none");
	});

	test("a Must cell holds one letter per attempt that scored it, in order", () => {
		const revision = commit("first");
		const flaky = result(
			{},
			{
				D: [
					behavioral("D", "pass", 1, { "D.M2": "fail" }),
					behavioral("D", "pass", 2),
				],
				G: [behavioral("G", "inconclusive", 1), behavioral("G", "pass", 2)],
			},
		);
		publish("a", at(flaky, revision, "2026-10-02T10:00:00.000Z"));
		const [row] = rows(trend());
		expect(row?.[2]).toBe("flaky-pass");
		expect(row?.slice(6, 8)).toEqual(["pp", "Fp"]);
		expect(row?.slice(9, 11)).toEqual(["?p", "?p"]);
	});

	test("history evaluations are rows of their own, marked; unknown cost is counted", () => {
		const first = commit("first");
		const second = commit("second");
		const value = at(result(), second, "2026-10-05T10:00:00.000Z");
		const earlier = structuredClone(value.evaluation);
		earlier.hash = `sha256:${"4".repeat(64)}`;
		earlier.startedAt = "2026-10-01T10:00:00.000Z";
		const build = earlier.invocations[0]?.build;
		if (build) build.revision = first;
		const subject = earlier.trials[0]?.attempts[0]?.cost.subject;
		if (subject) {
			subject.usd = null;
			subject.reason = "no cost record";
		}
		value.history = [earlier];
		publish("a", value);
		const lines = trend();
		expect(lines[0]).toContain("2 evaluations in 1 result files");
		const [old, current] = rows(lines);
		expect(old?.[0]).toBe(first.slice(0, 12));
		expect(old?.[3]).toBe("$3.70+1?");
		expect(old?.[17]).toBe("earlier evaluation identity");
		expect(current?.[0]).toBe(second.slice(0, 12));
		expect(current?.length).toBe(17);
	});

	test("a revision missing from history comes last, by start time; unreadable and uncommitted files are not rows", () => {
		const revision = commit("first");
		publish("a", at(result(), "c".repeat(40), "2026-10-01T10:00:00.000Z"));
		publish("b", at(result(), "d".repeat(40), "2026-09-01T10:00:00.000Z"));
		publish("c", at(result(), revision, "2026-10-09T10:00:00.000Z"));
		publish("e", "{\n");
		writeAt(root, "evals/shepherd/results/extra.json", "{}");
		commit("a file that is not a result");
		writeAt(
			root,
			`evals/shepherd/results/${"f".repeat(64)}.json`,
			JSON.stringify(at(result(), revision, "2026-10-10T10:00:00.000Z")),
		);
		const lines = trend();
		expect(lines[0]).toContain("3 evaluations in 4 result files");
		expect(rows(lines).map((row) => [row[0], row[17] ?? ""])).toEqual([
			[revision.slice(0, 12), ""],
			["d".repeat(12), "not in HEAD's history"],
			["c".repeat(12), "not in HEAD's history"],
		]);
		expect(lines.at(-1)).toBe(
			`Unreadable, not shown: evals/shepherd/results/${"e".repeat(64)}.json`,
		);
	});

	test("a dirty source is noted beside its revision", () => {
		const revision = commit("first");
		const value = at(result(), revision, "2026-10-01T10:00:00.000Z");
		const build = value.evaluation.invocations[0]?.build;
		if (build) build.sourceDirty = true;
		publish("a", value);
		expect(rows(trend())[0]?.[17]).toBe("dirty source");
	});

	test("fix round 1, nit 4: a merged branch's rows sit where its commits happened, by commit date", () => {
		const day = (n: number) => `2026-10-0${n}T10:00:00Z`;
		commit("A", day(1));
		git(root, "switch", "-q", "-c", "side");
		commit("S1", day(2));
		const s2 = commit("S2", day(3));
		git(root, "switch", "-q", "main");
		commit("B", day(4));
		const c = commit("C", day(5));
		gitAt(day(6), "merge", "-q", "--no-ff", "-m", "merge side", "side");
		const d = commit("D", day(7));
		publish("a", at(result(), d, "2026-10-08T10:00:00.000Z"), day(8));
		publish("b", at(result(), c, "2026-10-08T11:00:00.000Z"), day(8));
		publish("c", at(result(), s2, "2026-10-08T12:00:00.000Z"), day(8));
		expect(rows(trend()).map((row) => row[0])).toEqual(
			[s2, c, d].map((revision) => revision.slice(0, 12)),
		);
	});

	test("fix round 1, nit 5: the last invocation's revision and dirty flag decide the row; unknown Musts get a column", () => {
		const first = commit("first");
		const second = commit("second");
		const value = at(result(), first, "2026-10-01T10:00:00.000Z");
		const [one] = value.evaluation.invocations;
		if (one)
			value.evaluation.invocations.push({
				...structuredClone(one),
				build: { ...one.build, revision: second, sourceDirty: false },
			});
		if (one) one.build.sourceDirty = true;
		const must = value.evaluation.trials[0]?.attempts[0]?.musts[0];
		if (must)
			value.evaluation.trials[0]?.attempts[0]?.musts.push({
				...must,
				id: "Z.M9",
				outcome: "fail",
			});
		publish("a", value);
		publish("b", at(result(), first, "2026-10-02T10:00:00.000Z"));
		const lines = trend();
		expect(lines[1]).toMatch(/ G-neg\.M3 +Z\.M9 +note$/);
		expect(rows(lines).map((row) => [row[0], row[17], row[18] ?? ""])).toEqual([
			[first.slice(0, 12), "-", ""],
			[second.slice(0, 12), "F", ""],
		]);
	});
});

describe("the --trend flag", () => {
	test("fix round 1, nit 1: the entry prints the trend and never falls through to a run", () => {
		// A copy of this tree in a fixture repository, so the entry reads
		// handmade results only; a fake `claude` records any launch.
		const scratch = mkdtempSync(join(tmpdir(), "shepherd-trend-cli-"));
		try {
			const copy = join(scratch, "repo");
			const listed = new TextDecoder()
				.decode(
					testGit(
						["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
						REPO_ROOT,
					).stdout,
				)
				.split("\0")
				.filter(
					(path) =>
						path &&
						!path.startsWith("evals/shepherd/results/") &&
						!path.startsWith("evals/shepherd/artifacts/") &&
						existsSync(join(REPO_ROOT, path)),
				);
			for (const path of listed) {
				mkdirSync(dirname(join(copy, path)), { recursive: true });
				copyFileSync(join(REPO_ROOT, path), join(copy, path));
			}
			symlinkSync(join(REPO_ROOT, "node_modules"), join(copy, "node_modules"));
			git(copy, "init", "-q", "-b", "main");
			git(copy, "add", "-A");
			git(copy, "commit", "-q", "-m", "the tree");
			const revision = git(copy, "rev-parse", "HEAD").trim();
			writeAt(
				copy,
				`evals/shepherd/results/${"a".repeat(64)}.json`,
				JSON.stringify(at(result(), revision, "2026-10-01T10:00:00.000Z")),
			);
			git(copy, "add", "-A");
			git(copy, "commit", "-q", "-m", "a result");
			const bin = join(scratch, "bin");
			const launches = join(scratch, "launches.log");
			mkdirSync(bin);
			writeFileSync(
				join(bin, "claude"),
				`#!/bin/sh\necho "$@" >> '${launches}'\nexit 97\n`,
				{ mode: 0o755 },
			);
			const temp = join(scratch, "tmp");
			mkdirSync(temp);
			const child = spawnSync(
				"bun",
				[join(copy, "evals/shepherd/run.ts"), "--trend"],
				{
					cwd: copy,
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						TMPDIR: temp,
					},
					encoding: "utf8",
					timeout: 120_000,
				},
			);
			expect([child.status, child.stderr]).toEqual([0, ""]);
			expect(child.stdout).toMatch(
				/^Shepherd evals trend at [0-9a-f]{12}: 1 evaluations in 1 result files/,
			);
			expect(child.stdout).toContain(`\n${revision.slice(0, 12)}  2026-10-01`);
			expect(existsSync(launches)).toBe(false);
			expect(readdirSync(temp)).toEqual([]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 120_000);

	test("is off by default", () => {
		expect(parseOptions([]).trend).toBe(false);
		expect(parseOptions(["--trend"]).trend).toBe(true);
	});

	test("takes no other option", () => {
		for (const other of [
			["--check"],
			["--scratch", "/tmp"],
			["--artifacts", "/tmp/a"],
			["--validation", "--trials", "D"],
		]) {
			expect(() => parseOptions(["--trend", ...other])).toThrow(
				"--trend reads committed results only; it takes no other option",
			);
		}
		expect(parseOptions(["--scratch", "/tmp"]).scratch).toBe("/tmp");
	});
});
