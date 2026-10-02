import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRunResult } from "../../agents/tools/webfetch";
import { inspectExtension } from "../../scripts/agent-compiler";
import { claudeAdapter } from "./adapters/claude";
import { spec as fixtureSpec } from "./adapters/test-fixtures";
import type { BackendAdapter, StreamDecoder } from "./adapters/types";
import { parseCli } from "./cli";
import {
	type FakeScenario,
	installFakeClis,
	isAlive,
	readRecords,
	waitForFile,
} from "./fake-cli";
import {
	type AgentExtension,
	applyFlagOverrides,
	createPrepareContext,
	createResources,
	decodeStream,
	type ExecuteIo,
	executeAgent,
	type Interpolate,
	interpolateMcp,
	previewAgent,
	RunScope,
	type RunnerSignal,
	runPrepare,
	type SignalSource,
} from "./run";
import { PROMPT_SEPARATOR } from "./schema";
import type {
	AgentSpec,
	PrepareContext,
	PrepareResult,
	RunResult,
} from "./types";

let root: string;
let workspace: string;
let tmpRoot: string;
let bin: string;
let recordFile: string;
let pidFile: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agent-execute-")));
	workspace = join(root, "workspace");
	tmpRoot = join(root, "tmp");
	bin = join(root, "bin");
	for (const dir of [workspace, tmpRoot, bin]) mkdirSync(dir);
	installFakeClis(bin);
	recordFile = join(root, "records.jsonl");
	pidFile = join(root, "backend.pid");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A signal source the test fires by hand, counting live subscriptions. */
function fakeSignals() {
	let handler: ((signal: RunnerSignal) => void) | undefined;
	const state = { subscribed: 0 };
	const source: SignalSource = (next) => {
		handler = next;
		state.subscribed++;
		return () => {
			handler = undefined;
			state.subscribed--;
		};
	};
	return {
		source,
		state,
		send: (signal: RunnerSignal) => handler?.(signal),
	};
}

interface Outcome {
	code: number;
	stdout: string;
	stderr: string;
	/** Every write in order, tagged with its stream. */
	writes: { stream: "stdout" | "stderr"; text: string }[];
	/** What is left in the runner's temp root after the run. */
	leftovers: string[];
}

interface RunOptions {
	scenario?: FakeScenario;
	signals?: SignalSource;
	interpolate?: Interpolate;
	adapterFor?: ExecuteIo["adapterFor"];
	path?: string;
	onWrite?: (stream: "stdout" | "stderr", text: string) => void;
	createResources?: ExecuteIo["createResources"];
	flush?: ExecuteIo["flush"];
	killGraceMs?: number;
}

async function run(
	spec: AgentSpec,
	argv: string[],
	extension: AgentExtension = {},
	options: RunOptions = {},
): Promise<Outcome> {
	const outcome = parseCli(spec, argv, { cwd: workspace });
	if (outcome.kind !== "run") throw new Error("expected a run outcome");
	const result: Outcome = {
		code: 0,
		stdout: "",
		stderr: "",
		writes: [],
		leftovers: [],
	};
	const write = (stream: "stdout" | "stderr") => (text: string) => {
		options.onWrite?.(stream, text);
		result[stream] += text;
		result.writes.push({ stream, text });
	};
	const io: ExecuteIo = {
		stdout: write("stdout"),
		stderr: write("stderr"),
		isDirectory: (path) => existsSync(path) || "missing",
		env: {
			PATH: options.path ?? `${bin}:${process.env.PATH}`,
			HOME: process.env.HOME,
			FAKE_RECORD: recordFile,
			FAKE_PID_FILE: pidFile,
			FAKE_SCENARIO: options.scenario ?? "ok",
		},
		tmpRoot,
	};
	if (options.signals) io.signals = options.signals;
	if (options.interpolate) io.interpolate = options.interpolate;
	if (options.adapterFor) io.adapterFor = options.adapterFor;
	if (options.createResources) io.createResources = options.createResources;
	if (options.flush) io.flush = options.flush;
	if (options.killGraceMs !== undefined) io.killGraceMs = options.killGraceMs;
	result.code = await executeAgent(spec, extension, outcome.invocation, io);
	result.leftovers = readdirSync(tmpRoot);
	return result;
}

/**
 * Start a run without awaiting it, plus a `waitForFile` diagnostic that says
 * how the run ended if the awaited child never started.
 */
function startRun(...args: Parameters<typeof run>) {
	let settled: Outcome | undefined;
	let failure: unknown;
	const pending = run(...args).then(
		(outcome) => {
			settled = outcome;
			return outcome;
		},
		(error) => {
			failure = error;
			throw error;
		},
	);
	const diagnose = () =>
		settled
			? `the run already ended with ${settled.code}; stderr: ${settled.stderr}`
			: failure
				? `the run threw: ${String(failure)}`
				: "the run is still pending";
	return { pending, diagnose };
}

function gitInit(dir: string) {
	const init = Bun.spawnSync(["git", "init", "-q", dir]);
	expect(init.exitCode).toBe(0);
}

/** A finish that records what it received and echoes it as a payload. */
function recordingFinish(seen: RunResult[]): AgentExtension["finish"] {
	return (result) => {
		seen.push(result);
		return {
			exitCode: result.failure ? 9 : 0,
			stdout: `payload:${result.stdout}`,
		};
	};
}

/**
 * A sleeper started through `ctx.runCommand`, whose pid lands in
 * `<root>/prep.pid` so the test can signal once it is running.
 */
function sleeperCommand() {
	const file = join(root, "prep.pid");
	return {
		file,
		argv: ["fake-sleeper", file] as [string, ...string[]],
	};
}

describe("prepare invocation data (AC #1, #3; B-006, D-016)", () => {
	test("fragments, initial prompt, cwd, rules, directories and flag overrides reach the launch", async () => {
		const sub = join(workspace, "sub");
		mkdirSync(sub);
		const agent = fixtureSpec({
			initialPrompt: "focus={{flag.focus}} {{args}}",
			flags: {
				focus: {
					type: "enum",
					description: "Focus",
					values: ["tech", "changes"],
					default: "changes",
				},
			},
			native: {
				claude: { settings: { permissions: { allow: ["Read(//a/**)"] } } },
			},
		});
		const result = await run(agent, ["hi", "--print"], {
			prepare: () => ({
				systemPromptFragments: ["FRAGMENT"],
				cwd: "sub",
				flagOverrides: { focus: "tech" },
				extraAllowRules: {
					rules: ["Read(//a/**)", "Read(//b/**)", "Read(//b/**)"],
					additionalDirectories: ["../shared", "../shared"],
				},
			}),
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("claude result\n");
		const [record] = readRecords(recordFile);
		expect(record?.cwd).toBe(sub);
		const argv = record?.argv ?? [];
		expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe(
			`SYSTEM${PROMPT_SEPARATOR}FRAGMENT`,
		);
		expect(argv.slice(-2)).toEqual(["--", "focus=tech hi"]);
		// Rules and directories merge once with the native settings.
		expect(argv.filter((token) => token === "--settings")).toHaveLength(1);
		expect(JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "")).toEqual({
			permissions: {
				allow: ["Read(//a/**)", "Read(//b/**)"],
				additionalDirectories: [join(workspace, "shared")],
			},
		});
	});

	test("a prepared initial prompt replaces the template", async () => {
		const result = await run(fixtureSpec(), ["ignored", "--print"], {
			prepare: () => ({ initialPrompt: "prepared prompt" }),
		});
		expect(result.code).toBe(0);
		expect(readRecords(recordFile)[0]?.argv.slice(-2)).toEqual([
			"--",
			"prepared prompt",
		]);
	});

	test("prepared data is frozen: later mutation by the extension changes nothing", async () => {
		const returned = {
			systemPromptFragments: ["EARLY"],
			initialPrompt: "EARLY PROMPT",
		};
		// Runs after preparation returned and before the adapter builds.
		const interpolate: Interpolate = async () => {
			returned.systemPromptFragments.push("LATE");
			returned.initialPrompt = "LATE PROMPT";
			return { mcp: {}, env: {} };
		};
		const result = await run(
			fixtureSpec(),
			["--print"],
			{ prepare: () => returned },
			{ interpolate },
		);
		expect(result.code).toBe(0);
		expect(returned.initialPrompt).toBe("LATE PROMPT");
		const argv = readRecords(recordFile)[0]?.argv ?? [];
		expect(argv.join(" ")).not.toContain("LATE");
		expect(argv.at(-1)).toBe("EARLY PROMPT");
	});

	test("the prepared result is deeply frozen, nested arrays and objects included", async () => {
		const agent = fixtureSpec({
			flags: { name: { type: "string", description: "Name" } },
		});
		const parsed = parseCli(agent, [], { cwd: workspace });
		if (parsed.kind !== "run") throw new Error("expected a run outcome");
		const ctx = createPrepareContext(agent, parsed.invocation, {
			signal: new AbortController().signal,
		});
		const outcome = await runPrepare(
			agent,
			{
				prepare: () => ({
					flagOverrides: { name: "x" },
					extraAllowRules: {
						rules: ["Read(//a/**)"],
						additionalDirectories: ["/d"],
					},
					beforeRunMessages: ["B"],
					afterRunMessages: ["A"],
				}),
			},
			ctx,
			{ isDirectory: () => true },
		);
		if (outcome.kind !== "prepared") throw new Error("expected prepared");
		const prepared = outcome.prepared as {
			flags: Record<string, unknown>;
			extraAllowRules: { rules: string[]; additionalDirectories: string[] };
			beforeRunMessages: string[];
			afterRunMessages: string[];
		};
		const mutations = [
			() => prepared.beforeRunMessages.push("LATE"),
			() => prepared.afterRunMessages.push("LATE"),
			() => prepared.extraAllowRules.rules.push("LATE"),
			() => prepared.extraAllowRules.additionalDirectories.push("LATE"),
			() => {
				prepared.extraAllowRules.rules = [];
			},
			() => {
				prepared.flags.name = "LATE";
			},
		];
		for (const mutate of mutations) expect(mutate).toThrow(TypeError);
		expect(prepared.beforeRunMessages).toEqual(["B"]);
		expect(prepared.extraAllowRules.rules).toEqual(["Read(//a/**)"]);
	});

	test("Webfetch-style max-turns normalization is revalidated and rendered", async () => {
		// Webfetch's prepare normalizes finite max turns to max(1, floor(n)),
		// else 3, and returns it as a declared flag override.
		const webfetchLike = fixtureSpec({
			backends: ["claude"],
			initialPrompt: "turns={{flag.max-turns}}",
			flags: {
				"max-turns": { type: "string", description: "Max turns" },
			},
		});
		const extension: AgentExtension = {
			prepare(ctx) {
				const raw = ctx.flags["max-turns"];
				const n = Number(raw);
				const turns =
					typeof raw === "string" && raw !== "" && Number.isFinite(n)
						? Math.max(1, Math.floor(n))
						: 3;
				return { flagOverrides: { "max-turns": String(turns) } };
			},
		};
		const cases: [string[], string][] = [
			[["--max-turns", "7.9"], "7"],
			[["--max-turns", "0"], "1"],
			[["--max-turns=-5"], "1"],
			[["--max-turns", "abc"], "3"],
			[["--max-turns", "Infinity"], "3"],
			[[], "3"],
		];
		for (const [flags, expected] of cases) {
			rmSync(recordFile, { force: true });
			const result = await run(webfetchLike, [...flags, "--print"], extension);
			expect(result.code).toBe(0);
			expect(readRecords(recordFile)[0]?.argv.at(-1)).toBe(`turns=${expected}`);
		}
	});

	test("overrides must name a declared flag with a value the CLI would accept", () => {
		const agent = fixtureSpec({
			flags: {
				quick: { type: "boolean", description: "Quick" },
				name: { type: "string", description: "Name" },
				focus: { type: "enum", description: "Focus", values: ["a", "b"] },
			},
		});
		const base = { quick: false };
		expect(
			applyFlagOverrides(agent, base, { quick: true, name: "x", focus: "b" }),
		).toEqual({ quick: true, name: "x", focus: "b" });
		for (const bad of [
			{ model: "opus" },
			{ unknown: "x" },
			{ quick: "true" },
			{ name: true },
			{ focus: "c" },
		] as Record<string, string | boolean>[]) {
			expect(() => applyFlagOverrides(agent, base, bad)).toThrow(
				/flagOverrides\./,
			);
		}
	});

	test("an invalid override is a prepare failure: stderr/1, nothing launched", async () => {
		const result = await run(fixtureSpec(), [], {
			prepare: () => ({ flagOverrides: { model: "opus" } }),
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("prepare failed: flagOverrides.model");
		expect(readRecords(recordFile)).toEqual([]);
	});

	test("a nonempty rule object on Codex fails closed; an empty one is accepted", async () => {
		gitInit(workspace);
		const denied = await run(fixtureSpec(), ["--backend", "codex", "--print"], {
			prepare: () => ({ extraAllowRules: { rules: ["Read(//x/**)"] } }),
		});
		expect(denied.code).toBe(1);
		expect(denied.stdout).toBe("");
		expect(denied.stderr).toContain("Claude-only");
		expect(readRecords(recordFile)).toEqual([]);

		const empty = await run(fixtureSpec(), ["--backend", "codex", "--print"], {
			prepare: () => ({
				extraAllowRules: { rules: [], additionalDirectories: [] },
			}),
		});
		expect(empty.code).toBe(0);
		expect(empty.stdout).toBe("codex result\n");
	});

	test("the runner refuses Codex rules at prepare, before interpolation runs", async () => {
		gitInit(workspace);
		const seen: RunResult[] = [];
		let interpolated = 0;
		const result = await run(
			fixtureSpec(),
			["--backend", "codex", "--print"],
			{
				prepare: () => ({ extraAllowRules: { rules: ["Read(//x/**)"] } }),
				finish: recordingFinish(seen),
			},
			{
				interpolate: async () => {
					interpolated++;
					return { mcp: {}, env: {} };
				},
			},
		);
		expect(result.code).toBe(9);
		expect(seen[0]?.failure?.stage).toBe("prepare");
		expect(seen[0]?.failure?.message).toContain("Claude-only");
		expect(interpolated).toBe(0);
		expect(readRecords(recordFile)).toEqual([]);
	});
});

describe("exits (AC #2; B-006)", () => {
	test("an early exit writes exactly its message on its stream with its code and launches nothing", async () => {
		for (const [stream, code] of [
			["stdout", 64],
			["stderr", 2],
		] as const) {
			for (const mode of [[], ["--print"]]) {
				const result = await run(fixtureSpec(), mode, {
					prepare: () => ({
						exit: { message: "ERROR: missing URL.", code, stream },
					}),
					finish: () => {
						throw new Error("finish must not run on an early exit");
					},
				});
				expect(result.code).toBe(code);
				expect(result.writes).toEqual([
					{ stream, text: "ERROR: missing URL." },
				]);
				expect(result.leftovers).toEqual([]);
			}
		}
		expect(readRecords(recordFile)).toEqual([]);
	});

	test("a prepare throw or command failure is stderr/1 in interactive and stream mode", async () => {
		const throwing: AgentExtension = {
			prepare() {
				throw new Error("boom");
			},
		};
		const commandFailure: AgentExtension = {
			async prepare(ctx) {
				await ctx.runCommand({ argv: ["definitely-not-a-command-xyz"] });
				return {};
			},
		};
		for (const mode of ["interactive", "stream"] as const) {
			for (const extension of [throwing, commandFailure]) {
				const result = await run(fixtureSpec({ mode }), [], extension);
				expect(result.code).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toStartWith("test:agent: prepare failed: ");
			}
		}
		expect(readRecords(recordFile)).toEqual([]);
	});

	test("in print mode a prepare throw or command failure reaches finish as a failure RunResult", async () => {
		const seen: RunResult[] = [];
		const result = await run(fixtureSpec(), ["--print"], {
			async prepare(ctx) {
				await ctx.runCommand({ argv: ["definitely-not-a-command-xyz"] });
				return {};
			},
			finish: recordingFinish(seen),
		});
		expect(result.code).toBe(9);
		expect(result.stdout).toBe("payload:");
		expect(result.stderr).toBe("");
		expect(seen[0]?.failure?.stage).toBe("prepare");
		expect(seen[0]?.exitCode).toBe(1);
	});

	test("before-run messages print after preparation and before spawn; after-run messages follow success", async () => {
		const order: string[] = [];
		let preparedAt = -1;
		const result = await run(
			fixtureSpec({ mode: "stream" }),
			[],
			{
				prepare() {
					preparedAt = order.length;
					return {
						beforeRunMessages: ["BEFORE"],
						afterRunMessages: ["AFTER"],
					};
				},
			},
			{
				onWrite: (stream, text) => {
					// The backend has not been launched when the banner is written.
					if (text === "BEFORE\n") {
						expect(readRecords(recordFile)).toEqual([]);
					}
					order.push(`${stream}:${text}`);
				},
			},
		);
		expect(result.code).toBe(0);
		expect(preparedAt).toBe(0);
		expect(result.stdout).toBe("BEFORE\nhello from claude\nAFTER\n");
		expect(order[0]).toBe("stdout:BEFORE\n");
		expect(order.at(-1)).toBe("stdout:AFTER\n");
	});

	test("after-run messages follow a successful interactive run and are suppressed on failure", async () => {
		const extension: AgentExtension = {
			prepare: () => ({ afterRunMessages: ["DONE"] }),
		};
		const ok = await run(fixtureSpec(), [], extension);
		expect(ok.code).toBe(0);
		expect(ok.stdout).toBe("DONE\n");
		const failed = await run(fixtureSpec(), [], extension, {
			scenario: "fail",
		});
		expect(failed.code).toBe(3);
		expect(failed.stdout).toBe("");
	});

	test("a print-payload agent that returns before-run or after-run messages is rejected (AC #9)", async () => {
		for (const messages of [
			{ beforeRunMessages: ["banner"] },
			{ afterRunMessages: ["banner"] },
		]) {
			const seen: RunResult[] = [];
			const result = await run(fixtureSpec({ mode: "print" }), [], {
				prepare: () => messages,
				finish: recordingFinish(seen),
			});
			expect(seen[0]?.failure?.stage).toBe("prepare");
			expect(seen[0]?.failure?.message).toContain("print mode");
			expect(result.stdout).not.toContain("banner");
			expect(result.code).toBe(9);
		}
		expect(readRecords(recordFile)).toEqual([]);
	});
});

describe("finish (AC #4; B-006)", () => {
	test("finish runs only in print mode and its FinishResult is written verbatim", async () => {
		const seen: RunResult[] = [];
		const finish = (result: RunResult) => {
			seen.push(result);
			return { exitCode: 5, stdout: "OUT", stderr: "ERR" };
		};
		const print = await run(fixtureSpec(), ["--print"], { finish });
		expect(print.code).toBe(5);
		expect(print.writes).toEqual([
			{ stream: "stdout", text: "OUT" },
			{ stream: "stderr", text: "ERR" },
		]);
		expect(seen).toEqual([
			{ exitCode: 0, stdout: "claude result\n", stderr: "" },
		]);

		const absent = await run(fixtureSpec(), ["--print"], {
			finish: () => ({ exitCode: 0 }),
		});
		expect(absent.writes).toEqual([]);

		for (const mode of ["interactive", "stream"] as const) {
			const other = await run(fixtureSpec({ mode }), [], { finish });
			expect(other.code).toBe(0);
		}
		expect(seen).toHaveLength(1);
	});

	test("a backend failure in print mode reaches finish with stage backend and the captured output", async () => {
		const seen: RunResult[] = [];
		await run(
			fixtureSpec(),
			["--print"],
			{ finish: recordingFinish(seen) },
			{ scenario: "fail" },
		);
		expect(seen[0]).toMatchObject({
			exitCode: 3,
			stdout: "partial output\n",
			stderr: "backend exploded\n",
			failure: { stage: "backend" },
		});
	});

	test("print without finish writes the captured output and exits with the child's code", async () => {
		const result = await run(
			fixtureSpec(),
			["--print"],
			{},
			{ scenario: "fail" },
		);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("partial output\n");
		expect(result.stderr).toBe("backend exploded\n");
	});

	test("a finish throw cleans up, then exits stderr/1", async () => {
		const result = await run(
			fixtureSpec(),
			["--print"],
			{
				finish() {
					throw new Error("finish exploded");
				},
			},
			{
				onWrite: (stream) => {
					// Cleanup has already removed the TMPDIR when stderr is written.
					if (stream === "stderr") expect(readdirSync(tmpRoot)).toEqual([]);
				},
			},
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("test:agent: finish failed: finish exploded\n");
		expect(result.leftovers).toEqual([]);
	});
});

describe("stream decoders (AC #5; B-006, D-010)", () => {
	for (const backend of ["claude", "codex"] as const) {
		test(`${backend}: complete JSON lines map to ordered stdout/stderr emissions`, async () => {
			gitInit(workspace);
			const result = await run(
				fixtureSpec({ mode: "stream" }),
				["--backend", backend],
				{ prepare: () => ({ afterRunMessages: ["AFTER"] }) },
			);
			expect(result.code).toBe(0);
			const first =
				backend === "claude"
					? { type: "system", subtype: "init" }
					: { type: "thread.started" };
			const last =
				backend === "claude"
					? { type: "result", subtype: "success" }
					: { type: "turn.completed" };
			expect(result.writes).toEqual([
				{ stream: "stderr", text: `${JSON.stringify(first)}\n` },
				{ stream: "stdout", text: `hello from ${backend}\n` },
				{ stream: "stderr", text: `${JSON.stringify(last)}\n` },
				{ stream: "stdout", text: "AFTER\n" },
			]);
		});

		test(`${backend}: malformed JSON exits stderr/1, terminates the backend, cleans up, no after-run message`, async () => {
			gitInit(workspace);
			const result = await run(
				fixtureSpec({ mode: "stream", promptMode: "replace" }),
				["--backend", backend],
				{ prepare: () => ({ afterRunMessages: ["AFTER"] }) },
				{ scenario: "malformed" },
			);
			expect(result.code).toBe(1);
			expect(result.stdout).not.toContain("AFTER");
			expect(result.stderr).toContain(
				`test:agent: stream decoding failed: malformed ${backend} stream line: this is not json`,
			);
			expect(isAlive(await waitForFile(pidFile))).toBe(false);
			expect(result.leftovers).toEqual([]);
		});

		test(`${backend}: an incomplete final line fails unless it decodes`, async () => {
			gitInit(workspace);
			const bad = await run(
				fixtureSpec({ mode: "stream" }),
				["--backend", backend],
				{ prepare: () => ({ afterRunMessages: ["AFTER"] }) },
				{ scenario: "incomplete" },
			);
			expect(bad.code).toBe(1);
			expect(bad.stdout).toBe("");
			expect(bad.stderr).toContain(
				`incomplete final ${backend} stream line could not be decoded`,
			);
			expect(bad.leftovers).toEqual([]);

			const good = await run(
				fixtureSpec({ mode: "stream" }),
				["--backend", backend],
				{},
				{ scenario: "incomplete-valid" },
			);
			expect(good.code).toBe(0);
			expect(good.stdout).toBe(`hello from ${backend}\n`);
		});
	}

	test("a decoder throw exits stderr/1 and terminates the backend", async () => {
		const throwing: BackendAdapter = {
			...claudeAdapter,
			decoder: () => ({
				line() {
					throw new Error("decoder exploded");
				},
				end: () => [],
			}),
		};
		const result = await run(
			fixtureSpec({ mode: "stream" }),
			[],
			{ prepare: () => ({ afterRunMessages: ["AFTER"] }) },
			{ scenario: "malformed", adapterFor: () => throwing },
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"test:agent: stream decoding failed: decoder exploded\n",
		);
		expect(isAlive(await waitForFile(pidFile))).toBe(false);
		expect(result.leftovers).toEqual([]);
	});

	test("lines split across chunks decode whole and in order", async () => {
		const chunks = [
			'{"type":"assistant","mess',
			'age":{"content":[{"type":"text","text":"a"}]}}\n{"ty',
			'pe":"x"}\n',
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(new TextEncoder().encode(chunk));
				}
				controller.close();
			},
		});
		const writes: string[] = [];
		const decoded = await decodeStream(
			stream,
			claudeAdapter.decoder(),
			{
				stdout: (text) => writes.push(`out:${text}`),
				stderr: (text) => writes.push(`err:${text}`),
			},
			"claude",
		);
		expect(decoded).toEqual({ ok: true });
		expect(writes).toEqual(["out:a\n", 'err:{"type":"x"}\n']);
	});

	/** A byte stream delivered in exactly these chunks. */
	function byteStream(chunks: Uint8Array[]) {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});
	}

	/** A decoder that records each line it is handed, verbatim. */
	function recordingDecoder(lines: string[]): StreamDecoder {
		return {
			line(text) {
				lines.push(text);
				return [{ stream: "stdout", text: `[${text}]` }];
			},
			end: () => [],
		};
	}

	test("a multi-byte character split across chunks decodes intact", async () => {
		const bytes = new TextEncoder().encode(
			'{"type":"assistant","message":{"content":[{"type":"text","text":"héllo ✓ 🐑"}]}}\n',
		);
		// Split inside "é" (2 bytes), "✓" (3 bytes) and the emoji (4 bytes).
		const at = (char: string, offset: number) =>
			new TextEncoder().encode(
				'{"type":"assistant","message":{"content":[{"type":"text","text":"héllo ✓ 🐑"}]}}'.slice(
					0,
					'{"type":"assistant","message":{"content":[{"type":"text","text":"héllo ✓ 🐑"}]}}'.indexOf(
						char,
					),
				),
			).length + offset;
		const cuts = [at("é", 1), at("✓", 1), at("✓", 2), at("🐑", 1), at("🐑", 3)];
		const chunks: Uint8Array[] = [];
		let from = 0;
		for (const cut of [...cuts, bytes.length]) {
			chunks.push(bytes.slice(from, cut));
			from = cut;
		}
		const writes: string[] = [];
		const decoded = await decodeStream(
			byteStream(chunks),
			claudeAdapter.decoder(),
			{
				stdout: (text) => writes.push(text),
				stderr: (text) => writes.push(`err:${text}`),
			},
			"claude",
		);
		expect(decoded).toEqual({ ok: true });
		expect(writes).toEqual(["héllo ✓ 🐑\n"]);
	});

	test("CRLF lines arrive without CR; an empty final line and a final line without newline are handled", async () => {
		const encode = (text: string) => new TextEncoder().encode(text);
		const cases: [string[], string[]][] = [
			// CRLF, including a CR and LF split across chunks.
			[["one\r", "\ntwo\r\n"], ["one", "two"]],
			// An empty final line before the end of the stream.
			[["one\n", "\n"], ["one", ""]],
			// A valid final line without a newline.
			[["one\ntw", "o"], ["one", "two"]],
			// A trailing CR on an unterminated final line is kept as data.
			[["one\r\nlast"], ["one", "last"]],
		];
		for (const [chunks, expected] of cases) {
			const lines: string[] = [];
			const decoded = await decodeStream(
				byteStream(chunks.map(encode)),
				recordingDecoder(lines),
				{ stdout: () => {}, stderr: () => {} },
				"claude",
			);
			expect(decoded).toEqual({ ok: true });
			expect(lines).toEqual(expected);
		}
	});
});

describe("signals (AC #4, #9; B-006, D-018)", () => {
	test("a signal during preparation terminates its child, cleans up and exits 130", async () => {
		const signals = fakeSignals();
		const sleeper = sleeperCommand();
		const pending = run(
			fixtureSpec(),
			["--print"],
			{
				async prepare(ctx) {
					await ctx.runCommand({ argv: sleeper.argv });
					return {};
				},
				finish: () => {
					throw new Error("finish must not run after a signal");
				},
			},
			{ signals: signals.source },
		);
		const pid = await waitForFile(sleeper.file);
		expect(signals.state.subscribed).toBe(1);
		signals.send("SIGINT");
		const result = await pending;
		expect(result.code).toBe(130);
		expect(result.stdout).toBe("");
		expect(isAlive(pid)).toBe(false);
		expect(signals.state.subscribed).toBe(0);
		expect(readRecords(recordFile)).toEqual([]);
	});

	test("a signal during a preparation that ignores it still ends the run", async () => {
		const signals = fakeSignals();
		const pending = run(
			fixtureSpec(),
			[],
			{ prepare: () => new Promise(() => {}) },
			{ signals: signals.source },
		);
		await Bun.sleep(20);
		signals.send("SIGTERM");
		expect((await pending).code).toBe(143);
	});

	test("a signal during interpolation terminates the interpolation child and exits 143", async () => {
		const signals = fakeSignals();
		const sleeper = sleeperCommand();
		const interpolate: Interpolate = async (_servers, ctx) => {
			await ctx.runCommand({ argv: sleeper.argv });
			return { mcp: {}, env: {} };
		};
		const pending = run(
			fixtureSpec(),
			[],
			{},
			{
				signals: signals.source,
				interpolate,
			},
		);
		const pid = await waitForFile(sleeper.file);
		signals.send("SIGTERM");
		const result = await pending;
		expect(result.code).toBe(143);
		expect(isAlive(pid)).toBe(false);
		expect(result.leftovers).toEqual([]);
		expect(readRecords(recordFile)).toEqual([]);
	});

	for (const [mode, backend] of [
		["print", "claude"],
		["stream", "claude"],
		["print", "codex"],
		["stream", "codex"],
	] as const) {
		test(`a signal during the ${backend} ${mode} backend terminates it, cleans up and exits 143`, async () => {
			gitInit(workspace);
			const signals = fakeSignals();
			let finished = false;
			const pending = run(
				fixtureSpec({ mode, promptMode: "replace" }),
				["--backend", backend],
				{
					prepare: () =>
						mode === "stream" ? { afterRunMessages: ["AFTER"] } : {},
					finish: () => {
						finished = true;
						return { exitCode: 0 };
					},
				},
				{ scenario: "hang", signals: signals.source },
			);
			const pid = await waitForFile(pidFile);
			expect(readdirSync(tmpRoot)).toHaveLength(1);
			signals.send("SIGTERM");
			const result = await pending;
			expect(result.code).toBe(143);
			expect(finished).toBe(false);
			expect(result.stdout).toBe("");
			expect(isAlive(pid)).toBe(false);
			expect(result.leftovers).toEqual([]);
			expect(signals.state.subscribed).toBe(0);
		});
	}

	test("an interactive backend keeps SIGINT (the terminal delivers it); SIGTERM ends the run", async () => {
		const signals = fakeSignals();
		const pending = run(
			fixtureSpec(),
			[],
			{},
			{
				scenario: "hang",
				signals: signals.source,
			},
		);
		const pid = await waitForFile(pidFile);
		signals.send("SIGINT");
		await Bun.sleep(100);
		expect(isAlive(pid)).toBe(true);
		signals.send("SIGTERM");
		const result = await pending;
		expect(result.code).toBe(143);
		expect(isAlive(pid)).toBe(false);
		expect(result.leftovers).toEqual([]);
	});
});

describe("signals in the hard windows (AC #4, #8; D-018)", () => {
	test("SIGHUP during the backend exits 129 after cleanup", async () => {
		const signals = fakeSignals();
		const { pending, diagnose } = startRun(
			fixtureSpec({ mode: "stream" }),
			[],
			{},
			{ scenario: "hang", signals: signals.source },
		);
		const pid = await waitForFile(pidFile, { diagnose });
		signals.send("SIGHUP");
		const result = await pending;
		expect(result.code).toBe(129);
		expect(isAlive(pid)).toBe(false);
		expect(result.leftovers).toEqual([]);
		expect(signals.state.subscribed).toBe(0);
	});

	test("a child that ignores SIGTERM is killed after the grace period", async () => {
		const signals = fakeSignals();
		const { pending, diagnose } = startRun(
			fixtureSpec(),
			["--print"],
			{},
			{ scenario: "ignore-term", signals: signals.source, killGraceMs: 300 },
		);
		const pid = await waitForFile(pidFile, { diagnose });
		const sent = Date.now();
		signals.send("SIGTERM");
		const result = await pending;
		expect(Date.now() - sent).toBeGreaterThanOrEqual(250);
		expect(result.code).toBe(143);
		expect(isAlive(pid)).toBe(false);
		expect(result.leftovers).toEqual([]);
		expect(signals.state.subscribed).toBe(0);
	});

	test("a second signal kills a stubborn child at once", async () => {
		const signals = fakeSignals();
		const { pending, diagnose } = startRun(
			fixtureSpec({ mode: "stream" }),
			[],
			{},
			// A grace period longer than the test timeout: only SIGKILL ends it.
			{ scenario: "ignore-term", signals: signals.source, killGraceMs: 60_000 },
		);
		const pid = await waitForFile(pidFile, { diagnose });
		signals.send("SIGTERM");
		await Bun.sleep(100);
		expect(isAlive(pid)).toBe(true);
		const second = Date.now();
		signals.send("SIGINT");
		const result = await pending;
		expect(Date.now() - second).toBeLessThan(2000);
		expect(result.code).toBe(143);
		expect(isAlive(pid)).toBe(false);
		expect(result.leftovers).toEqual([]);
		expect(signals.state.subscribed).toBe(0);
	});

	test("a signal while resources are being created leaves nothing behind", async () => {
		for (const backend of ["claude", "codex"] as const) {
			gitInit(workspace);
			const signals = fakeSignals();
			let release = () => {};
			let started = () => {};
			const creating = new Promise<void>((done) => {
				started = done;
			});
			const result = run(
				fixtureSpec({ promptMode: "replace" }),
				["--backend", backend, "--print"],
				{},
				{
					signals: signals.source,
					// Creation is in flight when the signal arrives: the first
					// directory exists, the rest is still to come.
					createResources: async (needs, scope, root) => {
						const gate = new Promise<void>((done) => {
							release = done;
						});
						started();
						await gate;
						return createResources(needs, scope, root);
					},
				},
			);
			await creating;
			signals.send("SIGTERM");
			release();
			const outcome = await result;
			expect(outcome.code).toBe(143);
			expect(outcome.leftovers).toEqual([]);
			expect(readRecords(recordFile)).toEqual([]);
			expect(signals.state.subscribed).toBe(0);
		}
	});

	test("a signal between resource creation and spawn launches nothing and cleans up", async () => {
		const signals = fakeSignals();
		let resources: string[] = [];
		const result = await run(
			fixtureSpec(),
			["--print"],
			{},
			{
				signals: signals.source,
				flush: async () => {
					resources = readdirSync(tmpRoot);
					signals.send("SIGTERM");
					await Bun.sleep(10);
				},
			},
		);
		expect(resources).toHaveLength(1);
		expect(result.code).toBe(143);
		expect(result.leftovers).toEqual([]);
		expect(readRecords(recordFile)).toEqual([]);
		expect(signals.state.subscribed).toBe(0);
	});

	test("a cleanup registered on a closed scope runs at once", async () => {
		const scope = new RunScope();
		await scope.close();
		const dir = mkdtempSync(join(tmpRoot, "late-"));
		scope.onCleanup(() => rmSync(dir, { recursive: true, force: true }));
		await Bun.sleep(10);
		expect(readdirSync(tmpRoot)).toEqual([]);
	});

	test("a signal during preview terminates preparation's child, writes no envelope and exits 143", async () => {
		const signals = fakeSignals();
		const sleeper = sleeperCommand();
		const parsed = parseCli(fixtureSpec(), ["--show-prompt"], {
			cwd: workspace,
		});
		if (parsed.kind !== "run") throw new Error("expected a run outcome");
		let stdout = "";
		let stderr = "";
		const pending = previewAgent(
			fixtureSpec(),
			{
				async prepare(ctx) {
					await ctx.runCommand({
						argv: sleeper.argv,
						env: { PATH: `${bin}:${process.env.PATH}` },
					});
					return {};
				},
			},
			parsed.invocation,
			{
				stdout: (text) => {
					stdout += text;
				},
				stderr: (text) => {
					stderr += text;
				},
				isDirectory: () => true,
				signals: signals.source,
			},
		);
		const pid = await waitForFile(sleeper.file);
		expect(signals.state.subscribed).toBe(1);
		signals.send("SIGTERM");
		expect(await pending).toBe(143);
		expect(isAlive(pid)).toBe(false);
		expect(stdout).toBe("");
		expect(stderr).toBe("");
		expect(signals.state.subscribed).toBe(0);
	});
});

describe("runner-created resources (AC #8; D-019, Design §5)", () => {
	test("Claude gets a unique, clean TMPDIR through the plan env, removed after the run", async () => {
		await run(fixtureSpec(), ["--print"]);
		await run(fixtureSpec(), ["--print"]);
		const [first, second] = readRecords(recordFile);
		expect(first?.tmpdir).toStartWith(join(tmpRoot, "troupe-tmp-"));
		expect(second?.tmpdir).toStartWith(join(tmpRoot, "troupe-tmp-"));
		expect(first?.tmpdir).not.toBe(second?.tmpdir);
		expect(first?.tmpdirEntries).toEqual([]);
		expect(existsSync(first?.tmpdir ?? "")).toBe(false);
		expect(readdirSync(tmpRoot)).toEqual([]);
	});

	test("the Codex replace prompt file is owner-only (0600), holds the prompt and is removed", async () => {
		gitInit(workspace);
		for (const mode of ["interactive", "print"] as const) {
			rmSync(recordFile, { force: true });
			const result = await run(
				fixtureSpec({ promptMode: "replace", mode }),
				["--backend", "codex"],
				{ prepare: () => ({ systemPromptFragments: ["MORE"] }) },
			);
			expect(result.code).toBe(0);
			const record = readRecords(recordFile)[0];
			expect(record?.promptFile?.mode).toBe(0o600);
			expect(record?.promptFile?.content).toBe(`SYSTEM${PROMPT_SEPARATOR}MORE`);
			expect(record?.promptFile?.path).toStartWith(tmpRoot);
			expect(existsSync(record?.promptFile?.path ?? "")).toBe(false);
			expect(result.leftovers).toEqual([]);
		}
	});

	test("no temp file or TMPDIR remains after any exit path", async () => {
		gitInit(workspace);
		const paths: [string, () => Promise<Outcome>][] = [];
		for (const backend of ["claude", "codex"] as const) {
			const agent = (mode: AgentSpec["mode"]) =>
				fixtureSpec({ promptMode: "replace", mode });
			const argv = ["--backend", backend];
			paths.push(
				[`${backend} success`, () => run(agent("print"), argv)],
				[
					`${backend} early exit`,
					() =>
						run(agent("print"), argv, {
							prepare: () => ({
								exit: { message: "x", code: 3, stream: "stderr" },
							}),
						}),
				],
				[
					`${backend} backend failure`,
					() => run(agent("print"), argv, {}, { scenario: "fail" }),
				],
				[
					`${backend} prepare throw`,
					() =>
						run(agent("interactive"), argv, {
							prepare() {
								throw new Error("x");
							},
						}),
				],
				[
					`${backend} finish throw`,
					() =>
						run(agent("print"), argv, {
							finish() {
								throw new Error("x");
							},
						}),
				],
				[
					`${backend} decoder failure`,
					() => run(agent("stream"), argv, {}, { scenario: "malformed" }),
				],
				[
					`${backend} spawn failure`,
					() => run(agent("stream"), argv, {}, { path: "/nonexistent" }),
				],
			);
		}
		for (const [name, runPath] of paths) {
			const result = await runPath();
			expect({ name, leftovers: result.leftovers }).toEqual({
				name,
				leftovers: [],
			});
		}
	});

	test("Codex exec outside Git gets --skip-git-repo-check; inside Git it does not", async () => {
		const outside = await run(fixtureSpec(), ["--backend", "codex", "--print"]);
		expect(outside.code).toBe(0);
		expect(readRecords(recordFile)[0]?.argv).toContain("--skip-git-repo-check");

		gitInit(workspace);
		rmSync(recordFile, { force: true });
		const inside = await run(fixtureSpec(), ["--backend", "codex", "--print"]);
		expect(inside.code).toBe(0);
		expect(readRecords(recordFile)[0]?.argv).not.toContain(
			"--skip-git-repo-check",
		);
	});

	test("the worktree probe runs in the effective (prepared) cwd", async () => {
		const repo = join(workspace, "repo");
		mkdirSync(repo);
		gitInit(repo);
		// The invocation cwd is outside Git; prepare moves into a repository.
		const result = await run(fixtureSpec(), ["--backend", "codex", "--print"], {
			prepare: () => ({ cwd: "repo" }),
		});
		expect(result.code).toBe(0);
		const record = readRecords(recordFile)[0];
		expect(record?.cwd).toBe(repo);
		expect(record?.argv).not.toContain("--skip-git-repo-check");
	});
});

describe("interpolation, adapter and spawn failures (AC #9; B-006)", () => {
	const failures: [
		"interpolation" | "adapter" | "spawn",
		Partial<AgentSpec>,
		AgentExtension,
		Partial<RunOptions>,
	][] = [
		[
			"interpolation",
			{
				mcp: { api: { url: "https://x.test", headers: { A: "${env:TOKEN}" } } },
			},
			{},
			{},
		],
		[
			"adapter",
			{ native: { claude: { settings: { permissions: 5 } } } },
			{ prepare: () => ({ extraAllowRules: { rules: ["Read(//x/**)"] } }) },
			{},
		],
		["spawn", {}, {}, { path: "/nonexistent" }],
	];

	for (const [stage, overrides, extension, options] of failures) {
		test(`${stage} failure: stderr/1 in interactive and stream, finish in print`, async () => {
			for (const mode of ["interactive", "stream"] as const) {
				const result = await run(
					fixtureSpec({ ...overrides, mode }),
					[],
					extension,
					options,
				);
				expect(result.code).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toStartWith(`test:agent: ${stage} failed: `);
				expect(result.leftovers).toEqual([]);
			}
			const seen: RunResult[] = [];
			const print = await run(
				fixtureSpec({ ...overrides, mode: "print" }),
				[],
				{ ...extension, finish: recordingFinish(seen) },
				options,
			);
			expect(print.code).toBe(9);
			expect(seen[0]?.failure?.stage).toBe(stage);
			expect(print.leftovers).toEqual([]);
			expect(readRecords(recordFile)).toEqual([]);
		});
	}

	describe("Webfetch-style finish (Design §5)", () => {
		const webfetch = fixtureSpec({
			id: "tools:webfetch",
			backends: ["claude"],
			mode: "print",
			flags: { url: { type: "string", description: "URL" } },
		});
		const extension: AgentExtension = {
			prepare: (ctx): PrepareResult =>
				ctx.args.length === 0 && ctx.flags.url === undefined
					? {
							exit: {
								message:
									"ERROR: missing URL. Run `tools:webfetch --describe` for usage.\n",
								code: 64,
								stream: "stdout",
							},
						}
					: {},
			finish: (result) => normalizeRunResult(result),
		};

		test("a missing backend binary yields stdout ERROR:", async () => {
			const result = await run(webfetch, ["https://x.test"], extension, {
				path: "/nonexistent",
			});
			expect(result.code).toBe(1);
			expect(result.stdout).toBe(
				"ERROR: spawn failed: claude: command not found on PATH\n",
			);
			expect(result.stderr).toBe("");
		});

		test("a failing ${cmd:...} yields stdout ERROR:", async () => {
			const withMcp = {
				...webfetch,
				mcp: {
					api: {
						url: "https://x.test",
						headers: { Authorization: "${cmd:false}" },
					},
				},
			};
			// Stands in for TASK-006: runs the command through the runner's
			// tracked facility and fails on a nonzero exit.
			const interpolate: Interpolate = async (_servers, ctx) => {
				const result = await ctx.runCommand({ argv: ["false"] });
				if (result.exitCode !== 0) {
					throw new Error(`\${cmd:false} exited with ${result.exitCode}`);
				}
				return { mcp: {}, env: {} };
			};
			const result = await run(withMcp, ["https://x.test"], extension, {
				interpolate,
			});
			expect(result.code).toBe(1);
			expect(result.stdout).toBe(
				"ERROR: interpolation failed: ${cmd:false} exited with 1\n",
			);
			expect(readRecords(recordFile)).toEqual([]);
		});

		test("success keeps the payload; a missing URL keeps its own early exit", async () => {
			const ok = await run(webfetch, ["https://x.test"], extension);
			expect(ok).toMatchObject({ code: 0, stdout: "claude result\n" });
			const usage = await run(webfetch, [], extension);
			expect(usage.code).toBe(64);
			expect(usage.stdout).toStartWith("ERROR: missing URL.");
		});
	});

	test("the default interpolation passes literal values through untouched", async () => {
		const literal = await interpolateMcp(
			{ api: { url: "https://x.test", headers: { A: "literal" } } },
			{
				env: {},
				cwd: workspace,
				signal: new AbortController().signal,
				runCommand: async () => {
					throw new Error("literal values run nothing");
				},
			},
		);
		expect(literal).toEqual({
			mcp: {
				api: {
					url: { actual: "https://x.test", display: "https://x.test" },
					headers: { A: { actual: "literal", display: "literal" } },
				},
			},
			env: {},
		});
	});
});

describe("extensions return data only (AC #6; D-015)", () => {
	const EXTENSION = `import { join } from "node:path";
export async function prepare(ctx) {
	if (!ctx.preview) await ctx.runCommand({ argv: ["git", "status"] });
	return { systemPromptFragments: [join(ctx.cwd, "x")] };
}
export function finish(result) {
	return { exitCode: result.exitCode, stdout: result.stdout };
}
`;

	test("importing a converted extension spawns no process and does not exit", async () => {
		const file = join(root, "extension.ts");
		writeFileSync(file, EXTENSION);
		expect(inspectExtension(file, EXTENSION).sideEffects).toEqual([]);
		// Import it in a child whose PATH records any backend or git launch.
		const shims = join(root, "shims");
		mkdirSync(shims);
		for (const name of ["git", "gh"]) {
			writeFileSync(
				join(shims, name),
				`#!/bin/sh\necho ${name} >> ${JSON.stringify(recordFile)}\n`,
			);
			Bun.spawnSync(["chmod", "+x", join(shims, name)]);
		}
		const child = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`const m = await import(${JSON.stringify(file)}); console.log(Object.keys(m).sort().join(","));`,
			],
			{
				env: {
					...process.env,
					PATH: `${shims}:${bin}:${process.env.PATH}`,
					FAKE_RECORD: recordFile,
				},
			},
		);
		expect(child.exitCode).toBe(0);
		expect(child.stdout.toString()).toBe("finish,prepare\n");
		expect(existsSync(recordFile)).toBe(false);
	});

	test("a prepare result carrying argv, a command or unknown keys is refused", async () => {
		for (const returned of [
			{ argv: ["claude", "--print"] },
			{ command: "codex exec" },
			{ systemPromptFragments: "not a list" },
			{ exit: { message: "x", code: 1.5, stream: "stdout" } },
			{ exit: { message: "x", code: 1, stream: "tty" } },
		]) {
			const result = await run(fixtureSpec(), [], {
				prepare: () => returned as never,
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("prepare returned an invalid result");
		}
		expect(readRecords(recordFile)).toEqual([]);
	});

	test("preparation sees parsed data and runner commands, never framework flags or argv", async () => {
		let seen: PrepareContext | undefined;
		await run(
			fixtureSpec(),
			["a", "--model", "opus", "--print", "--", "--resume", "x"],
			{
				prepare(ctx) {
					seen = ctx;
					return {};
				},
			},
		);
		expect(Object.keys(seen ?? {}).sort()).toEqual([
			"args",
			"backend",
			"cwd",
			"flags",
			"mode",
			"preview",
			"runCommand",
			"signal",
			"spec",
		]);
		expect(seen?.args).toEqual(["a"]);
		expect(seen?.flags).toEqual({});
		expect(seen?.mode).toBe("print");
		expect(seen?.preview).toBe(false);
		expect(Object.isFrozen(seen)).toBe(true);
	});
});

describe("fake CLIs (AC #10; Design §9)", () => {
	test("the fake Claude rejects stream-json print without --verbose", () => {
		const env = { ...process.env, FAKE_RECORD: recordFile };
		const without = Bun.spawnSync(
			[join(bin, "claude"), "--print", "--output-format", "stream-json"],
			{ env },
		);
		expect(without.exitCode).not.toBe(0);
		expect(String(without.stderr)).toContain("requires --verbose");
		const withVerbose = Bun.spawnSync(
			[
				join(bin, "claude"),
				"--print",
				"--output-format",
				"stream-json",
				"--verbose",
			],
			{ env },
		);
		expect(withVerbose.exitCode).toBe(0);
	});

	test("an adapter that drops --verbose fails a runner test", async () => {
		const dropsVerbose: BackendAdapter = {
			...claudeAdapter,
			build(inv, paths) {
				const plan = claudeAdapter.build(inv, paths);
				const without = (argv: string[]) =>
					argv.filter((token) => token !== "--verbose");
				return {
					...plan,
					argv: without(plan.argv),
					displayArgv: without(plan.displayArgv),
				};
			},
		};
		const broken = await run(
			fixtureSpec({ mode: "stream" }),
			[],
			{},
			{
				adapterFor: () => dropsVerbose,
			},
		);
		expect(broken.code).not.toBe(0);
		expect(broken.stdout).toBe("");
		const real = await run(fixtureSpec({ mode: "stream" }), []);
		expect(real.code).toBe(0);
		expect(real.stdout).toBe("hello from claude\n");
	});
});
