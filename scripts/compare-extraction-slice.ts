#!/usr/bin/env bun

/**
 * Continuity evidence for one extraction slice (O32):
 *
 * 1. Generates the entry of every roster agent at `--base` and at `--head`
 *    with one fixed provenance fixture, in the same disposable absolute
 *    path in turn, and diffs them byte for byte (expected: no difference).
 * 2. Builds Shepherd from `--head` into a candidate installation (the
 *    slot's own `bin/` beside its `packages/`) and compares its
 *    `--show-prompt` output with the live binary's for every fixture
 *    workspace and both backends, fake backends first on PATH.
 * 3. Runs `shepherd tool doctor` with the candidate `bin/` first on PATH.
 * 4. Hashes the live `bin/shepherd` and lists live `packages/` before and
 *    after, and against `--baseline` when given (a live-baseline.md).
 *
 * The live root is only read. Exit 0 only when every comparison holds.
 *
 * Usage:
 *   bun scripts/compare-extraction-slice.ts --base <rev> [--head <rev>]
 *     --live-root <live-root> [--evidence <dir>] [--baseline <file>] [--keep]
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	parseArgs,
	readBaseline,
	repoRoot,
	revParse,
	run,
	sameSnapshot,
	scratchDir,
	versionProblem,
	writeEvidence,
} from "./extraction-continuity";

function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

const USAGE =
	"Usage: bun scripts/compare-extraction-slice.ts --base <rev> [--head <rev>] --live-root <dir> [--evidence <dir>] [--baseline <file>] [--keep]";

/** The fixed stamp every entry comparison uses. */
export const FIXED_PROVENANCE = {
	revision: "0".repeat(40),
	dirty: false,
	sourceDirty: false,
	manifest: { source: `sha256:${"0".repeat(64)}`, entries: [] },
};

const BACKENDS = ["claude", "codex"] as const;

function driver(slot: string, out: string): string {
	return `
import { mkdirSync, writeFileSync } from "node:fs";
import { generateEntry, planBuild } from ${JSON.stringify(join(slot, "scripts/agent-compiler.ts"))};
const plan = await planBuild({ root: ${JSON.stringify(slot)} });
mkdirSync(${JSON.stringify(out)}, { recursive: true });
for (const entry of plan.entries) {
	writeFileSync(${JSON.stringify(out)} + "/" + entry.id + ".ts", generateEntry(entry.agent, ${JSON.stringify(FIXED_PROVENANCE)}));
}
console.log(plan.entries.map((entry) => entry.id).join("\\n"));
`;
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2), USAGE);
	const repo = repoRoot();
	guardWorkspace(repo, args.liveRoot);
	const base = revParse(repo, args.base);
	const head = revParse(repo, args.head);
	const scratch = scratchDir("compare-extraction-slice");
	const evidence = args.evidence ?? join(scratch, "evidence");
	guardEvidence(evidence, args.liveRoot);
	const failures: string[] = [];
	const summary: string[] = [
		"# compare-extraction-slice",
		"",
		`repo ${repo}`,
		`base ${base}`,
		`head ${head}`,
		`live root ${args.liveRoot} (read only)`,
		`scratch ${scratch}`,
		`bun ${Bun.version}`,
		"",
	];

	const before = liveSnapshot(args.liveRoot);
	const slot = join(scratch, "slot/troupe");
	cloneSlot(repo, slot);

	// 1. Fixed-provenance entries at base and head, same slot path in turn.
	const entryDirs: Record<string, string> = {};
	for (const [label, rev] of [
		["base", base],
		["head", head],
	] as const) {
		const checkout = checkoutSlot(slot, rev);
		writeEvidence(
			evidence,
			`install-${label}.log`,
			checkout.runs.map(describeRan).join("\n"),
		);
		if (checkout.failed) {
			throw new Error(
				`${checkout.failed} failed at ${label}; see install-${label}.log`,
			);
		}
		const out = join(scratch, "entries", label);
		const script = join(scratch, `entries-${label}.ts`);
		writeFileSync(script, driver(slot, out));
		const ran = run([process.execPath, script], slot);
		writeEvidence(evidence, `entries-${label}.log`, describeRan(ran));
		if (ran.code !== 0) failures.push(`entry generation at ${label} failed`);
		entryDirs[label] = out;
	}
	const baseNames = readdirSync(entryDirs.base as string).sort();
	const headNames = readdirSync(entryDirs.head as string).sort();
	const entryDiff: string[] = [];
	for (const name of new Set([...baseNames, ...headNames])) {
		if (!baseNames.includes(name) || !headNames.includes(name)) {
			entryDiff.push(
				`${name}: present only at ${baseNames.includes(name) ? "base" : "head"}`,
			);
			continue;
		}
		const a = readFileSync(join(entryDirs.base as string, name));
		const b = readFileSync(join(entryDirs.head as string, name));
		if (!a.equals(b)) {
			const diff = run(
				[
					"diff",
					"-u",
					join(entryDirs.base as string, name),
					join(entryDirs.head as string, name),
				],
				scratch,
			);
			entryDiff.push(`${name}:\n${diff.stdout}`);
		}
	}
	writeEvidence(evidence, "entry-diff.txt", entryDiff.join("\n"));
	const entryHashes: string[] = [];
	for (const [label, names] of [
		["base", baseNames],
		["head", headNames],
	] as const) {
		for (const name of names) {
			const bytes = readFileSync(join(entryDirs[label] as string, name));
			entryHashes.push(`${label} ${sha256(bytes)} ${name}`);
		}
	}
	writeEvidence(evidence, "entries-sha256.txt", `${entryHashes.join("\n")}\n`);
	summary.push(
		`## Entries (fixed provenance)`,
		"",
		`${headNames.length} roster entries compared; ${entryDiff.length} differ.`,
		"",
	);
	if (entryDiff.length > 0) failures.push(`${entryDiff.length} entries differ`);

	// 2. Candidate installation from head (slot is at head now).
	const build = buildShepherd(slot);
	writeEvidence(evidence, "candidate-build.log", describeRan(build));
	if (build.code !== 0) {
		failures.push("candidate build failed");
	} else {
		const fakes = installFakes(slot, join(scratch, "fakes"));
		const workspaces = buildWorkspaces(
			join(slot, "agents/__fixtures__/shepherd/workspaces.json"),
			join(scratch, "workspaces"),
		);
		const env = childEnv({ PATH: `${fakes}:${process.env.PATH}` });
		const lines: string[] = [];
		const records: string[] = [];
		for (const [name, cwd] of workspaces) {
			for (const backend of BACKENDS) {
				const argv = [
					"--backend",
					backend,
					"--show-prompt",
					"triage",
					"my",
					"morning",
				];
				const live = run(
					[join(args.liveRoot, "bin/shepherd"), ...argv],
					cwd,
					env,
				);
				const candidate = run([join(slot, "bin/shepherd"), ...argv], cwd, env);
				const same =
					live.code === candidate.code &&
					live.stdout === candidate.stdout &&
					live.stderr === candidate.stderr;
				lines.push(`${same ? "identical" : "DIFFERENT"} ${name} ${backend}`);
				records.push(
					[
						`${same ? "identical" : "DIFFERENT"} ${name} ${backend}`,
						`  argv ${JSON.stringify(argv)}`,
						`  cwd ${cwd}`,
						`  live ${live.argv[0]} exit ${live.code} stdout sha256 ${sha256(live.stdout)} (${live.stdout.length} B) stderr sha256 ${sha256(live.stderr)} (${live.stderr.length} B)`,
						`  candidate ${candidate.argv[0]} exit ${candidate.code} stdout sha256 ${sha256(candidate.stdout)} (${candidate.stdout.length} B) stderr sha256 ${sha256(candidate.stderr)} (${candidate.stderr.length} B)`,
					].join("\n"),
				);
				if (!same) {
					failures.push(`preview ${name} ${backend} differs`);
					writeEvidence(
						evidence,
						`preview-${name}-${backend}.live.txt`,
						describeRan(live),
					);
					writeEvidence(
						evidence,
						`preview-${name}-${backend}.candidate.txt`,
						describeRan(candidate),
					);
				}
			}
		}
		writeEvidence(evidence, "previews.txt", `${records.join("\n\n")}\n`);
		summary.push(
			"## Previews (live vs candidate, fake backends first on PATH)",
			"",
			...lines,
			"",
		);

		// 3. tool doctor with the candidate first on PATH.
		const doctorEnv = childEnv({
			PATH: `${join(slot, "bin")}:${fakes}:${process.env.PATH}`,
		});
		const doctor = run(
			["shepherd", "tool", "doctor"],
			workspaces.get("plain") as string,
			doctorEnv,
		);
		writeEvidence(evidence, "tool-doctor.txt", describeRan(doctor));
		summary.push(
			"## tool doctor (candidate first on PATH)",
			"",
			`exit ${doctor.code}`,
			"",
		);
		if (doctor.code !== 0) failures.push("tool doctor failed");
		const version = run(
			[join(slot, "bin/shepherd"), "--version"],
			scratch,
			env,
		);
		writeEvidence(evidence, "candidate-version.txt", describeRan(version));
		const expected = expectedVersionLine(slot, head);
		writeEvidence(evidence, "expected-version.log", describeRan(expected.ran));
		const versionIssue = versionProblem(version.stdout, expected.line);
		if (versionIssue) failures.push(versionIssue);
		summary.push(
			"## Candidate --version",
			"",
			"```",
			version.stdout.trim(),
			"```",
			"",
			`expected: ${expected.line ?? "unavailable"}`,
			`matches: ${versionIssue === undefined}`,
			"",
		);
	}

	// 4. Live installation unchanged.
	const after = liveSnapshot(args.liveRoot);
	const unchanged = sameSnapshot(before, after);
	summary.push("## Live installation", "", `before == after: ${unchanged}`);
	if (!unchanged) failures.push("live installation changed during the run");
	if (args.baseline) {
		const baseline = readBaseline(args.baseline);
		const matches = sameSnapshot(baseline, after);
		summary.push(`after == baseline (${args.baseline}): ${matches}`);
		if (!matches) failures.push("live installation differs from the baseline");
	}
	summary.push(
		"",
		formatSnapshot("Live before", before),
		formatSnapshot("Live after", after),
	);
	summary.push(
		"## Result",
		"",
		failures.length === 0
			? "PASS"
			: `FAIL\n\n${failures.map((f) => `- ${f}`).join("\n")}`,
		"",
	);
	const file = writeEvidence(
		evidence,
		"compare-extraction-slice.md",
		summary.join("\n"),
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
