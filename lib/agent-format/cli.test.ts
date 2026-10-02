import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	CliError,
	type CliIo,
	type CliOutcome,
	parseCli,
	resolveCli,
} from "./cli";
import type { AgentSpec } from "./types";

const orient: AgentSpec = {
	id: "analyze:orient",
	description: "Get oriented in your codebase",
	backends: ["claude", "codex"],
	promptMode: "append",
	mode: "interactive",
	initialPrompt: "{{args}}",
	systemPrompt: "You orient.",
	flags: {
		quick: { type: "boolean", short: "q", description: "Quick overview" },
		focus: {
			type: "enum",
			short: "f",
			description: "Focus area",
			values: ["structure", "commands", "tech", "changes"],
		},
		task: { type: "string", description: "Task text", default: "none" },
		verbose: { type: "boolean", description: "Talk more", default: false },
	},
	model: { claude: "sonnet" },
};

const claudeOnly: AgentSpec = {
	...orient,
	id: "tools:webfetch",
	backends: ["claude"],
	mode: "print",
	flags: {},
	model: undefined,
};

// The parser is pure, so this directory need not exist; `fakeIo` stands in
// for the filesystem where `resolveCli` checks it.
const root = "/virtual/work";

function fakeIo() {
	const out = { stdout: "", stderr: "" };
	const entries: Record<string, boolean> = {
		[root]: true,
		[join(root, "sub")]: true,
		[join(root, "file.txt")]: false,
	};
	const io: CliIo = {
		cwd: root,
		stdout: (text) => {
			out.stdout += text;
		},
		stderr: (text) => {
			out.stderr += text;
		},
		isDirectory: (path) => entries[path] ?? "missing",
	};
	return { out, io };
}

function run(argv: string[], spec: AgentSpec = orient) {
	const outcome = parseCli(spec, argv, { cwd: root });
	if (outcome.kind !== "run") throw new Error("expected a run outcome");
	return outcome.invocation;
}

function failure(argv: string[], spec: AgentSpec = orient): string {
	try {
		parseCli(spec, argv, { cwd: root });
	} catch (error) {
		if (error instanceof CliError) return error.message;
		throw error;
	}
	throw new Error("expected parseCli to fail");
}

describe("B-002 declared and framework flags (AC #1)", () => {
	test("defaults: first backend, spec mode, declared flag defaults", () => {
		expect(run([])).toEqual({
			backend: "claude",
			mode: "interactive",
			model: "sonnet",
			cwd: root,
			flags: { quick: false, task: "none", verbose: false },
			args: [],
			passthrough: [],
			showPrompt: false,
		});
	});

	test("both value forms, shorts and booleans are consumed", () => {
		const separate = run(["--focus", "tech", "--task", "go", "--quick"]);
		const equals = run(["--focus=tech", "--task=go", "--quick"]);
		const shorts = run(["-f", "tech", "--task=go", "-q"]);
		for (const inv of [separate, equals, shorts]) {
			expect(inv.flags).toEqual({
				quick: true,
				focus: "tech",
				task: "go",
				verbose: false,
			});
			expect(inv.args).toEqual([]);
		}
	});

	test("framework flags in both forms", () => {
		const a = run(["--backend", "codex", "--cwd", "sub", "--model", "opus"]);
		const b = run(["--backend=codex", "--cwd=sub", "--model=opus"]);
		for (const inv of [a, b]) {
			expect(inv.backend).toBe("codex");
			expect(inv.cwd).toBe(join(root, "sub"));
			expect(inv.model).toBe("opus");
		}
		expect(run(["--print", "--show-prompt"])).toMatchObject({
			mode: "print",
			showPrompt: true,
		});
	});

	test("positionals keep their order around flags", () => {
		const inv = run(["one", "--quick", "two", "--focus=tech", "three", "-"]);
		expect(inv.args).toEqual(["one", "two", "three", "-"]);
	});

	test("the last occurrence of a repeated flag wins", () => {
		expect(run(["--focus", "tech", "-f", "changes"]).flags.focus).toBe(
			"changes",
		);
	});

	test("string flags accept empty and dash-leading values in = form", () => {
		expect(run(["--task="]).flags.task).toBe("");
		expect(run(["--task=-x"]).flags.task).toBe("-x");
	});
});

describe("B-002/D-028 strict pre-separator input (AC #2)", () => {
	test("unknown long and short options fail and point at --", () => {
		for (const argv of [
			["--resume", "abc"],
			["-p"],
			["--permission-mode=plan"],
		]) {
			const message = failure(argv);
			expect(message).toMatch(/^analyze:orient: unknown option "-/);
			expect(message).toContain("after a standalone --");
		}
	});

	test("value errors", () => {
		expect(failure(["--focus"])).toContain('"--focus" requires a value');
		expect(failure(["--focus", "--quick"])).toContain(
			'"--focus" requires a value',
		);
		expect(failure(["--focus=ops"])).toContain(
			'"--focus" must be one of structure, commands, tech, changes (got "ops")',
		);
		expect(failure(["--quick=yes"])).toContain(
			'"--quick" does not take a value',
		);
		expect(failure(["--print=true"])).toContain(
			'"--print" does not take a value',
		);
		expect(failure(["-qf", "tech"])).toContain('unknown option "-qf"');
		expect(failure(["--no-quick"])).toContain('unknown option "--no-quick"');
	});

	test("the value hint names forms the parser accepts", () => {
		expect(failure(["-f", "-x"])).toBe(
			'analyze:orient: "-f" requires a value (use -f <value> or --focus <value>; for a value starting with "-" use --focus=<value>)',
		);
		expect(failure(["--task"])).toBe(
			'analyze:orient: "--task" requires a value (use --task <value>; for a value starting with "-" use --task=<value>)',
		);
		expect(run(["-f", "tech"]).flags.focus).toBe("tech");
		expect(run(["--task=-x"]).flags.task).toBe("-x");
	});

	test("framework value flags reject an empty value", () => {
		for (const name of ["--model", "--cwd", "--backend"]) {
			expect(failure([`${name}=`])).toBe(
				`analyze:orient: "${name}" requires a non-empty value`,
			);
			expect(failure([name, ""])).toBe(
				`analyze:orient: "${name}" requires a non-empty value`,
			);
		}
		const { out, io } = fakeIo();
		expect(resolveCli(orient, ["--model="], io)).toEqual({ exitCode: 2 });
		expect(out.stderr).toBe(
			'analyze:orient: "--model" requires a non-empty value\n',
		);
	});

	test("tokens after the first standalone -- are verbatim and uninspected", () => {
		const tail = [
			"--resume",
			"abc",
			"--",
			"-p",
			"--backend=codex",
			"--help",
			"--model",
			"x",
			"",
		];
		const inv = run(["--quick", "pos", "--", ...tail]);
		expect(inv.passthrough).toEqual(tail);
		expect(inv.args).toEqual(["pos"]);
		expect(inv.backend).toBe("claude");
		expect(inv.model).toBe("sonnet");
		expect(inv.flags.quick).toBe(true);
	});

	test("a value flag cannot swallow the separator", () => {
		expect(failure(["--task", "--", "x"])).toContain(
			'"--task" requires a value',
		);
	});
});

describe("B-002/D-021/D-005 backend resolution (AC #3)", () => {
	test("explicit --backend wins, else the first declared backend", () => {
		expect(run(["--backend", "codex"]).backend).toBe("codex");
		expect(run([]).backend).toBe("claude");
		expect(run([], { ...orient, backends: ["codex", "claude"] }).backend).toBe(
			"codex",
		);
	});

	test("an undeclared backend fails hard; unknown values fail", () => {
		expect(failure(["--backend", "codex"], claudeOnly)).toBe(
			'tools:webfetch: backend "codex" is not declared by this agent (declared: claude)',
		);
		expect(failure(["--backend", "codex-cli"])).toContain(
			'unknown backend "codex-cli" (declared: claude, codex)',
		);
	});

	test("FORGE_BACKEND and its legacy aliases are ignored", () => {
		const saved = process.env.FORGE_BACKEND;
		try {
			for (const value of ["codex", "codex-cli", "codex-sdk", "claude-cli"]) {
				process.env.FORGE_BACKEND = value;
				expect(run([]).backend).toBe("claude");
				expect(run([], claudeOnly).backend).toBe("claude");
			}
		} finally {
			if (saved === undefined) delete process.env.FORGE_BACKEND;
			else process.env.FORGE_BACKEND = saved;
		}
	});

	test("cli.ts reads no environment and imports no adapter (AC #3, #6)", async () => {
		const source = await Bun.file(new URL("./cli.ts", import.meta.url)).text();
		expect(source).not.toContain("process.env");
		expect(source).not.toContain("Bun.env");
		expect(source).not.toContain("FORGE_BACKEND");
		const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
		expect(imports.length).toBeGreaterThan(0);
		expect(imports).not.toContain("node:fs");
		expect(imports).not.toContain("node:fs/promises");
		for (const specifier of imports) {
			expect(specifier).not.toMatch(/adapter/);
		}
	});
});

describe("B-002 help and error routing (AC #4)", () => {
	test("help is generated from the spec", () => {
		const outcome = parseCli(orient, ["--help"], { cwd: root });
		expect(outcome.kind).toBe("help");
		const text = (outcome as Extract<CliOutcome, { kind: "help" }>).text;
		expect(text).toBe(`analyze:orient: Get oriented in your codebase

Usage: analyze:orient [options] [args...] [-- backend-args...]

Backends: claude (default), codex
Mode: interactive

Framework options:
  --backend <claude|codex>  Backend to run on (default: claude)
  --cwd <dir>               Working directory (default: current directory)
  --model <id>              Override the backend model (declared: claude=sonnet)
  --print                   Run in print mode (non-interactive, prints the result)
  --show-prompt             Print the resolved prompt and argv per backend, then exit
  -h, --help                Show this help and exit

Agent options:
  -q, --quick                                    Quick overview (default: false)
  -f, --focus <structure|commands|tech|changes>  Focus area
  --task <value>                                 Task text (default: "none")
  --verbose                                      Talk more (default: false)

Passthrough:
  Everything after a standalone -- goes to the backend CLI verbatim,
  for example: analyze:orient -- --resume <session-id>
`);
	});

	test("-h and help after other input; help ignores later errors", () => {
		expect(parseCli(orient, ["pos", "-h"], { cwd: root }).kind).toBe("help");
		expect(parseCli(orient, ["--bogus", "--help"], { cwd: root }).kind).toBe(
			"help",
		);
		expect(run(["--", "--help"]).passthrough).toEqual(["--help"]);
	});

	test("help for an agent with no declared flags, model or second backend", () => {
		const outcome = parseCli(claudeOnly, ["-h"], { cwd: root });
		if (outcome.kind !== "help") throw new Error("expected help");
		expect(outcome.text).toContain("Backends: claude (default)\nMode: print\n");
		expect(outcome.text).toContain("--backend <claude>");
		expect(outcome.text).toContain(
			"--model <id>        Override the backend model\n",
		);
		expect(outcome.text).toContain("Agent options:\n  (none)\n");
	});

	test("the pure parser resolves a nonexistent --cwd without touching the filesystem", () => {
		expect(run(["--cwd", "missing"]).cwd).toBe(join(root, "missing"));
		expect(run(["--cwd=/no/such/dir"]).cwd).toBe("/no/such/dir");
	});

	test("resolveCli reports cwd errors through io", () => {
		const missing = fakeIo();
		expect(resolveCli(orient, ["--cwd", "missing"], missing.io)).toEqual({
			exitCode: 2,
		});
		expect(missing.out).toEqual({
			stdout: "",
			stderr: `analyze:orient: working directory ${join(root, "missing")} does not exist\n`,
		});
		const file = fakeIo();
		expect(resolveCli(orient, ["--cwd=file.txt"], file.io)).toEqual({
			exitCode: 2,
		});
		expect(file.out.stderr).toContain("file.txt is not a directory");
		const sub = fakeIo();
		const ok = resolveCli(orient, ["--cwd", "sub"], sub.io);
		expect("invocation" in ok && ok.invocation.cwd).toBe(join(root, "sub"));
	});

	test("resolveCli writes help to stdout/0 and errors to stderr/2, never yielding an invocation", () => {
		const io = fakeIo;
		const help = io();
		expect(resolveCli(orient, ["--help"], help.io)).toEqual({ exitCode: 0 });
		expect(help.out.stdout).toStartWith("analyze:orient: Get oriented");
		expect(help.out.stderr).toBe("");

		for (const argv of [
			["--nope"],
			["--cwd", "missing"],
			["--backend=codex"],
		]) {
			const bad = io();
			const spec = argv[0] === "--backend=codex" ? claudeOnly : orient;
			const result = resolveCli(spec, argv, bad.io);
			expect(result).toEqual({ exitCode: 2 });
			expect(bad.out.stdout).toBe("");
			expect(bad.out.stderr).toEndWith("\n");
			expect(bad.out.stderr.length).toBeGreaterThan(1);
		}

		const ok = io();
		const result = resolveCli(orient, ["x"], ok.io);
		expect("invocation" in result && result.invocation.args).toEqual(["x"]);
		expect(ok.out).toEqual({ stdout: "", stderr: "" });
	});
});

describe("Design §3 framework --model and --print (AC #7)", () => {
	test("--model replaces the selected backend's model, declared or not", () => {
		expect(run([]).model).toBe("sonnet");
		expect(run(["--backend", "codex"]).model).toBeUndefined();
		expect(run(["--model", "opus"]).model).toBe("opus");
		expect(run(["--model", "opus", "--backend", "codex"]).model).toBe("opus");
		expect(run(["--model", "opus"], claudeOnly).model).toBe("opus");
	});

	test("--print sets the effective mode for every declared mode", () => {
		for (const mode of ["interactive", "print", "stream"] as const) {
			expect(run([], { ...orient, mode }).mode).toBe(mode);
			expect(run(["--print"], { ...orient, mode }).mode).toBe("print");
		}
	});
});

describe("D-039 a declaration may opt out of backend passthrough", () => {
	const sealed: AgentSpec = {
		...claudeOnly,
		flags: { prompt: { type: "string", description: "Prompt" } },
		passthrough: false,
	};

	test("tokens after -- become positionals in order and the tail stays empty", () => {
		const invocation = run(["--", "a", "-b", "--c"], sealed);
		expect(invocation.args).toEqual(["a", "-b", "--c"]);
		expect(invocation.passthrough).toEqual([]);
		const mixed = run(["x", "--", "y"], sealed);
		expect(mixed.args).toEqual(["x", "y"]);
		expect(mixed.passthrough).toEqual([]);
		expect(run(["x", "--", "--", "-p"], sealed).args).toEqual([
			"x",
			"--",
			"-p",
		]);
	});

	test("after --, declared and framework flags are positionals too", () => {
		const invocation = run(["--", "--prompt", "p", "--help", "--backend"], sealed);
		expect(invocation.args).toEqual(["--prompt", "p", "--help", "--backend"]);
		expect(invocation.flags).toEqual({});
		expect(invocation.backend).toBe("claude");
	});

	test("tokens before -- are parsed as today: an unknown flag is still an error", () => {
		expect(failure(["--bogus", "--", "x"], sealed)).toBe(
			'tools:webfetch: unknown option "--bogus"; this agent passes nothing to the backend CLI, see --help',
		);
		expect(run(["--prompt", "p", "--", "x"], sealed).flags).toEqual({
			prompt: "p",
		});
	});

	test("passthrough: true and the default keep the verbatim tail", () => {
		for (const spec of [orient, { ...orient, passthrough: true }]) {
			const invocation = run(["x", "--", "-p", "--resume", "id"], spec);
			expect(invocation.args).toEqual(["x"]);
			expect(invocation.passthrough).toEqual(["-p", "--resume", "id"]);
		}
		expect(failure(["-p"], { ...orient, passthrough: true })).toContain(
			"Backend flags go after a standalone --",
		);
	});

	test("help offers no backend passthrough for an opted-out agent", () => {
		const outcome = parseCli(sealed, ["--help"], { cwd: root });
		if (outcome.kind !== "help") throw new Error("expected help");
		expect(outcome.text).toContain(
			"Usage: tools:webfetch [options] [args...] [-- args...]\n",
		);
		expect(outcome.text).toEndWith(
			"Passthrough:\n  None. This agent passes nothing to the backend CLI: arguments after\n  a standalone -- are taken as positional arguments.\n",
		);
		expect(outcome.text).not.toContain("backend-args");
		expect(outcome.text).not.toContain("--resume");
		const open = parseCli({ ...sealed, passthrough: true }, ["--help"], {
			cwd: root,
		});
		if (open.kind !== "help") throw new Error("expected help");
		expect(open.text).toContain("[-- backend-args...]");
		expect(open.text).toContain(
			"Everything after a standalone -- goes to the backend CLI verbatim",
		);
	});
});
