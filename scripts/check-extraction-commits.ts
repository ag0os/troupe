#!/usr/bin/env bun
/**
 * Per-commit continuity smoke for an extraction branch (O32). For every
 * commit of `git rev-list --reverse <base>..<head>` it checks the commit out
 * in one disposable clone, installs dependencies (running
 * `setup:extractions` when the commit defines it), builds Shepherd in the
 * existing layout and runs `--version` (expecting that commit's own clean
 * stamp: the whole line, its source digest read from the commit with
 * the commit's own legacy source module), a plain-fixture `--show-prompt`
 * for both backends and `tool doctor` with the candidate first on PATH. It
 * drives older commits from outside, inserting no files into them.
 *
 * The live root is only read: its `bin/shepherd` hash and `packages/` list
 * must not change during the run, and must equal `--baseline` when given.
 *
 * Usage:
 *   bun scripts/check-extraction-commits.ts --base <rev> [--head <rev>]
 *     --live-root <live-root> [--evidence <dir>] [--baseline <file>] [--keep]
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	buildShepherd,
	buildWorkspaces,
	checkoutSlot,
	childEnv,
	cloneSlot,
	describeRan,
	expectedVersionLine,
	formatSnapshot,
	guardEvidence,
	guardWorkspace,
	installFakes,
	liveSnapshot,
	must,
	parseArgs,
	type Ran,
	readBaseline,
	repoRoot,
	revParse,
	run,
	sameSnapshot,
	scratchDir,
	versionProblem,
	writeEvidence,
} from "./extraction-continuity";

const USAGE =
	"Usage: bun scripts/check-extraction-commits.ts --base <rev> [--head <rev>] --live-root <dir> [--evidence <dir>] [--baseline <file>] [--keep]";

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2), USAGE);
	const repo = repoRoot();
	guardWorkspace(repo, args.liveRoot);
	const base = revParse(repo, args.base);
	const head = revParse(repo, args.head);
	const commits = must(
		run(["git", "rev-list", "--reverse", `${base}..${head}`], repo),
		"rev-list",
	)
		.stdout.split("\n")
		.filter((line) => line.length > 0);
	const scratch = scratchDir("check-extraction-commits");
	const evidence = args.evidence ?? join(scratch, "evidence");
	guardEvidence(evidence, args.liveRoot);
	const before = liveSnapshot(args.liveRoot);
	const slot = join(scratch, "slot/troupe");
	cloneSlot(repo, slot);
	const failures: string[] = [];
	const rows: string[] = [];

	for (const [index, commit] of commits.entries()) {
		const short = commit.slice(0, 7);
		const subject = must(
			run(["git", "log", "-1", "--format=%s", commit], repo),
			"log",
		).stdout.trim();
		const logs: Ran[] = [];
		const problems: string[] = [];
		let error_: string | undefined;
		try {
			const checkout = checkoutSlot(slot, commit);
			logs.push(...checkout.runs);
			if (checkout.failed) throw new Error(`${checkout.failed} failed`);
			const build = buildShepherd(slot);
			logs.push(build);
			if (build.code !== 0) throw new Error("build failed");
			const fakes = installFakes(slot, join(scratch, `fakes-${short}`));
			const env = childEnv({ PATH: `${fakes}:${process.env.PATH}` });
			const binary = join(slot, "bin/shepherd");

			const version = run([binary, "--version"], scratch, env);
			logs.push(version);
			const expected = expectedVersionLine(slot, commit);
			logs.push(expected.ran);
			const versionIssue = versionProblem(version, expected.line);
			if (versionIssue) problems.push(versionIssue);
			if (expected.problem) problems.push(expected.problem);

			const workspaces = buildWorkspaces(
				join(slot, "agents/__fixtures__/shepherd/workspaces.json"),
				join(scratch, `workspaces-${short}`),
			);
			const plain = workspaces.get("plain") as string;
			for (const backend of ["claude", "codex"]) {
				const preview = run(
					[binary, "--backend", backend, "--show-prompt", "triage"],
					plain,
					env,
				);
				logs.push(preview);
				if (preview.code !== 0 || preview.stdout.length === 0) {
					problems.push(
						`plain --show-prompt on ${backend} exit ${preview.code}`,
					);
				}
			}

			const doctor = run(
				["shepherd", "tool", "doctor"],
				plain,
				childEnv({ PATH: `${join(slot, "bin")}:${fakes}:${process.env.PATH}` }),
			);
			logs.push(doctor);
			if (doctor.code !== 0) problems.push(`tool doctor exit ${doctor.code}`);
		} catch (error) {
			error_ = error instanceof Error ? error.message : String(error);
			problems.push((error_.split("\n")[0] as string) || "failed");
		}
		const log = writeEvidence(
			evidence,
			`commit-${String(index + 1).padStart(2, "0")}-${short}.log`,
			[
				...logs.map(describeRan),
				...(error_ ? [`--- failure (full)\n${error_}\n`] : []),
			].join("\n"),
		);
		rows.push(
			`| ${index + 1} | ${short} | ${subject} | ${problems.length === 0 ? "pass" : problems.join("; ")} | ${log.split("/").pop()} |`,
		);
		if (problems.length > 0) failures.push(`${short}: ${problems.join("; ")}`);
	}

	const after = liveSnapshot(args.liveRoot);
	const unchanged = sameSnapshot(before, after);
	if (!unchanged) failures.push("live installation changed during the run");
	const lines = [
		"# check-extraction-commits",
		"",
		`repo ${repo}`,
		`base ${base}`,
		`head ${head}`,
		`live root ${args.liveRoot} (read only)`,
		`scratch ${scratch}`,
		`bun ${Bun.version}`,
		"",
		"Per commit: frozen install, build Shepherd in the existing layout, `--version` (own clean stamp), plain `--show-prompt` on claude and codex, `tool doctor` with the candidate first on PATH.",
		"",
		"| # | commit | subject | result | log |",
		"|---|---|---|---|---|",
		...rows,
		"",
		"## Live installation",
		"",
		`before == after: ${unchanged}`,
	];
	if (args.baseline) {
		const matches = sameSnapshot(readBaseline(args.baseline), after);
		lines.push(`after == baseline (${args.baseline}): ${matches}`);
		if (!matches) failures.push("live installation differs from the baseline");
	}
	lines.push(
		"",
		formatSnapshot("Live before", before),
		formatSnapshot("Live after", after),
		"## Result",
		"",
		failures.length === 0
			? "PASS"
			: `FAIL\n\n${failures.map((f) => `- ${f}`).join("\n")}`,
		"",
	);
	const file = writeEvidence(
		evidence,
		"check-extraction-commits.md",
		lines.join("\n"),
	);
	console.log(`${failures.length === 0 ? "PASS" : "FAIL"}: ${file}`);
	for (const failure of failures) console.error(`- ${failure}`);
	if (!args.keep)
		rmSync(join(scratch, "slot"), { recursive: true, force: true });
	return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	try {
		process.exit(await main());
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}
}
