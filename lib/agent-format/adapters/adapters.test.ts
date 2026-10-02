import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpSecretEnvName } from "../command-text";
import { parseAgentMarkdown } from "../schema";
import { ADAPTERS, adapterFor, claudeAdapter, codexAdapter } from "./index";
import {
	invocation,
	literal,
	POLICY_TOKENS,
	secret,
	spec,
} from "./test-fixtures";
import type { BackendAdapter, Invocation, ResourcePaths } from "./types";

const PATHS: ResourcePaths = {
	promptFile: "<prompt-file>",
	tmpDir: "<tmpdir>",
};

function argv(adapter: BackendAdapter, inv: Invocation): string[] {
	return adapter.build(inv, PATHS).argv;
}
const claude = (overrides: Partial<Invocation> = {}) =>
	argv(claudeAdapter, invocation("claude", overrides));
const codex = (overrides: Partial<Invocation> = {}) =>
	argv(codexAdapter, invocation("codex", overrides));

/** The value following `flag`, for every occurrence. */
function valuesOf(tokens: string[], flag: string): string[] {
	return tokens.flatMap((token, i) =>
		token === flag ? [tokens[i + 1] ?? ""] : [],
	);
}

describe("#1 contracts and id-based selection (D-002)", () => {
	test("the selector returns one adapter per declared backend id", () => {
		expect(adapterFor("claude")).toBe(claudeAdapter);
		expect(adapterFor("codex")).toBe(codexAdapter);
		expect(Object.keys(ADAPTERS)).toEqual(["claude", "codex"]);
		for (const [id, adapter] of Object.entries(ADAPTERS)) {
			expect(adapter.id).toBe(id as "claude" | "codex");
		}
	});

	test("an unknown id fails naming the known ids", () => {
		expect(() => adapterFor("gemini")).toThrow(
			'unknown backend "gemini" (known: claude, codex)',
		);
	});

	test("an undeclared backend fails with a clear message (D-005)", () => {
		const claudeOnly = spec({ backends: ["claude"] });
		expect(() =>
			codexAdapter.build(invocation("codex", { spec: claudeOnly }), PATHS),
		).toThrow(
			"test:agent does not declare the codex backend (declared: claude)",
		);
	});

	test("an adapter refuses another backend's invocation", () => {
		expect(() => claudeAdapter.build(invocation("codex"), PATHS)).toThrow(
			/claude adapter cannot build a "codex" invocation/,
		);
	});

	test("build is deterministic and does not mutate its inputs", () => {
		const inv = invocation("claude", {
			spec: spec({ native: { claude: { settings: { model: "x" } } } }),
			extraAllowRules: { rules: ["Read(//abs/**)"] },
		});
		const before = structuredClone(inv);
		const first = claudeAdapter.build(inv, PATHS);
		const second = claudeAdapter.build(inv, PATHS);
		expect(second).toEqual(first);
		expect(inv).toEqual(before);
	});

	test("resources name what the runner must create; build only uses given paths", () => {
		const replace = spec({ promptMode: "replace" });
		expect(claudeAdapter.resources(invocation("claude"))).toEqual({
			tmpDir: true,
		});
		expect(codexAdapter.resources(invocation("codex"))).toEqual({});
		expect(
			codexAdapter.resources(invocation("codex", { spec: replace })),
		).toEqual({ promptFile: "SYSTEM" });
		expect(
			codexAdapter.build(invocation("codex", { spec: replace }), {
				promptFile: "/nonexistent/prompt.md",
			}).argv,
		).toContain('model_instructions_file="/nonexistent/prompt.md"');
		expect(
			claudeAdapter.build(invocation("claude"), { tmpDir: "/nonexistent/tmp" })
				.env,
		).toEqual({ TMPDIR: "/nonexistent/tmp" });
	});

	test("missing resource paths fail instead of being invented", () => {
		expect(() => claudeAdapter.build(invocation("claude"), {})).toThrow(
			/tmpDir/,
		);
		expect(() =>
			codexAdapter.build(
				invocation("codex", { spec: spec({ promptMode: "replace" }) }),
				{},
			),
		).toThrow(/promptFile/);
	});

	test("adapter modules import no process, filesystem or spawn APIs", () => {
		for (const file of ["claude.ts", "codex.ts", "shared.ts", "index.ts"]) {
			const source = readFileSync(join(import.meta.dir, file), "utf8");
			expect(source).not.toMatch(
				/from "(node:)?(fs|child_process|os|process)(\/promises)?"|Bun\.(spawn|file|write)|process\.(env|cwd)/,
			);
		}
	});
});

describe("#2 only declared concerns become argv (B-004, D-004)", () => {
	const bare = spec({ systemPrompt: "" });

	test("an agent that declares nothing emits no policy on either backend", () => {
		const claudeArgv = claude({ spec: bare, systemPrompt: "" });
		const codexArgv = codex({ spec: bare, systemPrompt: "" });
		expect(claudeArgv).toEqual([]);
		expect(codexArgv).toEqual([]);
	});

	test("print on codex adds only exec plumbing, never policy overrides", () => {
		const tokens = codex({ spec: bare, systemPrompt: "", mode: "print" });
		expect(tokens).toEqual(["exec"]);
		for (const token of POLICY_TOKENS) expect(tokens).not.toContain(token);
		expect(tokens.join(" ")).not.toMatch(
			/approval_policy|sandbox_mode|model_reasoning_effort|mcp_servers|model=/,
		);
	});

	test("declared model, effort and access appear exactly once", () => {
		const declared = spec({
			model: { claude: "opus", codex: "gpt-5.5" },
			effort: { claude: "high", codex: "low" },
			access: "workspace-write",
		});
		const c = claude({ spec: declared });
		expect(valuesOf(c, "--model")).toEqual(["opus"]);
		expect(valuesOf(c, "--effort")).toEqual(["high"]);
		expect(valuesOf(c, "--permission-mode")).toEqual(["acceptEdits"]);
		const x = codex({ spec: declared });
		expect(valuesOf(x, "-m")).toEqual(["gpt-5.5"]);
		expect(valuesOf(x, "-c")).toContain('model_reasoning_effort="low"');
		expect(valuesOf(x, "-s")).toEqual(["workspace-write"]);
	});

	test("a model declared only for one backend does not leak to the other", () => {
		const onlyClaude = spec({
			model: { claude: "opus" },
			effort: { claude: "max" },
		});
		expect(codex({ spec: onlyClaude })).not.toContain("-m");
		expect(codex({ spec: onlyClaude }).join(" ")).not.toContain("effort");
	});

	test("the framework --model override wins over the declared model", () => {
		const declared = spec({ model: { claude: "sonnet", codex: "gpt-5.5" } });
		expect(
			valuesOf(claude({ spec: declared, model: "opus" }), "--model"),
		).toEqual(["opus"]);
		expect(valuesOf(codex({ spec: declared, model: "o9" }), "-m")).toEqual([
			"o9",
		]);
	});

	test("no MCP and no settings emit no --mcp-config, --settings or mcp_servers", () => {
		const c = claude({ mcp: {} });
		expect(c).not.toContain("--mcp-config");
		expect(c).not.toContain("--settings");
		expect(codex({ mcp: {} }).join(" ")).not.toContain("mcp_servers");
	});

	test("cwd is the runner's spawn directory, not a flag", () => {
		const plan = claudeAdapter.build(
			invocation("claude", { cwd: "/elsewhere" }),
			PATHS,
		);
		expect(plan.argv.join(" ")).not.toContain("/elsewhere");
		expect(codex({ cwd: "/elsewhere" })).not.toContain("-C");
	});
});

describe("#3 prompt mode (D-003)", () => {
	const text = 'Line1\n"quoted" \\ back\tTab\nLine2 = true\n[section]\nünï';

	test("append: claude --append-system-prompt, codex developer_instructions", () => {
		expect(
			valuesOf(claude({ systemPrompt: text }), "--append-system-prompt"),
		).toEqual([text]);
		expect(valuesOf(codex({ systemPrompt: text }), "-c")).toEqual([
			`developer_instructions=${JSON.stringify(text)}`,
		]);
	});

	test("replace: claude --system-prompt, codex model_instructions_file", () => {
		const replace = spec({ promptMode: "replace" });
		const c = claude({ spec: replace, systemPrompt: text });
		expect(valuesOf(c, "--system-prompt")).toEqual([text]);
		expect(c).not.toContain("--append-system-prompt");
		const x = codex({ spec: replace, systemPrompt: text });
		expect(valuesOf(x, "-c")).toEqual([
			'model_instructions_file="<prompt-file>"',
		]);
		expect(x.join(" ")).not.toContain("developer_instructions");
	});

	test("an empty body emits no prompt flag and no prompt file", () => {
		for (const promptMode of ["append", "replace"] as const) {
			const empty = spec({ promptMode, systemPrompt: "" });
			const c = claude({ spec: empty, systemPrompt: "" });
			expect(c).not.toContain("--append-system-prompt");
			expect(c).not.toContain("--system-prompt");
			const inv = invocation("codex", { spec: empty, systemPrompt: "" });
			expect(codexAdapter.resources(inv)).toEqual({});
			expect(codexAdapter.build(inv, {}).argv.join(" ")).not.toMatch(
				/instructions/,
			);
		}
	});

	test("base_instructions is never emitted in any mode or prompt mode", () => {
		for (const promptMode of ["append", "replace"] as const) {
			for (const mode of ["interactive", "print", "stream"] as const) {
				const inv = { spec: spec({ promptMode }), mode, initialPrompt: "go" };
				expect(claude(inv).join(" ")).not.toContain("base_instructions");
				expect(codex(inv).join(" ")).not.toContain("base_instructions");
			}
		}
	});
});

describe("#4 access mappings (D-014)", () => {
	test.each([
		["read-only", ["--permission-mode", "plan"], ["-s", "read-only"]],
		[
			"workspace-write",
			["--permission-mode", "acceptEdits"],
			["-s", "workspace-write"],
		],
		[
			"full",
			["--permission-mode", "bypassPermissions"],
			["--dangerously-bypass-approvals-and-sandbox"],
		],
	] as const)("%s", (access, claudeFlags, codexFlags) => {
		const declared = spec({ access, systemPrompt: "" });
		expect(claude({ spec: declared, systemPrompt: "" })).toEqual([
			...claudeFlags,
		]);
		expect(codex({ spec: declared, systemPrompt: "" })).toEqual([
			...codexFlags,
		]);
	});

	test("absence emits nothing", () => {
		const tokens = [...claude(), ...codex()];
		for (const token of [
			"--permission-mode",
			"--dangerously-skip-permissions",
			"-s",
			"--sandbox",
			"--dangerously-bypass-approvals-and-sandbox",
		]) {
			expect(tokens).not.toContain(token);
		}
	});
});

describe("#5 modes, stdin and the Git check (B-004)", () => {
	test("claude print and stream flags", () => {
		expect(
			claude({
				mode: "print",
				systemPrompt: "",
				spec: spec({ systemPrompt: "" }),
			}),
		).toEqual(["--print"]);
		const stream = claude({ mode: "stream" });
		expect(stream.slice(0, 4)).toEqual([
			"--print",
			"--output-format",
			"stream-json",
			"--verbose",
		]);
	});

	test("claude stream-json never appears without --verbose", () => {
		for (const mode of ["interactive", "print", "stream"] as const) {
			const tokens = claude({ mode });
			if (tokens.includes("stream-json")) expect(tokens).toContain("--verbose");
		}
	});

	test("codex exec ignores stdin in print and stream; interactive inherits", () => {
		const plan = (mode: Invocation["mode"]) =>
			codexAdapter.build(invocation("codex", { mode }), PATHS);
		expect(plan("print").argv[0]).toBe("exec");
		expect(plan("print").stdin).toBe("ignore");
		expect(plan("stream").argv.slice(0, 2)).toEqual(["exec", "--json"]);
		expect(plan("stream").stdin).toBe("ignore");
		expect(plan("interactive").argv).not.toContain("exec");
		expect(plan("interactive").stdin).toBe("inherit");
	});

	test("stdout is piped for print and stream, inherited interactively", () => {
		for (const adapter of [claudeAdapter, codexAdapter]) {
			const plan = (mode: Invocation["mode"]) =>
				adapter.build(invocation(adapter.id, { mode }), PATHS);
			expect(plan("interactive")).toMatchObject({
				stdout: "inherit",
				stderr: "inherit",
			});
			expect(plan("print")).toMatchObject({ stdout: "pipe", stderr: "pipe" });
			expect(plan("stream")).toMatchObject({
				stdout: "pipe",
				stderr: "inherit",
			});
		}
	});

	test("--skip-git-repo-check only for exec outside a worktree", () => {
		for (const mode of ["print", "stream"] as const) {
			expect(codex({ mode, insideGitWorktree: false })).toContain(
				"--skip-git-repo-check",
			);
			expect(codex({ mode, insideGitWorktree: true })).not.toContain(
				"--skip-git-repo-check",
			);
		}
		expect(
			codex({ mode: "interactive", insideGitWorktree: false }),
		).not.toContain("--skip-git-repo-check");
	});

	test("adapter-generated codex argv never uses -a", () => {
		const everything = spec({
			access: "full",
			model: { codex: "m" },
			effort: { codex: "high" },
		});
		for (const mode of ["interactive", "print", "stream"] as const) {
			const tokens = codex({ spec: everything, mode });
			expect(tokens).not.toContain("-a");
			expect(tokens).not.toContain("--ask-for-approval");
		}
	});

	test("claude always runs with its own TMPDIR", () => {
		expect(claudeAdapter.build(invocation("claude"), PATHS).env).toEqual({
			TMPDIR: "<tmpdir>",
		});
		expect(codexAdapter.build(invocation("codex"), PATHS).env).toEqual({});
	});
});

describe("#6 native guards and verbatim user tail (D-006, D-013)", () => {
	const minimal = "---\ndescription: d\nbackends: [claude, codex]";
	const parseIssues = (frontmatter: string) => {
		try {
			parseAgentMarkdown("agents/x.md", `${minimal}\n${frontmatter}\n---\n`);
			return [];
		} catch (error) {
			return (error as { issues: { field: string }[] }).issues.map(
				(i) => i.field,
			);
		}
	};

	test("the schema rejects forbidden lifecycle and prompt keys in native", () => {
		expect(
			parseIssues('native:\n  claude:\n    args: ["--append-system-prompt=x"]'),
		).toEqual(["native.claude.args[0]"]);
		expect(
			parseIssues("native:\n  claude:\n    settings:\n      hooks: {}"),
		).toEqual(["native.claude.settings.hooks"]);
		expect(
			parseIssues('native:\n  codex:\n    args: ["-c", "base_instructions=x"]'),
		).toEqual(["native.codex.args[0]"]);
		expect(
			parseIssues(
				"native:\n  codex:\n    config:\n      developer_instructions: x",
			),
		).toEqual(["native.codex.config.developer_instructions"]);
		expect(
			parseIssues("native:\n  codex:\n    config:\n      hooks: {}"),
		).toEqual(["native.codex.config.hooks"]);
	});

	test("adapters refuse forbidden native keys on specs that skipped the parser", () => {
		const cases: [BackendAdapter, Parameters<typeof spec>[0]][] = [
			[
				claudeAdapter,
				{ native: { claude: { args: ["--system-prompt", "x"] } } },
			],
			[claudeAdapter, { native: { claude: { settings: { hooks: {} } } } }],
			[
				codexAdapter,
				{ native: { codex: { config: { base_instructions: "x" } } } },
			],
			[codexAdapter, { native: { codex: { args: ["-c", "hooks.Stop=[]"] } } }],
		];
		for (const [adapter, overrides] of cases) {
			expect(() =>
				adapter.build(invocation(adapter.id, { spec: spec(overrides) }), PATHS),
			).toThrow(/invalid native declarations/);
		}
	});

	test("reserved-looking user tail tokens pass through untouched", () => {
		const tail = [
			"--append-system-prompt",
			"user text",
			"-c",
			"base_instructions=user",
			"-a",
			"never",
			"--settings",
			'{"hooks":{}}',
			"--",
			"--weird=1",
		];
		for (const adapter of [claudeAdapter, codexAdapter]) {
			const tokens = adapter.build(
				invocation(adapter.id, {
					passthrough: tail,
					systemPrompt: "",
					spec: spec({ systemPrompt: "" }),
				}),
				PATHS,
			).argv;
			expect(tokens).toEqual(tail);
		}
	});
});

describe("#7 legacy runtime stays untouched (D-024)", () => {
	test("lib/index.ts still re-exports the legacy runtime", () => {
		const index = readFileSync(join(import.meta.dir, "../../index.ts"), "utf8");
		expect(index).toContain('export * from "./runtime"');
	});
});

describe("#8 argv composition (Design §5)", () => {
	const full = spec({
		model: { claude: "opus", codex: "gpt-5.5" },
		access: "read-only",
		native: {
			claude: { args: ["--max-turns", "3", { flag: "--no-chrome" }] },
			codex: {
				args: [{ flag: "--search" }],
				config: { "features.memories": false },
			},
		},
	});

	test("claude interactive: flags, native, user tail, -- prompt", () => {
		expect(
			claude({
				spec: full,
				passthrough: ["--resume", "abc"],
				initialPrompt: "hello",
			}),
		).toEqual([
			"--append-system-prompt",
			"SYSTEM",
			"--model",
			"opus",
			"--permission-mode",
			"plan",
			"--max-turns",
			"3",
			"--no-chrome",
			"--resume",
			"abc",
			"--",
			"hello",
		]);
	});

	test("codex interactive: flags, native, user tail, -- prompt", () => {
		expect(
			codex({
				spec: full,
				passthrough: ["--search-extra"],
				initialPrompt: "hello",
			}),
		).toEqual([
			"-c",
			'developer_instructions="SYSTEM"',
			"-m",
			"gpt-5.5",
			"-s",
			"read-only",
			"-c",
			"features.memories=false",
			"--search",
			"--search-extra",
			"--",
			"hello",
		]);
	});

	test("codex exec keeps the same order after exec plumbing", () => {
		expect(
			codex({
				spec: full,
				mode: "print",
				insideGitWorktree: false,
				passthrough: ["--ephemeral"],
				initialPrompt: "do it",
			}),
		).toEqual([
			"exec",
			"--skip-git-repo-check",
			"-c",
			'developer_instructions="SYSTEM"',
			"-m",
			"gpt-5.5",
			"-s",
			"read-only",
			"-c",
			"features.memories=false",
			"--search",
			"--ephemeral",
			"--",
			"do it",
		]);
	});

	test("claude print places the prompt after --", () => {
		const tokens = claude({
			mode: "print",
			initialPrompt: "-starts-with-dash",
		});
		expect(tokens.slice(-2)).toEqual(["--", "-starts-with-dash"]);
	});

	test("an empty initial prompt places nothing", () => {
		expect(claude({ initialPrompt: "" })).not.toContain("--");
		expect(codex({ initialPrompt: "" }).at(-1)).toBe(
			'developer_instructions="SYSTEM"',
		);
	});

	test("native settings merge with prepared rules exactly once", () => {
		const withSettings = spec({
			native: {
				claude: {
					settings: {
						permissions: { allow: ["Edit"], deny: ["Bash"] },
						env: { A: "1" },
					},
				},
			},
		});
		const tokens = claude({
			spec: withSettings,
			extraAllowRules: {
				rules: ["Read(//abs/.shepherd/**)", "Edit"],
				additionalDirectories: ["/abs/.shepherd"],
			},
		});
		const settings = valuesOf(tokens, "--settings");
		expect(settings).toHaveLength(1);
		expect(JSON.parse(settings[0] ?? "")).toEqual({
			permissions: {
				allow: ["Edit", "Read(//abs/.shepherd/**)"],
				deny: ["Bash"],
				additionalDirectories: ["/abs/.shepherd"],
			},
			env: { A: "1" },
		});
		expect(withSettings.native?.claude?.settings).toEqual({
			permissions: { allow: ["Edit"], deny: ["Bash"] },
			env: { A: "1" },
		});
	});

	test("prepared rules alone produce settings; empty rules and settings emit none", () => {
		const onlyRules = claude({
			extraAllowRules: { rules: ["Read(//a/**)"] },
		});
		expect(JSON.parse(valuesOf(onlyRules, "--settings")[0] ?? "")).toEqual({
			permissions: { allow: ["Read(//a/**)"] },
		});
		const empty = claude({
			spec: spec({ native: { claude: { settings: {} } } }),
			extraAllowRules: { rules: [], additionalDirectories: [] },
		});
		expect(empty).not.toContain("--settings");
	});

	test("codex fails closed on Claude-only allow rules", () => {
		expect(() =>
			codex({ extraAllowRules: { rules: ["Read(//a/**)"] } }),
		).toThrow(/Claude-only/);
		expect(codex({ extraAllowRules: { rules: [] } })).toBeDefined();
	});
});

describe("MCP mapping (B-004, D-029)", () => {
	const mcp = {
		chrome: {
			command: literal("npx"),
			args: [literal("chrome-devtools-mcp@latest")],
			env: { MODE: { actual: "real", display: "<env:MODE>" } },
			cwd: literal("/srv"),
		},
		github: {
			url: literal("https://api.githubcopilot.com/mcp/"),
			headers: {
				Authorization: secret("Bearer s3cr3t", "github", "Authorization"),
				"X-Toolsets": literal("repos,issues"),
			},
		},
	};

	const { cwd: _cwd, ...chromeWithoutCwd } = mcp.chrome;
	const claudeMcp = { ...mcp, chrome: chromeWithoutCwd };

	test("claude: one inline --mcp-config with env-referenced secret headers", () => {
		const plan = claudeAdapter.build(
			invocation("claude", { mcp: claudeMcp }),
			PATHS,
		);
		const [config] = valuesOf(plan.argv, "--mcp-config");
		expect(JSON.parse(config ?? "")).toEqual({
			mcpServers: {
				chrome: {
					type: "stdio",
					command: "npx",
					args: ["chrome-devtools-mcp@latest"],
					env: { MODE: "real" },
				},
				github: {
					type: "http",
					url: "https://api.githubcopilot.com/mcp/",
					headers: {
						Authorization: "${" + "TROUPE_MCP_GITHUB_AUTHORIZATION}",
						"X-Toolsets": "repos,issues",
					},
				},
			},
		});
		const [display] = valuesOf(plan.displayArgv, "--mcp-config");
		expect(JSON.parse(display ?? "").mcpServers.chrome.env).toEqual({
			MODE: "<env:MODE>",
		});
		expect(plan.argv.join(" ")).not.toContain("s3cr3t");
		expect(plan.displayArgv.join(" ")).not.toContain("s3cr3t");
	});

	test("claude refuses a stdio cwd and never emits one (D-032)", () => {
		expect(() =>
			claudeAdapter.build(invocation("claude", { mcp }), PATHS),
		).toThrow(
			"test:agent: mcp.chrome.cwd: a stdio cwd is not supported on claude",
		);
		const [config] = valuesOf(
			claudeAdapter.build(invocation("claude", { mcp: claudeMcp }), PATHS).argv,
			"--mcp-config",
		);
		expect(config).not.toContain('"cwd"');
	});

	test("codex: one mcp_servers entry per server, env_http_headers for secrets", () => {
		const plan = codexAdapter.build(
			invocation("codex", {
				mcp,
				systemPrompt: "",
				spec: spec({ systemPrompt: "" }),
			}),
			PATHS,
		);
		expect(plan.argv).toEqual([
			"-c",
			'mcp_servers.chrome={command = "npx", args = ["chrome-devtools-mcp@latest"], env = {MODE = "real"}, cwd = "/srv"}',
			"-c",
			'mcp_servers.github={url = "https://api.githubcopilot.com/mcp/", http_headers = {X-Toolsets = "repos,issues"}, env_http_headers = {Authorization = "TROUPE_MCP_GITHUB_AUTHORIZATION"}}',
		]);
		expect(plan.displayArgv[1]).toContain('env = {MODE = "<env:MODE>"}');
		expect(plan.argv.join(" ")).not.toContain("s3cr3t");
	});
});

describe("stream decoders", () => {
	test("claude: assistant text to stdout, other events as canonical JSON to stderr", () => {
		const decoder = claudeAdapter.decoder();
		expect(
			decoder.line(
				'{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"},{"type":"tool_use","name":"x"}]}}',
			),
		).toEqual([{ stream: "stdout", text: "Hi\n" }]);
		expect(decoder.line('{ "type" : "result", "ok": true }')).toEqual([
			{ stream: "stderr", text: '{"type":"result","ok":true}\n' },
		]);
		expect(decoder.line("   ")).toEqual([]);
		expect(decoder.end()).toEqual([]);
	});

	test("codex: completed agent messages to stdout, other events to stderr", () => {
		const decoder = codexAdapter.decoder();
		expect(
			decoder.line(
				'{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}',
			),
		).toEqual([{ stream: "stdout", text: "Done\n" }]);
		expect(decoder.line('{"type":"turn.started"}')).toEqual([
			{ stream: "stderr", text: '{"type":"turn.started"}\n' },
		]);
	});

	test("malformed lines throw", () => {
		expect(() => claudeAdapter.decoder().line("{not json")).toThrow(
			/malformed claude stream line/,
		);
		expect(() => codexAdapter.decoder().line("nope")).toThrow(
			/malformed codex stream line/,
		);
	});
});

describe("fix round 1", () => {
	test("codex places every prompt after --, so it never parses as a subcommand or flag", () => {
		const prompts = [
			"apply",
			"logout",
			"--dangerously-bypass-approvals-and-sandbox",
			"-c developer_instructions=x",
			"- review the diff",
		];
		for (const mode of ["interactive", "print", "stream"] as const) {
			for (const prompt of prompts) {
				const tokens = codex({ mode, initialPrompt: prompt });
				expect(tokens.slice(-2)).toEqual(["--", prompt]);
				expect(tokens.indexOf(prompt)).toBe(tokens.length - 1);
			}
		}
	});

	test("native codex config keys must be bare dotted paths (schema and adapter)", () => {
		expect(() =>
			parseAgentMarkdown(
				"agents/x.md",
				"---\ndescription: d\nbackends: [codex]\nnative:\n  codex:\n    config:\n      'projects.\"/w\".trust_level': trusted\n---\n",
			),
		).toThrow(/agents\/x\.md:\d+: native\.codex\.config\..*bare dotted key/);
		const quoted = spec({
			native: { codex: { config: { 'projects."/w".trust_level': "trusted" } } },
		});
		expect(() => codex({ spec: quoted })).toThrow(
			/native\.codex\.config.*bare dotted key/,
		);
		expect(
			codex({
				spec: spec({ native: { codex: { config: { "a.b-c.d_e": 1 } } } }),
			}),
		).toContain("a.b-c.d_e=1");
	});

	test("MCP server names that are not bare keys are rejected (schema and adapter)", () => {
		expect(() =>
			parseAgentMarkdown(
				"agents/x.md",
				'---\ndescription: d\nbackends: [codex]\nmcp:\n  "a.b": { command: echo }\n---\n',
			),
		).toThrow(/agents\/x\.md:\d+: mcp\.a\.b/);
		for (const name of ["a.b", "my server", 'x"=y']) {
			expect(() =>
				codex({ mcp: { [name]: { command: literal("echo") } } }),
			).toThrow(`test:agent: mcp.${name}: server names use only`);
		}
	});

	test("developer_instructions escapes DEL and refuses a lone surrogate", () => {
		const text = "line1\nline2 \u007f del";
		const [value] = valuesOf(codex({ systemPrompt: text }), "-c");
		expect(value).toBe(
			`developer_instructions=${JSON.stringify(text).replace("\u007f", "\\u007F")}`,
		);
		expect(value).not.toContain("\u007f");
		expect(Bun.TOML.parse(value ?? "")).toEqual({
			developer_instructions: text,
		});
		expect(() => codex({ systemPrompt: "bad \ud800 surrogate" })).toThrow(
			/unpaired surrogate/,
		);
	});

	test("secret env names are normalized and collisions fail", () => {
		expect(mcpSecretEnvName("github", "X-Api.Key")).toBe(
			"TROUPE_MCP_GITHUB_X_API_KEY",
		);
		expect(() =>
			codex({
				mcp: {
					s: {
						url: literal("https://x"),
						headers: {
							"X-Key": secret("a", "s", "X-Key"),
							X_Key: secret("b", "s", "X_Key"),
						},
					},
				},
			}),
		).toThrow(/collides with mcp\.s\.headers\.X-Key/);
		expect(() =>
			parseAgentMarkdown(
				"agents/x.md",
				'---\ndescription: d\nbackends: [codex]\nmcp:\n  s:\n    url: https://x\n    headers:\n      X-Key: "${env:A}"\n      X_Key: "${env:B}"\n---\n',
			),
		).toThrow(
			/mcp\.s\.headers\.X_Key: secret header variable TROUPE_MCP_S_X_KEY collides/,
		);
	});

	test("a secret marker off an HTTP header, or under a foreign name, is refused", () => {
		const leak = { actual: "SUPERSECRET", display: "<r>", secretEnv: "T" };
		const bad: Record<string, Invocation["mcp"][string]>[] = [
			{ s: { command: literal("x"), env: { TOKEN: leak } } },
			{ s: { command: literal("x"), args: [leak] } },
			{ s: { command: leak } },
			{ s: { url: leak } },
		];
		for (const mcp of bad) {
			for (const adapter of [claudeAdapter, codexAdapter]) {
				expect(() =>
					adapter.build(invocation(adapter.id, { mcp }), PATHS),
				).toThrow(/only allowed on an HTTP header value/);
			}
		}
		const foreign = {
			s: {
				url: literal("https://x"),
				headers: { A: { actual: "v", display: "<r>", secretEnv: "X}${HOME" } },
			},
		};
		expect(() => claude({ mcp: foreign })).toThrow(
			/secret variable must be TROUPE_MCP_S_A/,
		);
	});

	describe("hostile values round-trip through every MCP field", () => {
		const hostile = "a\"b\nc = 1}, command = \"evil\\ #x {y} 'q' ][ ${X}";
		const v = (text: string) => literal(text);
		const serversFor = (text: string) => ({
			s: {
				command: v(`cmd${text}`),
				args: [v(`arg${text}`), v(text)],
				env: { [`E${text}`]: v(`env${text}`) },
				cwd: v(`cwd${text}`),
			},
			h: {
				url: v(`url${text}`),
				headers: {
					[`H${text}`]: v(`hdr${text}`),
					Authorization: secret(text, "h", "Authorization"),
				},
			},
		});
		const mcp = serversFor(hostile);

		test("claude --mcp-config JSON parses back to the same values", () => {
			// Claude refuses "${" in a plain value (D-033) and a stdio cwd
			// (D-032); "$" and "{" apart still round-trip.
			const text = hostile.replace("${X}", "$X {X}");
			const { cwd: _cwd, ...stdio } = serversFor(text).s;
			const [config] = valuesOf(
				claude({ mcp: { ...serversFor(text), s: stdio } }),
				"--mcp-config",
			);
			expect(JSON.parse(config ?? "")).toEqual({
				mcpServers: {
					s: {
						type: "stdio",
						command: `cmd${text}`,
						args: [`arg${text}`, text],
						env: { [`E${text}`]: `env${text}` },
					},
					h: {
						type: "http",
						url: `url${text}`,
						headers: {
							[`H${text}`]: `hdr${text}`,
							Authorization: "${" + "TROUPE_MCP_H_AUTHORIZATION}",
						},
					},
				},
			});
		});

		test('claude refuses a plain value carrying "${" without naming the value', () => {
			const fields: [string, Invocation["mcp"]][] = [
				["s.command", { s: { command: v("x${SECRETVAL}") } }],
				["s.args[0]", { s: { command: v("x"), args: [v("${SECRETVAL}")] } }],
				["s.env.K", { s: { command: v("x"), env: { K: v("${SECRETVAL}") } } }],
				["h.url", { h: { url: v("https://x/${SECRETVAL}") } }],
				[
					"h.headers.A",
					{ h: { url: v("https://x"), headers: { A: v("${SECRETVAL}") } } },
				],
			];
			for (const [field, servers] of fields) {
				let message = "";
				try {
					claude({ mcp: servers });
				} catch (error) {
					message = (error as Error).message;
				}
				expect(message).toBe(
					`test:agent: mcp.${field}: the resolved value contains "\${", which Claude would expand (D-033)`,
				);
				expect(message).not.toContain("SECRETVAL");
			}
			// A secret header goes by reference, so its value may hold anything.
			expect(
				claude({
					mcp: {
						h: {
							url: v("https://x"),
							headers: { A: secret("${Y}", "h", "A") },
						},
					},
				}),
			).toBeDefined();
		});

		test("codex -c fragments parse as TOML to exactly the declared tables", () => {
			const entries = valuesOf(
				codex({ mcp, systemPrompt: "", spec: spec({ systemPrompt: "" }) }),
				"-c",
			);
			expect(entries).toHaveLength(2);
			const parsed = entries.map((entry) => {
				expect(entry).not.toMatch(/[\n\u007f]/);
				return Bun.TOML.parse(entry);
			});
			expect(parsed).toEqual([
				{
					mcp_servers: {
						s: {
							command: `cmd${hostile}`,
							args: [`arg${hostile}`, hostile],
							env: { [`E${hostile}`]: `env${hostile}` },
							cwd: `cwd${hostile}`,
						},
					},
				},
				{
					mcp_servers: {
						h: {
							url: `url${hostile}`,
							http_headers: { [`H${hostile}`]: `hdr${hostile}` },
							env_http_headers: {
								Authorization: "TROUPE_MCP_H_AUTHORIZATION",
							},
						},
					},
				},
			]);
		});
	});

	test("claude ignores stdin for print and stream; interactive inherits", () => {
		const stdin = (mode: Invocation["mode"]) =>
			claudeAdapter.build(invocation("claude", { mode }), PATHS).stdin;
		expect(stdin("interactive")).toBe("inherit");
		expect(stdin("print")).toBe("ignore");
		expect(stdin("stream")).toBe("ignore");
	});

	test("the plan carries the invocation cwd for the runner to spawn in", () => {
		for (const adapter of [claudeAdapter, codexAdapter]) {
			const plan = adapter.build(
				invocation(adapter.id, { cwd: "/some/dir" }),
				PATHS,
			);
			expect(plan.cwd).toBe("/some/dir");
			expect(plan.argv).not.toContain("/some/dir");
		}
	});
});

describe("passthrough opt-out fails closed (D-039)", () => {
	const sealed = spec({ passthrough: false });

	test("both adapters refuse a nonempty tail for a passthrough: false spec", () => {
		for (const adapter of [claudeAdapter, codexAdapter]) {
			for (const mode of ["interactive", "print", "stream"] as const) {
				expect(() =>
					adapter.build(
						invocation(adapter.id, {
							spec: sealed,
							mode,
							passthrough: ["--dangerously-skip-permissions"],
						}),
						PATHS,
					),
				).toThrow(
					"test:agent declares passthrough: false, but the invocation carries 1 backend argument(s)",
				);
			}
		}
	});

	test("an empty tail builds, and the default and passthrough: true still forward it", () => {
		expect(claude({ spec: sealed, initialPrompt: "go" }).slice(-2)).toEqual([
			"--",
			"go",
		]);
		expect(codex({ spec: sealed, initialPrompt: "go" }).slice(-2)).toEqual([
			"--",
			"go",
		]);
		for (const agent of [spec(), spec({ passthrough: true })]) {
			expect(
				claude({ spec: agent, passthrough: ["-p"], initialPrompt: "go" }),
			).toContain("-p");
			expect(
				codex({ spec: agent, passthrough: ["--x"], initialPrompt: "go" }),
			).toContain("--x");
		}
	});
});
