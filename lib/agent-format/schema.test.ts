import { describe, expect, test } from "bun:test";
import { AgentSourceError, type SourceIssue } from "./errors";
import {
	materializeAgentSpec,
	PROMPT_SEPARATOR,
	parseAgentMarkdown,
} from "./schema";

const FILE = "agents/ns/sample.md";

function md(frontmatter: string, body = "Body text.\n"): string {
	return `---\n${frontmatter.trim()}\n---\n${body}`;
}

function issuesOf(text: string): SourceIssue[] {
	try {
		parseAgentMarkdown(FILE, text);
	} catch (error) {
		if (error instanceof AgentSourceError) return [...error.issues];
		throw error;
	}
	throw new Error("expected parseAgentMarkdown to fail");
}

function expectIssue(
	text: string,
	field: string,
	message: RegExp,
	line?: number,
) {
	const issues = issuesOf(text);
	const match = issues.find(
		(i) => i.field === field && message.test(i.message),
	);
	expect(match, JSON.stringify(issues, null, 2)).toBeDefined();
	expect(match?.file).toBe(FILE);
	if (line !== undefined) expect(match?.line).toBe(line);
}

const minimal = "description: Sample agent\nbackends: [claude, codex]";

describe("parseAgentMarkdown + materializeAgentSpec", () => {
	test("defaults promptMode append, mode interactive and {{args}}", () => {
		const parsed = parseAgentMarkdown(FILE, md(minimal));
		const spec = materializeAgentSpec(parsed, {
			id: "ns:sample",
			includes: [],
		});
		expect(spec).toEqual({
			id: "ns:sample",
			description: "Sample agent",
			backends: ["claude", "codex"],
			promptMode: "append",
			mode: "interactive",
			initialPrompt: "{{args}}",
			systemPrompt: "Body text.",
			flags: {},
		});
	});

	test("body precedes includes, joined by the stable separator", () => {
		const parsed = parseAgentMarkdown(
			FILE,
			md(`${minimal}\nincludes: [a.md, b.md]`, "\nBody.\n\n"),
		);
		const spec = materializeAgentSpec(parsed, {
			id: "ns:sample",
			includes: [
				{ path: "a.md", text: "\nFirst include\n" },
				{ path: "b.md", text: "Second include" },
			],
		});
		expect(spec.systemPrompt).toBe(
			["Body.", "First include", "Second include"].join(PROMPT_SEPARATOR),
		);
		expect(spec).not.toHaveProperty("includes");
	});

	test("an empty body with no includes yields an empty system prompt", () => {
		const parsed = parseAgentMarkdown(FILE, md(minimal, ""));
		expect(
			materializeAgentSpec(parsed, { id: "ns:sample", includes: [] })
				.systemPrompt,
		).toBe("");
	});

	test("keeps declared optional fields", () => {
		const parsed = parseAgentMarkdown(
			FILE,
			md(`
description: Full
backends: [codex, claude]
promptMode: replace
mode: print
initialPrompt: "Focus {{flag.focus}} on {{args}} in {{cwd}}"
flags:
  focus: { type: enum, description: Area, values: [tech, product], default: tech, short: f }
  quick: { type: boolean, description: Fast }
model: { claude: opus, codex: gpt-5 }
effort: { claude: high, codex: minimal }
access: read-only
mcp:
  chrome: { command: npx, args: [chrome-devtools-mcp] }
  gh: { url: "https://example.test/mcp", headers: { Authorization: "Bearer \${env:TOKEN}" } }
native:
  claude: { args: ["--max-turns=3", "--tools", "Read", { flag: "--verbose" }], settings: { permissions: { allow: [Read] } } }
  codex: { args: ["-c", "model_reasoning_summary=none"], config: { tools: { web_search: true } } }
`),
		);
		const spec = materializeAgentSpec(parsed, {
			id: "ns:sample",
			includes: [],
		});
		expect(spec.backends).toEqual(["codex", "claude"]);
		expect(spec.promptMode).toBe("replace");
		expect(spec.mode).toBe("print");
		expect(spec.flags.focus).toEqual({
			type: "enum",
			description: "Area",
			values: ["tech", "product"],
			default: "tech",
			short: "f",
		});
		expect(spec.mcp?.gh).toEqual({
			url: "https://example.test/mcp",
			headers: { Authorization: "Bearer ${env:TOKEN}" },
		});
		expect(spec.native?.claude?.args).toEqual([
			"--max-turns=3",
			"--tools",
			"Read",
			{ flag: "--verbose" },
		]);
	});
});

describe("malformed sources name file, line and field", () => {
	test("missing frontmatter", () => {
		expectIssue("Just a body\n", "frontmatter", /frontmatter block/, 1);
	});

	test("invalid YAML", () => {
		expectIssue(
			md("description: [unclosed\nbackends: [claude]"),
			"frontmatter",
			/./,
		);
	});

	test("duplicate YAML keys name both lines", () => {
		expectIssue(
			md("description: a\ndescription: b\nbackends: [claude]"),
			"description",
			/duplicate key "description" \(first at line 2\)/,
			3,
		);
	});

	test("keys are compared after string normalization", () => {
		expectIssue(
			md(
				`${minimal}\nflags:\n  true: { type: boolean, description: first }\n  "true": { type: string, description: second }`,
			),
			"flags.true",
			/duplicate key "true" \(first at line 5\)/,
			6,
		);
		expectIssue(
			md(`${minimal}\nmcp:\n  1: { command: a }\n  "1": { command: b }`),
			"mcp.1",
			/duplicate key "1" \(first at line 5\)/,
			6,
		);
		expectIssue(
			md(
				`${minimal}\nnative:\n  claude:\n    settings:\n      true: 1\n      "true": 2`,
			),
			"native.claude.settings.true",
			/duplicate key/,
			8,
		);
		expectIssue(
			md(
				`${minimal}\nnative:\n  codex:\n    config:\n      null: 1\n      "null": 2`,
			),
			"native.codex.config.null",
			/duplicate key/,
		);
	});

	test.each(["__proto__", "constructor", "prototype"])(
		"rejects the reserved object key %s anywhere",
		(key) => {
			expectIssue(
				md(`${minimal}\nmcp:\n  ${key}: { command: a }`),
				`mcp.${key}`,
				/reserved object key/,
				5,
			);
			expectIssue(
				md(
					`${minimal}\nnative:\n  claude:\n    settings:\n      ${key}: { hooks: {} }`,
				),
				`native.claude.settings.${key}`,
				/reserved object key/,
			);
		},
	);

	test("missing required fields", () => {
		expectIssue(md("backends: [claude]"), "description", /./);
		expectIssue(md("description: x"), "backends", /./);
		expectIssue(md("description: x\nbackends: []"), "backends", /at least one/);
	});

	test("unknown top-level key", () => {
		expectIssue(md(`${minimal}\nhooks: {}`), "hooks", /unknown key/, 4);
	});

	test("unknown nested keys", () => {
		expectIssue(
			md(
				`${minimal}\nflags:\n  quick: { type: boolean, description: q, alias: x }`,
			),
			"flags.quick.alias",
			/unknown key/,
			5,
		);
		expectIssue(
			md(`${minimal}\nmodel: { gemini: pro }`),
			"model.gemini",
			/unknown key/,
		);
		expectIssue(
			md(`${minimal}\nnative:\n  claude: { args: [], extra: 1 }`),
			"native.claude.extra",
			/unknown key/,
		);
		expectIssue(
			md(`${minimal}\nmcp:\n  s: { command: x, headers: {} }`),
			"mcp.s.headers",
			/unknown key/,
		);
	});

	test("bad enum values", () => {
		expectIssue(md(`${minimal}\nmode: batch`), "mode", /./, 4);
		expectIssue(md(`${minimal}\naccess: root`), "access", /./);
		expectIssue(
			md("description: x\nbackends: [gemini]"),
			"backends[0]",
			/./,
			3,
		);
		expectIssue(md(`${minimal}\neffort: { codex: max }`), "effort.codex", /./);
	});
});

describe("cross-field validation", () => {
	test("duplicate backends", () => {
		expectIssue(
			md("description: x\nbackends: [claude, claude]"),
			"backends[1]",
			/duplicate backend/,
		);
	});

	test("reserved flag names", () => {
		for (const name of [
			"backend",
			"cwd",
			"model",
			"print",
			"show-prompt",
			"help",
		]) {
			expectIssue(
				md(`${minimal}\nflags:\n  ${name}: { type: boolean, description: d }`),
				`flags.${name}`,
				/reserved framework flag/,
				5,
			);
		}
	});

	test("duplicate and reserved shorts", () => {
		expectIssue(
			md(
				`${minimal}\nflags:\n  a: { type: boolean, description: d, short: x }\n  b: { type: string, description: d, short: x }`,
			),
			"flags.b.short",
			/duplicate short "-x"/,
			6,
		);
		expectIssue(
			md(
				`${minimal}\nflags:\n  a: { type: boolean, description: d, short: h }`,
			),
			"flags.a.short",
			/reserved/,
		);
		expectIssue(
			md(
				`${minimal}\nflags:\n  a: { type: boolean, description: d, short: xy }`,
			),
			"flags.a.short",
			/single ASCII letter/,
		);
	});

	test("enum default must be a declared value", () => {
		expectIssue(
			md(
				`${minimal}\nflags:\n  focus:\n    type: enum\n    description: d\n    values: [a, b]\n    default: c`,
			),
			"flags.focus.default",
			/not one of "a", "b"/,
			9,
		);
	});

	test("flag default type must match", () => {
		expectIssue(
			md(
				`${minimal}\nflags:\n  q: { type: boolean, description: d, default: "yes" }`,
			),
			"flags.q.default",
			/./,
		);
	});

	test("a boolean flag cannot default to true; false or no default is fine", () => {
		expectIssue(
			md(
				`${minimal}\nflags:\n  verbose:\n    type: boolean\n    description: d\n    default: true`,
			),
			"flags.verbose.default",
			/always defaults to false/,
			8,
		);
		expect(() =>
			parseAgentMarkdown(
				FILE,
				md(
					`${minimal}\nflags:\n  a: { type: boolean, description: d, default: false }\n  b: { type: boolean, description: d }`,
				),
			),
		).not.toThrow();
	});

	test("mixed MCP transports", () => {
		expectIssue(
			md(`${minimal}\nmcp:\n  both: { command: x, url: "https://x" }`),
			"mcp.both",
			/mixes stdio \(command\) and http \(url\)/,
			5,
		);
		expectIssue(
			md(`${minimal}\nmcp:\n  none: { args: [] }`),
			"mcp.none",
			/command/,
		);
	});

	test("model, effort and native for an undeclared backend", () => {
		const claudeOnly = "description: x\nbackends: [claude]";
		expectIssue(
			md(`${claudeOnly}\nnative:\n  codex: { args: [] }`),
			"native.codex",
			/not declared in backends/,
			5,
		);
		expectIssue(
			md(`${claudeOnly}\nmodel: { codex: gpt-5 }`),
			"model.codex",
			/not declared/,
		);
		expectIssue(
			md(`${claudeOnly}\neffort: { codex: low }`),
			"effort.codex",
			/not declared/,
		);
	});

	test("bad template references", () => {
		expectIssue(
			md(`${minimal}\ninitialPrompt: "Look at {{flag.nope}}"`),
			"initialPrompt",
			/undeclared flag "nope"/,
			4,
		);
		expectIssue(
			md(`${minimal}\ninitialPrompt: "{{user}}"`),
			"initialPrompt",
			/unknown/,
		);
		expectIssue(
			md(`${minimal}\ninitialPrompt: "{{args"`),
			"initialPrompt",
			/unterminated/,
		);
	});

	test("D-025 conditionals compile; nesting and impossible conditions fail", () => {
		const withFlags = `${minimal}
flags:
  quick: { type: boolean, description: Quick }
  focus: { type: enum, description: Focus, values: [tech, changes] }
  task: { type: string, description: Task }`;
		const orient = `initialPrompt: |
  {{#if flag.quick}}
  quick
  {{else if flag.focus == "tech"}}
  tech
  {{else}}
  full
  {{/if}}
  {{#if args}}Additional context: {{args}}{{/if}}`;
		expect(() =>
			parseAgentMarkdown(FILE, md(`${withFlags}\n${orient}`)),
		).not.toThrow();
		expectIssue(
			md(
				`${withFlags}\ninitialPrompt: "{{#if args}}{{#if flag.quick}}x{{/if}}{{/if}}"`,
			),
			"initialPrompt",
			/nested/,
		);
		expectIssue(
			md(`${withFlags}\ninitialPrompt: "{{#if flag.focus == 'ops'}}x{{/if}}"`),
			"initialPrompt",
			/not a declared value/,
		);
		expectIssue(
			md(`${withFlags}\ninitialPrompt: "{{#if flag.task}}x{{/if}}"`),
			"initialPrompt",
			/cannot be a condition/,
		);
		expectIssue(
			md(`${withFlags}\ninitialPrompt: "{{#if args}}x"`),
			"initialPrompt",
			/never closed/,
		);
	});

	test("reports every problem, not just the first", () => {
		const issues = issuesOf(
			md(
				"description: x\nbackends: [claude, claude]\nflags:\n  help: { type: boolean, description: d }",
			),
		);
		expect(issues.map((i) => i.field).sort()).toEqual([
			"backends[1]",
			"flags.help",
		]);
	});
});

describe("${cmd:...} needs no shell (D-026)", () => {
	test("accepts quoted arguments", () => {
		const parsed = parseAgentMarkdown(
			FILE,
			md(
				`${minimal}\nmcp:\n  gh:\n    url: "https://x"\n    headers:\n      Authorization: 'Bearer \${cmd:op item get "Github CLI Token" --fields password --reveal}'`,
			),
		);
		expect(parsed.source.mcp?.gh).toBeDefined();
	});

	test.each([
		["pipe", "a | b"],
		["redirection", "cat > out"],
		["separator", "a; b"],
		["and", "a && b"],
		["expansion", "echo $HOME"],
		["glob", "ls *.md"],
	])("rejects %s with file, line and field", (_, command) => {
		expectIssue(
			md(
				`${minimal}\nmcp:\n  s:\n    command: x\n    env:\n      TOKEN: '\${cmd:${command}}'`,
			),
			"mcp.s.env.TOKEN",
			/without a shell/,
			8,
		);
	});
});

describe("native args are structurally validated (D-013)", () => {
	const claude = (args: string) =>
		md(`${minimal}\nnative:\n  claude:\n    args: ${args}`);
	const codex = (args: string) =>
		md(`${minimal}\nnative:\n  codex:\n    args: ${args}`);

	test("accepts equals tokens, two-token pairs and {flag}", () => {
		expect(() =>
			parseAgentMarkdown(
				FILE,
				claude(
					'["--max-turns=3", "--allowedTools", "Read", { flag: "--verbose" }]',
				),
			),
		).not.toThrow();
		expect(() =>
			parseAgentMarkdown(
				FILE,
				codex('["-c", "tools.web_search=true", "--config=a.b=1"]'),
			),
		).not.toThrow();
	});

	test("rejects a bare flag without a value", () => {
		expectIssue(
			claude('["--verbose"]'),
			"native.claude.args[0]",
			/needs a value/,
			6,
		);
		expectIssue(
			claude('["--a", "--b=1"]'),
			"native.claude.args[0]",
			/needs a value/,
		);
	});

	test("rejects stray positionals and malformed flags", () => {
		expectIssue(
			claude('["Read"]'),
			"native.claude.args[0]",
			/not a --flag=value/,
		);
		expectIssue(
			claude('[{ flag: "verbose" }]'),
			"native.claude.args[0].flag",
			/not a --long/,
		);
		expectIssue(
			claude('["--bad flag=1"]'),
			"native.claude.args[0]",
			/not a valid --long flag/,
		);
	});

	test("rejects malformed Codex -c entries", () => {
		expectIssue(
			codex('["-c", "novalue"]'),
			"native.codex.args[0]",
			/well-formed key=value/,
		);
		expectIssue(codex('["-c", "=x"]'), "native.codex.args[0]", /well-formed/);
		expectIssue(
			codex('["-c", "a b=1"]'),
			"native.codex.args[0]",
			/well-formed/,
		);
		expectIssue(codex('[{ flag: "-c" }]'), "native.codex.args[0]", /key=value/);
	});

	test.each([
		["--system-prompt", "x"],
		["--append-system-prompt", "x"],
		["--system-prompt-file", "p"],
		["--append-system-prompt-file", "p"],
	])("rejects Claude prompt transport %s in both forms", (flag, value) => {
		expectIssue(
			claude(`["${flag}=${value}"]`),
			"native.claude.args[0]",
			/reserved/,
		);
		expectIssue(
			claude(`["${flag}", "${value}"]`),
			"native.claude.args[0]",
			/reserved/,
		);
	});

	test("rejects Claude --settings and settings.hooks", () => {
		expectIssue(
			claude('["--settings", "{}"]'),
			"native.claude.args[0]",
			/native.claude.settings/,
		);
		expectIssue(
			md(`${minimal}\nnative:\n  claude:\n    settings:\n      hooks: {}`),
			"native.claude.settings.hooks",
			/lifecycle hooks/,
			7,
		);
	});

	test.each([
		"developer_instructions",
		"model_instructions_file",
		"base_instructions",
		"instructions",
		"experimental_instructions_file",
		"hooks.PreToolUse",
	])("rejects Codex key %s in args and config", (key) => {
		expectIssue(
			codex(`["-c", "${key}=x"]`),
			"native.codex.args[0]",
			/reserved|never emitted|hooks/,
		);
		expectIssue(
			codex(`["--config=${key}=x"]`),
			"native.codex.args[0]",
			/reserved|never emitted|hooks/,
		);
		expectIssue(
			md(`${minimal}\nnative:\n  codex:\n    config:\n      "${key}": x`),
			`native.codex.config.${key}`,
			/reserved|never emitted|hooks/,
		);
	});

	test("rejects command-running settings like lifecycle hooks", () => {
		for (const key of ["statusLine", "apiKeyHelper"]) {
			expectIssue(
				md(`${minimal}\nnative:\n  claude:\n    settings:\n      ${key}: x`),
				`native.claude.settings.${key}`,
				/runs commands like a lifecycle hook/,
				7,
			);
		}
		expectIssue(
			codex('["-c", "notify=[\\"touch\\"]"]'),
			"native.codex.args[0]",
			/lifecycle hook/,
		);
		expectIssue(
			codex('["--config=notify=x"]'),
			"native.codex.args[0]",
			/lifecycle hook/,
		);
		expectIssue(
			md(`${minimal}\nnative:\n  codex:\n    config:\n      notify: [touch]`),
			"native.codex.config.notify",
			/lifecycle hook/,
		);
	});

	test("allows intended passthrough: agents, plugins and profiles", () => {
		const parsed = parseAgentMarkdown(
			FILE,
			md(`${minimal}
native:
  claude:
    args: ["--agent", "reviewer", "--agents", '{"r":{"prompt":"x"}}', "--plugin-dir", "./plug"]
    settings: { enabledPlugins: { "p@m": true } }
  codex:
    args: ["-p", "work", "--profile=work"]
`),
		);
		expect(parsed.source.native?.codex?.args).toEqual([
			"-p",
			"work",
			"--profile=work",
		]);
		expect(parsed.source.native?.claude?.settings).toEqual({
			enabledPlugins: { "p@m": true },
		});
	});

	test("rejects Codex hook trust bypass", () => {
		expectIssue(
			codex('[{ flag: "--dangerously-bypass-hook-trust" }]'),
			"native.codex.args[0]",
			/lifecycle hooks/,
		);
	});
});
