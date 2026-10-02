import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError, parseCli, resolveCli } from "../lib/agent-format/cli";
import { previewAgent } from "../lib/agent-format/run";
import type { AgentSpec, Backend } from "../lib/agent-format/types";
import {
	type LoadedAgent,
	loadAgentDefinition,
	planBuild,
	ROSTER,
} from "../scripts/agent-compiler";

const repo = resolve(import.meta.dir, "..");

/** The 12 ordinary agents (TASK-009) and their declared backends (D-005). */
const ORDINARY: Record<string, Backend[]> = {
	"analyze:orient": ["claude", "codex"],
	"build:builder": ["claude"],
	"build:refactor": ["claude", "codex"],
	"build:tdd": ["claude"],
	"design:architect": ["claude", "codex"],
	"design:designer": ["claude", "codex"],
	"meta:prompt": ["claude", "codex"],
	"modes:contain": ["claude"],
	"plan:planner": ["claude", "codex"],
	"plan:riff": ["claude", "codex"],
	"rails:backlog": ["claude"],
	"resume:tailor": ["claude", "codex"],
};

/** Reminders that replaced lifecycle echo hooks (D-007). */
const REMINDERS: Record<string, string> = {
	"analyze:orient":
		"After each search completes, analyze the results before continuing.",
	"build:builder":
		"Builder mode: provide a markdown build plan or I'll help create one. Use 'proceed', 'modify', or 'skip' to control the build process.",
	"build:tdd":
		"TDD Coordinator: You orchestrate TDD cycles (Red-Green-Refactor). Propose test cases, coordinate sub-agents, adapt the plan based on insights. NEVER implement directly.",
	"design:designer":
		"Designer mode: use the Chrome DevTools MCP to open and interact with Storybook.",
	"modes:contain":
		"Remember to always use the mcp__container-use__environment tools!",
	"rails:backlog":
		"Rails Backlog Task Coordinator: Analyze backlog tasks and coordinate specialized sub-agents. Always use backlog CLI with --plain flag.",
};

const CHROME_TOOLS = [
	"click",
	"fill",
	"navigate_page",
	"new_page",
	"press_key",
	"take_screenshot",
	"wait_for",
].map((tool) => `mcp__chrome-devtools__${tool}`);

const sourceOf = (id: string) => `agents/${id.split(":").join("/")}.md`;

const agents = new Map<string, LoadedAgent>();
let cwd: string;

beforeAll(async () => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "ordinary-agents-")));
	for (const id of Object.keys(ORDINARY)) {
		agents.set(id, await loadAgentDefinition(repo, sourceOf(id)));
	}
});

afterAll(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function spec(id: string): AgentSpec {
	const agent = agents.get(id);
	if (!agent) throw new Error(`${id} not loaded`);
	return agent.spec;
}

interface Envelope {
	text: string;
	systemPrompt: string;
	initialPrompt: string;
	argv: string[];
}

/** `--show-prompt` through the runner's preview, with no child processes. */
async function preview(id: string, argv: string[]): Promise<Envelope> {
	const outcome = parseCli(spec(id), argv, { cwd });
	if (outcome.kind !== "run") throw new Error("unexpected help");
	let text = "";
	let stderr = "";
	const code = await previewAgent(spec(id), {}, outcome.invocation, {
		stdout: (chunk) => {
			text += chunk;
		},
		stderr: (chunk) => {
			stderr += chunk;
		},
		isDirectory: () => true,
		runCommand: async () => {
			throw new Error("preview of an ordinary agent runs no command");
		},
	});
	expect(stderr).toBe("");
	expect(code).toBe(0);
	const match =
		/^Backend: \w+\n--- System prompt ---\n([\s\S]*)\n--- Initial prompt ---\n([\s\S]*)\n--- Argv ---\n(.*)\n$/.exec(
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

function valueAfter(argv: readonly string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i === -1 ? undefined : argv[i + 1];
}

/**
 * The envelope with the argv copy of the system prompt replaced by a marker,
 * after checking that the copy is exactly the previewed prompt on that
 * backend's transport, so the snapshot holds each prompt once.
 */
function compact(envelope: Envelope, backend: Backend): string {
	const marker = "<system prompt, as above>";
	const argv = envelope.argv.map((arg, i) => {
		if (
			backend === "claude" &&
			envelope.argv[i - 1] === "--append-system-prompt"
		) {
			expect(arg).toBe(envelope.systemPrompt);
			return marker;
		}
		if (backend === "codex" && arg.startsWith("developer_instructions=")) {
			expect(JSON.parse(arg.slice("developer_instructions=".length))).toBe(
				envelope.systemPrompt,
			);
			return `developer_instructions=${marker}`;
		}
		return arg;
	});
	const transport = backend === "claude" ? "--append-system-prompt" : "-c";
	expect(argv).toContain(
		backend === "claude" ? marker : `developer_instructions=${marker}`,
	);
	expect(argv).toContain(transport);
	return envelope.text.replace(/--- Argv ---\n.*\n$/, () =>
		["--- Argv ---", JSON.stringify(argv), ""].join("\n"),
	);
}

describe("ordinary agent declarations (B-007, D-001)", () => {
	test("each of the 12 is a path-named Markdown declaration with a body prompt", () => {
		for (const id of Object.keys(ORDINARY)) {
			const agent = agents.get(id);
			expect(agent?.file).toBe(sourceOf(id));
			expect(agent?.spec.id).toBe(id);
			expect(agent?.spec.systemPrompt.length).toBeGreaterThan(0);
			expect(agent?.spec.promptMode).toBe("append");
			expect(agent?.spec.mode).toBe("interactive");
			// The legacy sibling has no reserved exports, so it is not an extension.
			expect(agent?.extension).toBeUndefined();
		}
	});

	test("mixed mode: the 12 declarations shadow their legacy siblings; no ordinary agent is legacy", async () => {
		const plan = await planBuild({ root: repo, mode: "mixed" });
		expect(plan.entries.map((entry) => entry.id)).toEqual([...ROSTER].sort());
		for (const id of Object.keys(ORDINARY)) {
			const entry = plan.entries.find((candidate) => candidate.id === id);
			expect([id, entry?.kind, entry?.source]).toEqual([
				id,
				"declaration",
				sourceOf(id),
			]);
		}
		// Special agents convert in their own tasks; whatever is still legacy
		// is a .ts launcher outside the ordinary set.
		for (const entry of plan.entries) {
			if (entry.kind !== "legacy") continue;
			expect(entry.source).toMatch(/\.ts$/);
			expect(Object.hasOwn(ORDINARY, entry.id)).toBe(false);
		}
	});
});

describe("backends (D-005)", () => {
	test("builder, tdd, rails:backlog and modes:contain are Claude-only; the other eight declare claude then codex", () => {
		for (const [id, backends] of Object.entries(ORDINARY)) {
			expect({ id, backends: [...spec(id).backends] }).toEqual({
				id,
				backends,
			});
		}
	});

	test("an explicit undeclared backend fails clearly before any preview", () => {
		for (const [id, backends] of Object.entries(ORDINARY)) {
			if (backends.includes("codex")) continue;
			expect(() => parseCli(spec(id), ["--backend", "codex"], { cwd })).toThrow(
				new CliError(
					`${id}: backend "codex" is not declared by this agent (declared: claude)`,
				),
			);
			let stderr = "";
			let stdout = "";
			const result = resolveCli(
				spec(id),
				["--backend=codex", "--show-prompt"],
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
				`${id}: backend "codex" is not declared by this agent (declared: claude)\n`,
			);
		}
	});
});

describe("--show-prompt envelopes per declared backend (B-003)", () => {
	for (const [id, backends] of Object.entries(ORDINARY)) {
		for (const backend of backends) {
			test(`${id} on ${backend}`, async () => {
				const args = id === "analyze:orient" ? [] : ["hello world"];
				const envelope = await preview(id, ["--backend", backend, ...args]);
				expect(envelope.text.startsWith(`Backend: ${backend}\n`)).toBe(true);
				expect(envelope.argv[0]).toBe(backend);
				expect(envelope.systemPrompt).toBe(spec(id).systemPrompt);
				expect(compact(envelope, backend)).toMatchSnapshot();
			});
		}
	}
});

describe("dropped and moved legacy settings (B-007, D-007)", () => {
	test("no default mode, hooks, dead keys, empty MCP config or project env reach any envelope", async () => {
		for (const [id, backends] of Object.entries(ORDINARY)) {
			for (const backend of backends) {
				const { argv } = await preview(id, ["--backend", backend]);
				const joined = argv.join("\n");
				for (const dead of [
					"defaultMode",
					"hooks",
					"systemPromptFiles",
					"temperature",
					"maxTokens",
					"systemPromptMode",
					"CLAUDE_PROJECT_DIR",
					"mcp__deepwiki__",
					'"allow":[]',
				]) {
					expect([id, backend, joined.includes(dead)]).toEqual([
						id,
						backend,
						false,
					]);
				}
				const mcp = valueAfter(argv, "--mcp-config");
				if (mcp !== undefined) {
					expect(
						Object.keys(JSON.parse(mcp).mcpServers).length,
					).toBeGreaterThan(0);
				}
				expect(
					Object.keys(spec(id).native?.claude?.settings ?? {}).every(
						(key) => key === "permissions",
					),
				).toBe(true);
			}
		}
	});

	test("each lifecycle echo is now the last paragraph of the body", () => {
		for (const [id, reminder] of Object.entries(REMINDERS)) {
			expect(
				spec(id).systemPrompt.endsWith(`\n\n${reminder}`) ||
					spec(id).systemPrompt === reminder,
			).toBe(true);
		}
		expect(spec("modes:contain").systemPrompt).toBe(
			REMINDERS["modes:contain"] as string,
		);
	});
});

describe("orient template (D-025)", () => {
	const FULL =
		"Provide a comprehensive orientation of this project. Include project structure, available commands, tech stack, and recent changes. Identify any patterns or conventions used. Note any important configuration files";

	test("`orient` renders the full orientation without a context suffix", async () => {
		const envelope = await preview("analyze:orient", []);
		expect(envelope.initialPrompt).toBe(FULL);
		expect(envelope.argv.slice(-2)).toEqual(["--", FULL]);
	});

	test("`orient --quick --focus tech`: quick wins over focus and nothing leaks", async () => {
		const envelope = await preview("analyze:orient", [
			"--quick",
			"--focus",
			"tech",
		]);
		const quick = "Provide a quick overview of this project in 2-3 paragraphs";
		expect(envelope.initialPrompt).toBe(quick);
		expect(envelope.argv.slice(-2)).toEqual(["--", quick]);
		expect(envelope.argv).not.toContain("--quick");
		expect(envelope.argv).not.toContain("--focus");
		expect(envelope.argv).not.toContain("tech");
	});

	test("`orient foo` adds the context suffix only because args are present", async () => {
		const envelope = await preview("analyze:orient", ["foo"]);
		expect(envelope.initialPrompt).toBe(`${FULL}\n\nAdditional context: foo`);
	});

	test("each focus value renders its own tasks, in both value forms and the short flag", async () => {
		const expected: Record<string, string> = {
			structure:
				"Analyze the project structure and file organization. Identify key directories and their purposes. Find the main entry points",
			commands:
				"List all available commands and scripts. Explain what each command does. Identify development, build, and test commands",
			tech: "Identify all technologies and frameworks used. List key dependencies and their purposes. Analyze the tech stack and architecture",
			changes:
				"Show recent git commits. Identify areas of active development. Find any TODO items or incomplete features",
		};
		for (const [focus, text] of Object.entries(expected)) {
			for (const argv of [
				["--focus", focus],
				[`--focus=${focus}`],
				["-f", focus],
			]) {
				const envelope = await preview("analyze:orient", argv);
				expect([argv, envelope.initialPrompt]).toEqual([argv, text]);
			}
		}
		const withContext = await preview("analyze:orient", [
			"-q",
			"look",
			"at",
			"lib",
		]);
		expect(withContext.initialPrompt).toBe(
			"Provide a quick overview of this project in 2-3 paragraphs\n\nAdditional context: look at lib",
		);
	});

	test("an unknown focus value fails before preview", () => {
		expect(() =>
			parseCli(spec("analyze:orient"), ["--focus", "nope"], { cwd }),
		).toThrow(CliError);
	});
});

describe("Chrome MCP and Claude tool rules (D-008, D5)", () => {
	test("builder, refactor and designer declare stdio npx chrome-devtools-mcp@latest with their Claude rules", async () => {
		for (const id of ["build:builder", "build:refactor", "design:designer"]) {
			expect(spec(id).mcp).toEqual({
				"chrome-devtools": {
					command: "npx",
					args: ["chrome-devtools-mcp@latest"],
				},
			});
			const allow = spec(id).native?.claude?.settings?.permissions as {
				allow: string[];
			};
			expect([...allow.allow].sort()).toEqual(CHROME_TOOLS);
			const { argv } = await preview(id, ["--backend", "claude"]);
			expect(JSON.parse(valueAfter(argv, "--mcp-config") ?? "{}")).toEqual({
				mcpServers: {
					"chrome-devtools": {
						type: "stdio",
						command: "npx",
						args: ["chrome-devtools-mcp@latest"],
					},
				},
			});
			expect(
				JSON.parse(valueAfter(argv, "--settings") ?? "{}").permissions.allow,
			).toEqual(allow.allow);
		}
	});

	test("on codex the server is emitted and the Claude rules are not emulated", async () => {
		for (const id of ["build:refactor", "design:designer"]) {
			const { argv } = await preview(id, ["--backend", "codex"]);
			expect(argv).toContain(
				'mcp_servers.chrome-devtools={command = "npx", args = ["chrome-devtools-mcp@latest"]}',
			);
			const config = argv.filter(
				(arg) => !arg.startsWith("developer_instructions="),
			);
			expect(config.join("\n")).not.toContain("mcp__chrome-devtools__");
			expect(config.join("\n")).not.toContain("permissions");
			expect(argv).not.toContain("--model");
			expect(argv).not.toContain("-m");
		}
	});

	test("no migrated declaration references the dead package", () => {
		for (const id of Object.keys(ORDINARY)) {
			const text = readFileSync(join(repo, sourceOf(id)), "utf8");
			expect([id, text.includes("@anthropic-ai/mcp-chrome-devtools")]).toEqual([
				id,
				false,
			]);
		}
	});

	test("designer keeps its Claude sonnet model, overridable by --model", async () => {
		expect(spec("design:designer").model).toEqual({ claude: "sonnet" });
		const pinned = await preview("design:designer", []);
		expect(valueAfter(pinned.argv, "--model")).toBe("sonnet");
		const overridden = await preview("design:designer", ["--model", "opus"]);
		expect(valueAfter(overridden.argv, "--model")).toBe("opus");
		expect(overridden.initialPrompt).toBe("");
	});
});

describe("contain backend flags follow -- (D-028)", () => {
	test("`contain -- -p hi` passes -p and its prompt to claude verbatim", async () => {
		const envelope = await preview("modes:contain", ["--", "-p", "hi"]);
		expect(envelope.initialPrompt).toBe("");
		expect(envelope.argv.slice(-2)).toEqual(["-p", "hi"]);
		expect(envelope.argv).not.toContain("--");
	});

	test("`contain hi -- -p` puts the prompt after claude's own separator", async () => {
		const envelope = await preview("modes:contain", ["hi", "--", "-p"]);
		expect(envelope.argv.slice(-3)).toEqual(["-p", "--", "hi"]);
	});

	test("`contain -p hi` is refused: no unknown-flag forwarding or alias", () => {
		expect(() =>
			parseCli(spec("modes:contain"), ["-p", "hi"], { cwd }),
		).toThrow(CliError);
		expect(() =>
			parseCli(spec("modes:contain"), ["--print-mode", "hi"], { cwd }),
		).toThrow(CliError);
	});

	test("contain keeps its container-use server, allow list and built-in deny list on claude", async () => {
		const { argv } = await preview("modes:contain", []);
		expect(JSON.parse(valueAfter(argv, "--mcp-config") ?? "{}")).toEqual({
			mcpServers: {
				"container-use": {
					type: "stdio",
					command: "container-use",
					args: ["stdio"],
				},
			},
		});
		const { permissions } = JSON.parse(valueAfter(argv, "--settings") ?? "{}");
		expect(permissions.allow).toHaveLength(10);
		expect(
			permissions.allow.every((rule: string) =>
				rule.startsWith("mcp__container-use__environment_"),
			),
		).toBe(true);
		expect(permissions.deny).toEqual([
			"Bash",
			"Edit",
			"MultiEdit",
			"Write",
			"Read",
			"LS",
			"Glob",
			"Grep",
			"Task",
			"WebFetch",
			"WebSearch",
			"NotebookEdit",
			"NotebookRead",
		]);
	});
});
