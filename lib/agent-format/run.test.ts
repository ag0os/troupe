import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
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
import { spec as fixtureSpec } from "./adapters/test-fixtures";
import { parseCli } from "./cli";
import { PREVIEW_PLACEHOLDERS } from "./preview";
import {
	type AgentExtension,
	createPrepareContext,
	createRunCommand,
	previewAgent,
	probeGitWorktree,
	type RunCommand,
	runPrepare,
	withStdoutAbsorbed,
} from "./run";
import { PROMPT_SEPARATOR } from "./schema";
import type { AgentSpec, CommandRequest, PrepareContext } from "./types";

let workspace: string;

beforeEach(() => {
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "agent-preview-")));
	setSystemTime(new Date("2026-01-02T03:04:05Z"));
});

afterEach(() => {
	setSystemTime();
	rmSync(workspace, { recursive: true, force: true });
});

/** Every entry under `dir`, recursively, so writes of any depth show up. */
function tree(dir: string): string[] {
	return readdirSync(dir, { recursive: true }).map(String).sort();
}

interface Captured {
	code: number;
	stdout: string;
	stderr: string;
	commands: CommandRequest[];
}

/**
 * Parse `argv` against `spec` in the temp workspace and preview it with a
 * recording command facility that runs nothing.
 */
async function preview(
	spec: AgentSpec,
	argv: string[],
	extension: AgentExtension = {},
	onCommand: (request: CommandRequest) => {
		exitCode: number;
		stdout: string;
	} = () => ({
		exitCode: 1,
		stdout: "",
	}),
): Promise<Captured> {
	const outcome = parseCli(spec, [...argv, "--show-prompt"], {
		cwd: workspace,
	});
	if (outcome.kind !== "run") throw new Error("expected a run outcome");
	const captured: Captured = { code: 0, stdout: "", stderr: "", commands: [] };
	const runCommand: RunCommand = async (request) => {
		captured.commands.push(request);
		return { ...onCommand(request), stderr: "" };
	};
	captured.code = await previewAgent(spec, extension, outcome.invocation, {
		stdout: (text) => {
			captured.stdout += text;
		},
		stderr: (text) => {
			captured.stderr += text;
		},
		isDirectory: () => true,
		runCommand,
	});
	return captured;
}

/** An agent whose prepare behaves like Audit/diagrams: it creates a directory and calls gh only when not previewing. */
function auditLike(seen: PrepareContext[] = []): AgentExtension {
	return {
		async prepare(ctx) {
			seen.push(ctx);
			const dir = join(
				ctx.cwd,
				".audit",
				new Date().toISOString().slice(0, 10),
			);
			if (!ctx.preview) {
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "started"), "");
				await ctx.runCommand({ argv: ["gh", "pr", "view"] });
			}
			return {
				systemPromptFragments: [`Write the report to ${dir}.`],
				beforeRunMessages: ["BANNER: starting audit"],
				afterRunMessages: ["BANNER: audit done"],
				...(ctx.backend === "claude"
					? { extraAllowRules: { rules: [`Write(/${dir}/**)`] } }
					: {}),
			};
		},
	};
}

describe("previewAgent envelope (B-003, D-012)", () => {
	const agent = fixtureSpec({
		id: "fixture:audit",
		systemPrompt: "Audit body",
		initialPrompt: "Audit {{args}}",
	});

	test("prints exactly the fixed envelope on each declared backend", async () => {
		const dir = join(workspace, ".audit", "2026-01-02");
		const system = `Audit body${PROMPT_SEPARATOR}Write the report to ${dir}.`;

		const claude = await preview(agent, ["src"], auditLike());
		expect(claude).toEqual({
			code: 0,
			stderr: "",
			commands: [],
			stdout: [
				"Backend: claude",
				"--- System prompt ---",
				system,
				"--- Initial prompt ---",
				"Audit src",
				"--- Argv ---",
				JSON.stringify([
					"claude",
					"--append-system-prompt",
					system,
					"--settings",
					JSON.stringify({ permissions: { allow: [`Write(/${dir}/**)`] } }),
					"--",
					"Audit src",
				]),
				"",
			].join("\n"),
		});

		const codex = await preview(
			agent,
			["src", "--backend", "codex"],
			auditLike(),
		);
		expect(codex).toEqual({
			code: 0,
			stderr: "",
			commands: [],
			stdout: [
				"Backend: codex",
				"--- System prompt ---",
				system,
				"--- Initial prompt ---",
				"Audit src",
				"--- Argv ---",
				JSON.stringify([
					"codex",
					"-c",
					`developer_instructions=${JSON.stringify(system)}`,
					"--",
					"Audit src",
				]),
				"",
			].join("\n"),
		});
	});

	test("preparation sees preview, the effective mode and the parsed invocation (D-016)", async () => {
		const seen: PrepareContext[] = [];
		await preview(
			fixtureSpec({
				flags: { quick: { type: "boolean", description: "Quick" } },
			}),
			["a", "--quick", "--print", "--backend", "codex", "--", "--tail"],
			auditLike(seen),
			() => ({ exitCode: 0, stdout: "true\n" }),
		);
		expect(seen).toHaveLength(1);
		const [ctx] = seen as [PrepareContext];
		expect(ctx.preview).toBe(true);
		expect(ctx.mode).toBe("print");
		expect(ctx.backend).toBe("codex");
		expect(ctx.flags).toEqual({ quick: true });
		expect(ctx.args).toEqual(["a"]);
		expect(ctx.cwd).toBe(workspace);
		expect(ctx.spec.id).toBe("test:agent");
		expect(ctx.signal).toBeInstanceOf(AbortSignal);
		expect(typeof ctx.runCommand).toBe("function");
		expect(Object.isFrozen(ctx)).toBe(true);
		expect(Object.isFrozen(ctx.flags)).toBe(true);
	});

	test("preview writes nothing, runs no preparation child and emits no banner (negative)", async () => {
		const before = tree(workspace);
		const result = await preview(agent, ["src"], auditLike());
		expect(result.code).toBe(0);
		expect(tree(workspace)).toEqual(before);
		expect(result.commands).toEqual([]);
		expect(result.stdout).not.toContain("BANNER");
		expect(result.stderr).toBe("");
	});

	test("the same preparation outside preview does write and run children (mutation guard)", async () => {
		const commands: CommandRequest[] = [];
		const outcome = parseCli(agent, ["src"], { cwd: workspace });
		if (outcome.kind !== "run") throw new Error("expected run");
		const ctx = createPrepareContext(agent, outcome.invocation, {
			signal: new AbortController().signal,
			runCommand: async (request) => {
				commands.push(request);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		expect(ctx.preview).toBe(false);
		await runPrepare(agent, auditLike(), ctx, { isDirectory: () => true });
		expect(tree(workspace)).toContain(join(".audit", "2026-01-02", "started"));
		expect(commands).toEqual([{ argv: ["gh", "pr", "view"] }]);
	});

	const families: [
		string,
		string[],
		(c: Record<string, (...a: unknown[]) => void>) => void,
	][] = [
		[
			"log/info/debug/write",
			["log", "info", "debug", "write"],
			(c) => {
				c.log?.("LEAK");
				c.info?.("LEAK");
				c.debug?.("LEAK");
				c.write?.("LEAK");
			},
		],
		[
			"dir/dirxml/table",
			["dir", "dirxml", "table"],
			(c) => {
				c.dir?.({ LEAK: 1 });
				c.dirxml?.("LEAK");
				c.table?.([{ LEAK: 1 }]);
			},
		],
		[
			"count/countReset",
			["count", "countReset"],
			(c) => {
				c.count?.("LEAK");
				c.countReset?.("LEAK");
			},
		],
		[
			"group/groupCollapsed/groupEnd",
			["group", "groupCollapsed", "groupEnd"],
			(c) => {
				c.group?.("LEAK");
				c.groupCollapsed?.("LEAK");
				c.groupEnd?.();
			},
		],
		["trace", ["trace"], (c) => c.trace?.("LEAK")],
		[
			"timeLog/timeEnd",
			["timeLog", "timeEnd"],
			(c) => {
				c.timeLog?.("LEAK");
				c.timeEnd?.("LEAK");
			},
		],
		["clear", ["clear"], (c) => c.clear?.()],
	];

	for (const [family, methods, call] of families) {
		test(`absorbs console ${family} during preparation`, async () => {
			const target = console as unknown as Record<
				string,
				(...a: unknown[]) => void
			>;
			const leaked: unknown[] = [];
			const saved = methods.map((name) => [name, target[name]] as const);
			const write = process.stdout.write;
			for (const name of methods)
				target[name] = (...data) => leaked.push([name, data]);
			process.stdout.write = ((chunk: unknown) => {
				leaked.push(chunk);
				return true;
			}) as typeof process.stdout.write;
			let result: Captured;
			try {
				result = await preview(agent, ["src"], {
					prepare() {
						call(target);
						return {};
					},
				});
			} finally {
				process.stdout.write = write;
				for (const [name, method] of saved)
					target[name] = method as (...a: unknown[]) => void;
			}
			expect(leaked).toEqual([]);
			expect(result.code).toBe(0);
			expect(result.stdout).toStartWith("Backend: claude\n");
		});
	}

	test("absorbs direct process.stdout.write during preparation", async () => {
		const leaked: unknown[] = [];
		const write = process.stdout.write;
		process.stdout.write = ((chunk: unknown) => {
			leaked.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		let result: Captured;
		try {
			result = await preview(agent, ["src"], {
				prepare() {
					process.stdout.write("LEAK write\n");
					return {};
				},
			});
		} finally {
			process.stdout.write = write;
		}
		expect(leaked).toEqual([]);
		expect(result.code).toBe(0);
	});

	test("prepare sees a deep-frozen copy; mutating ctx.spec cannot change the argv", async () => {
		const declared = fixtureSpec({ model: { claude: "sonnet" } });
		const attempts: string[] = [];
		const result = await preview(declared, ["hi"], {
			prepare(ctx) {
				const spec = ctx.spec as AgentSpec;
				for (const [label, mutate] of [
					[
						"model",
						() => {
							spec.model = { claude: "evil" };
						},
					],
					[
						"model.claude",
						() => {
							(spec.model as { claude?: string }).claude = "evil";
						},
					],
					[
						"promptMode",
						() => {
							spec.promptMode = "replace";
						},
					],
					[
						"mcp",
						() => {
							spec.mcp = { x: { command: "evil" } };
						},
					],
				] as const) {
					try {
						mutate();
					} catch (error) {
						if (error instanceof TypeError) attempts.push(label);
					}
				}
				return {};
			},
		});
		expect(attempts).toEqual(["model", "model.claude", "promptMode", "mcp"]);
		expect(declared.model).toEqual({ claude: "sonnet" });
		expect(result.stdout).toContain(
			JSON.stringify([
				"claude",
				"--append-system-prompt",
				"SYSTEM",
				"--model",
				"sonnet",
				"--",
				"hi",
			]),
		);
	});

	test("an unguarded spec mutation fails the preview with no envelope", async () => {
		const result = await preview(fixtureSpec(), ["hi"], {
			prepare(ctx) {
				(ctx.spec as AgentSpec).model = { claude: "evil" };
				return {};
			},
		});
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toStartWith("test:agent: prepare failed: ");
	});

	test("an agent without prepare previews its compiled prompt and rendered template", async () => {
		const result = await preview(
			fixtureSpec({
				flags: {
					focus: {
						type: "enum",
						description: "Focus",
						values: ["a", "b"],
						default: "a",
					},
				},
				initialPrompt:
					"{{#if args}}Look at {{args}} in {{cwd}}{{else}}Focus {{flag.focus}}{{/if}}",
			}),
			["x"],
		);
		expect(result.stdout).toContain(
			`--- Initial prompt ---\nLook at x in ${workspace}\n--- Argv ---`,
		);
	});

	test("a prepared initial prompt replaces the template and a prepared cwd is resolved", async () => {
		mkdirSync(join(workspace, "sub"));
		const result = await preview(fixtureSpec(), ["ignored"], {
			prepare: () => ({ initialPrompt: "Prepared", cwd: "sub" }),
		});
		expect(result.stdout).toContain("--- Initial prompt ---\nPrepared\n");
		expect(result.stdout).toContain(
			JSON.stringify([
				"claude",
				"--append-system-prompt",
				"SYSTEM",
				"--",
				"Prepared",
			]),
		);
	});
});

describe("preview placeholders (D-012)", () => {
	const mcpAgent = fixtureSpec({
		promptMode: "replace",
		mcp: {
			api: {
				url: "https://api.example.test/mcp",
				headers: {
					Authorization:
						'Bearer ${cmd:op item get "Github CLI Token" --fields password --reveal}',
					"X-Client": "troupe",
				},
			},
			local: { command: "local-mcp", env: { TOKEN: "${env:SECRET_TOKEN}" } },
		},
	});

	test("secrets and temp prompt paths use stable placeholders; nothing is resolved", async () => {
		const previous = process.env.SECRET_TOKEN;
		process.env.SECRET_TOKEN = "super-secret-value";
		try {
			const claude = await preview(mcpAgent, []);
			const codex = await preview(mcpAgent, ["--backend", "codex"]);
			for (const result of [claude, codex]) {
				expect(result.code).toBe(0);
				expect(result.commands).toEqual([]);
				expect(result.stdout).not.toContain("super-secret-value");
				expect(result.stdout).not.toContain("op item get");
				expect(result.stdout).not.toContain(tmpdir());
			}
			const claudeArgv = JSON.parse(claude.stdout.split("\n").at(-2) ?? "");
			expect(claudeArgv.slice(0, 3)).toEqual([
				"claude",
				"--system-prompt",
				"SYSTEM",
			]);
			expect(JSON.parse(claudeArgv[4])).toEqual({
				mcpServers: {
					api: {
						type: "http",
						url: "https://api.example.test/mcp",
						headers: {
							Authorization: "${TROUPE_MCP_API_AUTHORIZATION}",
							"X-Client": "troupe",
						},
					},
					local: {
						type: "stdio",
						command: "local-mcp",
						env: { TOKEN: PREVIEW_PLACEHOLDERS.env("SECRET_TOKEN") },
					},
				},
			});

			const codexArgv = JSON.parse(codex.stdout.split("\n").at(-2) ?? "");
			expect(codexArgv).toEqual([
				"codex",
				"-c",
				`model_instructions_file="${PREVIEW_PLACEHOLDERS.promptFile}"`,
				"-c",
				'mcp_servers.api={url = "https://api.example.test/mcp", http_headers = {X-Client = "troupe"}, env_http_headers = {Authorization = "TROUPE_MCP_API_AUTHORIZATION"}}',
				"-c",
				`mcp_servers.local={command = "local-mcp", env = {TOKEN = "${PREVIEW_PLACEHOLDERS.env("SECRET_TOKEN")}"}}`,
			]);
			// Stable: a second preview is byte-identical.
			expect((await preview(mcpAgent, ["--backend", "codex"])).stdout).toBe(
				codex.stdout,
			);
		} finally {
			if (previous === undefined) delete process.env.SECRET_TOKEN;
			else process.env.SECRET_TOKEN = previous;
		}
	});
});

describe("framework model and print in preview (B-002, AC #7)", () => {
	const declared = fixtureSpec({ model: { claude: "sonnet", codex: "gpt-5" } });
	const undeclared = fixtureSpec();

	test("--model opus reaches both adapters with or without a declared model", async () => {
		for (const agent of [declared, undeclared]) {
			const claude = await preview(agent, ["--model", "opus", "hi"]);
			expect(claude.stdout).toContain(
				JSON.stringify([
					"claude",
					"--append-system-prompt",
					"SYSTEM",
					"--model",
					"opus",
					"--",
					"hi",
				]),
			);
			const codex = await preview(agent, [
				"--model",
				"opus",
				"--backend",
				"codex",
				"hi",
			]);
			expect(codex.stdout).toContain(
				JSON.stringify([
					"codex",
					"-c",
					'developer_instructions="SYSTEM"',
					"-m",
					"opus",
					"--",
					"hi",
				]),
			);
		}
	});

	test("without --model the declared model shows and an undeclared one shows nothing", async () => {
		expect((await preview(declared, [])).stdout).toContain(
			'"--model","sonnet"',
		);
		expect((await preview(declared, ["--backend", "codex"])).stdout).toContain(
			'"-m","gpt-5"',
		);
		const plain = await preview(undeclared, ["--backend", "codex"]);
		expect(plain.stdout).not.toContain('"-m"');
	});

	test("--print previews print-mode argv and that mode reaches ctx.mode", async () => {
		const seen: PrepareContext[] = [];
		const claude = await preview(
			undeclared,
			["--print", "hi"],
			auditLike(seen),
		);
		expect(JSON.parse(claude.stdout.split("\n").at(-2) ?? "")[1]).toBe(
			"--print",
		);

		// Outside a worktree the probe answers false, so exec skips the Git check.
		const codex = await preview(
			undeclared,
			["--print", "--backend", "codex", "hi"],
			auditLike(seen),
		);
		const argv = JSON.parse(codex.stdout.split("\n").at(-2) ?? "");
		expect(argv.slice(0, 3)).toEqual([
			"codex",
			"exec",
			"--skip-git-repo-check",
		]);
		expect(codex.commands).toEqual([
			{ argv: ["git", "rev-parse", "--is-inside-work-tree"], cwd: workspace },
		]);
		const inside = await preview(
			undeclared,
			["--print", "--backend", "codex", "hi"],
			{},
			() => ({ exitCode: 0, stdout: "true\n" }),
		);
		expect(
			JSON.parse(inside.stdout.split("\n").at(-2) ?? "").slice(0, 3),
		).toEqual(["codex", "exec", "-c"]);
		expect(seen.map((ctx) => [ctx.backend, ctx.mode])).toEqual([
			["claude", "print"],
			["codex", "print"],
		]);
	});
});

describe("failing previews (B-003 AC #4)", () => {
	const stderrOnly = (result: Captured) => {
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr.length).toBeGreaterThan(0);
	};

	test("a prepare throw writes a diagnostic and no envelope", async () => {
		const result = await preview(fixtureSpec(), [], {
			prepare() {
				console.log("partial");
				throw new Error("boom");
			},
		});
		stderrOnly(result);
		expect(result.stderr).toBe("test:agent: prepare failed: boom\n");
	});

	test("an adapter failure writes a diagnostic and no envelope", async () => {
		// Allow rules are Claude-only; a Codex preview that receives them fails closed.
		const result = await preview(fixtureSpec(), ["--backend", "codex"], {
			prepare: () => ({ extraAllowRules: { rules: ["Read(//x/**)"] } }),
		});
		stderrOnly(result);
		expect(result.stderr).toContain("allow rules are Claude-only");
	});

	test("an early exit is reported on stderr with exit 1, never as an envelope (D-030)", async () => {
		const result = await preview(fixtureSpec(), [], {
			prepare: () => ({
				exit: { message: "ERROR: no URL", code: 64, stream: "stdout" },
			}),
		});
		expect(result).toEqual({
			code: 1,
			stdout: "",
			stderr: "ERROR: no URL\n",
			commands: [],
		});
		const zero = await preview(fixtureSpec(), [], {
			prepare: () => ({
				exit: { message: "listed", code: 0, stream: "stdout" },
			}),
		});
		expect(zero.code).toBe(1);
		expect(zero.stdout).toBe("");
	});

	test("flagOverrides are refused until the runner revalidates them", async () => {
		const result = await preview(fixtureSpec(), [], {
			prepare: () => ({ flagOverrides: { x: "1" } }),
		});
		stderrOnly(result);
	});

	test("an unknown or undeclared backend fails in the CLI before preparation", () => {
		const restricted = fixtureSpec({ backends: ["claude"] });
		for (const backend of ["gemini", "codex"]) {
			expect(() =>
				parseCli(restricted, ["--show-prompt", "--backend", backend], {
					cwd: workspace,
				}),
			).toThrow(/backend/);
		}
	});
});

describe("createRunCommand", () => {
	test("captures child output without a shell and never inherits stdout", async () => {
		const runCommand = createRunCommand({
			cwd: workspace,
			signal: new AbortController().signal,
		});
		const result = await runCommand({
			argv: [
				"sh",
				"-c",
				'printf "%s|%s" "$PWD" "$EXTRA"; echo err >&2; exit 3',
			],
			env: { EXTRA: "x y" },
		});
		expect(result).toEqual({
			exitCode: 3,
			stdout: `${workspace}|x y`,
			stderr: "err\n",
		});
		const quoted = await runCommand({ argv: ["printf", "%s", "a b;$HOME"] });
		expect(quoted.stdout).toBe("a b;$HOME");
	});

	test("an aborted signal refuses to start a child", async () => {
		const controller = new AbortController();
		controller.abort();
		const marker = join(workspace, "ran");
		const runCommand = createRunCommand({
			cwd: workspace,
			signal: controller.signal,
		});
		await expect(runCommand({ argv: ["touch", marker] })).rejects.toThrow();
		expect(existsSync(marker)).toBe(false);
	});
});

describe("probeGitWorktree", () => {
	const real = () =>
		createRunCommand({ cwd: workspace, signal: new AbortController().signal });

	test("runs the real git: true inside a repository", async () => {
		const repo = join(workspace, "repo");
		mkdirSync(join(repo, "nested"), { recursive: true });
		expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
		const errors: string[] = [];
		expect(
			await probeGitWorktree(real(), join(repo, "nested"), (m) =>
				errors.push(m),
			),
		).toBe(true);
		expect(errors).toEqual([]);
	});

	test("runs the real git: false outside any repository", async () => {
		const errors: string[] = [];
		expect(
			await probeGitWorktree(real(), workspace, (m) => errors.push(m)),
		).toBe(false);
		expect(errors).toEqual([]);
	});

	test("a probe that cannot run counts as inside and reports once", async () => {
		const errors: string[] = [];
		const inside = await probeGitWorktree(
			async () => {
				throw new Error("spawn git ENOENT");
			},
			workspace,
			(m) => errors.push(m),
		);
		expect(inside).toBe(true);
		expect(errors).toEqual(["git worktree probe failed: spawn git ENOENT"]);
	});

	test("a failed probe keeps the Codex Git check and says so on stderr", async () => {
		const outcome = parseCli(
			fixtureSpec(),
			["--print", "--backend", "codex", "hi", "--show-prompt"],
			{
				cwd: workspace,
			},
		);
		if (outcome.kind !== "run") throw new Error("expected run");
		let stdout = "";
		let stderr = "";
		const code = await previewAgent(fixtureSpec(), {}, outcome.invocation, {
			stdout: (text) => {
				stdout += text;
			},
			stderr: (text) => {
				stderr += text;
			},
			isDirectory: () => true,
			runCommand: async () => {
				throw new Error("spawn git ENOENT");
			},
		});
		expect(code).toBe(0);
		expect(stderr).toBe(
			"test:agent: git worktree probe failed: spawn git ENOENT\n",
		);
		expect(JSON.parse(stdout.split("\n").at(-2) ?? "")).toEqual([
			"codex",
			"exec",
			"-c",
			'developer_instructions="SYSTEM"',
			"--",
			"hi",
		]);
	});
});

describe("withStdoutAbsorbed", () => {
	test("restores stdout writers even when the callback throws", async () => {
		const write = process.stdout.write;
		const log = console.log;
		await expect(
			withStdoutAbsorbed(async () => {
				throw new Error("x");
			}),
		).rejects.toThrow("x");
		expect(process.stdout.write).toBe(write);
		expect(console.log).toBe(log);
	});
});
