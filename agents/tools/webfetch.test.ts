import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError, parseCli, resolveCli } from "../../lib/agent-format/cli";
import { installFakeClis, readRecords } from "../../lib/agent-format/fake-cli";
import {
	type AgentExtension,
	createPrepareContext,
	executeAgent,
	previewAgent,
} from "../../lib/agent-format/run";
import type { AgentSpec, RunResult } from "../../lib/agent-format/types";
import {
	compileAgent,
	generateEntry,
	inspectExtension,
	loadAgentDefinition,
	planBuild,
} from "../../scripts/agent-compiler";
import * as webfetch from "./webfetch";
import {
	buildTaskPrompt,
	finish,
	formatErrorLine,
	normalizeRunResult,
	prepare,
	resolveWebfetchInput,
	USAGE_DOC,
} from "./webfetch";

const repo = resolve(import.meta.dir, "../..");

// Execution and binary tests spawn fake CLIs and a compiled agent.
setDefaultTimeout(60_000);

const ID = "tools:webfetch";
const SOURCE = "agents/tools/webfetch";
const PAGE = "https://example.com";
const MISSING_URL =
	"ERROR: missing URL. Run `tools:webfetch --describe` for usage.\n";

/** The legacy `settings/webfetch.settings.json`, rule by rule. */
const LEGACY_SETTINGS = {
	permissions: {
		allow: ["WebFetch"],
		deny: [
			"Bash",
			"Edit",
			"Write",
			"Read",
			"Glob",
			"Grep",
			"Task",
			"WebSearch",
		],
	},
};

const extension: AgentExtension = webfetch;

let spec: AgentSpec;
let scratch: string;
let cwd: string;
let fakeBin: string;
/** A shell fake claude for payload shapes the shared fake has no scenario for. */
let shapesBin: string;

beforeAll(async () => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "webfetch-agent-")));
	cwd = join(scratch, "ws");
	mkdirSync(cwd);
	fakeBin = join(scratch, "fakebin");
	mkdirSync(fakeBin);
	installFakeClis(fakeBin);
	shapesBin = join(scratch, "shapesbin");
	mkdirSync(shapesBin);
	writeFileSync(
		join(shapesBin, "claude"),
		`#!/bin/sh
case "$WF_SHAPE" in
error0) printf 'ERROR: 404 Not Found\\n' ;;
note) printf 'payload\\n'; printf 'claude note\\n' >&2 ;;
empty) ;;
esac
exit 0
`,
	);
	chmodSync(join(shapesBin, "claude"), 0o755);
	spec = (await loadAgentDefinition(repo, `${SOURCE}.md`)).spec;
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function invocationOf(argv: string[], dir = cwd) {
	const outcome = parseCli(spec, argv, { cwd: dir });
	if (outcome.kind !== "run") throw new Error("unexpected help");
	return outcome.invocation;
}

/** Call `prepare` the way the runner would. */
function prepareWith(argv: string[], preview = false) {
	const invocation = invocationOf(argv);
	const ctx = createPrepareContext(
		spec,
		{ ...invocation, showPrompt: preview },
		{
			signal: new AbortController().signal,
			runCommand: async () => {
				throw new Error("webfetch runs no commands");
			},
		},
	);
	return prepare(ctx);
}

interface Envelope {
	text: string;
	systemPrompt: string;
	initialPrompt: string;
	argv: string[];
}

async function preview(argv: string[]) {
	let stdout = "";
	let stderr = "";
	const code = await previewAgent(spec, extension, invocationOf(argv), {
		stdout: (chunk) => {
			stdout += chunk;
		},
		stderr: (chunk) => {
			stderr += chunk;
		},
		isDirectory: () => true,
	});
	return { code, stdout, stderr };
}

function parseEnvelope(text: string): Envelope {
	const match =
		/^Backend: claude\n--- System prompt ---\n([\s\S]*)\n--- Initial prompt ---\n([\s\S]*)\n--- Argv ---\n(.*)\n$/.exec(
			text,
		);
	if (!match) throw new Error(`malformed envelope:\n${text}`);
	return {
		text,
		systemPrompt: match[1] ?? "",
		initialPrompt: match[2] ?? "",
		argv: JSON.parse(match[3] ?? "[]"),
	};
}

async function envelopeOf(argv: string[]): Promise<Envelope> {
	const result = await preview(argv);
	expect({ code: result.code, stderr: result.stderr }).toEqual({
		code: 0,
		stderr: "",
	});
	return parseEnvelope(result.stdout);
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i === -1 ? undefined : argv[i + 1];
}

/** The review's M-1 line: tokens that would widen Claude's tools if forwarded. */
const ATTACK = [
	"--dangerously-skip-permissions",
	"--settings",
	"{}",
	"--allowedTools",
	"Bash",
	"--max-turns",
	"50",
];

/**
 * A recorded claude argv that carries only the declared policy: one
 * `--settings` with the legacy rules, one `--max-turns=3`, no bypass, and
 * `words` only as the caller request inside the task prompt.
 */
function expectSealedArgv(argv: readonly string[], words: string) {
	const prompt = buildTaskPrompt({
		mode: "run",
		url: PAGE,
		userPrompt: words,
		raw: false,
	});
	expect(argv.at(-1)).toBe(prompt);
	expect(argv.at(-2)).toBe("--");
	const options = argv.slice(0, -2);
	expect(options.filter((arg) => arg === "--settings")).toHaveLength(1);
	expect(JSON.parse(valueAfter(options, "--settings") ?? "null")).toEqual(
		LEGACY_SETTINGS,
	);
	expect(options.filter((arg) => arg.includes("max-turns"))).toEqual([
		"--max-turns=3",
	]);
	expect(options.filter((arg) => arg.includes("allowedTools"))).toEqual([
		"--allowedTools=WebFetch",
	]);
	expect(options).not.toContain("--dangerously-skip-permissions");
	expect(options).not.toContain("{}");
	expect(options).not.toContain("Bash");
	expect(options).not.toContain("50");
}

/**
 * The envelope with the argv copies of both prompts replaced by markers,
 * after checking each is exactly the previewed text, so the snapshot holds
 * each prompt once.
 */
function compact(envelope: Envelope): string {
	const argv = envelope.argv.map((arg, i) => {
		if (envelope.argv[i - 1] === "--append-system-prompt") {
			expect(arg).toBe(envelope.systemPrompt);
			return "<system prompt, as above>";
		}
		return arg;
	});
	expect(argv.slice(-2)).toEqual(["--", envelope.initialPrompt]);
	argv[argv.length - 1] = "<initial prompt, as above>";
	return envelope.text.replace(/--- Argv ---\n.*\n$/, () =>
		["--- Argv ---", JSON.stringify(argv), ""].join("\n"),
	);
}

describe("declaration and extension (D-001, D-005, D-016)", () => {
	test("a Claude-only print declaration with haiku and the legacy flags, minus max-turns", () => {
		expect(spec.id).toBe(ID);
		expect([...spec.backends]).toEqual(["claude"]);
		expect(spec.mode).toBe("print");
		expect(spec.promptMode).toBe("append");
		expect(spec.model).toEqual({ claude: "haiku" });
		expect(Object.keys(spec.flags)).toEqual([
			"url",
			"prompt",
			"raw",
			"describe",
		]);
		expect(spec.flags["max-turns"]).toBeUndefined();
		expect(spec.passthrough).toBe(false);
	});

	// Migration check against the legacy prompt file, which the strict
	// cutover deletes; delete this check with it. The envelope snapshots are
	// the lasting guard.
	test("the body is the legacy webfetch-prompt.md", () => {
		expect(spec.systemPrompt).toBe(
			readFileSync(
				join(repo, "system-prompts/webfetch-prompt.md"),
				"utf8",
			).trimEnd(),
		);
	});

	test("the usage document drops the --max-turns bullet and documents -- and exit 2 (D-037, D-039)", () => {
		expect(USAGE_DOC).not.toContain("max-turns");
		expect(USAGE_DOC).toContain("- **--model <name>**: Claude model");
		expect(USAGE_DOC).toContain(
			"- **--**: everything after a standalone `--` is taken as positional\n  arguments (the URL, then prompt words), even when it starts with `-`.\n  Nothing is passed to the underlying Claude CLI.\n",
		);
		expect(USAGE_DOC).toContain("- `64` — usage error (missing URL).");
		expect(USAGE_DOC).toContain(
			"- `2` — invalid option, backend or working directory; the message is on\n  stderr, nothing on stdout.\n",
		);
	});

	test("mixed mode builds the same-stem pair as declaration plus extension (AC #6)", async () => {
		const plan = await planBuild({ root: repo, mode: "mixed" });
		const entry = plan.entries.find((candidate) => candidate.id === ID);
		expect(entry?.kind).toBe("declaration");
		if (entry?.kind !== "declaration") return;
		expect(entry.source).toBe(`${SOURCE}.md`);
		expect(entry.agent.extension).toEqual({
			file: join(repo, `${SOURCE}.ts`),
			exports: ["prepare", "finish"],
		});
		const source = generateEntry(entry.agent);
		expect(source).toContain(
			`import { prepare, finish } from ${JSON.stringify(join(repo, `${SOURCE}.ts`))};`,
		);
		expect(source).toContain("const extension = { prepare, finish };");
	});
});

describe("importing the extension has no side effects (D-015, AC #6)", () => {
	test("static inspection finds no top-level side effects", () => {
		const file = `${SOURCE}.ts`;
		expect(
			inspectExtension(file, readFileSync(join(repo, file), "utf8")),
		).toEqual({
			exports: ["prepare", "finish"],
			exportProblems: [],
			hidingExportProblems: [],
			sideEffects: [],
		});
	});

	test("a fresh process that imports the extension spawns nothing and does not exit", async () => {
		const file = join(repo, `${SOURCE}.ts`);
		const records = join(scratch, "import-records.jsonl");
		const probe = join(scratch, "import-probe.ts");
		writeFileSync(
			probe,
			`const childProcess = require("node:child_process");
const events: string[] = [];
const trap = (name: string) => (..._args: unknown[]) => {
	events.push(name);
	throw new Error(name + " called on import");
};
Bun.spawn = trap("Bun.spawn") as typeof Bun.spawn;
Bun.spawnSync = trap("Bun.spawnSync") as typeof Bun.spawnSync;
process.exit = trap("process.exit") as typeof process.exit;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
	childProcess[name] = trap("child_process." + name);
}
const exported = Object.keys(await import(${JSON.stringify(file)})).sort();
console.log(JSON.stringify({ events, exported }));
`,
		);
		const child = Bun.spawn([process.execPath, probe, PAGE], {
			cwd: scratch,
			env: {
				...process.env,
				PATH: `${fakeBin}:${process.env.PATH}`,
				FAKE_RECORD: records,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		const result = JSON.parse(stdout);
		expect(result.events).toEqual([]);
		expect(result.exported).toContain("prepare");
		expect(result.exported).toContain("finish");
		expect(result.exported).not.toContain("default");
		expect(readRecords(records)).toEqual([]);
	});
});

describe("prepare: usage and task normalization (AC #1)", () => {
	// Rewritten from the legacy "consumes repo-level backend flag before
	// deriving the PAGE": `--backend` is now a framework flag, and the legacy
	// `claude-cli` alias is gone (D-021).
	test("the framework consumes --backend before the URL is derived", () => {
		const invocation = invocationOf([
			"--backend",
			"claude",
			PAGE,
			"extract",
			"pricing",
		]);
		expect(invocation.backend).toBe("claude");
		expect(resolveWebfetchInput(invocation.flags, invocation.args)).toEqual({
			mode: "run",
			url: PAGE,
			userPrompt: "extract pricing",
			raw: false,
		});
	});

	test("the URL is --url, else the first positional; the prompt is --prompt, else the other positionals", () => {
		const resolveArgv = (argv: string[]) => {
			const invocation = invocationOf(argv);
			return resolveWebfetchInput(invocation.flags, invocation.args);
		};
		expect(resolveArgv([PAGE])).toEqual({
			mode: "run",
			url: PAGE,
			userPrompt: "",
			raw: false,
		});
		expect(resolveArgv(["--url", PAGE, "--prompt", " list tiers "])).toEqual({
			mode: "run",
			url: PAGE,
			userPrompt: "list tiers",
			raw: false,
		});
		expect(resolveArgv([`--url=${PAGE}`, "extra", "words"])).toEqual({
			mode: "run",
			url: PAGE,
			userPrompt: "extra words",
			raw: false,
		});
		expect(resolveArgv([PAGE, "ignored", "--prompt", "wins"])).toEqual({
			mode: "run",
			url: PAGE,
			userPrompt: "wins",
			raw: false,
		});
		expect(resolveArgv(["--raw", PAGE])).toEqual({
			mode: "run",
			url: PAGE,
			userPrompt: "",
			raw: true,
		});
		// An empty --url falls back to the first positional, which still
		// counts toward the prompt, exactly as the legacy parser did.
		expect(resolveArgv(["--url=", PAGE, "more"])).toEqual({
			mode: "run",
			url: PAGE,
			userPrompt: `${PAGE} more`,
			raw: false,
		});
	});

	test("the initial prompt is the task prompt for each legacy mode", async () => {
		const cases: [string[], Parameters<typeof buildTaskPrompt>[0]][] = [
			[[PAGE], { mode: "run", url: PAGE, userPrompt: "", raw: false }],
			[
				[PAGE, "list", "tiers"],
				{ mode: "run", url: PAGE, userPrompt: "list tiers", raw: false },
			],
			[
				["--raw", PAGE, "x"],
				{ mode: "run", url: PAGE, userPrompt: "x", raw: true },
			],
		];
		for (const [argv, request] of cases) {
			expect(await prepareWith(argv)).toEqual({
				initialPrompt: buildTaskPrompt(request),
			});
		}
		expect(
			buildTaskPrompt({
				mode: "run",
				url: PAGE,
				userPrompt: "list tiers",
				raw: false,
			}),
		).toEndWith(`URL: ${PAGE}\n\nCaller request:\nlist tiers`);
	});

	test("--describe, no input at all, and flags without URL or prompt print the usage document on stdout with 0", async () => {
		for (const argv of [["--describe"], ["--describe", PAGE], [], ["--raw"]]) {
			expect(await prepareWith(argv)).toEqual({
				exit: { message: USAGE_DOC, code: 0, stream: "stdout" },
			});
		}
	});

	test("a prompt without a URL is the stdout ERROR early exit with code 64", async () => {
		for (const argv of [
			["--prompt", "x"],
			["--url=", "--prompt", "x"],
		]) {
			expect(await prepareWith(argv)).toEqual({
				exit: { message: MISSING_URL, code: 64, stream: "stdout" },
			});
		}
	});

	test("prepare returns no flagOverrides, rules or before/after-run messages", async () => {
		const result = await prepareWith([PAGE, "--raw"]);
		expect(Object.keys(result)).toEqual(["initialPrompt"]);
	});
});

describe("CLI contract (D-005, D-028, D-037)", () => {
	test("--max-turns before -- is rejected like any unknown flag", () => {
		for (const argv of [
			["--max-turns", "5", PAGE],
			["--max-turns=5", PAGE],
		]) {
			expect(() => parseCli(spec, argv, { cwd })).toThrow(CliError);
		}
		expect(() => parseCli(spec, ["--max-turns", "5", PAGE], { cwd })).toThrow(
			'tools:webfetch: unknown option "--max-turns"',
		);
	});

	test("Claude's -p before -- is rejected; there is no alias (D-028)", () => {
		expect(() => parseCli(spec, ["-p", PAGE], { cwd })).toThrow(
			'tools:webfetch: unknown option "-p"',
		);
	});

	test("an explicit --backend codex fails clearly before prepare (AC #8)", () => {
		expect(() => parseCli(spec, ["--backend", "codex", PAGE], { cwd })).toThrow(
			new CliError(
				'tools:webfetch: backend "codex" is not declared by this agent (declared: claude)',
			),
		);
		let stdout = "";
		let stderr = "";
		const result = resolveCli(
			spec,
			["--backend=codex", "--show-prompt", PAGE],
			{
				cwd,
				stdout: (text) => {
					stdout += text;
				},
				stderr: (text) => {
					stderr += text;
				},
				isDirectory: () => true,
			},
		);
		expect(result).toEqual({ exitCode: 2 });
		expect(stdout).toBe("");
		expect(stderr).toBe(
			'tools:webfetch: backend "codex" is not declared by this agent (declared: claude)\n',
		);
	});

	test("--help is generated from the declaration and lists no --max-turns", () => {
		const outcome = parseCli(spec, ["--help"], { cwd });
		expect(outcome.kind).toBe("help");
		if (outcome.kind !== "help") return;
		for (const flag of [
			"--url",
			"--prompt",
			"--raw",
			"--describe",
			"--model",
		]) {
			expect(outcome.text).toContain(flag);
		}
		expect(outcome.text).not.toContain("max-turns");
	});
});

describe("--show-prompt envelopes (B-003)", () => {
	const cases: string[][] = [
		[PAGE],
		[PAGE, "extract", "the", "pricing", "tiers"],
		["--url", PAGE, "--prompt", "list the CLI flags"],
		["--raw", PAGE],
		["--model", "sonnet", PAGE],
	];
	for (const argv of cases) {
		test(argv.join(" "), async () => {
			expect(compact(await envelopeOf(argv))).toMatchSnapshot();
		});
	}

	test("the argv carries the fixed max turns and the legacy safety rules verbatim (AC #2)", async () => {
		const { argv } = await envelopeOf([PAGE]);
		expect(argv[0]).toBe("claude");
		expect(argv[1]).toBe("--print");
		expect(valueAfter(argv, "--model")).toBe("haiku");
		expect(JSON.parse(valueAfter(argv, "--settings") ?? "null")).toEqual(
			LEGACY_SETTINGS,
		);
		// Byte for byte, the JSON the legacy launcher passed.
		expect(valueAfter(argv, "--settings")).toBe(
			JSON.stringify(LEGACY_SETTINGS),
		);
		expect(argv.filter((arg) => arg.startsWith("--max-turns"))).toEqual([
			"--max-turns=3",
		]);
		expect(argv.filter((arg) => arg.startsWith("--allowedTools"))).toEqual([
			"--allowedTools=WebFetch",
		]);
		expect(argv).not.toContain("--permission-mode");
	});

	test("framework --model replaces haiku and is not forwarded twice", async () => {
		const { argv } = await envelopeOf(["--model", "sonnet", PAGE]);
		expect(argv.filter((arg) => arg === "--model")).toHaveLength(1);
		expect(valueAfter(argv, "--model")).toBe("sonnet");
	});

	test("declared flags are consumed and never reach the argv", async () => {
		const { argv } = await envelopeOf([
			"--url",
			PAGE,
			"--prompt",
			"p",
			"--raw",
		]);
		for (const flag of ["--url", "--prompt", "--raw", "--describe"]) {
			expect(argv).not.toContain(flag);
		}
	});

	test("tokens after -- are positionals and the previewed argv carries no tail (AC #4, D-039)", async () => {
		const envelope = await envelopeOf([PAGE, "--", "-p", "--verbose"]);
		const prompt = buildTaskPrompt({
			mode: "run",
			url: PAGE,
			userPrompt: "-p --verbose",
			raw: false,
		});
		expect(envelope.initialPrompt).toBe(prompt);
		expect(envelope.argv.slice(-4)).toEqual([
			"--max-turns=3",
			"--allowedTools=WebFetch",
			"--",
			prompt,
		]);
		expect(envelope.argv).not.toContain("-p");
		expect(envelope.argv).not.toContain("--verbose");
	});

	test("usage early exits under --show-prompt are stderr diagnostics with code 1 (D-030)", async () => {
		for (const argv of [["--prompt", "x"], ["--describe"]]) {
			const result = await preview(argv);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toBe("");
		}
	});

	test("an exported FORGE_BACKEND=codex changes nothing (D-021, AC #3)", async () => {
		const saved = process.env.FORGE_BACKEND;
		const without = await envelopeOf([PAGE]);
		process.env.FORGE_BACKEND = "codex";
		try {
			expect((await envelopeOf([PAGE])).text).toBe(without.text);
		} finally {
			if (saved === undefined) delete process.env.FORGE_BACKEND;
			else process.env.FORGE_BACKEND = saved;
		}
	});
});

describe("finish: the payload contract", () => {
	// Kept from the legacy suite.
	test("turns model-reported ERROR payloads into non-zero failures", () => {
		const result = normalizeRunResult({
			exitCode: 0,
			stdout: "ERROR: 404 Not Found\n",
			stderr: "",
		});

		expect(result.stdout).toBe("ERROR: 404 Not Found\n");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBeUndefined();
	});

	// Kept from the legacy suite.
	test("synthesizes ERROR stdout from non-zero runtime failures", () => {
		const result = normalizeRunResult({
			exitCode: 17,
			stdout: "",
			stderr: "backend unavailable\nstack trace",
		});

		expect(result.stdout).toBe("ERROR: backend unavailable\n");
		expect(result.exitCode).toBe(17);
		expect(result.stderr).toBeUndefined();
	});

	test("success passes stdout and stderr through with 0", () => {
		expect(
			finish({ exitCode: 0, stdout: "payload\n", stderr: "note\n" }),
		).toEqual({ stdout: "payload\n", stderr: "note\n", exitCode: 0 });
	});

	test("a backend failure keeps a model ERROR line, else synthesizes one", () => {
		const backend = (
			stdout: string,
			stderr: string,
			exitCode: number,
		): RunResult => ({
			exitCode,
			stdout,
			stderr,
			failure: {
				stage: "backend",
				message: `claude exited with code ${exitCode}`,
			},
		});
		expect(finish(backend("ERROR: blocked\n", "", 5))).toEqual({
			stdout: "ERROR: blocked\n",
			exitCode: 5,
		});
		expect(finish(backend("partial\n", "", 3))).toEqual({
			stdout: "ERROR: partial\n",
			exitCode: 3,
		});
		expect(finish(backend("", "", 7))).toEqual({
			stdout: "ERROR: web fetch failed with exit code 7\n",
			exitCode: 7,
		});
	});

	// Rewritten from the legacy "maps thrown runtime failures to the
	// documented ERROR contract": the runner now reports them as a failure
	// stage instead of a throw.
	test("a failure before the backend maps its message to one ERROR line with 1", () => {
		for (const stage of [
			"prepare",
			"interpolation",
			"adapter",
			"spawn",
		] as const) {
			expect(
				finish({
					exitCode: 1,
					stdout: "",
					stderr: `${stage} failed: claude: command not found on PATH\n`,
					failure: {
						stage,
						message: "claude: command not found on PATH\nmore",
					},
				}),
			).toEqual({
				stdout: "ERROR: claude: command not found on PATH\n",
				exitCode: 1,
			});
		}
	});

	test("formatErrorLine keeps one line and never doubles the prefix", () => {
		expect(formatErrorLine("ERROR: nope\nstack")).toBe("ERROR: nope\n");
		expect(formatErrorLine("   \n")).toBe("ERROR: web fetch failed\n");
	});
});

describe("execution through the fake Claude CLI (B-006)", () => {
	async function execute(
		argv: string[],
		options: {
			scenario?: "ok" | "fail";
			env?: Record<string, string>;
			path?: string;
			extension?: AgentExtension;
		} = {},
	) {
		const records = join(scratch, `records-${crypto.randomUUID()}.jsonl`);
		let stdout = "";
		let stderr = "";
		const code = await executeAgent(
			spec,
			options.extension ?? extension,
			invocationOf(argv),
			{
				stdout: (text) => {
					stdout += text;
				},
				stderr: (text) => {
					stderr += text;
				},
				isDirectory: () => true,
				env: {
					...process.env,
					PATH: options.path ?? `${fakeBin}:${process.env.PATH}`,
					FAKE_RECORD: records,
					FAKE_SCENARIO: options.scenario ?? "ok",
					...options.env,
				},
			},
		);
		return { code, stdout, stderr, records: readRecords(records) };
	}

	test("success: the payload on stdout, code 0, one claude launch with the previewed argv", async () => {
		const run = await execute([PAGE, "list", "tiers"]);
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 0,
			stdout: "claude result\n",
			stderr: "",
		});
		expect(run.records).toHaveLength(1);
		const argv = run.records[0]?.argv ?? [];
		const { argv: previewed } = await envelopeOf([PAGE, "list", "tiers"]);
		expect(argv).toEqual(previewed.slice(1));
		expect(argv).toContain("--max-turns=3");
		expect(JSON.parse(valueAfter(argv, "--settings") ?? "null")).toEqual(
			LEGACY_SETTINGS,
		);
	});

	test("backend failure: ERROR from its stderr on stdout, the backend's code", async () => {
		const run = await execute([PAGE], { scenario: "fail" });
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 3,
			stdout: "ERROR: backend exploded\n",
			stderr: "",
		});
		expect(run.records).toHaveLength(1);
	});

	test("prepare failure: ERROR on stdout, code 1, no backend", async () => {
		const run = await execute([PAGE], {
			extension: {
				prepare: () => {
					throw new Error("prepare exploded");
				},
				finish,
			},
		});
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 1,
			stdout: "ERROR: prepare exploded\n",
			stderr: "",
		});
		expect(run.records).toEqual([]);
	});

	test("spawn failure: no claude on PATH is ERROR on stdout with code 1", async () => {
		const empty = join(scratch, "empty-path");
		mkdirSync(empty, { recursive: true });
		const run = await execute([PAGE], { path: empty });
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 1,
			stdout: "ERROR: claude: command not found on PATH\n",
			stderr: "",
		});
	});

	test("missing URL: the stdout ERROR line, code 64, no backend", async () => {
		const run = await execute(["--prompt", "x"]);
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 64,
			stdout: MISSING_URL,
			stderr: "",
		});
		expect(run.records).toEqual([]);
	});

	test("--describe: the usage document on stdout, code 0, no backend", async () => {
		const run = await execute(["--describe"]);
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 0,
			stdout: USAGE_DOC,
			stderr: "",
		});
		expect(run.records).toEqual([]);
	});

	test("FORGE_BACKEND=codex in the environment still launches claude with the same argv (AC #3)", async () => {
		const plain = await execute([PAGE]);
		const exported = await execute([PAGE], { env: { FORGE_BACKEND: "codex" } });
		expect(exported.code).toBe(0);
		expect(exported.records.map((record) => record.name)).toEqual(["claude"]);
		expect(exported.records[0]?.argv).toEqual(plain.records[0]?.argv ?? []);
	});

	test("the reviewer's attack line after -- never reaches claude: the tokens become prompt words (AC #4, D-039)", async () => {
		const run = await execute([PAGE, "--", ...ATTACK]);
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 0,
			stdout: "claude result\n",
			stderr: "",
		});
		expect(run.records).toHaveLength(1);
		expectSealedArgv(run.records[0]?.argv ?? [], ATTACK.join(" "));
	});

	test("a URL and prompt after -- are fetched as positionals, as the legacy parser did (review m-1)", async () => {
		const run = await execute(["--", PAGE, "list tiers"]);
		expect(run.code).toBe(0);
		expect(run.records).toHaveLength(1);
		expect(run.records[0]?.argv.at(-1)).toBe(
			buildTaskPrompt({
				mode: "run",
				url: PAGE,
				userPrompt: "list tiers",
				raw: false,
			}),
		);
	});

	test("a URL that starts with a dash after -- is the URL, not an option", async () => {
		const run = await execute(["--", "-odd.example/page", "--raw"]);
		expect(run.code).toBe(0);
		expect(run.records[0]?.argv.at(-1)).toBe(
			buildTaskPrompt({
				mode: "run",
				url: "-odd.example/page",
				userPrompt: "--raw",
				raw: false,
			}),
		);
		expect(run.records[0]?.argv).not.toContain("-odd.example/page");
	});

	// Shapes the shared fake has no scenario for (review n-7).
	for (const [scenario, expected] of [
		["error0", { code: 1, stdout: "ERROR: 404 Not Found\n", stderr: "" }],
		["note", { code: 0, stdout: "payload\n", stderr: "claude note\n" }],
		["empty", { code: 0, stdout: "", stderr: "" }],
	] as const) {
		test(`through a fake claude: ${scenario}`, async () => {
			const run = await execute([PAGE], {
				path: `${shapesBin}:${process.env.PATH}`,
				env: { WF_SHAPE: scenario },
			});
			expect({
				code: run.code,
				stdout: run.stdout,
				stderr: run.stderr,
			}).toEqual(expected);
		});
	}
});

describe("compiled binary (AC #3, B-001)", () => {
	let binary: string;

	beforeAll(async () => {
		const out = join(scratch, "bin");
		mkdirSync(out);
		binary = join(out, ID);
		await compileAgent({ root: repo, file: `${SOURCE}.md`, outFile: binary });
	});

	async function runBinary(argv: string[], env: Record<string, string> = {}) {
		const records = join(scratch, `bin-records-${crypto.randomUUID()}.jsonl`);
		const child = Bun.spawn([binary, ...argv], {
			cwd,
			env: {
				...process.env,
				PATH: `${fakeBin}:${process.env.PATH}`,
				FAKE_RECORD: records,
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, stdout, stderr, records: readRecords(records) };
	}

	test("the binary previews like the in-process runner, keeping its prompt and rules, with or without FORGE_BACKEND=codex", async () => {
		const plain = await runBinary(["--show-prompt", PAGE]);
		expect({ code: plain.code, stderr: plain.stderr }).toEqual({
			code: 0,
			stderr: "",
		});
		const expected = await preview([PAGE]);
		expect(plain.stdout).toBe(expected.stdout);
		const envelope = parseEnvelope(plain.stdout);
		expect(envelope.systemPrompt).toBe(spec.systemPrompt);
		expect(
			JSON.parse(valueAfter(envelope.argv, "--settings") ?? "null"),
		).toEqual(LEGACY_SETTINGS);
		const exported = await runBinary(["--show-prompt", PAGE], {
			FORGE_BACKEND: "codex",
		});
		expect(exported).toEqual(plain);
	});

	test("with FORGE_BACKEND=codex exported the binary runs claude and returns its payload", async () => {
		const run = await runBinary([PAGE], { FORGE_BACKEND: "codex" });
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 0,
			stdout: "claude result\n",
			stderr: "",
		});
		expect(run.records.map((record) => record.name)).toEqual(["claude"]);
		expect(
			JSON.parse(
				valueAfter(run.records[0]?.argv ?? [], "--settings") ?? "null",
			),
		).toEqual(LEGACY_SETTINGS);
	});

	test("missing URL, --max-turns, -p and --backend codex exit as declared", async () => {
		expect(await runBinary(["--prompt", "x"])).toEqual({
			code: 64,
			stdout: MISSING_URL,
			stderr: "",
			records: [],
		});
		for (const argv of [
			["--max-turns", "5", PAGE],
			["-p", PAGE],
			["--backend", "codex", PAGE],
			["--bogus", PAGE],
		]) {
			const run = await runBinary(argv);
			expect({
				code: run.code,
				stdout: run.stdout,
				records: run.records,
			}).toEqual({ code: 2, stdout: "", records: [] });
			expect(run.stderr).toStartWith("tools:webfetch: ");
		}
	});

	test("the attack line after -- leaves the binary's claude argv sealed (D-039)", async () => {
		const run = await runBinary([PAGE, "--", ...ATTACK]);
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 0,
			stdout: "claude result\n",
			stderr: "",
		});
		expect(run.records).toHaveLength(1);
		expectSealedArgv(run.records[0]?.argv ?? [], ATTACK.join(" "));
		const help = await runBinary(["--help"]);
		expect(help.stdout).not.toContain("--resume");
		expect(help.stdout).toContain("[-- args...]");
	});
});
