import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	setSystemTime,
	test,
} from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseCli, resolveCli } from "../lib/agent-format/cli";
import { installFakeClis, readRecords } from "../lib/agent-format/fake-cli";
import { executeAgent, previewAgent } from "../lib/agent-format/run";
import { PROMPT_SEPARATOR } from "../lib/agent-format/schema";
import type {
	AgentSpec,
	Backend,
	PrepareContext,
} from "../lib/agent-format/types";
import type { ToolEnv } from "../lib/shepherd/sessions";
import { fakeToolEnv, makeTree } from "../lib/shepherd/test-support";
import {
	generateEntry,
	type LoadedAgent,
	loadAgentDefinition,
	planBuild,
} from "../scripts/agent-compiler";
import * as shepherd from "./shepherd";

const repo = resolve(import.meta.dir, "..");
const SOURCE = "agents/shepherd.md";
const EXTENSION_FILE = join(repo, "agents/shepherd.ts");
const FIXTURES = join(repo, "agents/__fixtures__/shepherd");
const extension = {
	prepare: (ctx: PrepareContext) => shepherd.prepare(ctx, testToolEnv(ctx)),
};
const BACKENDS: Backend[] = ["claude", "codex"];
const STATIC_RULES = [
	"Read(.shepherd/**)",
	"Edit(.shepherd/**)",
	"Bash(herdr:*)",
];

const MODULE = (name: string) =>
	`system-prompts/shepherd/integrations/${name}.md`;

/** What every launch gets first: core, then the two modules that check themselves. */
const ALWAYS_LAYERS = [
	"system-prompts/shepherd/core.md",
	MODULE("herdr"),
	MODULE("inter-agent"),
];

/** The modules the launcher adds only when they apply, by title, in load order. */
const GATED_TITLES: Record<string, string> = {
	nested: "# Integration: Nested workspace",
	root: "# Integration: Root workspace",
	software: "# Integration: Software coordination",
};

/**
 * The legacy launcher baked in core, Herdr and inter-agent messaging. The base
 * text has changed since its fixtures were captured, so they vouch only for
 * what follows those three layers: the workspace layers and the header.
 */
const LEGACY_BASE_LAYERS = 3;

// Runs launch the fake CLIs; a loaded machine needs more than the 5s default.
setDefaultTimeout(60_000);

let agent: LoadedAgent;
let root: string;

function testToolEnv(ctx: PrepareContext): ToolEnv {
	return {
		cwd: ctx.cwd,
		home: join(root, "home"),
		env: {},
		now: new Date(),
		runCommand: ctx.runCommand,
		pidAlive: () => false,
	};
}

beforeAll(async () => {
	// The session header carries the date: pin it (fake time).
	setSystemTime(new Date("2026-10-02T12:00:00Z"));
	agent = await loadAgentDefinition(repo, SOURCE);
	root = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-")));
});

afterAll(() => {
	setSystemTime();
	rmSync(root, { recursive: true, force: true });
});

const spec = (): AgentSpec => agent.spec;
const text = (path: string) => readFileSync(join(repo, path), "utf8");

interface Fixture {
	cwd: string;
	files: Record<string, string>;
	symlinks?: Record<string, string>;
}

const FIXTURE_SET: Record<string, Fixture> = JSON.parse(
	readFileSync(join(FIXTURES, "workspaces.json"), "utf8"),
);

let counter = 0;

function write(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/**
 * Build a fixture under a fresh directory of the test root (never the real
 * home) and return that directory and the launch directory in it.
 */
function build(name: string): { base: string; cwd: string } {
	const fixture = FIXTURE_SET[name];
	if (!fixture) throw new Error(`no fixture ${name}`);
	return buildFrom(fixture);
}

function buildFrom(fixture: Fixture): { base: string; cwd: string } {
	const base = join(root, `fx-${counter++}`);
	mkdirSync(base);
	for (const [rel, body] of Object.entries(fixture.files)) {
		write(join(base, rel), body);
	}
	for (const [rel, target] of Object.entries(fixture.symlinks ?? {})) {
		mkdirSync(dirname(join(base, rel)), { recursive: true });
		symlinkSync(join(base, target), join(base, rel));
	}
	return { base, cwd: join(base, fixture.cwd) };
}

/** Every entry under `dir` with type, mode, size, times and content. */
function snapshotTree(dir: string): string[] {
	const out: string[] = [];
	const walk = (path: string, rel: string) => {
		const stat = lstatSync(path);
		const content = stat.isFile()
			? readFileSync(path, "base64")
			: stat.isSymbolicLink()
				? readlinkSync(path)
				: "";
		out.push(
			`${rel}|${stat.mode}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${content}`,
		);
		if (stat.isDirectory()) {
			for (const name of readdirSync(path).sort()) {
				walk(join(path, name), `${rel}/${name}`);
			}
		}
	};
	walk(dir, ".");
	return out;
}

interface Envelope {
	text: string;
	stderr: string;
	code: number;
	systemPrompt: string;
	initialPrompt: string;
	argv: string[];
}

/** `--show-prompt` through the runner's preview; preparation runs no command. */
async function preview(argv: string[], cwd: string): Promise<Envelope> {
	const outcome = parseCli(spec(), [...argv, "--show-prompt"], { cwd });
	if (outcome.kind !== "run") throw new Error("unexpected help");
	let out = "";
	let stderr = "";
	const code = await previewAgent(spec(), extension, outcome.invocation, {
		stdout: (chunk) => {
			out += chunk;
		},
		stderr: (chunk) => {
			stderr += chunk;
		},
		isDirectory: () => true,
		// Only the runner's own read-only worktree probe for a Codex exec plan.
		runCommand: async (request) => {
			if (request.argv.join(" ") === "git rev-parse --is-inside-work-tree") {
				return { exitCode: 128, stdout: "", stderr: "not a git repository" };
			}
			throw new Error("a Shepherd preview runs no command");
		},
	});
	const match =
		/^Backend: \w+\n--- System prompt ---\n([\s\S]*)\n--- Initial prompt ---\n([\s\S]*)\n--- Argv ---\n(.*)\n$/.exec(
			out,
		);
	return {
		text: out,
		stderr,
		code,
		systemPrompt: match?.[1] ?? "",
		initialPrompt: match?.[2] ?? "",
		argv: match ? JSON.parse(match[3] ?? "[]") : [],
	};
}

/** The parsed `--settings` value of a Claude argv, or undefined. */
function settingsOf(argv: string[]): unknown {
	const at = argv.indexOf("--settings");
	return at === -1 ? undefined : JSON.parse(argv[at + 1] ?? "");
}

/**
 * The envelope with the fixture directory as `<root>`, and the argv copy of
 * the system prompt as a marker after checking the copy is exactly the prompt.
 */
function compact(envelope: Envelope, backend: Backend, base: string): string {
	const marker = "<system prompt, as above>";
	const nameAt = backend === "claude" ? envelope.argv.indexOf("-n") : -1;
	const argv = envelope.argv.flatMap((arg, i) => {
		if (nameAt !== -1 && (i === nameAt || i === nameAt + 1)) return [];
		if (
			backend === "claude" &&
			envelope.argv[i - 1] === "--append-system-prompt"
		) {
			expect(arg).toBe(envelope.systemPrompt);
			return [marker];
		}
		if (backend === "codex" && arg.startsWith("developer_instructions=")) {
			expect(JSON.parse(arg.slice("developer_instructions=".length))).toBe(
				envelope.systemPrompt,
			);
			return [`developer_instructions=${marker}`];
		}
		return [arg];
	});
	return envelope.text
		.replace(/^- Session name:.*\n/m, "")
		.replace(/^- Codex home:.*\n/m, "")
		.replace(/--- Argv ---\n.*\n$/, () =>
			["--- Argv ---", JSON.stringify(argv), ""].join("\n"),
		)
		.replaceAll(base, "<root>");
}

interface Execution {
	code: number;
	stdout: string;
	stderr: string;
	records: ReturnType<typeof readRecords>;
}

/** Execute through the runner with the fake CLIs first on PATH. */
async function execute(
	argv: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<Execution> {
	const base = join(root, `run-${counter++}`);
	const bin = join(base, "bin");
	const tmp = join(base, "tmp");
	mkdirSync(bin, { recursive: true });
	mkdirSync(tmp);
	installFakeClis(bin);
	const recordFile = join(base, "records.jsonl");
	const outcome = parseCli(spec(), argv, { cwd });
	if (outcome.kind !== "run") throw new Error("unexpected help");
	const result: Execution = { code: 0, stdout: "", stderr: "", records: [] };
	result.code = await executeAgent(spec(), extension, outcome.invocation, {
		stdout: (chunk) => {
			result.stdout += chunk;
		},
		stderr: (chunk) => {
			result.stderr += chunk;
		},
		isDirectory: (path) => existsSync(path) || "missing",
		env: {
			PATH: bin,
			HOME: join(base, "home"),
			FAKE_RECORD: recordFile,
			...env,
		},
		tmpRoot: tmp,
	});
	result.records = readRecords(recordFile);
	return result;
}

/** A direct `prepare` context, for checks on the returned data itself. */
function context(
	backend: Backend,
	cwd: string,
	overrides: Partial<PrepareContext> = {},
): PrepareContext {
	return {
		flags: {},
		args: [],
		passthrough: [],
		cwd,
		backend,
		modelFromFlag: false,
		mode: "interactive",
		preview: true,
		spec: spec(),
		signal: new AbortController().signal,
		runCommand: async () => {
			throw new Error("Shepherd runs no command");
		},
		...overrides,
	};
}

describe("declaration paired with its extension (D-001, D-015, AC #7)", () => {
	test("shepherd is a dual-backend declaration whose same-stem .ts is its prepare extension", () => {
		expect(agent.file).toBe(SOURCE);
		expect(agent.spec.id).toBe("shepherd");
		expect(agent.extension).toEqual({
			file: EXTENSION_FILE,
			exports: ["prepare"],
		});
		expect(agent.spec.backends).toEqual(["claude", "codex"]);
		expect(agent.spec.promptMode).toBe("append");
		expect(agent.spec.mode).toBe("interactive");
		// Composition is all runtime, so the joins match the legacy launcher's.
		expect(agent.spec.systemPrompt).toBe("");
		expect(agent.spec.flags).toEqual({
			all: {
				type: "boolean",
				description: "tool check: also show info findings",
			},
			status: {
				type: "boolean",
				description: "tool check: show work and live session status",
			},
			context: {
				type: "boolean",
				description: "tool check: show words per context tier",
			},
			json: {
				type: "boolean",
				description:
					"tool check, tool archive, tool init and tool doctor: emit machine-readable JSON",
			},
			today: {
				type: "string",
				description:
					"tool check and tool archive: evaluate dates as of YYYY-MM-DD",
			},
			apply: {
				type: "boolean",
				description: "tool archive: apply planned moves and reference rewrites",
			},
			recursive: {
				type: "boolean",
				description: "tool archive: include nested workspaces",
			},
			master: {
				type: "boolean",
				description:
					"tool init: also write the shared layer for a root workspace",
			},
			name: {
				type: "string",
				short: "n",
				description: "launch: name a new Claude session",
			},
		});
		expect(agent.spec.native).toEqual({
			claude: { settings: { permissions: { allow: STATIC_RULES } } },
		});
		expect(agent.spec.mcp).toBeUndefined();
	});

	test("builds the pair as declaration plus extension, never the hook as entry", async () => {
		const plan = await planBuild({ root: repo });
		const entries = plan.entries.filter((entry) => entry.id === "shepherd");
		expect(entries).toHaveLength(1);
		const [entry] = entries;
		expect(entry?.source).toBe(SOURCE);
		if (!entry) return;
		expect(entry.agent.extension?.file).toBe(EXTENSION_FILE);
		const generated = generateEntry(entry.agent);
		expect(generated).toContain(
			`import { prepare } from ${JSON.stringify(EXTENSION_FILE)};`,
		);
		expect(generated).toContain("const extension = { prepare };");
	});

	// A smoke test: it catches a top-level exit, output, a cwd write or a
	// synchronous backend launch on import. The static §4 inspection that the
	// compiler runs is the real guard against code on import.
	test("importing the extension exits 0, prints nothing, launches no fake backend before exit and writes nothing to the cwd", () => {
		const cwd = join(root, `import-cwd-${counter++}`);
		mkdirSync(cwd);
		const base = join(root, `import-${counter++}`);
		const bin = join(base, "bin");
		mkdirSync(bin, { recursive: true });
		installFakeClis(bin);
		const recordFile = join(base, "records.jsonl");
		const child = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`const mod = await import(${JSON.stringify(EXTENSION_FILE)}); console.log("imported", Object.keys(mod).sort().join(","));`,
			],
			{
				cwd,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					FAKE_RECORD: recordFile,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect({
			code: child.exitCode,
			stdout: child.stdout.toString(),
			stderr: child.stderr.toString(),
		}).toEqual({ code: 0, stdout: "imported prepare\n", stderr: "" });
		expect(existsSync(recordFile)).toBe(false);
		expect(readdirSync(cwd)).toEqual([]);
	});
});

describe("characterization fixtures from the legacy launcher (AC #4, B-008)", () => {
	/**
	 * A legacy capture with the fixture root as `<ROOT>` and the date as
	 * `<DATE>`, minus the newline `console.log` added.
	 */
	const legacy = (file: string) =>
		readFileSync(join(FIXTURES, file), "utf8").replace(/\n$/, "");
	const normalize = (prompt: string, base: string) =>
		prompt
			.replaceAll(base, "<ROOT>")
			.replace("- Date: 2026-10-02", "- Date: <DATE>")
			.replace(/^- Session name:.*\n/m, "")
			.replace(/^- Codex home:.*\n/m, "");
	/**
	 * What a legacy capture still vouches for, brought to today's shape rather
	 * than captured again: the charter now follows the local modules, and the
	 * header has a line for the workspaces beneath.
	 */
	const legacyWorkspaceLayers = (name: string, file: string) => {
		const parts = legacy(file).split(PROMPT_SEPARATOR);
		expect(parts[LEGACY_BASE_LAYERS - 1]).toStartWith(
			"# Integration: Inter agent messaging\n",
		);
		const fixture = FIXTURE_SET[name];
		const charter = fixture?.files[`${fixture.cwd}/.shepherd/charter.md`];
		const header = (parts.at(-1) ?? "").replace(
			/^- Enclosing workspace: .*$/m,
			(line) =>
				`${line}\n- Workspaces beneath: none within 3 levels\n- Gated modules loaded: ${/\(inherited integrations: (?!none\))/.test(line) ? "nested" : "none"}`,
		);
		const modules = parts
			.slice(LEGACY_BASE_LAYERS, -1)
			.filter((part) => part !== charter);
		return {
			layers: [...modules, ...(charter ? [charter] : []), header],
			inherits: /\(inherited integrations: (?!none\))/.test(header),
		};
	};

	for (const name of Object.keys(FIXTURE_SET)) {
		for (const backend of BACKENDS) {
			test(`${name}: the ${backend} prompt is the current base layers, then the legacy workspace layers and header`, async () => {
				const { base, cwd } = build(name);
				const envelope = await preview(["--backend", backend], cwd);
				expect(envelope).toMatchObject({ code: 0, stderr: "" });
				const before = legacyWorkspaceLayers(
					name,
					`${name}.${backend}.prompt.txt`,
				);
				// Every fixture launches in a leaf with no module declared, so
				// the only gated module is the nested one.
				const baseLayers = [
					...ALWAYS_LAYERS,
					...(before.inherits ? [MODULE("nested")] : []),
				];
				const parts = normalize(envelope.systemPrompt, base).split(
					PROMPT_SEPARATOR,
				);
				expect(parts.slice(0, baseLayers.length)).toEqual(baseLayers.map(text));
				expect(parts.slice(baseLayers.length)).toEqual(before.layers);
				if (backend === "codex") {
					expect(settingsOf(envelope.argv)).toBeUndefined();
				}
			});
		}

		test(`${name}: the Claude --settings are the legacy shepherdSettings minus defaultMode and the Write rule, with no MCP config`, async () => {
			const { base, cwd } = build(name);
			const envelope = await preview(["--backend", "claude"], cwd);
			// The legacy `--settings` value, exactly as it was put on the argv.
			const before = JSON.parse(
				legacy(`${name}.settings.txt`).replaceAll("<ROOT>", base),
			);
			// Spec Migration: defaultMode "default" and the empty mcpServers are dropped.
			expect(before.permissions.defaultMode).toBe("default");
			delete before.permissions.defaultMode;
			// Claude Code ignores Write rules for file checks and warns on every
			// launch; Edit covers every file-editing tool (fix round 1).
			expect(before.permissions.allow).toContain("Write(.shepherd/**)");
			before.permissions.allow = before.permissions.allow.filter(
				(rule: string) => rule !== "Write(.shepherd/**)",
			);
			expect(settingsOf(envelope.argv)).toEqual(before);
			// Key order too, since the argv carries the JSON text.
			expect(envelope.argv).toContain(JSON.stringify(before));
			expect(envelope.argv).not.toContain("--mcp-config");
		});
	}
});

describe("--show-prompt envelopes (B-003, AC #4)", () => {
	for (const backend of BACKENDS) {
		for (const name of ["plain", "uninitiated", "nested-symlink-dedupe"]) {
			test(`${name} on ${backend}`, async () => {
				const { base, cwd } = build(name);
				const envelope = await preview(
					["--backend", backend, "triage", "my", "morning"],
					cwd,
				);
				expect(envelope.code).toBe(0);
				expect(envelope.initialPrompt).toBe("triage my morning");
				expect(compact(envelope, backend, base)).toMatchSnapshot();
			});
		}
	}
});

describe("enclosing workspace (B-008, AC #1, AC #2, AC #3)", () => {
	test("a Codex preview of a nested workspace shows the inherited fragments with no rule error and no rule object", async () => {
		const { base, cwd } = build("nested-inherited");
		const envelope = await preview(["--backend", "codex"], cwd);
		expect({ code: envelope.code, stderr: envelope.stderr }).toEqual({
			code: 0,
			stderr: "",
		});
		expect(envelope.systemPrompt).toContain(
			"# Shared A\n\nShared conventions A.",
		);
		expect(envelope.systemPrompt).toContain(
			"# Flock B\n\nShared conventions B.",
		);
		expect(envelope.systemPrompt).toContain(
			`- Enclosing workspace: ${base}/flock (inherited integrations: a-shared.md, b-flock.md)`,
		);
		expect(envelope.systemPrompt).toContain("- Backend: codex-cli");
		expect(envelope.argv).toEqual([
			"codex",
			"-c",
			`developer_instructions=${JSON.stringify(envelope.systemPrompt)}`,
		]);
		expect(envelope.text).not.toContain(".shepherd/**");
		expect(compact(envelope, "codex", base)).toMatchSnapshot();
	});

	test("on Claude only, the double-slash Read rule and the additional directory name the enclosing .shepherd/", async () => {
		const { base, cwd } = build("nested-inherited");
		const shared = `${base}/flock/.shepherd`;
		expect(shared.startsWith("/")).toBe(true);
		const envelope = await preview(["--backend", "claude"], cwd);
		expect(settingsOf(envelope.argv)).toEqual({
			permissions: {
				allow: [...STATIC_RULES, `Read(/${shared}/**)`],
				additionalDirectories: [shared],
			},
		});
		// Literally `Read(//abs/...)`, never the single-slash form.
		const rule = `Read(//${shared.slice(1)}/**)`;
		expect(JSON.stringify(settingsOf(envelope.argv))).toContain(rule);
		expect(JSON.stringify(settingsOf(envelope.argv))).not.toContain(
			`"Read(${shared}/**)"`,
		);

		expect(extension.prepare(context("claude", cwd))).toMatchObject({
			extraAllowRules: {
				rules: [`Read(/${shared}/**)`],
				additionalDirectories: [shared],
			},
		});
		const onCodex = extension.prepare(context("codex", cwd));
		expect(onCodex).not.toHaveProperty("extraAllowRules");
		expect(onCodex).toHaveProperty("systemPromptFragments");
	});

	test("Codex never receives a rule object, and Claude gets none without an enclosing workspace", () => {
		for (const name of Object.keys(FIXTURE_SET)) {
			const { cwd } = build(name);
			expect(extension.prepare(context("codex", cwd))).not.toHaveProperty(
				"extraAllowRules",
			);
			const enclosed = FIXTURE_SET[name]?.cwd.includes("/");
			expect(
				Object.hasOwn(
					extension.prepare(context("claude", cwd)),
					"extraAllowRules",
				),
			).toBe(enclosed === true);
		}
	});

	test("the rule and directory use the enclosing workspace's realpath when the launch path goes through a symlink", async () => {
		const { base } = build("nested-inherited");
		const link = join(root, `link-${counter++}`);
		symlinkSync(join(base, "flock"), link);
		const cwd = join(link, "child");
		const shared = `${base}/flock/.shepherd`;
		const envelope = await preview(["--backend", "claude"], cwd);
		expect(settingsOf(envelope.argv)).toEqual({
			permissions: {
				allow: [...STATIC_RULES, `Read(/${shared}/**)`],
				additionalDirectories: [shared],
			},
		});
		// The header keeps the path as launched, as the legacy launcher did.
		expect(envelope.systemPrompt).toContain(
			`- Enclosing workspace: ${link} (inherited integrations: a-shared.md, b-flock.md)`,
		);
	});

	test("the nearest enclosing workspace wins; one further up contributes nothing", async () => {
		const { base, cwd } = build("nearest-parent");
		const envelope = await preview(["--backend", "claude"], cwd);
		expect(envelope.systemPrompt).toContain(
			"# Inner\n\nThe nearest enclosing module.",
		);
		expect(envelope.systemPrompt).not.toContain("# Outer");
		expect(settingsOf(envelope.argv)).toMatchObject({
			permissions: { additionalDirectories: [`${base}/outer/inner/.shepherd`] },
		});
	});

	test("the enclosing workspace's charter never loads in a child", async () => {
		const { cwd } = build("nested-inherited");
		const { systemPrompt } = await preview([], cwd);
		expect(systemPrompt).toContain("# Child charter");
		expect(systemPrompt).not.toContain("# Flock charter");
	});

	test("a local module whose realpath matches an inherited one is skipped (realpath dedupe)", async () => {
		const { cwd } = build("nested-symlink-dedupe");
		const { systemPrompt } = await preview([], cwd);
		expect(
			systemPrompt.split("# Flock\n\nThe shared flock module."),
		).toHaveLength(2);
		expect(systemPrompt).toContain(
			"- Workspace-local integrations loaded: z-local.md",
		);
		expect(systemPrompt).toContain("(inherited integrations: flock.md)");
	});

	test("an enclosing path with a space keeps the space in the rule and the directory", async () => {
		const { base, cwd } = build("enclosing-with-space");
		const shared = `${base}/my flock/.shepherd`;
		const envelope = await preview(["--backend", "claude"], cwd);
		expect(settingsOf(envelope.argv)).toEqual({
			permissions: {
				allow: [...STATIC_RULES, `Read(/${shared}/**)`],
				additionalDirectories: [shared],
			},
		});
	});
});

describe("tool surface", () => {
	test("check exits through prepare, writes stdout, and starts no backend", async () => {
		const { cwd } = build("plain");
		const output = await execute(["tool", "check"], cwd);
		expect(output.code).toBeOneOf([0, 1]);
		expect(output.stdout).toContain("1 workspaces:");
		expect(output.stderr).toBe("");
		expect(output.records).toEqual([]);
	});

	test("tool usage and preview are diagnostics and start no backend", async () => {
		const { cwd } = build("plain");
		for (const argv of [["tool"], ["tool", "sweep"]]) {
			const output = await execute(argv, cwd);
			expect(output.code).toBe(2);
			expect(output.stderr).toContain("shepherd tool check");
			expect(output.stderr).toContain("shepherd tool archive");
			expect(output.records).toEqual([]);
		}
		for (const [argv, code, stderr] of [
			[
				["tool", "sweep"],
				1,
				"shepherd tool check   [<workspace>...] [--all] [--status | --context] [--json] [--today YYYY-MM-DD]",
			],
			[
				["tool"],
				1,
				"shepherd tool archive [<workspace>...] [--recursive] [--apply] [--json] [--today YYYY-MM-DD]",
			],
			[
				["tool", "archive"],
				1,
				"shepherd tool archive does not launch a session; drop --show-prompt\n",
			],
		] as const) {
			const previewResult = await preview([...argv], cwd);
			expect(previewResult.code).toBe(code);
			expect(previewResult.stderr).toContain(stderr);
		}
	});

	test("every tool-shaped command line preserves the no-backend invariant", async () => {
		const { cwd } = build("plain");
		const cases = [
			["tool"],
			["tool", "sweep"],
			["tool", "check"],
			["tool", "archive"],
			["tool", "guide"],
			["tool", "guide", "charter"],
			["tool", "guide", "--json"],
			["tool", "guide", "--show-prompt"],
			["tool", "guide", "--model", "x"],
			["tool", "init"],
			["tool", "init", "--master"],
			["tool", "init", "--json"],
			["tool", "init", "--master", "--json"],
			["tool", "init", "--show-prompt"],
			["tool", "init", "--model", "x"],
			["tool", "doctor"],
			["tool", "doctor", "--json"],
			["tool", "doctor", "--show-prompt"],
			["tool", "doctor", "--model", "x"],
			["tool", "check", "--master"],
			["tool", "check", "--all"],
			["tool", "check", "--status"],
			["tool", "check", "--context"],
			["tool", "check", "--json"],
			["tool", "check", "--today", "2026-10-05"],
			["tool", "archive", "--apply"],
			["tool", "archive", "--recursive"],
			["tool", "check", "--name", "session"],
			["tool", "check", "--print"],
			["tool", "check", "--backend", "codex"],
			["tool", "check", "--model", "x"],
			["tool", "check", "--", "--resume", "notes"],
		];
		for (const argv of cases) {
			const output = await execute(argv, cwd);
			expect(output.records, argv.join(" ")).toEqual([]);
		}
	});

	test("guide returns text and refusals without launching either backend", async () => {
		const { cwd } = build("plain");
		for (const backend of BACKENDS) {
			for (const [argv, code, stdout, stderr] of [
				[
					["tool", "guide"],
					0,
					[
						"charter: the init conversation's questions and the charter's shape",
						"memory: the memory file format and what each type holds",
						"tools: generic traps in Claude Code delegates, the Codex CLI and the shell",
						"",
					].join("\n"),
					"",
				],
				[
					["tool", "guide", "charter"],
					0,
					text("system-prompts/shepherd/guides/charter.md"),
					"",
				],
				[
					["tool", "guide", "--json"],
					2,
					"",
					"shepherd: --json applies only to tool check, tool archive, tool init and tool doctor\n",
				],
				[
					["tool", "guide", "--model", "x"],
					2,
					"",
					"shepherd: --model applies only to launches\n",
				],
			] as const) {
				const output = await execute(["--backend", backend, ...argv], cwd);
				expect(output).toEqual({ code, stdout, stderr, records: [] });
			}
			for (const args of [
				["tool", "guide"],
				["tool", "guide", "charter"],
			]) {
				const output = await preview(["--backend", backend, ...args], cwd);
				expect(output).toMatchObject({
					code: 1,
					text: "",
					stderr:
						"shepherd tool guide does not launch a session; drop --show-prompt\n",
					argv: [],
				});
			}
		}
	});

	test("doctor reports and refuses preview and model flags without either backend", async () => {
		const tree = makeTree({ "launch/placeholder": "" });
		try {
			const cwd = join(tree.root, "launch");
			for (const backend of BACKENDS) {
				for (const flags of [[], ["--json"]]) {
					const output = await execute(
						["--backend", backend, "tool", "doctor", ...flags],
						cwd,
					);
					expect(output).toMatchObject({ code: 1, stderr: "", records: [] });
					if (flags.includes("--json"))
						expect(JSON.parse(output.stdout)).toMatchObject({
							schema: 1,
							command: "doctor",
							home: join(root, "home"),
						});
					else expect(output.stdout).toStartWith("Shepherd doctor, home ");
					const shown = await preview(
						["--backend", backend, "tool", "doctor", ...flags],
						cwd,
					);
					expect(shown).toMatchObject({
						code: 1,
						text: "",
						argv: [],
						stderr:
							"shepherd tool doctor does not launch a session; drop --show-prompt\n",
					});
					const modeled = await execute(
						["--backend", backend, "tool", "doctor", ...flags, "--model", "x"],
						cwd,
					);
					expect(modeled).toEqual({
						code: 2,
						stdout: "",
						records: [],
						stderr: "shepherd: --model applies only to launches\n",
					});
				}
			}
		} finally {
			tree.cleanup();
		}
	});

	test("launch JSON refusal names doctor as an owner", async () => {
		const { cwd } = build("plain");
		expect(await execute(["--json"], cwd)).toEqual({
			code: 2,
			stdout: "",
			records: [],
			stderr:
				"shepherd: --json applies only to tool check, tool archive, tool init and tool doctor\n",
		});
	});

	test("init succeeds and refuses preview and model flags without either backend", async () => {
		const tree = makeTree({ "launch/placeholder": "" });
		try {
			const cwd = join(tree.root, "launch");
			for (const backend of BACKENDS) {
				for (const flags of [
					[],
					["--master"],
					["--json"],
					["--master", "--json"],
				]) {
					const output = await execute(
						["--backend", backend, "tool", "init", ...flags],
						cwd,
					);
					expect(output).toMatchObject({ code: 0, stderr: "", records: [] });
					if (flags.includes("--json")) {
						expect(JSON.parse(output.stdout)).toMatchObject({
							command: "init",
							root: cwd,
							master: flags.includes("--master"),
							failed: null,
						});
					} else {
						expect(output.stdout).toStartWith(
							`Initialized ${cwd}/.shepherd (workspace${flags.includes("--master") ? ", shared layer" : ""})\n`,
						);
					}
					const shown = await preview(
						["--backend", backend, "tool", "init", ...flags],
						cwd,
					);
					expect(shown).toMatchObject({
						code: 1,
						text: "",
						argv: [],
						stderr:
							"shepherd tool init does not launch a session; drop --show-prompt\n",
					});
				}
				const modeled = await execute(
					["--backend", backend, "tool", "init", "--model", "x"],
					cwd,
				);
				expect(modeled).toEqual({
					code: 2,
					stdout: "",
					records: [],
					stderr: "shepherd: --model applies only to launches\n",
				});
			}
		} finally {
			tree.cleanup();
		}
	});

	test("launch flag gate and other tools reject master with its owner message", async () => {
		const { cwd } = build("plain");
		for (const backend of BACKENDS) {
			for (const argv of [
				["--master"],
				["tool", "check", "--master"],
				["tool", "archive", "--master"],
				["tool", "guide", "--master"],
			]) {
				expect(await execute(["--backend", backend, ...argv], cwd)).toEqual({
					code: 2,
					stdout: "",
					records: [],
					stderr: "shepherd: --master applies only to tool init\n",
				});
			}
		}
	});

	test("initialized master and child load shared integrations and gate root and nested modules", async () => {
		const tree = makeTree({ "launch/child/placeholder": "" });
		try {
			const cwd = join(tree.root, "launch");
			const child = join(cwd, "child");
			expect((await execute(["tool", "init", "--master"], cwd)).code).toBe(0);
			for (const backend of BACKENDS) {
				const shown = await preview(["--backend", backend], cwd);
				expect(shown.code).toBe(0);
				expect(shown.systemPrompt).toContain(
					"Workspace-local integrations loaded: shared.md",
				);
				expect(shown.systemPrompt).toContain("Enclosing workspace: none");
				expect(shown.systemPrompt).toContain("Gated modules loaded: none");
			}
			expect((await execute(["tool", "init"], child)).code).toBe(0);
			for (const backend of BACKENDS) {
				const parentShown = await preview(["--backend", backend], cwd);
				expect(parentShown.code).toBe(0);
				expect(parentShown.systemPrompt).toContain(
					"Gated modules loaded: root",
				);
				const childShown = await preview(["--backend", backend], child);
				expect(childShown.code).toBe(0);
				expect(childShown.systemPrompt).toContain(
					`Enclosing workspace: ${cwd} (inherited integrations: shared.md)`,
				);
				expect(childShown.systemPrompt).toContain(
					"Gated modules loaded: nested",
				);
			}
			const checked = await execute(["tool", "check", "--json"], cwd);
			expect(checked).toMatchObject({ code: 0, stderr: "", records: [] });
			expect(JSON.parse(checked.stdout).totals).toMatchObject({
				error: 0,
				warn: 0,
			});
		} finally {
			tree.cleanup();
		}
	});

	test("check and archive remain ordinary launch prompts without tool", async () => {
		const { cwd } = build("plain");
		for (const prompt of ["check the deploy", "archive old notes"]) {
			const output = await execute(prompt.split(" "), cwd);
			expect(output.code).toBe(0);
			expect(output.records).toHaveLength(1);
			expect(output.records[0]?.argv.at(-1)).toBe(prompt);
		}
	});
});

describe("composition order (B-008, AC #1)", () => {
	test("core, built-ins, inherited (sorted), local (sorted), charter, header", async () => {
		const { cwd } = build("nested-local");
		const { systemPrompt } = await preview([], cwd);
		const parts = systemPrompt.split(PROMPT_SEPARATOR);
		const baseLayers = [...ALWAYS_LAYERS, MODULE("nested")];
		expect(parts.slice(0, baseLayers.length)).toEqual(baseLayers.map(text));
		expect(parts.slice(baseLayers.length, -1)).toEqual([
			"# Flock\n\nThe shared flock module.\n",
			"# A local\n\nNot inherited, sorts before the flock module by name.\n",
			"# Child charter\n\nBelow a directory that is not a workspace.\n",
		]);
		expect(parts.at(-1)).toStartWith("# Shepherd session context\n");
	});

	// The charter wins over every module on how a workspace works, a root's
	// own shared modules included, so it is composed after them.
	test("a root's shared modules are its local modules, and its charter follows them", async () => {
		const { base } = build("nested-inherited");
		const { systemPrompt } = await preview([], join(base, "flock"));
		const parts = systemPrompt.split(PROMPT_SEPARATOR);
		const baseLayers = [...ALWAYS_LAYERS, MODULE("root")];
		expect(parts.slice(0, baseLayers.length)).toEqual(baseLayers.map(text));
		expect(parts.slice(baseLayers.length, -1)).toEqual([
			"# Shared A\n\nShared conventions A.\n",
			"# Flock B\n\nShared conventions B.\n",
			"# Flock charter\n\nMust not load in a child.\n",
		]);
		expect(parts.at(-1)).toContain("- Workspaces beneath: child\n");
		expect(parts.at(-1)).toContain("- Gated modules loaded: root\n");
		expect(parts.at(-1)).toContain(
			"- Workspace-local integrations loaded: a-shared.md, b-flock.md",
		);
	});

	test("a plain workspace has no inherited layer, and only .md files are modules", async () => {
		const { cwd } = build("plain");
		const { systemPrompt } = await preview([], cwd);
		expect(systemPrompt).toContain("- Enclosing workspace: none");
		expect(systemPrompt).toContain("- Charter: loaded");
		expect(systemPrompt).toContain(
			"- Workspace-local integrations loaded: local-a.md",
		);
		expect(systemPrompt).not.toContain("not a module");
	});

	test("an uninitiated workspace says so and still gets core and the two always-loaded modules", async () => {
		const { cwd } = build("uninitiated");
		const { systemPrompt } = await preview([], cwd);
		expect(systemPrompt).toContain(
			"- Charter: none, this workspace is uninitiated",
		);
		expect(systemPrompt).toContain(
			"- Workspace-local integrations loaded: none",
		);
		expect(systemPrompt.split(PROMPT_SEPARATOR)).toHaveLength(
			ALWAYS_LAYERS.length + 1,
		);
	});

	test("the header carries cwd, state dir, the fixed date and the legacy backend label", async () => {
		const { cwd } = build("plain");
		for (const [backend, label] of [
			["claude", "claude-cli"],
			["codex", "codex-cli"],
		]) {
			const { systemPrompt } = await preview(
				["--backend", backend as string],
				cwd,
			);
			const header = systemPrompt.split(PROMPT_SEPARATOR).at(-1);
			expect(
				header?.replaceAll(cwd, "<cwd>").replaceAll(root, "<root>"),
			).toMatchSnapshot(`new ${backend} header`);
			expect(header).toBe(
				[
					"# Shepherd session context",
					"",
					`- Launch directory: ${cwd}`,
					`- State directory: ${cwd}/.shepherd`,
					"- Date: 2026-10-02",
					`- Backend: ${label}`,
					backend === "claude"
						? "- Session name: ws-1002 (set by the launcher: use it as it stands in CURRENT.md and in messages, do not rename yourself)"
						: "- Session name: not set (Codex takes no name at launch: name it with its rename dialog, suggested ws-1002, then record the name the host reports)",
					...(backend === "codex"
						? [`- Codex home: ${join(root, "home", ".codex")} (Codex default)`]
						: []),
					"- Enclosing workspace: none",
					"- Workspaces beneath: none within 3 levels",
					"- Gated modules loaded: none",
					"- Charter: loaded",
					"- Workspace-local integrations loaded: local-a.md",
				].join("\n"),
			);
		}
	});

	test("the header date is the local day, not the UTC one", async () => {
		if (process.env.SHEPHERD_TZ_CHILD !== "1") {
			const child = Bun.spawnSync(
				[
					process.execPath,
					"test",
					"./agents/shepherd.test.ts",
					"--test-name-pattern",
					"the header date is the local day",
				],
				{
					cwd: repo,
					env: {
						...process.env,
						TZ: "America/New_York",
						SHEPHERD_TZ_CHILD: "1",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			if (child.exitCode !== 0) {
				throw new Error(child.stderr.toString());
			}
			return;
		}

		const { cwd } = build("plain");
		try {
			// 21:30 on the 2nd in New York is already the 3rd in UTC.
			setSystemTime(new Date("2026-10-03T01:30:00Z"));
			const { systemPrompt } = await preview([], cwd);
			expect(systemPrompt).toContain("- Date: 2026-10-02\n");
		} finally {
			setSystemTime(new Date("2026-10-02T12:00:00Z"));
		}
	});
});

describe("launcher-gated modules", () => {
	const charter = (body: string) => ({ "ws/.shepherd/charter.md": body });
	const CASES: Record<string, { fixture: Fixture; modules: string[] }> = {
		"an uninitiated directory": {
			fixture: { cwd: "ws", files: { "ws/README.md": "Nothing here.\n" } },
			modules: [],
		},
		"a standalone workspace whose charter declares no module": {
			fixture: {
				cwd: "ws",
				// "Modules:" in the middle of a sentence declares nothing.
				files: charter("# Charter\n\nErrands. No Modules: line here.\n"),
			},
			modules: [],
		},
		"a charter with the line Modules: software": {
			fixture: {
				cwd: "ws",
				files: charter("# Charter\n\n## Structure\nModules: software\n"),
			},
			modules: ["software"],
		},
		"a charter that declares it as a list item in another case": {
			fixture: {
				cwd: "ws",
				files: charter("# Charter\n\n- modules: docs, Software\n"),
			},
			modules: ["software"],
		},
		"a workspace under a root that publishes a module": {
			fixture: {
				cwd: "root/ws",
				files: {
					"root/.shepherd/integrations/shared.md": "# Shared\n",
					"root/ws/.shepherd/charter.md": "# Charter\n",
				},
			},
			modules: ["nested"],
		},
		"a workspace under a stray ancestor that publishes nothing": {
			fixture: {
				cwd: "home/projects/app",
				files: {
					"home/.shepherd/journal.md": "## 2026-10-01\n",
					"home/projects/app/.shepherd/charter.md": "# Charter\n",
				},
			},
			modules: [],
		},
		"a root above a workspace": {
			fixture: {
				cwd: "root",
				files: {
					"root/.shepherd/charter.md": "# Root charter\n",
					"root/.shepherd/integrations/shared.md": "# Shared\n",
					"root/ws/.shepherd/charter.md": "# Charter\n",
				},
			},
			modules: ["root"],
		},
		"a software workspace that is nested and has workspaces beneath it": {
			fixture: {
				cwd: "root/mid",
				files: {
					"root/.shepherd/integrations/shared.md": "# Shared\n",
					"root/mid/.shepherd/charter.md": "# Charter\n\nModules: software\n",
					"root/mid/leaf/.shepherd/charter.md": "# Charter\n",
				},
			},
			modules: ["nested", "root", "software"],
		},
	};

	for (const [name, { fixture, modules }] of Object.entries(CASES)) {
		for (const backend of BACKENDS) {
			test(`${name} loads ${modules.join(", ") || "none of them"} on ${backend}`, async () => {
				const { cwd } = buildFrom(fixture);
				const { systemPrompt } = await preview(["--backend", backend], cwd);
				const titles = systemPrompt
					.split(PROMPT_SEPARATOR)
					.map((part) => part.split("\n", 1)[0] ?? "");
				expect(titles.slice(0, ALWAYS_LAYERS.length)).toEqual([
					"# Shepherd",
					"# Integration: Herdr",
					"# Integration: Inter agent messaging",
				]);
				const gated = Object.values(GATED_TITLES);
				expect(titles.filter((title) => gated.includes(title))).toEqual(
					modules.map((module) => GATED_TITLES[module] ?? ""),
				);
			});
		}
	}

	test("each gated module's source opens with the title the cases look for", () => {
		for (const [name, title] of Object.entries(GATED_TITLES)) {
			expect(text(MODULE(name))).toStartWith(`${title}\n`);
		}
	});

	test("a stray ancestor is still named in the header, with nothing inherited", async () => {
		const { base, cwd } = buildFrom(
			CASES["a workspace under a stray ancestor that publishes nothing"]
				?.fixture as Fixture,
		);
		const { systemPrompt } = await preview([], cwd);
		expect(systemPrompt).toContain(
			`- Enclosing workspace: ${base}/home (inherited integrations: none)`,
		);
	});

	test("Workspaces beneath lists child workspaces by relative path, sorted, and stops at each one, at hidden directories, node_modules and symlinks, and three levels down", async () => {
		const state = (dir: string) => [`${dir}/.shepherd/charter.md`, "# C\n"];
		const { cwd } = buildFrom({
			cwd: "root",
			files: Object.fromEntries([
				state("root/b"),
				state("root/a"),
				state("root/a/inside-a-workspace"),
				state("root/group/c"),
				state("root/l1/l2/l3"),
				state("root/d1/d2/d3/d4"),
				state("root/.hidden/h"),
				state("root/node_modules/pkg"),
			]),
			symlinks: { "root/link-to-a": "root/a" },
		});
		const { systemPrompt } = await preview([], cwd);
		expect(systemPrompt).toContain(
			"- Workspaces beneath: a, b, group/c, l1/l2/l3\n",
		);
	});
});

describe("print mode (B-008, AC #3)", () => {
	test("--print without a prompt fails before spawn: stderr, exit 1, no backend launched", async () => {
		const { cwd } = build("plain");
		for (const backend of BACKENDS) {
			for (const argv of [["--print"], ["--print", "   "]]) {
				const run = await execute([...argv, "--backend", backend], cwd);
				expect(run).toEqual({
					code: 1,
					stdout: "",
					stderr: 'Print mode requires a prompt: shepherd --print "..."\n',
					records: [],
				});
			}
		}
	});

	test("--print with a prompt launches the backend in print mode with that prompt", async () => {
		const { cwd } = build("plain");
		const run = await execute(["--print", "status", "report"], cwd);
		expect(run.code).toBe(0);
		const [record] = run.records;
		expect(record?.cwd).toBe(cwd);
		expect(record?.argv).toContain("--print");
		expect(record?.argv.slice(-2)).toEqual(["--", "status report"]);
	});

	test("previewing --print without a prompt still shows the prompt, as the legacy launcher did", async () => {
		const { cwd } = build("plain");
		const envelope = await preview(["--print"], cwd);
		expect(envelope).toMatchObject({ code: 0, stderr: "", initialPrompt: "" });
		expect(envelope.argv).toContain("--print");
	});

	test("Codex print mode ignores configured interactive defaults", async () => {
		const { cwd } = build("plain");
		const home = join(root, "home");
		const configFile = join(home, ".config", "shepherd", "config.json");
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(
			configFile,
			JSON.stringify({
				codex: {
					home: join(home, "missing-codex-home"),
					model: "configured",
					effort: "high",
				},
			}),
		);
		try {
			const envelope = await preview(
				["--backend", "codex", "--print", "hi"],
				cwd,
			);
			expect(envelope).toMatchObject({ code: 0, stderr: "" });
			expect(envelope.systemPrompt).not.toContain("- Codex home:");
			expect(envelope.argv).not.toContain("configured");
			expect(envelope.argv).not.toContain('model_reasoning_effort="high"');
			const prepared = extension.prepare(
				context("codex", cwd, { mode: "print", args: ["hi"] }),
			);
			expect(prepared).not.toHaveProperty("codexHome");
			expect(prepared).not.toHaveProperty("model");
			expect(prepared).not.toHaveProperty("effort");
		} finally {
			rmSync(configFile, { force: true });
		}
	});
});

describe("framework flags and passthrough (D-028, AC #6)", () => {
	test("an invalid user config fails the launch with exit 2", async () => {
		const { cwd } = build("plain");
		const configFile = join(root, "home", ".config", "shepherd", "config.json");
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(configFile, JSON.stringify({ sessionPrefix: "wrong-scope" }));
		try {
			const run = await execute(["hello"], cwd);
			expect(run).toEqual({
				code: 2,
				stdout: "",
				stderr: `shepherd: ${configFile}: sessionPrefix: unknown key\n`,
				records: [],
			});
		} finally {
			rmSync(configFile, { force: true });
		}
	});

	test("an invalid workspace config warns only interactively and uses the directory prefix", async () => {
		const { cwd } = buildFrom({
			cwd: "fallback",
			files: {
				"fallback/.shepherd/charter.md": "# Charter\n",
				"fallback/.shepherd/config.json": JSON.stringify({
					sessionPrefix: "bad prefix",
				}),
			},
		});
		const configFile = join(cwd, ".shepherd", "config.json");
		const warning = `shepherd: ${configFile}: sessionPrefix: must start with a letter and contain only letters, digits, and hyphens`;
		const interactive = await execute(["hello"], cwd);
		expect(interactive).toMatchObject({
			code: 0,
			stdout: `${warning}\n`,
			stderr: "",
		});
		const interactiveArgv = interactive.records[0]?.argv ?? [];
		expect(interactiveArgv[interactiveArgv.indexOf("-n") + 1]).toBe(
			"fallback-1002",
		);

		const printed = await execute(["--print", "hello"], cwd);
		expect(printed.code).toBe(0);
		expect(printed.stdout).not.toContain(warning);
		expect(printed.records).toHaveLength(1);
	});

	test("Codex config supplies home, model, effort, and the home header", async () => {
		const { cwd } = build("plain");
		const home = join(root, "home");
		const codexHome = join(home, ".codex-work");
		const configFile = join(home, ".config", "shepherd", "config.json");
		mkdirSync(codexHome, { recursive: true });
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(
			configFile,
			JSON.stringify({
				codex: { home: codexHome, model: "gpt-5.6-sol", effort: "high" },
			}),
		);
		try {
			const envelope = await preview(["--backend", "codex"], cwd);
			expect(envelope.systemPrompt).toContain(
				`- Codex home: ${codexHome} (config)`,
			);
			expect(envelope.argv[envelope.argv.indexOf("-m") + 1]).toBe(
				"gpt-5.6-sol",
			);
			expect(envelope.argv).toContain('model_reasoning_effort="high"');

			const run = await execute(["--backend", "codex", "hello"], cwd);
			expect(run.code).toBe(0);
			expect(run.records[0]?.codexHome).toBe(codexHome);
		} finally {
			rmSync(configFile, { force: true });
			rmSync(codexHome, { recursive: true, force: true });
		}
	});

	test("explicit Codex launch values override config defaults", async () => {
		const { cwd } = build("plain");
		const home = join(root, "home");
		const environmentHome = join(home, ".codex-environment");
		const configFile = join(home, ".config", "shepherd", "config.json");
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(
			configFile,
			JSON.stringify({
				codex: {
					home: join(home, "missing-configured-home"),
					model: "configured",
					effort: "high",
				},
			}),
		);
		try {
			const result = shepherd.prepare(
				context("codex", cwd, {
					passthrough: ["-m", "launch", "-c", "model_reasoning_effort=low"],
				}),
				{
					...testToolEnv(context("codex", cwd)),
					env: { CODEX_HOME: environmentHome },
				},
			);
			expect(result).toMatchObject({ codexHome: environmentHome });
			expect(result).not.toHaveProperty("model");
			expect(result).not.toHaveProperty("effort");
			expect(result).toHaveProperty("systemPromptFragments");
			expect(JSON.stringify(result)).toContain(
				`- Codex home: ${environmentHome} (environment)`,
			);
		} finally {
			rmSync(configFile, { force: true });
		}
	});

	test("Codex homeFile selects the first non-empty path", () => {
		const { cwd } = build("plain");
		const home = join(root, "home");
		const codexHome = join(home, ".codex-file");
		const homeFile = join(home, ".codex-active");
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(homeFile, "\n~/.codex-file\nignored\n");
		const configFile = join(home, ".config", "shepherd", "config.json");
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(configFile, JSON.stringify({ codex: { homeFile } }));
		try {
			expect(extension.prepare(context("codex", cwd))).toMatchObject({
				codexHome,
			});
		} finally {
			rmSync(configFile, { force: true });
			rmSync(homeFile, { force: true });
			rmSync(codexHome, { recursive: true, force: true });
		}
	});

	test("resumes and forks keep Codex home and withhold configured defaults", async () => {
		const { cwd } = build("plain");
		const home = join(root, "home");
		const codexHome = join(home, ".codex-history");
		const configFile = join(home, ".config", "shepherd", "config.json");
		mkdirSync(codexHome, { recursive: true });
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(
			configFile,
			JSON.stringify({
				codex: { home: codexHome, model: "configured", effort: "high" },
			}),
		);
		try {
			for (const passthrough of [
				["resume", "id"],
				["fork", "id"],
			]) {
				const result = extension.prepare(
					context("codex", cwd, { passthrough }),
				);
				expect(result).toMatchObject({ codexHome });
				expect(result).not.toHaveProperty("model");
				expect(result).not.toHaveProperty("effort");
				expect(result).not.toHaveProperty("sessionName");
				expect(JSON.stringify(result)).not.toMatch(/- Session name:/);
			}
			const explicit = extension.prepare(
				context("codex", cwd, {
					passthrough: ["resume"],
					modelFromFlag: true,
				}),
			);
			expect(explicit).not.toHaveProperty("model");
			const envelope = await preview(
				["--backend", "codex", "--model", "launch", "--", "resume"],
				cwd,
			);
			expect(envelope.argv[envelope.argv.indexOf("-m") + 1]).toBe("launch");
			expect(envelope.argv).not.toContain('model_reasoning_effort="high"');
		} finally {
			rmSync(configFile, { force: true });
			rmSync(codexHome, { recursive: true, force: true });
		}
	});

	test("a typed model plus a passthrough model exits 2 on both backends", async () => {
		const { cwd } = build("plain");
		for (const backend of BACKENDS) {
			for (const tail of [["-m", "tail"], ["--model=tail"]]) {
				const run = await execute(
					["--backend", backend, "--model", "typed", "--", ...tail],
					cwd,
				);
				expect(run.code).toBe(2);
				expect(run.stderr).toContain("model given twice: --model and");
				expect(run.records).toEqual([]);
			}
		}
	});

	test("a missing configured home fails only a Codex launch", () => {
		const { cwd } = build("plain");
		const home = join(root, "home");
		const missing = join(home, "missing-codex-home");
		const configFile = join(home, ".config", "shepherd", "config.json");
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(configFile, JSON.stringify({ codex: { home: missing } }));
		try {
			expect(extension.prepare(context("claude", cwd))).not.toHaveProperty(
				"exit",
			);
			expect(extension.prepare(context("codex", cwd))).toEqual({
				exit: {
					message: `${configFile}: Codex home is not an existing directory: ${missing}\n`,
					code: 2,
					stream: "stderr",
				},
			});
		} finally {
			rmSync(configFile, { force: true });
		}
	});

	test("a default interactive Claude launch returns and forwards its name", async () => {
		const { cwd } = build("plain");
		const prepared = extension.prepare(context("claude", cwd));
		expect(prepared).toMatchObject({ sessionName: "ws-1002" });
		const envelope = await preview([], cwd);
		expect(envelope.systemPrompt).toContain(
			"- Session name: ws-1002 (set by the launcher: use it as it stands in CURRENT.md and in messages, do not rename yourself)",
		);
		expect(envelope.argv.filter((token) => token === "-n")).toHaveLength(1);
		expect(envelope.argv[envelope.argv.indexOf("-n") + 1]).toBe("ws-1002");
	});

	test("the injected clock supplies both the header date and session name", () => {
		const { cwd } = build("plain");
		const ctx = context("claude", cwd);
		const result = shepherd.prepare(ctx, {
			...testToolEnv(ctx),
			now: new Date(2026, 10, 7, 12),
		});
		expect(result).toMatchObject({ sessionName: "ws-1107" });
		expect(JSON.stringify(result)).toContain("- Date: 2026-11-07");
		expect(JSON.stringify(result)).toContain(
			"- Session name: ws-1107 (set by the launcher: use it as it stands in CURRENT.md and in messages, do not rename yourself)",
		);
	});

	test("Claude registry names move the launcher name to the b suffix", () => {
		const tree = makeTree({
			"home/.claude/sessions/123.json": JSON.stringify({
				pid: 123,
				name: "workspace-1005",
				cwd: "/elsewhere",
				status: "running",
			}),
			"workspace/.shepherd/charter.md": "# Charter\n",
		});
		try {
			const cwd = join(tree.root, "workspace");
			const result = shepherd.prepare(
				context("claude", cwd),
				fakeToolEnv({
					home: join(tree.root, "home"),
					cwd,
					alivePids: [123],
				}),
			);
			expect(result).toMatchObject({ sessionName: "workspace-1005b" });
			expect(JSON.stringify(result)).toContain(
				"- Session name: workspace-1005b (set by the launcher: use it as it stands in CURRENT.md and in messages, do not rename yourself)",
			);
		} finally {
			tree.cleanup();
		}
	});

	test("Codex index names move the suggested name to the b suffix", () => {
		const tree = makeTree({
			"home/.codex/session_index.jsonl": `${JSON.stringify({ id: "one", thread_name: "workspace-1005" })}\n`,
			"workspace/.shepherd/charter.md": "# Charter\n",
		});
		try {
			const cwd = join(tree.root, "workspace");
			const result = shepherd.prepare(
				context("codex", cwd),
				fakeToolEnv({ home: join(tree.root, "home"), cwd }),
			);
			expect(result).not.toHaveProperty("sessionName");
			expect(JSON.stringify(result)).toContain(
				"suggested workspace-1005b, then record the name the host reports",
			);
		} finally {
			tree.cleanup();
		}
	});

	test("a typed Claude name reaches the argv once and a passthrough name is not added", async () => {
		const { cwd } = build("plain");
		const typed = await preview(["-n", "forge-1002"], cwd);
		expect(typed.code).toBe(0);
		expect(typed.argv.filter((token) => token === "-n")).toHaveLength(1);
		expect(typed.argv[typed.argv.indexOf("-n") + 1]).toBe("forge-1002");
		expect(typed.systemPrompt).toContain(
			"- Session name: forge-1002 (set by the launcher: use it as it stands in CURRENT.md and in messages, do not rename yourself)",
		);

		const passthrough = await preview(["--", "-n", "tail-1002"], cwd);
		expect(passthrough.code).toBe(0);
		expect(passthrough.argv.filter((token) => token === "-n")).toHaveLength(1);
		expect(passthrough.systemPrompt).toContain(
			"- Session name: tail-1002 (given at launch: use it as it stands in CURRENT.md and in messages, do not rename yourself)",
		);
	});

	test("invalid, duplicate, resumed, and Codex names exit 2", async () => {
		const { cwd } = build("plain");
		for (const [argv, message] of [
			[["-n", "invalid"], "session name must start with a letter"],
			[
				["-n", "forge-1002", "--", "--name=other-1002"],
				"session name given twice",
			],
			[
				["-n", "forge-1002", "--", "--resume"],
				"a resumed session keeps its name",
			],
			[
				["-n", "forge-1002", "--", "--resume", "x", "--fork-session"],
				"a resumed session keeps its name",
			],
			[
				["--", "--resume", "x", "--fork-session", "-n", "forge-1002"],
				"a resumed session keeps its name",
			],
			[
				["--backend", "codex", "-n", "forge-1002", "--", "fork", "id"],
				"a resumed session keeps its name",
			],
			[
				["--backend", "codex", "-n", "forge-1002"],
				"Codex takes no session name at launch",
			],
		] as const) {
			const run = await execute([...argv], cwd);
			expect(run.code).toBe(2);
			expect(run.stderr).toContain(message);
			expect(run.records).toEqual([]);
		}
	});

	test("resumes and forks emit no Session name line, and print mode gets no name", async () => {
		const { cwd } = build("plain");
		for (const argv of [
			["--", "--resume", "x"],
			["--", "--resume", "x", "--fork-session"],
			["--backend", "codex", "--", "resume", "id"],
			["--backend", "codex", "--", "fork", "id"],
		]) {
			const envelope = await preview(argv, cwd);
			expect({ code: envelope.code, stderr: envelope.stderr }).toEqual({
				code: 0,
				stderr: "",
			});
			expect(envelope.systemPrompt).not.toMatch(/^- Session name:/m);
			expect(envelope.argv).not.toContain("-n");
			for (const token of argv.slice(argv.indexOf("--") + 1)) {
				expect(envelope.argv).toContain(token);
			}
		}

		const printed = await preview(["--print", "summary"], cwd);
		expect(printed.systemPrompt).not.toContain("- Session name:");
		expect(printed.argv).not.toContain("-n");
	});

	test("Codex suggests a name for new sessions", async () => {
		const { cwd } = build("plain");
		const envelope = await preview(["--backend", "codex"], cwd);
		expect(envelope.systemPrompt).toContain(
			"- Session name: not set (Codex takes no name at launch: name it with its rename dialog, suggested ws-1002, then record the name the host reports)",
		);
		expect(envelope.argv).not.toContain("-n");
	});

	test("an interactive launch starts in the requested --cwd with the composed prompt", async () => {
		const { cwd } = build("nested-inherited");
		const elsewhere = build("plain").cwd;
		const run = await execute(["--cwd", cwd, "hello"], elsewhere);
		expect(run.code).toBe(0);
		const [record] = run.records;
		expect(record?.cwd).toBe(cwd);
		const argv = record?.argv ?? [];
		const prompt = argv[argv.indexOf("--append-system-prompt") + 1];
		expect(prompt).toContain(`- Launch directory: ${cwd}`);
		expect(argv).not.toContain("--cwd");
		expect(argv.slice(-2)).toEqual(["--", "hello"]);
	});

	test("--resume after -- reaches the backend argv on both backends", async () => {
		const { cwd } = build("plain");
		for (const backend of BACKENDS) {
			const run = await execute(
				["--backend", backend, "hi", "--", "--resume", "abc"],
				cwd,
			);
			expect(run.code).toBe(0);
			const argv = run.records[0]?.argv ?? [];
			const at = argv.indexOf("--resume");
			expect(at).toBeGreaterThan(0);
			expect(argv[at + 1]).toBe("abc");
			expect(argv.slice(-2)).toEqual(["--", "hi"]);
		}
	});

	test("--resume and --permission-mode before -- fail as unknown flags, before prepare", () => {
		for (const flag of ["--resume", "--permission-mode"]) {
			let stderr = "";
			let prepared = false;
			const outcome = resolveCli(spec(), [flag, "x"], {
				cwd: build("plain").cwd,
				stdout: () => {},
				stderr: (chunk) => {
					stderr += chunk;
				},
				isDirectory: () => {
					prepared = true;
					return true;
				},
			});
			expect(outcome).toMatchObject({ exitCode: 2 });
			expect(stderr).toContain(`unknown option "${flag}"`);
			expect(prepared).toBe(false);
		}
	});

	// The legacy launcher read `--model haiku` as `--model true` plus a
	// positional, and let `--permission-mode default` swallow the next flag.
	test("framework --model haiku reaches the argv as haiku on both backends", async () => {
		const { cwd } = build("plain");
		const run = await execute(["--model", "haiku", "hi"], cwd);
		const argv = run.records[0]?.argv ?? [];
		expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
		expect(argv.slice(-2)).toEqual(["--", "hi"]);
		const codex = await execute(
			["--backend", "codex", "--model=haiku", "hi"],
			cwd,
		);
		const codexArgv = codex.records[0]?.argv ?? [];
		expect(codexArgv[codexArgv.indexOf("-m") + 1]).toBe("haiku");
		expect(codexArgv.slice(-2)).toEqual(["--", "hi"]);
	});

	test("-- --permission-mode default --resume x reaches the backend verbatim", async () => {
		const { cwd } = build("plain");
		const run = await execute(
			["hi", "--", "--permission-mode", "default", "--resume", "x"],
			cwd,
		);
		expect(run.code).toBe(0);
		const argv = run.records[0]?.argv ?? [];
		const at = argv.indexOf("--permission-mode");
		expect(argv.slice(at, at + 4)).toEqual([
			"--permission-mode",
			"default",
			"--resume",
			"x",
		]);
		expect(argv.filter((arg) => arg === "--permission-mode")).toHaveLength(1);
		expect(argv.slice(-2)).toEqual(["--", "hi"]);
	});

	test("the Claude launch carries no MCP config, and an inherited CLAUDE_PROJECT_DIR does not reach it", async () => {
		const { cwd } = build("nested-inherited");
		// As when Shepherd starts from inside another Claude Code session.
		const run = await execute(["hi"], cwd, {
			CLAUDE_PROJECT_DIR: join(root, "parent-session-project"),
		});
		expect(run.code).toBe(0);
		expect(run.records[0]?.argv).not.toContain("--mcp-config");
		expect(run.records).toHaveLength(1);
		expect(run.records[0]).not.toHaveProperty("claudeProjectDir");
	});

	test("FORGE_BACKEND is not read: the default backend is the first declared", async () => {
		const { cwd } = build("plain");
		const saved = process.env.FORGE_BACKEND;
		process.env.FORGE_BACKEND = "codex-cli";
		try {
			const envelope = await preview([], cwd);
			expect(envelope.text.startsWith("Backend: claude\n")).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.FORGE_BACKEND;
			else process.env.FORGE_BACKEND = saved;
		}
	});
});

describe("preview is side-effect free (D-012)", () => {
	test("every preview leaves the fixture byte-for-byte unchanged and prints only the envelope", async () => {
		for (const name of Object.keys(FIXTURE_SET)) {
			const { base, cwd } = build(name);
			for (const argv of [[], ["hi"], ["--print"]]) {
				for (const backend of BACKENDS) {
					const before = snapshotTree(base);
					const envelope = await preview([...argv, "--backend", backend], cwd);
					expect(snapshotTree(base)).toEqual(before);
					expect(envelope.code).toBe(0);
					expect(envelope.stderr).toBe("");
					expect(envelope.text.startsWith(`Backend: ${backend}\n`)).toBe(true);
				}
			}
		}
	});
});
