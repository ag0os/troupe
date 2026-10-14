import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRubric } from "./schema";
import {
	buildPacket,
	checkIsolation,
	DROPPED_ATTACHMENTS,
	DROPPED_ENTRIES,
	liveScorerGroups,
	SCORER_ISOLATION,
	type ScorerConfig,
	scoreAll,
	scoreAttempt,
	scorerArgv,
	stopScorers,
	validateDecisions,
} from "./scorer";

let scratch: string;
let fakeDir: string;
let config: ScorerConfig;
const rubric = loadRubric();

const FAKE = String.raw`
import json, os, subprocess, sys, time
argv = sys.argv[1:]
here = os.environ['FAKE_SCORER_DIR']
if '--help' in argv:
    help_text = open(os.path.join(here, 'help.txt')).read()
    print(help_text)
    raise SystemExit(0)
if '--version' in argv:
    print('9.9.9 (Claude Code)')
    raise SystemExit(0)
packet = sys.stdin.read()
n = 0
while True:
    # Each fake claims its step atomically; concurrent fakes never share one.
    try:
        os.close(os.open(os.path.join(here, f'step-{n}'), os.O_CREAT | os.O_EXCL))
        break
    except FileExistsError:
        n += 1
plan = json.load(open(os.path.join(here, 'plan.json')))
step = plan[min(n, len(plan) - 1)]
with open(os.path.join(here, 'calls.jsonl'), 'a') as log:
    log.write(json.dumps({'n': n, 'argv': argv, 'cwd': os.getcwd(), 'start': time.time(),
                          'cwd_entries': os.listdir('.'), 'packet': len(packet)}) + '\n')
if step.get('orphan'):
    child = subprocess.Popen(['sleep', '30'])
    open(os.path.join(here, 'orphan.pid'), 'w').write(str(child.pid))
time.sleep(step.get('sleep', 0))
with open(os.path.join(here, 'calls.jsonl'), 'a') as log:
    log.write(json.dumps({'n': n, 'end': time.time()}) + '\n')
if step.get('exit'):
    sys.stderr.write('warming up\nboom: quota exceeded\n')
if 'raw' in step:
    sys.stdout.write(step['raw'])
else:
    session = argv[argv.index('--session-id') + 1]
    print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': step.get('is_error', False),
                      'result': step['result'] if isinstance(step['result'], str) else json.dumps(step['result']),
                      'session_id': session, 'total_cost_usd': 0.25,
                      'modelUsage': {step.get('model', 'claude-opus-5-5'): {'costUSD': 0.25}}}))
sys.stdout.flush()
time.sleep(step.get('linger', 0))
raise SystemExit(step.get('exit', 0))
`;

const HELP = [
	"Usage: claude [options]",
	...SCORER_ISOLATION.map((flag) => `  ${flag} <x>   description`),
].join("\n");

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-evals-scorer-")));
	fakeDir = join(scratch, "fake");
	mkdirSync(fakeDir);
	writeFileSync(join(fakeDir, "fake.py"), FAKE);
	writeFileSync(join(fakeDir, "help.txt"), HELP);
	const claude = join(fakeDir, "claude");
	writeFileSync(
		claude,
		`#!/bin/sh\nexec python3 -I ${join(fakeDir, "fake.py")} "$@"\n`,
	);
	chmodSync(claude, 0o755);
	config = {
		claude,
		model: "claude-opus-5-5",
		effort: "high",
		timeoutMs: 5_000,
		graceMs: 200,
		workRoot: join(scratch, "scorer"),
		env: { ...process.env, FAKE_SCORER_DIR: fakeDir } as Record<string, string>,
		prompt: readFileSync(join(import.meta.dir, "scorer-prompt.md"), "utf8"),
	};
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function resetSteps() {
	for (const name of readdirSync(fakeDir)) {
		if (name.startsWith("step-")) rmSync(join(fakeDir, name));
	}
}

function plan(...steps: Record<string, unknown>[]) {
	writeFileSync(join(fakeDir, "plan.json"), JSON.stringify(steps));
}

function calls() {
	const path = join(fakeDir, "calls.jsonl");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];
}

const LOG_LINE = JSON.stringify({
	type: "assistant",
	timestamp: "2026-10-13T15:11:14.662Z",
	message: {
		content: [
			{
				type: "tool_use",
				id: "toolu_1",
				name: "Bash",
				input: { command: "shepherd tool start" },
			},
		],
	},
});

function exported(): string {
	const dir = join(scratch, "attempt");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "claude.jsonl"), `${LOG_LINE}\n{"type":"user"}\n`);
	writeFileSync(
		join(dir, "claude-fixture-notes.md"),
		"# Trial A fixture facts\nNEXT: Edit settings.\n",
	);
	writeFileSync(
		join(dir, "claude-stdout.txt"),
		"I set page_size to 24 first.\n",
	);
	writeFileSync(
		join(dir, "claude-baseline.json"),
		JSON.stringify({
			snapshotVersion: 1,
			files: {
				"ledger/settings.txt": {
					type: "file",
					encoding: "utf-8",
					content: "page_size=16\n",
				},
			},
		}),
	);
	writeFileSync(
		join(dir, "claude-final.json"),
		JSON.stringify({
			snapshotVersion: 1,
			files: {
				"ledger/settings.txt": {
					type: "file",
					encoding: "utf-8",
					content: "page_size=24\n",
				},
			},
		}),
	);
	writeFileSync(
		join(dir, "claude-diff.patch"),
		"--- a/ledger/settings.txt\n+++ b/ledger/settings.txt\n",
	);
	writeFileSync(
		join(dir, "claude-run.json"),
		JSON.stringify({ expected: "LABEL: regression" }),
	);
	writeFileSync(
		join(dir, "must-check.json"),
		JSON.stringify({ "A.M1": "pass" }),
	);
	return dir;
}

const good = (outcome = "pass") => ({
	decisions: [
		{
			id: "A.M2",
			outcome,
			rationale: "It names the NEXT first.",
			evidence: [
				{
					artifact: "claude-stdout.txt",
					line: 1,
					quote: "I set page_size to 24 first.",
				},
				{
					artifact: "claude.jsonl",
					line: 1,
					callId: "toolu_1",
					quote: "shepherd tool start",
				},
				{
					artifact: "claude-final.json",
					path: "ledger/settings.txt",
					lines: [1, 1],
					quote: "page_size=24",
				},
			],
		},
	],
});

async function score(round = 1) {
	const packet = buildPacket({
		trial: "A",
		dir: exported(),
		requested: ["A.M2"],
		rubric,
	});
	return {
		packet,
		scored: await scoreAttempt({
			config,
			packet,
			requested: ["A.M2"],
			round,
			cliVersion: "9.9.9",
		}),
	};
}

describe("scorer launch (4.1, 4.3)", () => {
	test("isolates tools, MCP, settings, project instructions and hooks, with the fixed model and effort", () => {
		const argv = scorerArgv(config, "00000000-0000-4000-8000-000000000009");
		const value = (flag: string) => argv[argv.indexOf(flag) + 1] ?? "";
		expect(argv[0]).toBe(config.claude);
		expect(argv).toContain("--print");
		expect(value("--model")).toBe("claude-opus-5-5");
		expect(value("--effort")).toBe("high");
		expect(value("--tools")).toBe("");
		expect(argv).toContain("--strict-mcp-config");
		expect(JSON.parse(value("--mcp-config"))).toEqual({ mcpServers: {} });
		expect(value("--setting-sources")).toBe("");
		expect(JSON.parse(value("--settings"))).toEqual({ disableAllHooks: true });
		expect(argv).toContain("--safe-mode");
		expect(argv).toContain("--disable-slash-commands");
		expect(argv).toContain("--no-session-persistence");
		expect(value("--output-format")).toBe("json");
		expect(value("--system-prompt")).toBe(config.prompt);
		expect(argv).not.toContain("--fallback-model");
		expect(argv).not.toContain("--resume");
	});

	test("unsupported isolation is an error before any scoring", () => {
		expect(checkIsolation(config).cliVersion).toBe("9.9.9 (Claude Code)");
		writeFileSync(
			join(fakeDir, "help.txt"),
			HELP.replace("--safe-mode", "--other"),
		);
		expect(() => checkIsolation(config)).toThrow(
			/unsupported isolation.*--safe-mode/i,
		);
	});

	test("scores in a fresh, empty, isolated directory and records the invocation", async () => {
		plan({ result: good() });
		const { packet, scored } = await score();
		const [call] = calls();
		expect(call.cwd.startsWith(realpathSync(config.workRoot))).toBe(true);
		expect(call.cwd_entries).toEqual([]);
		expect(scored.invocations).toHaveLength(1);
		const [invocation] = scored.invocations;
		expect(invocation?.failure).toBeNull();
		expect(invocation?.observedModels).toEqual(["claude-opus-5-5"]);
		expect(invocation?.argv).toEqual(
			call.argv.length ? [config.claude, ...call.argv] : [],
		);
		expect(invocation?.packetSha256).toBe(packet.sha256);
		expect(invocation?.cost).toEqual({
			usd: 0.25,
			reason: null,
			usage: { "claude-opus-5-5": { costUSD: 0.25 } },
			source: "scorer output total_cost_usd",
		});
		expect(invocation?.sessionId).toBe(
			call.argv[call.argv.indexOf("--session-id") + 1],
		);
		expect(scored.decisions?.[0]).toMatchObject({
			id: "A.M2",
			outcome: "pass",
		});
	});
});

describe("blind packet (4.2)", () => {
	test("holds only the rubric for requested Musts, fixture facts, transcript, answer, snapshots and diff", () => {
		const packet = buildPacket({
			trial: "A",
			dir: exported(),
			requested: ["A.M2"],
			rubric,
		});
		expect(packet.files.map((f) => f.name).sort()).toEqual(
			[
				"claude-baseline.json",
				"claude-diff.patch",
				"claude-final.json",
				"claude-fixture-notes.md",
				"claude-stdout.txt",
				"claude.jsonl",
			].sort(),
		);
		expect(packet.text).toContain(
			rubric.musts.find((m) => m.id === "A.M2")?.requirement ?? "?",
		);
		expect(packet.text).not.toContain(
			rubric.musts.find((m) => m.id === "A.M1")?.requirement ?? "?",
		);
		expect(packet.text).not.toContain("LABEL: regression");
		expect(packet.text).not.toContain('"A.M1": "pass"');
		expect(packet.text).toContain(LOG_LINE);
		expect(packet.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(
			buildPacket({
				trial: "A",
				dir: join(scratch, "attempt"),
				requested: ["A.M2"],
				rubric,
			}).sha256,
		).toBe(packet.sha256);
	});
});

describe("packet line numbers and slimming", () => {
	const listing = (type: string, body: Record<string, unknown>) =>
		JSON.stringify({
			type: "attachment",
			timestamp: "2026-10-13T15:11:10.000Z",
			attachment: { type, ...body },
		});
	const KEPT = JSON.stringify({
		type: "user",
		timestamp: "2026-10-13T15:11:20.000Z",
		message: { content: "the kept user line" },
	});
	const thinking = (text: string) =>
		JSON.stringify({
			type: "assistant",
			message: {
				content: [{ type: "thinking", thinking: text, signature: "SIGNED" }],
			},
		});
	// One line of every dropped kind, each carrying a marker the packet must not show.
	const DROPPED_LINES = [
		...DROPPED_ATTACHMENTS.map((kind) =>
			listing(kind, { text: `DROPPED-${kind}` }),
		),
		...DROPPED_ENTRIES.map((type) =>
			JSON.stringify({ type, text: `DROPPED-${type}` }),
		),
		thinking(""),
	];
	const LOG = [
		DROPPED_LINES[0] ?? "",
		LOG_LINE,
		...DROPPED_LINES.slice(1, 6),
		listing("date", { date: "2026-10-13" }),
		KEPT,
		...DROPPED_LINES.slice(6),
		thinking("THOUGHT-KEPT"),
	];
	const DIFF = [
		"--- a/ledger/settings.txt",
		"+++ b/ledger/settings.txt",
		"@@ -1 +1 @@",
		"-page_size=16",
		"+page_size=24",
		"",
	].join("\n");

	function numbered(): string {
		const dir = exported();
		writeFileSync(join(dir, "claude.jsonl"), `${LOG.join("\n")}\n`);
		writeFileSync(join(dir, "claude-diff.patch"), DIFF);
		writeFileSync(
			join(dir, "claude-stdout.txt"),
			"I set page_size to 24 first.\nNo newline ends this line.",
		);
		writeFileSync(
			join(dir, "claude-final.json"),
			JSON.stringify({
				snapshotVersion: 1,
				files: {
					"ledger/settings.txt": {
						type: "file",
						encoding: "utf-8",
						content: "page_size=24\nrows=3\n",
					},
					"ledger/logo.bin": {
						type: "file",
						encoding: "base64",
						content: Buffer.concat([
							Buffer.from("BINARY-BYTES"),
							Buffer.from([0xff, 0x0a]),
						]).toString("base64"),
					},
					"notes/second.md": {
						type: "file",
						encoding: "utf-8",
						content: "second file one\nsecond file two",
					},
				},
			}),
		);
		return dir;
	}

	/** Each snapshot path's shown rows, in order. */
	function byPath(text: string, name: string): Map<string, [number, string][]> {
		const begin = text.indexOf(`\nBEGIN ${name} `);
		const end = text.indexOf(`\nEND ${name} `, begin);
		const paths = new Map<string, [number, string][]>();
		let rows: [number, string][] = [];
		for (const line of text
			.slice(text.indexOf("\n", begin + 1) + 1, end)
			.split("\n")) {
			const header = /^path (\S+) \(/.exec(line);
			const row = /^(\d+)\t(.*)$/s.exec(line);
			if (header) {
				rows = [];
				paths.set(header[1] ?? "", rows);
			} else if (row) rows.push([Number(row[1]), row[2] ?? ""]);
			else rows.push([0, line]);
		}
		return paths;
	}

	const build = () =>
		buildPacket({ trial: "A", dir: numbered(), requested: ["A.M2"], rubric });

	/** The shown lines of one packet file: its number prefix and its text. */
	function shown(text: string, name: string): [number, string][] {
		const begin = text.indexOf(`\nBEGIN ${name} `);
		const end = text.indexOf(`\nEND ${name} `, begin);
		return text
			.slice(text.indexOf("\n", begin + 1) + 1, end)
			.split("\n")
			.flatMap((line): [number, string][] => {
				const match = /^(\d+)\t(.*)$/s.exec(line);
				return match ? [[Number(match[1]), match[2] ?? ""]] : [];
			});
	}

	const decide = (
		packet: ReturnType<typeof build>,
		evidence: Record<string, unknown>,
	) => {
		const checked = validateDecisions(
			JSON.stringify({
				decisions: [
					{ id: "A.M2", outcome: "pass", rationale: "r", evidence: [evidence] },
				],
			}),
			["A.M2"],
			packet,
		);
		if ("failure" in checked) throw new Error(checked.failure);
		return checked.decisions[0]?.outcome;
	};

	test("every shown number is the validator's count of that line", () => {
		const packet = build();
		for (const name of [
			"claude-fixture-notes.md",
			"claude.jsonl",
			"claude-stdout.txt",
			"claude-diff.patch",
		]) {
			const lines =
				packet.files.find((f) => f.name === name)?.content.split("\n") ?? [];
			const rows = shown(packet.text, name);
			expect(rows.length).toBeGreaterThan(0);
			for (const [n, text] of rows) expect(text).toBe(lines[n - 1] ?? "?");
		}
		expect(shown(packet.text, "claude-fixture-notes.md")[0]).toEqual([
			1,
			"# Trial A fixture facts",
		]);
		expect(shown(packet.text, "claude-diff.patch")).toContainEqual([
			3,
			"@@ -1 +1 @@",
		]);
		expect(shown(packet.text, "claude-stdout.txt").at(-1)).toEqual([
			2,
			"No newline ends this line.",
		]);
	});

	test("snapshot file contents are numbered per path as the validator counts them", () => {
		const packet = build();
		const paths = byPath(packet.text, "claude-final.json");
		expect(paths.get("ledger/settings.txt")).toEqual([
			[1, "page_size=24"],
			[2, "rows=3"],
		]);
		expect(paths.get("notes/second.md")).toEqual([
			[1, "second file one"],
			[2, "second file two"],
		]);
		const cite = (path: string, lines: [number, number], quote: string) =>
			decide(packet, { artifact: "claude-final.json", path, lines, quote });
		expect(cite("ledger/settings.txt", [1, 1], "page_size=24")).toBe("pass");
		expect(cite("notes/second.md", [2, 2], "second file two")).toBe("pass");
		expect(cite("notes/second.md", [1, 1], "second file two")).toBe(
			"inconclusive",
		);
	});

	test("a binary snapshot record is shown as a marker, never decoded", () => {
		const packet = build();
		expect(
			byPath(packet.text, "claude-final.json").get("ledger/logo.bin"),
		).toEqual([]);
		expect(packet.text).toContain(
			"path ledger/logo.bin (binary, 14 bytes, not shown)",
		);
		expect(packet.text).not.toContain("BINARY-BYTES");
	});

	test("a quote cited at its shown number validates, and one line off is demoted", () => {
		const packet = build();
		const at = (artifact: string, line: number, quote: string) =>
			decide(packet, { artifact, line, quote });
		expect(at("claude-diff.patch", 3, "@@ -1 +1 @@")).toBe("pass");
		expect(at("claude-diff.patch", 4, "@@ -1 +1 @@")).toBe("inconclusive");
		expect(at("claude-stdout.txt", 2, "No newline ends")).toBe("pass");
		expect(at("claude-stdout.txt", 1, "No newline ends")).toBe("inconclusive");
		const kept = LOG.indexOf(KEPT) + 1;
		expect(at("claude.jsonl", kept, "the kept user line")).toBe("pass");
		expect(at("claude.jsonl", kept - 1, "the kept user line")).toBe(
			"inconclusive",
		);
	});

	test("the prompt checked in tells the scorer the numbers are a prefix", () => {
		expect(config.prompt).toMatch(/prefix/);
		expect(config.prompt).toMatch(/not part of/);
	});

	test("the dropped kinds are exactly these", () => {
		expect([...DROPPED_ATTACHMENTS]).toEqual([
			"prompt_snapshot",
			"skill_listing",
			"agent_listing_delta",
			"mcp_instructions_delta",
			"deferred_tools_delta",
			"deferred_tools_record",
			"total_tokens_reminder",
			"session_context",
			"credential_org",
			"auto_mode",
			"model",
			"remote_session_change",
		]);
		expect([...DROPPED_ENTRIES]).toEqual([
			"last-prompt",
			"cost-state",
			"atis-latch",
		]);
	});

	test("the log copy drops every listed kind, keeps original numbers and names what it dropped", () => {
		const packet = build();
		for (const line of DROPPED_LINES) {
			expect(packet.text).not.toContain(line);
			const marker = /DROPPED-[\w-]+/.exec(line)?.[0];
			if (marker) expect(packet.text).not.toContain(marker);
		}
		const kept = [
			LOG_LINE,
			LOG[LOG.indexOf(KEPT) - 1] ?? "",
			KEPT,
			LOG.at(-1) ?? "",
		];
		expect(shown(packet.text, "claude.jsonl")).toEqual(
			kept.map((line) => [LOG.indexOf(line) + 1, line]),
		);
		expect(packet.text).toContain(
			`dropped ${DROPPED_LINES.length} of ${LOG.length} lines`,
		);
		for (const kind of [
			...DROPPED_ATTACHMENTS.map((k) => `attachment ${k}`),
			...DROPPED_ENTRIES,
			"assistant thinking without text",
		])
			expect(packet.text).toContain(`${kind}: 1`);
		// The validator still reads the archived log, whole.
		expect(packet.files.find((f) => f.name === "claude.jsonl")?.content).toBe(
			`${LOG.join("\n")}\n`,
		);
	});
});

describe("decisions and retries (4.4, 4.5)", () => {
	test("a missing decision is schema-invalid and retried once on the identical packet", async () => {
		plan({ result: { decisions: [] } }, { result: good() });
		const { packet, scored } = await score();
		expect(scored.invocations.map((i) => i.failure)).toEqual([
			expect.stringMatching(/schema-invalid.*A\.M2/),
			null,
		]);
		expect(scored.invocations[1]?.retryReason).toBe(
			scored.invocations[0]?.failure ?? "?",
		);
		expect(
			scored.invocations.every((i) => i.packetSha256 === packet.sha256),
		).toBe(true);
		expect(
			calls()
				.filter((c) => "packet" in c)
				.map((c) => c.packet),
		).toEqual([packet.text.length, packet.text.length]);
		expect(scored.decisions?.[0]?.outcome).toBe("pass");
	});

	test("a well-formed fail or inconclusive verdict is final", async () => {
		for (const outcome of ["fail", "inconclusive"] as const) {
			resetSteps();
			plan({ result: good(outcome) }, { result: good("pass") });
			const { scored } = await score();
			expect(scored.invocations).toHaveLength(1);
			expect(scored.decisions?.[0]?.outcome).toBe(outcome);
		}
	});

	test("unknown, duplicate and extra Must ids are schema-invalid", async () => {
		const extra = good();
		const [decision] = extra.decisions;
		if (decision) extra.decisions.push({ ...decision, id: "A.M1" });
		plan(
			{ result: extra },
			{ result: { decisions: [good().decisions[0], good().decisions[0]] } },
		);
		const { scored } = await score();
		expect(scored.invocations.map((i) => i.failure)).toEqual([
			expect.stringMatching(/A\.M1/),
			expect.stringMatching(/duplicate/),
		]);
		expect(scored.decisions).toBeUndefined();
	});

	test("timeouts, nonzero exits, unparsable output and other models are infrastructure failures", async () => {
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ result: good(), sleep: 3 }, /timeout/],
			[{ raw: "", exit: 1 }, /nonzero exit 1: boom: quota exceeded/],
			[{ raw: "not json" }, /unparsable/],
			[{ result: "Here you go: {}" }, /unparsable JSON/],
			[
				{ result: good(), is_error: true },
				/schema-invalid output: the CLI reported an error result/,
			],
		];
		config.timeoutMs = 600;
		for (const [step, failure] of cases) {
			resetSteps();
			plan(step, { result: good() });
			const { scored } = await score();
			expect(scored.invocations[0]?.failure ?? "").toMatch(failure);
			expect(scored.invocations).toHaveLength(2);
			expect(scored.decisions?.[0]?.outcome).toBe("pass");
		}
	}, 30_000);

	test("a complete verdict printed before a timeout, a kill or a nonzero exit is the verdict (G1 fix round 1)", async () => {
		config.timeoutMs = 1_500;
		for (const step of [
			{ result: good("fail"), linger: 10 },
			{ result: good("fail"), exit: 1 },
		]) {
			resetSteps();
			plan(step, { result: good("pass") });
			const { scored } = await score();
			expect(scored.invocations).toHaveLength(1);
			expect(scored.invocations[0]?.failure).toBeNull();
			expect(scored.invocations[0]?.observedModels).toEqual([
				"claude-opus-5-5",
			]);
			expect(scored.decisions?.[0]?.outcome).toBe("fail");
		}
		expect(calls().filter((c) => "packet" in c)).toHaveLength(2);
	}, 30_000);

	test("another or missing observed model is invalid output, retried once (addendum C)", async () => {
		plan({ result: good(), model: "claude-sonnet-5-5" }, { result: good() });
		const { scored } = await score();
		expect(scored.invocations).toHaveLength(2);
		expect(scored.invocations[0]?.failure).toMatch(
			/^schema-invalid output: observed model claude-sonnet-5-5/,
		);
		expect(scored.decisions?.[0]?.outcome).toBe("pass");
	});

	test("the invocation record keeps the scorer's stderr, bounded", async () => {
		plan({ raw: "", exit: 1 }, { result: good() });
		const { scored } = await score();
		expect(scored.invocations[0]?.stderr).toBe(
			"warming up\nboom: quota exceeded",
		);
		expect(scored.invocations[1]?.stderr).toBe("");
	});

	test("exhausted retries leave the attempt unscored, and a later round scores again", async () => {
		plan({ raw: "", exit: 2 });
		const { scored } = await score();
		expect(scored.invocations).toHaveLength(2);
		expect(scored.decisions).toBeUndefined();
		plan({ result: good() });
		const later = await score(2);
		expect(later.scored.invocations.map((i) => i.round)).toEqual([2]);
		expect(later.scored.decisions?.[0]?.outcome).toBe("pass");
	});

	test("unsupported evidence makes a decision inconclusive without a retry", async () => {
		const unsupported = good();
		const evidence = unsupported.decisions[0]?.evidence[0];
		if (evidence) evidence.quote = "words that are not there";
		const noEvidence = good();
		if (noEvidence.decisions[0]) noEvidence.decisions[0].evidence = [];
		for (const result of [unsupported, noEvidence]) {
			resetSteps();
			plan({ result });
			const { scored } = await score();
			expect(scored.invocations).toHaveLength(1);
			expect(scored.decisions?.[0]?.outcome).toBe("inconclusive");
			expect(scored.decisions?.[0]?.rationale).toMatch(/unsupported/);
		}
	});

	test("a timeout kills the scorer's whole process group", async () => {
		config.timeoutMs = 500;
		plan({ result: good(), sleep: 10, orphan: true }, { result: good() });
		await score();
		const pid = Number(readFileSync(join(fakeDir, "orphan.pid"), "utf8"));
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	}, 20_000);
});

describe("bounds and cleanup (review finding 9)", () => {
	const orphanPid = () =>
		Number(readFileSync(join(fakeDir, "orphan.pid"), "utf8"));
	const orphanAlive = (pid = orphanPid()) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	// The fake creates the pid file before writing it, so wait for its content.
	const waitForOrphan = async () => {
		const path = join(fakeDir, "orphan.pid");
		for (
			let i = 0;
			i < 200 && !(existsSync(path) && readFileSync(path, "utf8") !== "");
			i++
		)
			await Bun.sleep(20);
	};

	test("cancellation stops a running scorer's whole process group at once, without a retry", async () => {
		plan({ result: good(), sleep: 30, orphan: true });
		const controller = new AbortController();
		const packet = buildPacket({
			trial: "A",
			dir: exported(),
			requested: ["A.M2"],
			rubric,
		});
		const started = Date.now();
		const running = scoreAttempt({
			config,
			packet,
			requested: ["A.M2"],
			round: 1,
			cliVersion: "9",
			signal: controller.signal,
		});
		await waitForOrphan();
		controller.abort();
		const scored = await running;
		expect(Date.now() - started).toBeLessThan(4_000);
		expect(scored.invocations).toHaveLength(1);
		expect(scored.invocations[0]?.failure).toBe("cancelled");
		expect(orphanAlive()).toBe(false);
		expect(liveScorerGroups.size).toBe(0);
	}, 20_000);

	test("stopScorers kills every live scorer group (the exit handler)", async () => {
		// The killed invocation is retried; the retry must neither replace the
		// orphan being watched nor outlast the test.
		plan({ result: good(), sleep: 30, orphan: true }, { result: good() });
		const packet = buildPacket({
			trial: "A",
			dir: exported(),
			requested: ["A.M2"],
			rubric,
		});
		const running = scoreAttempt({
			config,
			packet,
			requested: ["A.M2"],
			round: 1,
			cliVersion: "9",
		});
		await waitForOrphan();
		const orphan = orphanPid();
		expect(liveScorerGroups.size).toBe(1);
		stopScorers();
		for (let i = 0; i < 100 && orphanAlive(orphan); i++) await Bun.sleep(20);
		expect(orphanAlive(orphan)).toBe(false);
		await running;
	}, 20_000);

	test("no invocation starts that could not finish before the deadline", async () => {
		plan({ result: good() });
		const packet = buildPacket({
			trial: "A",
			dir: exported(),
			requested: ["A.M2"],
			rubric,
		});
		const scored = await scoreAttempt({
			config,
			packet,
			requested: ["A.M2"],
			round: 1,
			cliVersion: "9",
			deadline: Date.now() + 1_000,
		});
		expect(scored.invocations).toEqual([]);
		expect(calls()).toEqual([]);
	});
});

describe("concurrency (4.5)", () => {
	test("never runs more than two scorer processes at once", async () => {
		plan({ result: good(), sleep: 0.4 });
		const dir = exported();
		const jobs = Array.from(
			{ length: 5 },
			() => () =>
				scoreAttempt({
					config,
					packet: buildPacket({ trial: "A", dir, requested: ["A.M2"], rubric }),
					requested: ["A.M2"],
					round: 1,
					cliVersion: "9.9.9",
				}),
		);
		await scoreAll(jobs, 2);
		const log = calls();
		const events = log
			.flatMap((c) => ("start" in c ? [[c.start, 1]] : [[c.end, -1]]))
			.sort((a, b) => a[0] - b[0]);
		let running = 0;
		let most = 0;
		for (const [, delta] of events) {
			running += delta;
			most = Math.max(most, running);
		}
		expect(log.filter((c) => "start" in c)).toHaveLength(5);
		expect(most).toBeLessThanOrEqual(2);
		expect(readdirSync(config.workRoot).length).toBe(5);
	}, 30_000);
});
