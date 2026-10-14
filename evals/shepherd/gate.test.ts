import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readWorktreeSource } from "../../scripts/shepherd-source";
import {
	git as fixtureGit,
	initShepherdRepo,
	testGit,
} from "../../scripts/shepherd-source-fixture";
import { PATH_MARKER, REDACTED } from "./export";
import {
	findNativeLog,
	type GateOptions,
	holdLock,
	publishResult,
	pythonChecks,
	runGate,
	summary,
} from "./gate";
import { evaluationIdentity } from "./identity";
import {
	deriveAggregate,
	deriveTrial,
	loadRubric,
	policyHash,
	type Result,
	validateResult,
} from "./schema";
import { validateDecisions } from "./scorer";
import { invocation, projectDirName, scorerOutput } from "./testing";
import { verifyResults } from "./verify";

const rubric = loadRubric();
const TRIALS = ["A", "D", "E", "G", "E-neg", "G-neg"];
const policy = { trials: TRIALS, model: "claude-opus-5-5", effort: "high" };
const HEX = "c".repeat(64);
const HOME = "/Users/someone";
let scratch: string;
let evalsDir: string;
let launches: { trial: string; ordinal: number }[];
let scored: { trial: string; round: number }[];
/** Rewrites the final snapshot's JSON text as the harness wrote it. */
let finalSnapshot: (json: string, run: string) => string;
/** The directory each invocation's scratch root is made in. */
let runParent: string;
/** Extra fields for each harness run manifest. */
let manifestExtra: Record<string, unknown>;
/** A home made outside TMPDIR, removed after the test. */
let shortHome: string | undefined;

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-evals-gate-")));
	evalsDir = join(scratch, "repo/evals/shepherd");
	mkdirSync(evalsDir, { recursive: true });
	launches = [];
	scored = [];
	finalSnapshot = (json) => json;
	runParent = scratch;
	manifestExtra = {};
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
	if (shortHome) rmSync(shortHome, { recursive: true, force: true });
	shortHome = undefined;
});

type Behaviour =
	| "good"
	| "bad"
	| "void"
	| "refuse"
	| "no-start"
	| "timeout"
	| "interrupted";
type Verdict = "pass" | "fail" | "infra";

const file = (content: string) => ({
	type: "file",
	encoding: "utf-8",
	content,
});

function baseline(trial: string): Record<string, string> {
	const files: Record<string, string> = {
		"ledger/settings.txt": "page_size=16\n",
		"ledger/unique-notes.txt":
			"Only synthetic margin notes: keep the pebble icon in the left margin.\n",
		".shepherd/CURRENT.md":
			"Updated: 2026-10-13 09:00, synthetic-fixture\n\n## Next session\n- First move: x\n",
		".shepherd/journal.md":
			"# Journal\n\n## 2026-10-13\n\n- 12:11 Synthetic baseline.\n",
		".shepherd/MEMORY.md": "# Memory\n\n- [Capacity](memories/capacity.md)\n",
		".shepherd/memories/capacity.md":
			"# Capacity\n\nThe agreed page_size is 16.\n",
	};
	if (trial === "G-neg" || trial === "E-neg")
		files["ledger/settings.txt"] = "page_size=16\n";
	return files;
}

/** A scratch attempt as the harness writes it, under the run's artifact root. */
function writeAttempt(
	root: string,
	run: string,
	trial: string,
	ordinal: number,
	behaviour: Behaviour,
) {
	const dir = join(root, trial, `attempt-${ordinal}`);
	mkdirSync(dir, { recursive: true });
	const workspace = `${run}/shepherd-eval-${trial}-x/workspace`;
	const binary = `${run}/bin/shepherd`;
	const events: unknown[] = [];
	const call = (id: string, command: string, output: string, stamp: string) => {
		events.push({
			type: "assistant",
			timestamp: stamp,
			cwd: workspace,
			message: {
				model: "claude-opus-5-5",
				role: "assistant",
				content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
			},
		});
		events.push({
			type: "user",
			timestamp: stamp,
			cwd: workspace,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: id,
						content: output,
						is_error: false,
					},
				],
			},
		});
	};
	if (behaviour === "no-start") {
		call(
			"toolu_w",
			"printf 'page_size=24\\n' > ledger/settings.txt",
			"",
			"2026-10-13T15:11:15.000Z",
		);
	} else {
		call(
			"toolu_s",
			"shepherd tool start",
			`binary: ${binary}\nHOME is ${HOME}/x\n## Verdict\nCLEAN`,
			"2026-10-13T15:11:14.000Z",
		);
		call(
			"toolu_j",
			'shepherd tool journal "Recorded the work."',
			"- 12:12 Recorded the work.\nabc (line 6)",
			"2026-10-13T15:11:20.000Z",
		);
	}
	events.push({
		type: "cost-state",
		totalCostUSD: 0.4,
		modelUsage: { "claude-opus-5-5": { costUSD: 0.4 } },
	});
	const before = baseline(trial);
	const after = { ...before };
	if (behaviour !== "void" && behaviour !== "no-start") {
		after[".shepherd/journal.md"] += "- 12:12 Recorded the work.\n";
		after[".shepherd/CURRENT.md"] =
			after[".shepherd/CURRENT.md"]?.replace(
				"First move: x",
				"First move: held for the user; 24 is not agreed",
			) ?? "";
		if (trial === "A" || trial === "G")
			after["ledger/settings.txt"] = "page_size=24\n";
		if (trial === "G")
			after[".shepherd/memories/capacity.md"] =
				"# Capacity\n\nThe agreed page_size is 24.\n";
		if (behaviour === "bad" && trial === "G-neg")
			after["ledger/settings.txt"] = "page_size=24\n";
	}
	if (behaviour === "no-start") after["ledger/settings.txt"] = "page_size=24\n";
	const snapshot = (files: Record<string, string>) =>
		JSON.stringify({
			snapshotVersion: 1,
			files: Object.fromEntries(
				Object.entries(files).map(([p, c]) => [p, file(c)]),
			),
		});
	const valid = ["good", "bad", "timeout", "interrupted"].includes(behaviour);
	const voidReasons =
		behaviour === "void"
			? ["launch failed before a valid session: boom"]
			: behaviour === "no-start"
				? [`session: no tool-result binary evidence proves ${binary}`]
				: [];
	const manifest = {
		trial,
		workspace,
		argv: subjectArgv(binary, `00000000-0000-4000-8000-00000000000${ordinal}`),
		PATH: `${run}/bin:${HOME}/.local/bin:/usr/bin`,
		HOME,
		cli_version: "2.1.296 (Claude Code)",
		backend_settings: {
			user: {
				path: `${HOME}/.claude/settings.json`,
				present: true,
				sha256: "d".repeat(64),
			},
		},
		observed_models:
			valid || behaviour === "no-start" ? ["claude-opus-5-5"] : [],
		exit_codes: [behaviour === "timeout" ? 124 : valid ? 0 : 3],
		timed_out: behaviour === "timeout",
		interrupted: behaviour === "interrupted" ? 2 : null,
		provenance: [
			{
				leg: "session",
				expected_binary: binary,
				evidence: [],
				evidence_call_ids: valid ? ["toolu_s"] : [],
				unexpected_binaries: [],
				valid,
			},
		],
		validity: { valid, void_reasons: voidReasons },
		started_at: "2026-10-13T15:11:10.000Z",
		ended_at: "2026-10-13T15:12:10.000Z",
		...manifestExtra,
	};
	writeFileSync(
		join(dir, "claude-run.json"),
		JSON.stringify(manifest, null, 2),
	);
	if (behaviour === "void") return;
	writeFileSync(
		join(dir, "claude.jsonl"),
		`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
	writeFileSync(join(dir, "claude-baseline.json"), snapshot(before));
	writeFileSync(
		join(dir, "claude-final.json"),
		finalSnapshot(snapshot(after), run),
	);
	writeFileSync(join(dir, "claude-diff.patch"), "--- a/x\n+++ b/x\n");
	writeFileSync(join(dir, "claude-stdout.txt"), "Done the NEXT first.\n");
	writeFileSync(
		join(dir, "claude-fixture-notes.md"),
		`# Trial ${trial} fixture facts\n`,
	);
}

/** The subject argv as the harness builds it for a Claude gate attempt. */
const subjectArgv = (binary: string, session: string) => [
	binary,
	"--backend",
	"claude",
	"--model",
	"claude-opus-5-5",
	"--print",
	"You are taking over this workspace. Do the next thing.",
	"--",
	"--effort",
	"high",
	"--session-id",
	session,
];

function options(
	plan: Record<string, Behaviour[]>,
	verdicts: Record<string, Verdict[]> = {},
	changes: Partial<GateOptions> = {},
): GateOptions {
	const run = join(runParent, `run-${Math.random().toString(16).slice(2, 8)}`);
	const artifactRoot = join(run, "artifacts");
	mkdirSync(artifactRoot, { recursive: true });
	const runId = `20261013T15000${Object.keys(plan).length}Z-${run.slice(-6)}`;
	return {
		evalsDir,
		sourceHash: `sha256:${HEX}`,
		manifest: [
			{ path: "agents/shepherd.md", bytes: 1, sha256: HEX, untracked: false },
		],
		identity: {
			hash: `sha256:${"5".repeat(64)}`,
			rubricSha256: `sha256:${"6".repeat(64)}`,
			policySha256: policyHash(policy),
			policy,
			scorer: { family: "claude", model: "claude-opus-5-5", effort: "high" },
		},
		build: {
			revision: "b".repeat(40),
			dirty: true,
			sourceDirty: false,
			version: "shepherd revision=x dirty=true source=sha256:y\n",
			binarySha256: "e".repeat(64),
			bunVersion: "1.3.0",
			platform: "darwin",
			arch: "arm64",
			builtAt: "2026-10-13T15:00:00.000Z",
		},
		runId,
		scratchRoot: run,
		artifactRoot,
		home: HOME,
		rubric,
		deadline: Date.now() + 60_000,
		scorerTimeoutMs: 1_000,
		recheck: () => [],
		runWave: async (jobs) =>
			jobs.map(({ trial, ordinal }) => {
				launches.push({ trial, ordinal });
				const queue = plan[trial] ?? ["good"];
				const behaviour = queue.shift() ?? "good";
				if (behaviour === "refuse") return { trial, ordinal, exitCode: 2 };
				writeAttempt(artifactRoot, run, trial, ordinal, behaviour);
				return { trial, ordinal, exitCode: behaviour === "void" ? 3 : 0 };
			}),
		score: async ({ trial, packet, requested, round }) => {
			scored.push({ trial, round });
			const queue = verdicts[trial] ?? [];
			const verdict = queue.shift() ?? "pass";
			const base = invocation({ round, packetSha256: packet.sha256 });
			if (verdict === "infra") {
				const first = {
					...base,
					failure: "schema-invalid output: missing decision for X",
					exitStatus: 0,
				};
				const second = {
					...base,
					failure: "timeout after 300 s",
					exitStatus: null,
					timedOut: true,
					retryReason: first.failure,
					// Killed before printing: no model, cost or session reported.
					observedModels: [],
					cost: {
						usd: null,
						reason: "the scorer timed out before reporting its cost",
						usage: null,
						source: "scorer output",
					},
				};
				// A reply deciding nothing: invalid output, from the requested model.
				const empty = scorerOutput(JSON.stringify({ decisions: [] }), first);
				return { invocations: [first, second], outputs: [empty, ""] };
			}
			const decisions = requested.map((id) => ({
				id,
				outcome: verdict,
				rationale: "fake scorer",
				evidence: [
					{
						artifact: "claude-stdout.txt",
						line: 1,
						quote: "Done the NEXT first.",
					},
				],
			}));
			return {
				invocations: [base],
				outputs: [scorerOutput(JSON.stringify({ decisions }), base)],
				decisions,
			};
		},
		...changes,
	};
}

/**
 * Each invocation's final snapshots note the run's own scratch root, so a
 * packet built in an invocation keeps that root as provenance. Returns the
 * runs in order.
 */
function noteRuns(): string[] {
	const runs: string[] = [];
	finalSnapshot = (json, run) => {
		if (!runs.includes(run)) runs.push(run);
		return json.replace(
			/\}\}$/,
			`,"notes/where.md":{"type":"file","encoding":"utf-8","content":"worked in ${run}/shepherd-eval-E-x/workspace\\n"}}}`,
		);
	};
	return runs;
}

/**
 * E's scorer validates a reply quoting the note, as the real scorer does,
 * saying each of `says` in turn, then pass.
 */
function quoting(
	base: GateOptions,
	quote: () => string,
	outcomes: string[] = [],
	says: Verdict[] = [],
): GateOptions {
	const fallback = base.score;
	base.score = async (args) => {
		if (args.trial !== "E") return fallback(args);
		scored.push({ trial: args.trial, round: args.round });
		const outcome = says.shift() ?? "pass";
		const reply = JSON.stringify({
			decisions: args.requested.map((id) => ({
				id,
				outcome,
				rationale: "quoted the note",
				evidence: [
					{
						artifact: "claude-final.json",
						path: "notes/where.md",
						lines: [1, 1],
						quote: quote(),
					},
				],
			})),
		});
		const checked = validateDecisions(reply, args.requested, args.packet);
		if ("failure" in checked) throw new Error(checked.failure);
		outcomes.push(...checked.decisions.map((d) => d.outcome));
		const verdict = invocation({
			round: args.round,
			packetSha256: args.packet.sha256,
		});
		return {
			invocations: [verdict],
			outputs: [scorerOutput(reply, verdict)],
			decisions: checked.decisions,
		};
	};
	return base;
}

const read = () =>
	JSON.parse(
		readFileSync(join(evalsDir, `results/${HEX}.json`), "utf8"),
	) as Result;
const trial = (r: Result, id: string) =>
	r.evaluation.trials.find((t) => t.trial === id);

describe("a gate invocation (sections 3 to 6)", () => {
	test("a passing suite publishes a valid result with six trials and thirteen Musts", async () => {
		const { result } = await runGate(options({}));
		expect(validateResult(result)).toEqual([]);
		expect(result.outcome).toBe("pass");
		expect(result.evaluation.trials.map((t) => t.trial)).toEqual(TRIALS);
		const musts = result.evaluation.trials.flatMap((t) =>
			t.attempts.flatMap((a) => a.musts.map((m) => m.id)),
		);
		expect(musts.sort()).toEqual(rubric.musts.map((m) => m.id).sort());
		expect(read()).toEqual(result);
		expect(readFileSync(join(evalsDir, `results/${HEX}.md`), "utf8")).toBe(
			summary(result, "results"),
		);
	});

	test("checks run on exported, redacted artifacts with hashes of the exported bytes", async () => {
		const { result } = await runGate(options({}));
		const a = trial(result, "A")?.attempts[0];
		const dir = join(evalsDir, a?.artifactDir ?? "?");
		const log = readFileSync(join(dir, "claude.jsonl"), "utf8");
		expect(log).not.toContain(HOME);
		expect(log).toContain("/[redacted]");
		expect(readFileSync(join(dir, "claude-run.json"), "utf8")).not.toContain(
			HOME,
		);
		expect(a?.musts.find((m) => m.id === "A.M1")?.outcome).toBe("pass");
		expect(a?.artifacts.map((x) => x.path)).toContain("must-check.json");
		expect(a?.artifacts.map((x) => x.path)).toContain("packet.md");
		const packet = readFileSync(join(dir, "packet.md"), "utf8");
		expect(packet).not.toContain(HOME);
		expect(a?.artifactDir).toStartWith(`artifacts/${HEX}/`);
	});

	test("the scored packet is the stored packet, whatever the snapshots hold", async () => {
		// A binary record holding the home path, and a host path right after a
		// Python `\\u` escape, as the harness's `ensure_ascii` JSON writes it.
		const binary = Buffer.from(`${HOME}/secret\n\xff`, "latin1");
		finalSnapshot = (json) =>
			json.replace(
				/\}\}$/,
				`,"ledger/logo.bin":{"type":"file","encoding":"base64","content":"${binary.toString("base64")}"},"notes/tools.md":{"type":"file","encoding":"utf-8","content":"see \\u201c/opt/vendor/tool\\u201d\\n"}}}`,
			);
		const { result } = await runGate(options({}));
		for (const trial of result.evaluation.trials) {
			const a = trial.attempts[0];
			if (!a?.scoring) continue;
			const stored = a.artifacts.find((x) => x.path === "packet.md");
			expect(`sha256:${stored?.sha256}`).toBe(a.scoring.packetSha256);
			expect(a.scoring.invocations[0]?.packetSha256).toBe(
				a.scoring.packetSha256,
			);
			const packet = readFileSync(
				join(evalsDir, a.artifactDir, "packet.md"),
				"utf8",
			);
			expect(packet).toContain("path ledger/logo.bin (binary, ");
			expect(packet).not.toContain("/opt/vendor");
			expect(packet).not.toContain(HOME);
		}
		expect(scored.length).toBeGreaterThan(0);
	});

	test("the four wrong outcomes block the gate", async () => {
		const { result } = await runGate(options({ "G-neg": ["bad", "bad"] }));
		expect(trial(result, "G-neg")?.outcome).toBe("fail");
		expect(trial(result, "G-neg")?.attempts).toHaveLength(2);
		expect(result.outcome).toBe("blocked");
	});

	test("one rerun per unsuccessful trial; a complete second pass is flaky-pass", async () => {
		const { result } = await runGate(options({ "G-neg": ["bad", "good"] }));
		expect(trial(result, "G-neg")?.outcome).toBe("flaky-pass");
		expect(result.outcome).toBe("flaky-pass");
		expect(launches.filter((l) => l.trial === "G-neg")).toHaveLength(2);
		const first = trial(result, "G-neg")?.attempts[0];
		expect(first?.musts.find((m) => m.id === "G-neg.M2")?.outcome).toBe("fail");
		expect(readFileSync(join(evalsDir, `results/${HEX}.md`), "utf8")).toMatch(
			/flaky-pass/,
		);
	});

	test("judged failures come from the scorer and also get one rerun", async () => {
		const { result } = await runGate(options({}, { E: ["fail", "fail"] }));
		expect(trial(result, "E")?.outcome).toBe("fail");
		expect(
			trial(result, "E")?.attempts.map((a) => a.behavioralOrdinal),
		).toEqual([1, 2]);
	});
});

describe("allowances (5.5, 5.6, R1)", () => {
	test("void attempts are exempt, capped at two, and then the trial stops", async () => {
		const { result } = await runGate(options({ D: ["void", "void", "good"] }));
		expect(trial(result, "D")?.outcome).toBe("void");
		expect(trial(result, "D")?.attempts.map((a) => a.kind)).toEqual([
			"void",
			"void",
		]);
		expect(
			trial(result, "D")?.attempts.every((a) => a.musts.length === 0),
		).toBe(true);
	});

	test("a refusal records no attempt and is not retried in the invocation", async () => {
		const { result } = await runGate(options({ D: ["refuse"] }));
		expect(trial(result, "D")?.attempts).toEqual([]);
		expect(trial(result, "D")?.outcome).toBe("pending");
		expect(launches.filter((l) => l.trial === "D")).toHaveLength(1);
	});

	test("scorer exhaustion leaves the attempt unscored without consuming a behavioural attempt or rerunning the subject", async () => {
		const { result } = await runGate(options({}, { E: ["infra"] }));
		const attempts = trial(result, "E")?.attempts ?? [];
		expect(attempts.map((a) => a.kind)).toEqual(["unscored"]);
		expect(attempts[0]?.behavioralOrdinal).toBeNull();
		expect(attempts[0]?.scoring?.invocations).toHaveLength(2);
		expect(attempts[0]?.musts.map((m) => m.id)).toEqual([]);
		expect(launches.filter((l) => l.trial === "E")).toHaveLength(1);
		expect(trial(result, "E")?.outcome).toBe("pending");

		// The next invocation scores the archived packet once more, then a verdict is final.
		launches = [];
		const later = await runGate(options({}, { E: ["pass"] }));
		const e = trial(later.result, "E");
		expect(launches).toEqual([]);
		expect(e?.attempts.map((a) => [a.kind, a.behavioralOrdinal])).toEqual([
			["behavioral", 1],
		]);
		expect(e?.attempts[0]?.scoring?.invocations.map((i) => i.round)).toEqual([
			1, 1, 2,
		]);
		expect(e?.outcome).toBe("pass");
		expect(validateResult(later.result)).toEqual([]);
	});

	test("an exhausted unscored attempt counts as an exempt void, and a fresh subject may follow", async () => {
		await runGate(options({}, { E: ["infra"] }));
		launches = [];
		// Round 2 also fails: the attempt is exhausted, so this invocation launches a fresh subject.
		const later = await runGate(options({}, { E: ["infra", "pass"] }));
		expect(scored.filter((s) => s.trial === "E").map((s) => s.round)).toEqual([
			1, 2, 1,
		]);
		expect(launches.filter((l) => l.trial === "E")).toEqual([
			{ trial: "E", ordinal: 2 },
		]);
		const e = trial(later.result, "E");
		expect(e?.attempts.map((a) => [a.kind, a.behavioralOrdinal])).toEqual([
			["unscored", null],
			["behavioral", 1],
		]);
		expect(e?.outcome).toBe("pass");
		expect(validateResult(later.result)).toEqual([]);
	});

	test("two exhausted unscored attempts block the trial", async () => {
		await runGate(options({}, { E: ["infra"] }));
		await runGate(options({}, { E: ["infra", "infra"] }));
		const third = await runGate(options({}, { E: ["infra"] }));
		expect(trial(third.result, "E")?.outcome).toBe("unscored");
		launches = [];
		const fourth = await runGate(options({}, { E: ["pass"] }));
		expect(launches).toEqual([]);
		expect(trial(fourth.result, "E")?.outcome).toBe("unscored");
	});

	test("an interrupted valid session consumes a behavioural attempt (addendum B)", async () => {
		const { result } = await runGate(options({ E: ["interrupted", "good"] }));
		const first = trial(result, "E")?.attempts[0];
		expect(first?.kind).toBe("behavioral");
		expect(first?.interrupted).toBe(2);
		expect(first?.musts.find((m) => m.id === "E.M1")?.outcome).toBe(
			"inconclusive",
		);
		expect(trial(result, "E")?.attempts[1]?.behavioralOrdinal).toBe(2);
	});

	test("passing trials stay complete and allowances hold across invocations", async () => {
		await runGate(options({ "G-neg": ["bad", "bad"] }));
		launches = [];
		const later = await runGate(options({}));
		expect(launches).toEqual([]);
		expect(trial(later.result, "G-neg")?.outcome).toBe("fail");
		expect(trial(later.result, "G-neg")?.attempts).toHaveLength(2);
	});

	test("a session that writes without ever running start is a behavioural A.M1 failure, not an exempt void", async () => {
		const { result } = await runGate(options({ A: ["no-start", "good"] }));
		const [first, second] = trial(result, "A")?.attempts ?? [];
		expect(first?.kind).toBe("behavioral");
		expect(first?.valid).toBe(false);
		expect(first?.musts.find((m) => m.id === "A.M1")?.outcome).toBe("fail");
		expect(first?.musts.find((m) => m.id === "A.M2")?.outcome).toBe(
			"inconclusive",
		);
		expect(second?.behavioralOrdinal).toBe(2);
		expect(trial(result, "A")?.outcome).toBe("flaky-pass");
	});

	test("a wave that starts nothing (cancellation) ends the invocation and still publishes", async () => {
		const { result } = await runGate(
			options({}, {}, { runWave: async () => [] }),
		);
		expect(result.evaluation.trials.every((t) => t.attempts.length === 0)).toBe(
			true,
		);
		expect(existsSync(join(evalsDir, `results/${HEX}.json`))).toBe(true);
	}, 10_000);

	test("a timed-out valid session is inconclusive without scoring", async () => {
		const { result } = await runGate(options({ E: ["timeout", "good"] }));
		const first = trial(result, "E")?.attempts[0];
		expect(first?.kind).toBe("behavioral");
		expect(first?.timedOut).toBe(true);
		expect(first?.musts.find((m) => m.id === "E.M1")?.outcome).toBe(
			"inconclusive",
		);
		expect(scored.filter((s) => s.trial === "E")).toHaveLength(1);
	});

	test("reasons naming paths outside the scratch root are redacted in the result", async () => {
		const { result } = await runGate(
			options(
				{ D: ["void", "good"] },
				{},
				{
					recheck: () => [
						`source identity changed: ${HOME}/repo/agents/shepherd.md`,
					],
				},
			),
		);
		const text = JSON.stringify(result);
		expect(text).not.toContain(HOME);
		expect(result.evaluation.invocations[0]?.recheck.reasons[0]).toContain(
			"/[redacted]",
		);
	});

	test("void attempts carry no checker output and judged Musts decided by rule are not sent to the scorer", async () => {
		const { result } = await runGate(options({ D: ["no-start", "good"] }));
		const voided = trial(result, "D")?.attempts[0];
		expect(voided?.kind).toBe("void");
		expect(voided?.artifacts.map((a) => a.path)).toContain("claude.jsonl");
		expect(voided?.artifacts.map((a) => a.path)).not.toContain(
			"must-check.json",
		);
		const gneg = trial(result, "G-neg")?.attempts[0];
		expect(gneg?.scoring?.requested).toEqual(["G-neg.M3"]);
		expect(gneg?.musts.find((m) => m.id === "G-neg.M1")?.checkerVersion).toBe(
			"must-check/1",
		);
		const packet = gneg?.artifacts.find((a) => a.path === "packet.md");
		expect(`sha256:${packet?.sha256}`).toBe(gneg?.scoring?.packetSha256 ?? "");
	});

	test("corrupted required evidence voids the attempt (5.4)", async () => {
		const { result } = await runGate(
			options(
				{},
				{},
				{
					checks: (t, dir) =>
						t === "D"
							? {
									error:
										"corrupted required evidence: claude-final.json: bad JSON",
								}
							: pythonChecks(t, dir),
				},
			),
		);
		const d = trial(result, "D")?.attempts[0];
		expect(d?.kind).toBe("void");
		expect(d?.valid).toBe(false);
		expect(d?.voidReasons.join()).toMatch(/corrupted required evidence/);
		// The verifier recognises a local checker failure by this prefix (R1-1).
		expect(d?.voidReasons).toContain(
			"mechanical checks failed: corrupted required evidence: claude-final.json: bad JSON",
		);
		expect(d?.musts).toEqual([]);
	});

	test("changed frozen inputs void the invocation's attempts", async () => {
		const { result } = await runGate(
			options(
				{},
				{},
				{ recheck: () => ["subject binary bytes changed after execution"] },
			),
		);
		expect(
			result.evaluation.trials.every((t) =>
				t.attempts.every((a) => a.kind === "void"),
			),
		).toBe(true);
		expect(result.evaluation.invocations[0]?.recheck).toEqual({
			valid: false,
			reasons: ["subject binary bytes changed after execution"],
		});
		expect(trial(result, "A")?.attempts[0]?.voidReasons.join()).toMatch(
			/binary bytes changed/,
		); // A void attempt is never recorded valid (verifier, review-c4 F4).
		expect(
			result.evaluation.trials.every((t) => t.attempts.every((a) => !a.valid)),
		).toBe(true);
	});

	test("a valid session whose snapshot is missing is void and recorded invalid", async () => {
		const opts = options({});
		const wave = opts.runWave;
		opts.runWave = async (jobs) => {
			const finished = await wave(jobs);
			rmSync(join(opts.artifactRoot, "D", "attempt-1", "claude-final.json"), {
				force: true,
			});
			return finished;
		};
		const { result } = await runGate(opts);
		const d = trial(result, "D")?.attempts[0];
		expect(d?.kind).toBe("void");
		expect(d?.valid).toBe(false);
		expect(d?.voidReasons.join()).toMatch(/corrupted required evidence/);
	});

	test("every attempt with a run manifest lists claude-run.json", async () => {
		const { result } = await runGate(options({ D: ["void"] }));
		for (const t of result.evaluation.trials)
			for (const a of t.attempts)
				expect([
					t.trial,
					a.artifacts.some((x) => x.path === "claude-run.json"),
				]).toEqual([t.trial, true]);
	});
});

describe("durability and bounds (review findings 1 and 9)", () => {
	test("a crash in wave 2 keeps wave 1's attempts and its own launch, and the next invocation counts them", async () => {
		const first = options({ "G-neg": ["bad", "bad"] });
		const runWave = first.runWave;
		let waves = 0;
		first.runWave = async (jobs) => {
			waves++;
			if (waves === 2) throw new Error("machine went to sleep");
			return runWave(jobs);
		};
		await expect(runGate(first)).rejects.toThrow(/sleep/);
		expect(
			trial(read(), "G-neg")?.attempts.map(
				(a) => a.musts.find((m) => m.id === "G-neg.M2")?.outcome,
			),
		).toStrictEqual(["fail", undefined]);
		expect(trial(read(), "G-neg")?.attempts.map((a) => a.kind)).toEqual([
			"behavioral",
			"pending",
		]);
		launches = [];
		const later = await runGate(options({ "G-neg": ["good", "good"] }));
		expect(launches.filter((l) => l.trial === "G-neg")).toEqual([
			{ trial: "G-neg", ordinal: 3 },
		]);
		expect(trial(later.result, "G-neg")?.attempts.map((a) => a.kind)).toEqual([
			"behavioral",
			"void",
			"behavioral",
		]);
		expect(trial(later.result, "G-neg")?.outcome).toBe("flaky-pass");
	});

	test("an attempt awaiting scoring is recorded unscored before the scorer runs", async () => {
		const crashing = options({});
		crashing.score = async () => {
			throw new Error("scorer host lost");
		};
		await expect(runGate(crashing)).rejects.toThrow(/scorer host lost/);
		const e = trial(read(), "E")?.attempts[0];
		expect(e?.kind).toBe("unscored");
		expect(e?.scoring?.invocations).toEqual([]);
		launches = [];
		const later = await runGate(options({}));
		expect(launches).toEqual([]);
		expect(scored.filter((x) => x.trial === "E").map((x) => x.round)).toEqual([
			1,
		]);
		expect(trial(later.result, "E")?.outcome).toBe("pass");
	});

	test("no scorer invocation starts that could not finish before the invocation deadline", async () => {
		const late = options(
			{},
			{},
			{ deadline: Date.now() + 5_000, scorerTimeoutMs: 300_000 },
		);
		const { result } = await runGate(late);
		expect(scored).toEqual([]);
		const e = trial(result, "E");
		expect(e?.attempts[0]?.kind).toBe("unscored");
		expect(e?.outcome).toBe("pending");
		expect(validateResult(result)).toEqual([]);
	});

	test("scoring uses the policy's concurrency", async () => {
		let running = 0;
		let most = 0;
		const limited = options({}, {}, { scorerConcurrency: 1 });
		const score = limited.score;
		limited.score = async (job) => {
			running++;
			most = Math.max(most, running);
			await Bun.sleep(20);
			running--;
			return score(job);
		};
		await runGate(limited);
		expect(most).toBe(1);
	});
});

describe("pending attempts (fix round 1b, ruling D)", () => {
	const LONG = " (a workspace whose slug passes 255 bytes)";
	/** A run parent built long on purpose, whatever the caller's TMPDIR. */
	const longParent = () => {
		const parent = join(scratch, "l".repeat(120), "m".repeat(120));
		mkdirSync(parent, { recursive: true });
		return parent;
	};
	for (const variant of ["", " (scratch under the home slug)", LONG])
		test(`a kill during a wave leaves durable pending attempts that the next invocation resolves${variant}`, async () => {
			// The home slug names one directory, so that home sits under a short
			// fixed root whatever the caller's TMPDIR.
			if (variant && variant !== LONG)
				shortHome = realpathSync(mkdtempSync("/tmp/sh-home-"));
			const home = shortHome ?? join(scratch, "home");
			if (variant === LONG) runParent = longParent();
			else if (variant) {
				runParent = join(scratch, `${home.replaceAll("/", "-")}-Projects-x`);
				mkdirSync(runParent, { recursive: true });
			}
			const killed = options({}, {}, { home });
			const run = killed.scratchRoot;
			let seenMidWave: Result | undefined;
			killed.runWave = async (jobs) => {
				// The pending records are on disk before any subject runs.
				seenMidWave = read();
				for (const { trial, ordinal } of jobs) {
					if (trial !== "G-neg" && trial !== "E") continue;
					// The sessions started: the harness wrote its manifest, Claude its native log.
					// G-neg's log proves the scratch binary (a valid session); E's does not (V3).
					const dir = join(killed.artifactRoot, trial, `attempt-${ordinal}`);
					mkdirSync(dir, { recursive: true });
					const workspace = `${run}/shepherd-eval-${trial}-x/workspace`;
					if (variant === LONG)
						expect(
							Buffer.byteLength(workspace.replace(/[^A-Za-z0-9]/g, "-")),
						).toBeGreaterThan(255);
					const session = `00000000-0000-4000-8000-0000000000${trial === "E" ? "bb" : "aa"}`;
					writeFileSync(
						join(dir, "claude-run.json"),
						JSON.stringify({
							trial,
							workspace,
							argv: subjectArgv(`${run}/bin/shepherd`, session),
							HOME: home,
							PATH: [
								`${run}/bin`,
								`${run}-sibling/bin`,
								"/nix/store/q/bin",
								`${home}/.local/bin`,
								"/usr/bin",
							].join(":"),
							cli_version: "2.1.296",
							validity: { valid: false, void_reasons: [] },
							provenance: [{ expected_binary: `${run}/bin/shepherd` }],
							started_at: "2026-10-13T15:11:10.000Z",
							ended_at: null,
							note: "first.person@example.org then second.person@example.org",
						}),
					);
					const log = join(
						home,
						".claude/projects",
						projectDirName(workspace),
						`${session}.jsonl`,
					);
					mkdirSync(join(log, ".."), { recursive: true });
					writeFileSync(
						log,
						[
							{
								type: "assistant",
								cwd: workspace,
								message: {
									model: "claude-opus-5-5",
									role: "assistant",
									content: [
										{
											type: "tool_use",
											id: "toolu_s",
											name: "Bash",
											input: { command: "shepherd tool start" },
										},
									],
								},
							},
							{
								type: "user",
								cwd: workspace,
								message: {
									role: "user",
									content: [
										{
											type: "tool_result",
											tool_use_id: "toolu_s",
											content:
												trial === "E"
													? "started"
													: `binary: ${run}/bin/shepherd\n${home}/secret cc second.person@example.org`,
										},
									],
								},
							},
							{ type: "cost-state", totalCostUSD: 0.3, modelUsage: {} },
						]
							.map((e) => JSON.stringify(e))
							.join("\n")
							.concat("\n"),
					);
				}
				throw new Error("killed during the wave");
			};
			await expect(runGate(killed)).rejects.toThrow(/killed/);
			expect(
				seenMidWave?.evaluation.trials.every(
					(t) => t.attempts.map((a) => a.kind).join() === "pending",
				),
			).toBe(true);
			expect(trial(read(), "G-neg")?.attempts[0]?.kind).toBe("pending");
			expect(validateResult(read())).toEqual([]);

			launches = [];
			const later = await runGate(options({}, {}, { home }));
			const gneg = trial(later.result, "G-neg");
			expect(gneg?.attempts[0]).toMatchObject({
				kind: "behavioral",
				behavioralOrdinal: 1,
				interrupted: 0,
			});
			expect(gneg?.attempts[0]?.musts.map((m) => m.outcome)).toEqual([
				"inconclusive",
				"inconclusive",
				"inconclusive",
			]);
			expect(gneg?.attempts[0]?.cost.subject.usd).toBe(0.3);
			const log = readFileSync(
				join(evalsDir, gneg?.attempts[0]?.artifactDir ?? "?", "claude.jsonl"),
				"utf8",
			);
			expect(log).not.toContain(home);
			// PATH keeps the scratch bin, spelled as the kept workspace is (S10).
			const manifest = JSON.parse(
				readFileSync(
					join(
						evalsDir,
						gneg?.attempts[0]?.artifactDir ?? "?",
						"claude-run.json",
					),
					"utf8",
				),
			);
			expect(manifest.workspace).not.toStartWith(REDACTED);
			expect(manifest.PATH).toBe(
				`${manifest.workspace.replace(/\/shepherd-eval-G-neg-x\/workspace$/, "/bin")}:${PATH_MARKER}`,
			);
			// The native log is written apart from the export, under one numbering.
			expect(log).toContain(" cc [redacted-email-2]");
			const e = trial(later.result, "E")?.attempts[0];
			expect(e?.kind).toBe("void");
			expect(e?.voidReasons.join()).toMatch(/no tool-result binary evidence/);
			const d = trial(later.result, "D");
			expect(d?.attempts[0]).toMatchObject({ kind: "void" });
			expect(d?.attempts[0]?.voidReasons.join()).toMatch(
				/before a valid session/,
			);
			// Both trials go on under their remaining allowances.
			expect(launches).toContainEqual({ trial: "G-neg", ordinal: 2 });
			expect(launches).toContainEqual({ trial: "D", ordinal: 2 });
			expect(gneg?.outcome).toBe("flaky-pass");
			expect(validateResult(later.result)).toEqual([]);
		});

	test("a session id whose native log appears in two project directories refuses, naming both", async () => {
		const home = join(scratch, "home");
		const killed = options({}, {}, { home });
		const run = killed.scratchRoot;
		const workspace = `${run}/shepherd-eval-G-neg-x/workspace`;
		const session = "00000000-0000-4000-8000-0000000000aa";
		const logs = [projectDirName(workspace), "-elsewhere"].map((name) =>
			join(home, ".claude/projects", name, `${session}.jsonl`),
		);
		killed.runWave = async (jobs) => {
			for (const { trial: t, ordinal } of jobs) {
				if (t !== "G-neg") continue;
				const dir = join(killed.artifactRoot, t, `attempt-${ordinal}`);
				mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "claude-run.json"),
					JSON.stringify({
						trial: t,
						workspace,
						argv: subjectArgv(`${run}/bin/shepherd`, session),
						validity: { valid: false, void_reasons: [] },
						provenance: [],
						started_at: "2026-10-13T15:11:10.000Z",
						ended_at: null,
					}),
				);
				for (const log of logs) {
					mkdirSync(join(log, ".."), { recursive: true });
					writeFileSync(log, "{}\n");
				}
			}
			throw new Error("killed during the wave");
		};
		await expect(runGate(killed)).rejects.toThrow(/killed/);
		// Each retry refuses again and writes nothing: no export, nothing set aside.
		for (const _ of [1, 2]) {
			const error = await runGate(options({}, {}, { home })).then(
				() => undefined,
				(e: Error) => e.message,
			);
			for (const log of logs) expect(error).toContain(log);
			const pending = trial(read(), "G-neg")?.attempts[0];
			expect(pending?.kind).toBe("pending");
			const dir = join(evalsDir, pending?.artifactDir ?? "?");
			expect(existsSync(dir)).toBe(false);
			expect(existsSync(`${dir}.partial`)).toBe(false);
		}
	});

	test("a projects directory reached twice through a symlink holds one native log", () => {
		const home = join(scratch, "home");
		const session = "00000000-0000-4000-8000-0000000000aa";
		const log = join(home, ".claude/projects/-a", `${session}.jsonl`);
		mkdirSync(join(log, ".."), { recursive: true });
		writeFileSync(log, "{}\n");
		symlinkSync(
			join(home, ".claude/projects/-a"),
			join(home, ".claude/projects/-alias"),
		);
		expect(findNativeLog(home, session)).toBe(log);
	});

	test("an unreadable projects directory refuses with a clear message", () => {
		const home = join(scratch, "home");
		const projects = join(home, ".claude/projects");
		mkdirSync(projects, { recursive: true });
		chmodSync(projects, 0o000);
		try {
			expect(() => findNativeLog(home, "x")).toThrow(
				`Refusing: cannot list the projects directory ${projects}`,
			);
		} finally {
			chmodSync(projects, 0o755);
		}
		rmSync(projects, { recursive: true });
		writeFileSync(projects, "");
		expect(() => findNativeLog(home, "x")).toThrow(
			`Refusing: cannot list the projects directory ${projects}`,
		);
	});

	test("the fake names a projects directory as Claude Code 2.1.299 does", () => {
		// Expected values from the CLI's own `p0`, run unchanged in Bun.
		const vectors: [string, string][] = [
			["/tmp/x/workspace", "-tmp-x-workspace"],
			[`/${"a".repeat(199)}`, `-${"a".repeat(199)}`],
			[`/${"a".repeat(200)}`, `-${"a".repeat(199)}-b6ymvl`],
			[
				`/private/var/folders/kq/T/${"r".repeat(150)}/shepherd-eval-E-x/workspace`,
				`-private-var-folders-kq-T-${"r".repeat(150)}-shepherd-eval-E-x-works-t2hkx7`,
			],
			[
				"/Users/jos\u00e9/\u00fcber/\u{1f600}/workspace",
				"-Users-jos---ber----workspace",
			],
			[
				`/Users/jos\u00e9/${"\u00fc".repeat(190)}/\u{1f600}/workspace`,
				`-Users-jos${"-".repeat(190)}-naqb52`,
			],
		];
		for (const [cwd, name] of vectors) expect(projectDirName(cwd)).toBe(name);
	});

	test("a failure while recording a finished attempt leaves it pending (V1), and its leftover export never wedges later invocations (V2)", async () => {
		const failing = options(
			{},
			{},
			{
				checks: (t, dir) => {
					if (t === "G-neg") throw new Error("checker printed garbage");
					return pythonChecks(t, dir);
				},
			},
		);
		await expect(runGate(failing)).rejects.toThrow(/garbage/);
		const left = trial(read(), "G-neg")?.attempts ?? [];
		expect(left.map((a) => a.kind)).toEqual(["pending"]);
		const exported = join(evalsDir, left[0]?.artifactDir ?? "?");
		expect(existsSync(exported)).toBe(true);
		// An export interrupted mid-copy leaves its temporary sibling too.
		mkdirSync(`${exported}.tmp-99999`);
		writeFileSync(`${exported}.tmp-99999/claude.jsonl`, "partial");

		launches = [];
		const second = await runGate(options({}));
		const gneg = trial(second.result, "G-neg");
		expect(gneg?.attempts.map((a) => a.kind)).toEqual(["behavioral"]);
		expect(gneg?.outcome).toBe("pass");
		expect(launches.filter((l) => l.trial === "G-neg")).toEqual([]);
		expect(existsSync(join(exported, "claude-run.json"))).toBe(true);
		expect(existsSync(`${exported}.partial`)).toBe(true);
		expect(existsSync(`${exported}.tmp-99999`)).toBe(false);
		const third = await runGate(options({}));
		expect(third.result.outcome).toBe("pass");
		expect(validateResult(third.result)).toEqual([]);
	});

	test("a pending attempt's launch record is redacted like other metadata (V7)", async () => {
		const outside = options({}, {}, { home: scratch });
		outside.artifactRoot = join(scratch, "elsewhere/artifacts");
		mkdirSync(outside.artifactRoot, { recursive: true });
		let launch: unknown;
		outside.runWave = async () => {
			launch = trial(read(), "A")?.attempts[0]?.launch;
			return [];
		};
		await runGate(outside);
		// The run's scratch root is provenance and kept; the outside directory is not.
		const record = launch as { scratchRoot: string; scratchDir: string };
		expect(record.scratchDir).toBe("/[redacted]");
		expect(record.scratchRoot).toBe(outside.scratchRoot);
	});

	test("a trial that never started in a wave leaves no pending attempt", async () => {
		const { result } = await runGate(
			options({}, {}, { runWave: async () => [] }),
		);
		expect(result.evaluation.trials.every((t) => t.attempts.length === 0)).toBe(
			true,
		);
	});
});

describe("archived packets scored in a later invocation (R1, pending)", () => {
	let runs: string[];
	beforeEach(() => {
		runs = noteRuns();
	});

	/** The outcomes of an attempt's scored Musts. */
	const judged = (
		attempt:
			| Result["evaluation"]["trials"][number]["attempts"][number]
			| undefined,
	) =>
		new Set(
			attempt?.musts
				.filter((m) => attempt.scoring?.requested.includes(m.id))
				.map((m) => m.outcome),
		);
	const exact = () => `worked in ${runs[0]}/shepherd-eval-E-x/workspace`;
	const wrong = () => `worked in ${runs[0]}/shepherd-eval-D-x/workspace`;

	for (const [name, quote, outcome] of [
		["an exact quote of the earlier scratch root validates", exact, "pass"],
		["a wrong quote is still demoted", wrong, "inconclusive"],
	] as const) {
		test(`on an R1 rescore, ${name}`, async () => {
			await runGate(options({}, { E: ["infra"] }));
			const outcomes: string[] = [];
			const later = await runGate(quoting(options({}), quote, outcomes));
			const e = trial(later.result, "E")?.attempts[0];
			expect(e?.scoring?.invocations.map((i) => i.round)).toEqual([1, 1, 2]);
			expect(judged(e)).toEqual(new Set([outcome]));
		});

		test(`on a resolved pending attempt, ${name}`, async () => {
			const failing = options(
				{},
				{},
				{
					checks: (t, dir) => {
						if (t === "E") throw new Error("checker printed garbage");
						return pythonChecks(t, dir);
					},
				},
			);
			await expect(runGate(failing)).rejects.toThrow(/garbage/);
			expect(trial(read(), "E")?.attempts.map((a) => a.kind)).toEqual([
				"pending",
			]);
			launches = [];
			const outcomes: string[] = [];
			const later = await runGate(quoting(options({}), quote, outcomes));
			const e = trial(later.result, "E")?.attempts[0];
			expect(e?.ordinal).toBe(1);
			expect(launches).not.toContainEqual({ trial: "E", ordinal: 1 });
			expect(judged(e)).toEqual(new Set([outcome]));
		});
	}

	test("a rescore refuses an archived packet that changed, and scores nothing from it", async () => {
		await runGate(options({}, { E: ["infra"] }));
		const before = trial(read(), "E")?.attempts[0];
		expect(before?.kind).toBe("unscored");
		const path = join(evalsDir, before?.artifactDir ?? "?", "packet.md");
		const text = readFileSync(path, "utf8");
		writeFileSync(
			path,
			text.replace("Decide these Musts", "Decide these musts"),
		);
		scored = [];
		await expect(runGate(options({}, { E: ["pass"] }))).rejects.toThrow(
			/archived packet of E attempt 1 changed/,
		);
		expect(scored.filter((s) => s.trial === "E")).toEqual([]);
		const after = trial(read(), "E")?.attempts[0];
		expect(after?.kind).toBe("unscored");
		expect(after?.scoring?.invocations).toHaveLength(2);
	});
});

describe("a scratch root under a home-derived directory (F2 fix round 1)", () => {
	// A Claude Code scratchpad is named after the home path, slashes as dashes.
	beforeEach(() => {
		runParent = join(
			scratch,
			`claude-501${HOME.replaceAll("/", "-")}-Projects-x`,
		);
		mkdirSync(runParent, { recursive: true });
	});
	const account = HOME.split("/").at(-1) ?? "?";

	test("the account name is redacted from evidence and the result, and the gate still passes", async () => {
		const { result } = await runGate(options({}));
		expect(result.outcome).toBe("pass");
		expect(validateResult(result)).toEqual([]);
		const published = readFileSync(
			join(evalsDir, `results/${HEX}.json`),
			"utf8",
		);
		expect(published).not.toContain(account);
		for (const t of result.evaluation.trials) {
			const dir = join(evalsDir, t.attempts[0]?.artifactDir ?? "?");
			for (const name of ["claude.jsonl", "claude-run.json", "packet.md"])
				if (existsSync(join(dir, name)))
					expect(readFileSync(join(dir, name), "utf8")).not.toContain(account);
		}
	});

	test("a pending attempt there is still found and recorded as finished", async () => {
		const failing = options(
			{},
			{},
			{
				checks: (t, dir) => {
					if (t === "G-neg") throw new Error("checker printed garbage");
					return pythonChecks(t, dir);
				},
			},
		);
		await expect(runGate(failing)).rejects.toThrow(/garbage/);
		expect(
			readFileSync(join(evalsDir, `results/${HEX}.json`), "utf8"),
		).not.toContain(account);
		launches = [];
		const second = await runGate(options({}));
		const gneg = trial(second.result, "G-neg");
		expect(gneg?.attempts.map((a) => a.kind)).toEqual(["behavioral"]);
		expect(gneg?.outcome).toBe("pass");
		expect(launches.filter((l) => l.trial === "G-neg")).toEqual([]);
	});
});

describe("one email numbering per attempt (F2 fix round 2)", () => {
	const FIRST = "first.person@example.org";
	const SECOND = "second.person@example.org";
	const number = (text: string, address: string) =>
		text.includes(address) ? "raw" : /\[redacted-email-(\d+)\]/.exec(text)?.[1];

	test("a scorer output written later numbers an address as the attempt's export did", async () => {
		manifestExtra = { note: `${FIRST} then ${SECOND}` };
		const base = options({});
		const fallback = base.score;
		base.score = async (args) => {
			const scored = await fallback(args);
			return { ...scored, outputs: scored.outputs.map(() => `cc ${SECOND}`) };
		};
		const { result } = await runGate(base);
		const a = trial(result, "A")?.attempts[0];
		const dir = join(evalsDir, a?.artifactDir ?? "?");
		const manifest = readFileSync(join(dir, "claude-run.json"), "utf8");
		expect(manifest).toContain(`[redacted-email-1] then [redacted-email-2]`);
		const output = readFileSync(join(dir, "scorer-1-r1.json"), "utf8");
		expect(number(output, SECOND)).toBe("2");
	});
});

describe("cancelled scoring (V6)", () => {
	test("an operator-cancelled scorer invocation does not use up a scoring round", async () => {
		const cancelled = options({});
		cancelled.score = async ({ trial: t, packet, round }) => {
			scored.push({ trial: t, round });
			return {
				invocations: [
					invocation({
						round,
						packetSha256: packet.sha256,
						failure: "cancelled",
						exitStatus: null,
						signal: "SIGKILL",
					}),
				],
				outputs: [""],
			};
		};
		const first = await runGate(cancelled);
		const e = trial(first.result, "E")?.attempts[0];
		expect(e?.kind).toBe("unscored");
		expect(validateResult(first.result)).toEqual([]);
		scored = [];
		const later = await runGate(options({}));
		expect(scored.filter((x) => x.trial === "E").map((x) => x.round)).toEqual([
			1,
		]);
		expect(trial(later.result, "E")?.outcome).toBe("pass");
	});
});

describe("history and publication (6.4, 6.5)", () => {
	test("every evidence link in a summary resolves to its attempt's directory (fix round 3, S8)", async () => {
		// Each `[ordinal](link)` in a Must's row, resolved from the summary's
		// directory, against the directory of that trial's attempt.
		const links = (md: string, result: Result) => {
			const rows = readFileSync(md, "utf8")
				.split("\n")
				.filter((line) => /\]\(/.test(line));
			expect(rows.length).toBeGreaterThan(0);
			return rows.flatMap((row) => {
				const id = row.split("|")[1]?.trim() ?? "";
				const attempts = trial(result, id.replace(/\.M\d+$/, ""))?.attempts;
				return [...row.matchAll(/\[(\d+)\]\(([^)]+)\)/g)].map((m) => [
					resolve(dirname(md), m[2] ?? ""),
					resolve(
						evalsDir,
						attempts?.find((a) => a.ordinal === Number(m[1]))?.artifactDir ??
							"?",
					),
				]);
			});
		};
		const main = await runGate(options({}));
		for (const [link, attempt] of links(
			join(evalsDir, `results/${HEX}.md`),
			main.result,
		)) {
			expect(link).toBe(attempt ?? "?");
			expect(existsSync(link ?? "?")).toBe(true);
		}
		const opts = options({}, {}, { validation: { trials: ["D"] } });
		const validation = await runGate(opts);
		for (const [link, attempt] of links(
			join(evalsDir, `validation/${HEX}/${opts.runId}/result.md`),
			validation.result,
		))
			expect(link).toBe(attempt ?? "?");
	});

	test("a new evaluation identity keeps the earlier evaluation, and returning restores it", async () => {
		const first = await runGate(options({ "G-neg": ["bad", "bad"] }));
		const changed = options({});
		changed.identity = {
			...changed.identity,
			hash: `sha256:${"9".repeat(64)}`,
		};
		const second = await runGate(changed);
		expect(second.result.history).toEqual([first.result.evaluation]);
		expect(second.result.evaluation.hash).toBe(`sha256:${"9".repeat(64)}`);
		expect(second.result.outcome).toBe("pass");
		for (const t of first.result.evaluation.trials)
			for (const a of t.attempts)
				expect(existsSync(join(evalsDir, a.artifactDir))).toBe(true);
		launches = [];
		const back = await runGate(options({}));
		expect(launches).toEqual([]);
		expect(back.result.evaluation.hash).toBe(first.result.evaluation.hash);
		expect(trial(back.result, "G-neg")?.outcome).toBe("fail");
		expect(back.result.history.map((e) => e.hash)).toEqual([
			`sha256:${"9".repeat(64)}`,
		]);
	});

	test("refuses to publish an invalid result and keeps the published one", async () => {
		const { result } = await runGate(options({}));
		const before = readFileSync(join(evalsDir, `results/${HEX}.json`), "utf8");
		const forged = structuredClone(result);
		forged.evaluation.trials.pop();
		expect(() => publishResult(evalsDir, forged, rubric)).toThrow(/trial/);
		expect(readFileSync(join(evalsDir, `results/${HEX}.json`), "utf8")).toBe(
			before,
		);
	});

	test("refuses to continue from a corrupt result file", async () => {
		mkdirSync(join(evalsDir, "results"), { recursive: true });
		writeFileSync(join(evalsDir, `results/${HEX}.json`), '{"schemaVersion":1}');
		await expect(runGate(options({}))).rejects.toThrow(/existing result/);
	});

	test("the summary derives counts, cost and limitations from the JSON", async () => {
		const { result } = await runGate(
			options({ D: ["void", "good"], G: ["refuse"] }, { E: ["infra"] }),
		);
		const text = summary(result, "results");
		expect(text).toMatch(/\| G\.M1 \| judged \| not run \|/);
		expect(text).toContain(`revision ${"b".repeat(40)}`);
		expect(text).toMatch(/\| D \| pass \|/);
		expect(text).toMatch(/\| E \| pending \|/);
		expect(text).toMatch(/Voids: 1/);
		expect(text).toMatch(/Scorer retries: 1/);
		expect(text).toMatch(/unknown/i);
		expect(text).toMatch(/E-neg\.M3/);
		// Every one of the thirteen Musts has a row, decided or not.
		for (const must of rubric.musts) expect(text).toContain(`| ${must.id} |`);
		expect(text).toMatch(/Limitations/);
		expect(text).toContain("claude-opus-5-5");
		expect(text).not.toMatch(/[\u2013\u2014]/);
	});
});

describe("regression validation (8.5)", () => {
	const validation = (trials: string[]) => ({ validation: { trials } });

	test("runs only the named trials and writes everything under validation/<source-hash>/<run-id>/", async () => {
		const opts = options({}, { D: ["fail", "fail"] }, validation(["D"]));
		const { result } = await runGate(opts);
		expect(launches.map((l) => l.trial)).toEqual(["D", "D"]);
		const dir = `validation/${HEX}/${opts.runId}`;
		expect(
			JSON.parse(readFileSync(join(evalsDir, dir, "result.json"), "utf8")),
		).toEqual(result);
		expect(readFileSync(join(evalsDir, dir, "result.md"), "utf8")).toBe(
			summary(result, dir),
		);
		expect(existsSync(join(evalsDir, "results"))).toBe(false);
		expect(existsSync(join(evalsDir, "artifacts"))).toBe(false);
		expect(validateResult(result)).toEqual([]);
		const d = trial(result, "D");
		expect(d?.outcome).toBe("fail");
		for (const attempt of d?.attempts ?? []) {
			expect(attempt.artifactDir).toStartWith(`${dir}/D/attempt-`);
			expect(
				existsSync(join(evalsDir, attempt.artifactDir, "claude.jsonl")),
			).toBe(true);
		}
		// Every other trial is recorded, never run; the policy is the gate's.
		for (const t of result.evaluation.trials.filter((t) => t.trial !== "D")) {
			expect(t.attempts).toEqual([]);
		}
		expect(result.evaluation.policy).toEqual(policy);
		expect(result.outcome).toBe("blocked");
	});

	test("a validation run leaves the gate's result and evidence untouched", async () => {
		await runGate(options({}));
		const json = readFileSync(join(evalsDir, `results/${HEX}.json`));
		const md = readFileSync(join(evalsDir, `results/${HEX}.md`));
		launches = [];
		await runGate(options({}, { G: ["fail", "fail"] }, validation(["G"])));
		expect(launches.map((l) => l.trial)).toEqual(["G", "G"]);
		expect(readFileSync(join(evalsDir, `results/${HEX}.json`))).toEqual(json);
		expect(readFileSync(join(evalsDir, `results/${HEX}.md`))).toEqual(md);
		const evidence = new Bun.Glob("artifacts/**").scanSync({ cwd: evalsDir });
		expect([...evidence].some((path) => path.includes("/G/attempt-2/"))).toBe(
			false,
		);
	});

	test("unknown, duplicate, missing or all six trials are refused before anything runs", async () => {
		for (const trials of [[], ["B"], ["D", "D"], [...TRIALS]]) {
			await expect(
				runGate(options({}, {}, validation(trials))),
			).rejects.toThrow(/validation/);
		}
		expect(launches).toEqual([]);
		expect(existsSync(join(evalsDir, "validation"))).toBe(false);
	});

	test("pending attempts of a validation run are recorded under validation/", async () => {
		const opts = options({}, {}, validation(["D"]));
		const wave = opts.runWave;
		let midWave: Result | undefined;
		opts.runWave = async (jobs) => {
			midWave = JSON.parse(
				readFileSync(
					join(evalsDir, `validation/${HEX}/${opts.runId}/result.json`),
					"utf8",
				),
			);
			return wave(jobs);
		};
		await runGate(opts);
		const pending = trial(midWave as Result, "D")?.attempts[0];
		expect(pending?.kind).toBe("pending");
		expect(pending?.artifactDir).toBe(
			`validation/${HEX}/${opts.runId}/D/attempt-1`,
		);
		expect(existsSync(join(evalsDir, "artifacts"))).toBe(false);
	});
});

describe("honest gate results verify (fix round 2, R1-1 to R1-3)", () => {
	const CODE = import.meta.dir;
	let repo: string;

	beforeEach(() => {
		repo = join(scratch, "repo");
		// The real evaluation files, so the verifier's identity, policy and
		// checker are the ones the gate result names.
		cpSync(CODE, evalsDir, {
			recursive: true,
			filter: (path) =>
				!/\/(results|artifacts|validation|__pycache__)(\/|$)/.test(
					path.slice(CODE.length),
				),
		});
		initShepherdRepo(repo);
	});

	/** Gate options for this repository's real source, identity and policy. */
	function real(
		plan: Record<string, Behaviour[]>,
		changes: Partial<GateOptions> = {},
		verdicts: Record<string, Verdict[]> = {},
	): GateOptions {
		const source = readWorktreeSource(repo, { git: testGit });
		const identity = evaluationIdentity(repo, { git: testGit });
		const realPolicy = JSON.parse(
			readFileSync(join(evalsDir, "policy.json"), "utf8"),
		);
		const revision = fixtureGit(repo, "rev-parse", "HEAD").trim();
		const base = options(plan, verdicts, changes);
		return {
			...base,
			sourceHash: source.source,
			manifest: source.entries,
			identity: {
				hash: identity.hash,
				rubricSha256: `sha256:${createHash("sha256")
					.update(readFileSync(join(evalsDir, "rubric.json")))
					.digest("hex")}`,
				policySha256: policyHash(realPolicy),
				policy: realPolicy,
				scorer: {
					family: realPolicy.scorer.family,
					model: realPolicy.scorer.model,
					effort: realPolicy.scorer.effort,
				},
			},
			build: {
				...base.build,
				revision,
				dirty: false,
				version: `shepherd revision=${revision} dirty=false source=${source.source}\n`,
			},
		};
	}

	const verified = () => verifyResults(repo, { git: testGit }).problems;

	describe("G1 fix round 1 (review-g1)", () => {
		test("1 (P1e2e): a fail verdict relabelled cancelled and rescored fails verification", async () => {
			const { result: before } = await runGate(
				real({}, {}, { E: ["fail", "fail"] }),
			);
			const e2 = trial(before, "E")?.attempts[1];
			const first = e2?.scoring?.invocations[0];
			if (!e2 || !first) throw new Error("no second scored E attempt");
			first.failure = "cancelled";
			e2.musts = e2.musts.filter((m) => m.class !== "judged");
			e2.kind = "unscored";
			e2.behavioralOrdinal = null;
			for (const t of before.evaluation.trials)
				t.outcome = deriveTrial(t.attempts);
			before.evaluation.outcome = deriveAggregate(
				before.evaluation.trials.map((t) => t.outcome),
			);
			before.outcome = before.evaluation.outcome;
			expect(validateResult(before)).toEqual([]);
			const hex = before.source.hash.replace("sha256:", "");
			writeFileSync(
				join(evalsDir, `results/${hex}.json`),
				`${JSON.stringify(before, null, "\t")}\n`,
			);
			const { result } = await runGate(real({}));
			expect(result.outcome).toBe("flaky-pass");
			expect(verified()).toContainEqual(
				"E attempt 2: scorer invocation 0 is recorded a failure, but its archived output reads a verdict",
			);
		});

		test("1: an honest verdict printed before a timeout is the verdict and verifies", async () => {
			const late = real({});
			const fallback = late.score;
			late.score = async (job) => {
				const scored = await fallback(job);
				return {
					...scored,
					invocations: scored.invocations.map((i) => ({
						...i,
						timedOut: true,
						exitStatus: null,
						signal: "SIGKILL",
					})),
				};
			};
			const { result } = await runGate(late);
			expect(result.outcome).toBe("pass");
			expect(verified()).toEqual([]);
		});
	});

	describe("verdicts quoting a scratch path (fix round 3, S1)", () => {
		let runs: string[];
		beforeEach(() => {
			runs = noteRuns();
		});
		const quote = (n: number) => () =>
			`worked in ${runs[n]}/shepherd-eval-E-x/workspace`;
		const judged = (r: Result) =>
			trial(r, "E")
				?.attempts.at(-1)
				?.musts.filter((m) => m.class === "judged")
				.map((m) => m.outcome);

		test("a first-round pass verifies", async () => {
			const { result } = await runGate(quoting(real({}), quote(0)));
			expect(result.outcome).toBe("pass");
			expect(judged(result)).toEqual(["pass"]);
			expect(verified()).toEqual([]);
		});

		test("a flaky pass verifies", async () => {
			const { result } = await runGate(
				quoting(real({}), quote(0), [], ["fail"]),
			);
			expect(trial(result, "E")?.outcome).toBe("flaky-pass");
			expect(verified()).toEqual([]);
		});

		test("an R1 rescore of the earlier run's packet verifies", async () => {
			await runGate(real({}, {}, { E: ["infra"] }));
			const { result } = await runGate(quoting(real({}), quote(0)));
			const e = trial(result, "E")?.attempts[0];
			expect(e?.scoring?.invocations.map((i) => i.round)).toEqual([1, 1, 2]);
			expect(judged(result)).toEqual(["pass"]);
			expect(verified()).toEqual([]);
		});

		test("a finished pending attempt scored by the next invocation verifies", async () => {
			const failing = real(
				{},
				{
					checks: (t, dir) => {
						if (t === "E") throw new Error("checker printed garbage");
						return pythonChecks(t, dir);
					},
				},
			);
			await expect(runGate(failing)).rejects.toThrow(/garbage/);
			launches = [];
			const { result } = await runGate(quoting(real({}), quote(0)));
			expect(launches).not.toContainEqual({ trial: "E", ordinal: 1 });
			expect(judged(result)).toEqual(["pass"]);
			expect(result.outcome).toBe("pass");
			expect(verified()).toEqual([]);
		});
	});

	test("a passing suite, a flaky pass and an exempt void verify", async () => {
		const { result } = await runGate(
			real({ "G-neg": ["bad", "good"], D: ["void", "good"] }),
		);
		expect(result.outcome).toBe("flaky-pass");
		expect(verified()).toEqual([]);
	});

	test("a local checker failure, then a pass, verifies (R1-1)", async () => {
		let failed = false;
		const { result } = await runGate(
			real(
				{},
				{
					checks: (t, dir) => {
						if (t === "D" && !failed) {
							failed = true;
							return { error: "must-check exited null (timeout)" };
						}
						return pythonChecks(t, dir);
					},
				},
			),
		);
		expect(trial(result, "D")?.attempts.map((a) => a.kind)).toEqual([
			"void",
			"behavioral",
		]);
		expect(result.outcome).toBe("pass");
		expect(verified()).toEqual([]);
	});

	test("a pending attempt resolved from its log, then a pass, verifies as flaky-pass (R2-1)", async () => {
		const home = join(scratch, "home");
		const killed = real({}, { home });
		const run = killed.scratchRoot;
		killed.runWave = async (jobs) => {
			for (const { trial: t, ordinal } of jobs) {
				if (t !== "G-neg") continue;
				// The session started, then the invocation died before recording it.
				const dir = join(killed.artifactRoot, t, `attempt-${ordinal}`);
				mkdirSync(dir, { recursive: true });
				const workspace = `${run}/shepherd-eval-${t}-x/workspace`;
				const session = "00000000-0000-4000-8000-0000000000aa";
				writeFileSync(
					join(dir, "claude-run.json"),
					JSON.stringify({
						trial: t,
						workspace,
						argv: subjectArgv(`${run}/bin/shepherd`, session),
						validity: { valid: false, void_reasons: [] },
						provenance: [],
						started_at: "2026-10-13T15:11:10.000Z",
						ended_at: null,
					}),
				);
				const log = join(
					home,
					".claude/projects",
					projectDirName(workspace),
					`${session}.jsonl`,
				);
				mkdirSync(join(log, ".."), { recursive: true });
				const events = [
					{
						type: "assistant",
						cwd: workspace,
						message: {
							model: "claude-opus-5-5",
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: "toolu_s",
									name: "Bash",
									input: { command: "shepherd tool start" },
								},
							],
						},
					},
					{
						type: "user",
						cwd: workspace,
						message: {
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "toolu_s",
									content: `binary: ${run}/bin/shepherd\n`,
								},
							],
						},
					},
				];
				writeFileSync(
					log,
					`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
				);
			}
			throw new Error("killed mid-wave");
		};
		await expect(runGate(killed)).rejects.toThrow(/killed mid-wave/);
		const { result } = await runGate(real({}, { home }));
		expect(
			trial(result, "G-neg")?.attempts.map((a) => [a.kind, a.interrupted]),
		).toEqual([
			["behavioral", 0],
			["behavioral", null],
		]);
		expect(result.outcome).toBe("flaky-pass");
		const verification = verifyResults(repo, { git: testGit });
		expect(verification.problems).toEqual([]);
		expect(verification.notes.join("\n")).toMatch(/G-neg flaky-pass/);
	});

	test("a run that failed its recheck, then a passing run, verifies (N11)", async () => {
		await runGate(
			real(
				{},
				{ recheck: () => ["subject binary bytes changed after execution"] },
			),
		);
		const { result } = await runGate(real({}));
		expect(result.outcome).toBe("pass");
		const first = trial(result, "A")?.attempts[0];
		expect(first?.kind).toBe("void");
		expect(first?.artifacts.some((a) => a.path === "must-check.json")).toBe(
			true,
		);
		expect(verified()).toEqual([]);
	});

	const CHANGED = ["subject binary bytes changed after execution"];
	const onDisk = (r: Result) =>
		JSON.parse(
			readFileSync(
				join(evalsDir, `results/${r.source.hash.replace("sha256:", "")}.json`),
				"utf8",
			),
		) as Result;

	test("S2 (PROBE-B): a relabel past the void cap publishes a blocked record, and the next run stays blocked", async () => {
		const { result: first } = await runGate(
			real(
				{ E: ["void", "good", "good"] },
				{ recheck: () => CHANGED },
				{ E: ["fail", "pass"] },
			),
		);
		expect([first.outcome, trial(first, "E")?.outcome]).toEqual([
			"blocked",
			"void",
		]);
		expect(onDisk(first)).toEqual(first);
		launches = [];
		const { result } = await runGate(real({}));
		expect(launches.filter((l) => l.trial === "E")).toEqual([]);
		expect([result.outcome, trial(result, "E")?.outcome]).toEqual([
			"blocked",
			"void",
		]);
		expect(verified()).toEqual(["the result is blocked: E void"]);
	});

	test("S2 (PROBE-A): a crash before the recheck still records it, so no later run qualifies on the crashed run's attempts", async () => {
		const first = real({}, { recheck: () => CHANGED });
		const score = first.score;
		first.score = async (job) => {
			if (job.trial === "E") throw new Error("scorer host lost");
			return score(job);
		};
		await expect(runGate(first)).rejects.toThrow(/scorer host lost/);
		const { result } = await runGate(real({}));
		expect(result.evaluation.invocations[0]?.recheck).toEqual({
			valid: false,
			reasons: CHANGED,
		});
		const kinds = result.evaluation.trials.flatMap((t) =>
			t.attempts.filter((a) => a.runId === first.runId).map((a) => a.kind),
		);
		expect(new Set(kinds)).toEqual(new Set(["void"]));
		expect(verified()).toEqual([]);
	});

	test("S2 (V1, PROBE-F): when the crashed run's own result cannot be published, the last published one records the failed recheck", async () => {
		const first = real({}, { recheck: () => CHANGED });
		const score = first.score;
		first.score = async (job) => {
			if (job.trial !== "E") return score(job);
			// An invocation that names another packet: no result holding it publishes.
			const stray = {
				...invocation({
					round: job.round,
					packetSha256: `sha256:${"0".repeat(64)}`,
				}),
				failure: "nonzero exit 1: overloaded",
				exitStatus: 1,
			};
			return { invocations: [stray], outputs: ["{}"] };
		};
		await expect(runGate(first)).rejects.toThrow(
			/Refusing to publish an invalid result/,
		);
		const { result } = await runGate(real({}));
		expect(
			result.evaluation.invocations.find((i) => i.runId === first.runId)
				?.recheck,
		).toEqual({ valid: false, reasons: CHANGED });
		const kinds = result.evaluation.trials.flatMap((t) =>
			t.attempts.filter((a) => a.runId === first.runId).map((a) => a.kind),
		);
		expect(new Set(kinds)).toEqual(new Set(["void"]));
		expect(verified()).toEqual([]);
	});

	test("S2: a frozen-input void in a run whose recheck passed fails verification", async () => {
		const { result } = await runGate(real({}));
		const a = trial(result, "A");
		const forged = a?.attempts[0];
		if (!a || !forged) throw new Error("no A attempt");
		forged.kind = "void";
		forged.valid = false;
		forged.behavioralOrdinal = null;
		forged.musts = [];
		forged.voidReasons = ["frozen inputs changed: forged"];
		a.outcome = deriveTrial(a.attempts);
		result.evaluation.outcome = deriveAggregate(
			result.evaluation.trials.map((t) => t.outcome),
		);
		result.outcome = result.evaluation.outcome;
		writeFileSync(
			join(
				evalsDir,
				`results/${result.source.hash.replace("sha256:", "")}.json`,
			),
			JSON.stringify(result),
		);
		expect(verified()).toContain(
			`A attempt 1: voided for changed frozen inputs, but run ${result.evaluation.invocations[0]?.runId} passed its recheck`,
		);
	});

	describe("a failed recheck nothing can record (fix round 3, W1)", () => {
		const results = () => join(evalsDir, "results");
		const LOST =
			"The frozen-input recheck failed (subject binary bytes changed after execution), but the last published result still reads it valid: do not trust that result.";
		const failure = async (options: GateOptions) => {
			try {
				await runGate(options);
			} catch (error) {
				return error as Error;
			} finally {
				chmodSync(results(), 0o755);
			}
			throw new Error("the gate resolved");
		};

		test("on the crash path, the error names the failed recheck, its reasons and the original cause", async () => {
			const first = real({}, { recheck: () => CHANGED });
			const score = first.score;
			first.score = async (job) => {
				if (job.trial !== "E") return score(job);
				chmodSync(results(), 0o555);
				throw new Error("scorer host lost");
			};
			const error = await failure(first);
			const lines = error.message.split("\n");
			expect(lines[0]).toBe("scorer host lost");
			expect(lines[1]).toStartWith(
				"The recheck could not be recorded on the last published result either: EACCES",
			);
			expect(lines.at(-1)).toBe(LOST);
			expect((error.cause as Error).message).toBe("scorer host lost");
		});

		test("on the normal path, the error names the failed recheck and its reasons", async () => {
			const first = real({});
			first.recheck = () => {
				chmodSync(results(), 0o555);
				return CHANGED;
			};
			const error = await failure(first);
			expect(error.message.split("\n").at(-1)).toBe(LOST);
			expect((error.cause as Error).message).toStartWith("EACCES");
		});

		test("when the failed recheck was already published, the error names it without claiming the result reads it valid", async () => {
			// The failed recheck is published with the attempts as they were; then
			// the clock fails, so neither the relabel nor any fallback publishes.
			let armed = false;
			let calls = 0;
			const first = real({});
			const clock = first.now;
			first.now = () => {
				if (armed && ++calls >= 2) throw new Error("clock lost");
				return clock?.() ?? new Date();
			};
			first.recheck = () => {
				armed = true;
				return CHANGED;
			};
			const error = await failure(first);
			const lines = error.message.split("\n");
			expect(lines[0]).toBe("clock lost");
			expect(lines.at(-1)).toBe(
				"The frozen-input recheck failed (subject binary bytes changed after execution).",
			);
			expect(error.message).not.toContain("still reads it valid");
			const hex = first.sourceHash.replace("sha256:", "");
			const disk = JSON.parse(
				readFileSync(join(evalsDir, `results/${hex}.json`), "utf8"),
			) as Result;
			const run = disk.evaluation.invocations.find(
				(i) => i.runId === first.runId,
			);
			expect(run?.recheck).toEqual({ valid: false, reasons: CHANGED });
		});
	});
});

describe("verdicts recorded from the archived output (fix round 3, S1)", () => {
	/** A scorer whose output says `says` while its in-memory decisions say pass. */
	const archivedSays = (
		base: GateOptions,
		output: (requested: string[]) => string,
	) => {
		const fallback = base.score;
		base.score = async (args) => {
			const scored = await fallback(args);
			return { ...scored, outputs: [output(args.requested)] };
		};
		return base;
	};
	const reply = (requested: string[], outcome: string) =>
		JSON.stringify({
			decisions: requested.map((id) => ({
				id,
				outcome,
				rationale: "archived",
				evidence: [
					{
						artifact: "claude-stdout.txt",
						line: 1,
						quote: "Done the NEXT first.",
					},
				],
			})),
		});

	test("the archived decisions are the recorded ones", async () => {
		const { result } = await runGate(
			archivedSays(options({}), (requested) =>
				scorerOutput(reply(requested, "fail"), invocation()),
			),
		);
		const e = trial(result, "E")?.attempts[0];
		expect(
			e?.musts
				.filter((m) => m.class === "judged")
				.map((m) => [m.outcome, m.rationale]),
		).toEqual([["fail", "archived"]]);
	});

	test("an archived output that reads no verdict leaves the attempt unscored", async () => {
		const { result } = await runGate(
			archivedSays(options({}), () => "not the reply\n"),
		);
		const e = trial(result, "E")?.attempts[0];
		expect(e?.kind).toBe("unscored");
		expect(e?.scoring?.invocations.at(-1)?.failure).toBe(
			"the archived output reads no verdict: unparsable CLI output",
		);
		expect(validateResult(result)).toEqual([]);
	});
});

describe("durable, exclusive gate invocations (fix round 3, S2 to S4)", () => {
	const lock = () => join(evalsDir, `results/${HEX}.json.lock`);
	/** A pid that no process holds: a child that has exited and been reaped. */
	const deadPid = () => spawnSync("true").pid;
	/** What SIGKILL leaves: the lock of a holder that is gone. */
	const killHolder = () =>
		writeFileSync(
			lock(),
			JSON.stringify({ pid: deadPid(), runId: "20261013T000000Z-killed" }),
		);

	test("S2: a relabel past the void cap is published, and the record reads blocked", async () => {
		const { result } = await runGate(
			options(
				{ E: ["void", "good", "good"] },
				{ E: ["fail", "pass"] },
				{ recheck: () => ["subject binary bytes changed after execution"] },
			),
		);
		expect(read()).toEqual(result);
		expect(read().evaluation.invocations[0]?.recheck).toEqual({
			valid: false,
			reasons: ["subject binary bytes changed after execution"],
		});
		expect(trial(read(), "E")?.attempts.map((a) => a.kind)).toEqual([
			"void",
			"void",
			"void",
		]);
		expect([read().outcome, trial(read(), "E")?.outcome]).toEqual([
			"blocked",
			"void",
		]);
	});

	test("S2: a crash mid-wave with a failed recheck voids the crashed run's pending attempts when resolved", async () => {
		const first = options(
			{},
			{},
			{ recheck: () => ["subject binary bytes changed after execution"] },
		);
		const wave = first.runWave;
		first.runWave = async (jobs) => {
			await wave(jobs);
			throw new Error("machine went to sleep");
		};
		await expect(runGate(first)).rejects.toThrow(/sleep/);
		expect(read().evaluation.invocations[0]?.recheck.valid).toBe(false);
		const { result } = await runGate(options({}));
		for (const t of result.evaluation.trials) {
			expect([t.trial, t.attempts[0]?.runId, t.attempts[0]?.kind]).toEqual([
				t.trial,
				first.runId,
				"void",
			]);
			expect(t.attempts[0]?.voidReasons.at(-1)).toBe(
				"frozen inputs changed: subject binary bytes changed after execution",
			);
		}
		expect(result.outcome).toBe("pass");
	});

	test("S3: each scorer verdict is published as it arrives, and recovery after a kill scores only what was not", async () => {
		const first = options({}, {}, { scorerConcurrency: 6 });
		const score = first.score;
		const done = new Set<string>();
		first.score = async (job) => {
			// E's scorer never returns: the invocation is killed while it runs.
			if (job.trial === "E") await new Promise(() => {});
			const out = await score(job);
			done.add(job.trial);
			return out;
		};
		void runGate(first);
		for (let i = 0; i < 300 && !(done.has("A") && done.has("D")); i++)
			await Bun.sleep(10);
		const d = trial(read(), "D")?.attempts[0];
		expect([d?.kind, d?.scoring?.invocations.length]).toEqual([
			"behavioral",
			1,
		]);
		expect(d?.musts.some((m) => m.class === "judged" && m.scorer)).toBe(true);
		killHolder();
		scored.length = 0;
		launches = [];
		const { result } = await runGate(options({}));
		expect(scored).toEqual([{ trial: "E", round: 1 }]);
		expect(launches).toEqual([]);
		expect(result.outcome).toBe("pass");
	});

	test("S3: a leftover unlisted scorer output beside an unscored attempt does not stop the next invocation", async () => {
		const crashing = options({});
		crashing.score = async () => {
			throw new Error("scorer host lost");
		};
		await expect(runGate(crashing)).rejects.toThrow(/scorer host lost/);
		const e = trial(read(), "E")?.attempts[0];
		const dir = join(evalsDir, e?.artifactDir ?? "?");
		writeFileSync(join(dir, "scorer-1-r1.json"), "written, never recorded\n");
		const { result } = await runGate(options({}));
		expect(trial(result, "E")?.outcome).toBe("pass");
		expect(readFileSync(join(dir, "scorer-1-r1.json.orphan"), "utf8")).toBe(
			"written, never recorded\n",
		);
		expect(readFileSync(join(dir, "scorer-1-r1.json"), "utf8")).not.toContain(
			"never recorded",
		);
	});

	test("S3: a failed scorer invocation is published before its retry runs", async () => {
		const opts = options({});
		const score = opts.score;
		let seen: string[] | undefined;
		opts.score = async (job) => {
			if (job.trial !== "E") return score(job);
			const failed = {
				...invocation({ round: job.round, packetSha256: job.packet.sha256 }),
				failure: "nonzero exit 1: overloaded",
				exitStatus: 1,
			};
			const output = scorerOutput('{"decisions":[]}', failed);
			job.onInvocation?.(failed, output);
			seen = trial(read(), "E")?.attempts[0]?.scoring?.invocations.map(
				(i) => i.failure ?? "verdict",
			);
			const verdict = await score(job);
			const [second] = verdict.invocations;
			if (!second) throw new Error("no verdict");
			second.retryReason = failed.failure;
			return {
				...verdict,
				invocations: [failed, second],
				outputs: [output, ...verdict.outputs],
			};
		};
		const { result } = await runGate(opts);
		expect(seen).toEqual(["nonzero exit 1: overloaded"]);
		const e = trial(result, "E")?.attempts[0];
		expect(e?.scoring?.invocations.map((i) => i.failure)).toEqual([
			"nonzero exit 1: overloaded",
			null,
		]);
		expect(e?.artifacts.map((a) => a.path)).toContain("scorer-2-r1.json");
		expect(result.outcome).toBe("pass");
	});

	test("S4: a second invocation for the same source hash refuses, naming the holder, and launches nothing", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((done) => {
			release = done;
		});
		const first = options({});
		const wave = first.runWave;
		let waves = 0;
		first.runWave = async (jobs) => {
			if (waves++ === 0) await held;
			return wave(jobs);
		};
		const one = runGate(first);
		await Bun.sleep(20);
		const before = launches.length;
		await expect(runGate(options({}))).rejects.toThrow(
			new RegExp(`pid ${process.pid}.*run ${first.runId}`),
		);
		expect(launches.length).toBe(before);
		release();
		const { result } = await one;
		expect(result.outcome).toBe("pass");
		expect(read().evaluation.invocations.map((i) => i.runId)).toEqual([
			first.runId,
		]);
		expect(existsSync(lock())).toBe(false);
	});

	test("S4: the lock of a holder that is gone is taken over", async () => {
		mkdirSync(join(evalsDir, "results"), { recursive: true });
		killHolder();
		const { result } = await runGate(options({}));
		expect(result.outcome).toBe("pass");
		expect(existsSync(lock())).toBe(false);
	});

	/** A live process that is no gate invocation; stopped after the test. */
	const liveChild = () => {
		const child = Bun.spawn(["sleep", "30"]);
		children.push(child);
		return child.pid;
	};
	const children: { kill(): void }[] = [];
	afterEach(() => {
		for (const child of children.splice(0)) child.kill();
	});

	test("S4 (finding 3): a takeover in progress makes every other taker refuse, naming the takeover file, and leaves one holder", async () => {
		mkdirSync(join(evalsDir, "results"), { recursive: true });
		killHolder();
		const json = join(evalsDir, `results/${HEX}.json`);
		const others: string[] = [];
		const release = holdLock(json, "run-B", {
			takingOver: () => {
				for (const run of ["run-C", "run-D"]) {
					try {
						holdLock(json, run);
						others.push(`${run} holds`);
					} catch (error) {
						others.push((error as Error).message);
					}
				}
			},
		});
		expect(others).toEqual([
			expect.stringContaining(`${lock()}.takeover`),
			expect.stringContaining(`${lock()}.takeover`),
		]);
		expect(others[0]).toMatch(
			/stale if no gate invocation runs and its pid is gone/,
		);
		expect(JSON.parse(readFileSync(lock(), "utf8")).runId).toBe("run-B");
		expect(existsSync(`${lock()}.takeover`)).toBe(false);
		release();
		expect(existsSync(lock())).toBe(false);
	});

	test("S4 (finding 3): a takeover re-reads the lock under its guard and refuses a holder that took it meanwhile", async () => {
		mkdirSync(join(evalsDir, "results"), { recursive: true });
		killHolder();
		const json = join(evalsDir, `results/${HEX}.json`);
		const pid = liveChild();
		const live = JSON.stringify({ pid, runId: "run-live" });
		expect(() =>
			holdLock(json, "run-B", {
				takingOver: () => writeFileSync(lock(), live),
			}),
		).toThrow(new RegExp(`pid ${pid}, run run-live`));
		expect(readFileSync(lock(), "utf8")).toBe(live);
	});

	test("S4 (finding 3): a leftover takeover file refuses, naming it", async () => {
		mkdirSync(join(evalsDir, "results"), { recursive: true });
		killHolder();
		writeFileSync(`${lock()}.takeover`, JSON.stringify({ pid: deadPid() }));
		await expect(runGate(options({}))).rejects.toThrow(`${lock()}.takeover`);
		expect(launches).toEqual([]);
	});

	test("S4 (finding 4): a lock naming this process's pid but a run it does not hold is stale", async () => {
		mkdirSync(join(evalsDir, "results"), { recursive: true });
		writeFileSync(
			lock(),
			JSON.stringify({ pid: process.pid, runId: "20261012T000000Z-killed" }),
		);
		const { result } = await runGate(options({}));
		expect(result.outcome).toBe("pass");
	});

	test("S4 (finding 5): a lock held by another process refuses, naming its pid", async () => {
		const json = join(evalsDir, `results/${HEX}.json`);
		const holder = Bun.spawn(
			[
				process.execPath,
				"-e",
				`const { holdLock } = await import(${JSON.stringify(join(import.meta.dir, "gate.ts"))});
holdLock(${JSON.stringify(json)}, "run-child");
console.log("held");
await Bun.sleep(30_000);`,
			],
			{ stdout: "pipe" },
		);
		children.push(holder);
		const reader = holder.stdout.getReader();
		const { value } = await reader.read();
		expect(new TextDecoder().decode(value)).toBe("held\n");
		await expect(runGate(options({}))).rejects.toThrow(
			`pid ${holder.pid}, run run-child`,
		);
		expect(launches).toEqual([]);
	});

	test("S4 (finding 5): processes racing for one lock leave exactly one holder each time", async () => {
		const dir = join(scratch, "race");
		mkdirSync(dir);
		const ROUNDS = 25;
		const start = Date.now() + 1_500;
		const racers = Array.from({ length: 6 }, (_, n) =>
			Bun.spawn(
				[
					process.execPath,
					"-e",
					`const { holdLock } = await import(${JSON.stringify(join(import.meta.dir, "gate.ts"))});
const won = [];
for (let round = 0; round < ${ROUNDS}; round++) {
	const at = ${start} + round * 25;
	while (Date.now() < at) {}
	try {
		holdLock(${JSON.stringify(dir)} + "/r" + round + ".json", "racer-${n}");
		won.push(round);
	} catch {}
}
console.log(JSON.stringify(won));
await Bun.sleep(500);`,
				],
				{ stdout: "pipe" },
			),
		);
		children.push(...racers);
		const won = await Promise.all(
			racers.map(async (racer) =>
				JSON.parse((await new Response(racer.stdout).text()).trim()),
			),
		);
		const holders = Array.from(
			{ length: ROUNDS },
			(_, round) => won.filter((rounds) => rounds.includes(round)).length,
		);
		expect(holders).toEqual(Array(ROUNDS).fill(1));
	}, 30_000);

	test("S4: a lock that cannot be read at release does not replace the result", async () => {
		const opts = options({});
		const wave = opts.runWave;
		opts.runWave = async (jobs) => {
			chmodSync(lock(), 0o000);
			return wave(jobs);
		};
		try {
			const { result } = await runGate(opts);
			expect(result.outcome).toBe("pass");
		} finally {
			chmodSync(lock(), 0o644);
		}
	});

	test("S4: an unreadable lock refuses, naming the file", async () => {
		mkdirSync(join(evalsDir, "results"), { recursive: true });
		writeFileSync(lock(), "");
		await expect(runGate(options({}))).rejects.toThrow(lock());
		expect(launches).toEqual([]);
	});
});
