import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type GateOptions,
	publishResult,
	pythonChecks,
	runGate,
	summary,
} from "./gate";
import { loadRubric, policyHash, type Result, validateResult } from "./schema";
import { invocation } from "./testing";

const rubric = loadRubric();
const TRIALS = ["A", "D", "E", "G", "E-neg", "G-neg"];
const policy = { trials: TRIALS, model: "claude-opus-5-5", effort: "high" };
const HEX = "c".repeat(64);
const HOME = "/Users/someone";
let scratch: string;
let evalsDir: string;
let launches: { trial: string; ordinal: number }[];
let scored: { trial: string; round: number }[];

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-evals-gate-")));
	evalsDir = join(scratch, "repo/evals/shepherd");
	mkdirSync(evalsDir, { recursive: true });
	launches = [];
	scored = [];
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
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
		argv: [
			binary,
			"--backend",
			"claude",
			"--session-id",
			`00000000-0000-4000-8000-00000000000${ordinal}`,
		],
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
	writeFileSync(join(dir, "claude-final.json"), snapshot(after));
	writeFileSync(join(dir, "claude-diff.patch"), "--- a/x\n+++ b/x\n");
	writeFileSync(join(dir, "claude-stdout.txt"), "Done the NEXT first.\n");
	writeFileSync(
		join(dir, "claude-fixture-notes.md"),
		`# Trial ${trial} fixture facts\n`,
	);
}

function options(
	plan: Record<string, Behaviour[]>,
	verdicts: Record<string, Verdict[]> = {},
	changes: Partial<GateOptions> = {},
): GateOptions {
	const run = join(scratch, `run-${Math.random().toString(16).slice(2, 8)}`);
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
				};
				return { invocations: [first, second], outputs: ["{}", ""] };
			}
			return {
				invocations: [base],
				outputs: ['{"decisions":[]}'],
				decisions: requested.map((id) => ({
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
				})),
			};
		},
		...changes,
	};
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
			summary(result),
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
		);
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
	test("a kill during a wave leaves durable pending attempts that the next invocation resolves", async () => {
		const home = join(scratch, "home");
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
				const session = `00000000-0000-4000-8000-0000000000${trial === "E" ? "bb" : "aa"}`;
				writeFileSync(
					join(dir, "claude-run.json"),
					JSON.stringify({
						trial,
						workspace,
						argv: [`${run}/bin/shepherd`, "--session-id", session],
						HOME: home,
						cli_version: "2.1.296",
						validity: { valid: false, void_reasons: [] },
						provenance: [{ expected_binary: `${run}/bin/shepherd` }],
						started_at: "2026-10-13T15:11:10.000Z",
						ended_at: null,
					}),
				);
				const log = join(
					home,
					".claude/projects",
					workspace.replace(/[^A-Za-z0-9]/g, "-"),
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
												: `binary: ${run}/bin/shepherd\n${home}/secret`,
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
		const text = summary(result);
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
