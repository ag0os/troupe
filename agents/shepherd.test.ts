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
const extension = { prepare: shepherd.prepare };
const BACKENDS: Backend[] = ["claude", "codex"];
const STATIC_RULES = [
	"Read(.shepherd/**)",
	"Edit(.shepherd/**)",
	"Bash(herdr:*)",
];

/**
 * The one line AC #8 changes in core.md. The legacy fixtures were captured
 * before it changed, so the comparison applies it to them and nothing else.
 */
const AC8_OLD = "recompiled via `agents/shepherd.ts`)";
const AC8_NEW = "recompiled via `agents/shepherd.md` and its extension)";

// Runs launch the fake CLIs; a loaded machine needs more than the 5s default.
setDefaultTimeout(60_000);

let agent: LoadedAgent;
let root: string;

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
	return envelope.text
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
			PATH: `${bin}:${process.env.PATH}`,
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
		cwd,
		backend,
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
		expect(agent.spec.flags).toEqual({});
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
			.replace("- Date: 2026-10-02", "- Date: <DATE>");

	for (const name of Object.keys(FIXTURE_SET)) {
		test(`${name}: the Claude prompt differs from the legacy one only at the AC #8 line`, async () => {
			const { base, cwd } = build(name);
			const envelope = await preview(["--backend", "claude"], cwd);
			expect(envelope).toMatchObject({ code: 0, stderr: "" });
			const before = legacy(`${name}.claude.prompt.txt`);
			expect(before).toContain(AC8_OLD);
			expect(normalize(envelope.systemPrompt, base)).toBe(
				before.replace(AC8_OLD, AC8_NEW),
			);
		});

		test(`${name}: the Codex prompt differs from the legacy one only at the AC #8 line`, async () => {
			const { base, cwd } = build(name);
			const envelope = await preview(["--backend", "codex"], cwd);
			expect(envelope).toMatchObject({ code: 0, stderr: "" });
			expect(normalize(envelope.systemPrompt, base)).toBe(
				legacy(`${name}.codex.prompt.txt`).replace(AC8_OLD, AC8_NEW),
			);
			expect(settingsOf(envelope.argv)).toBeUndefined();
		});

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

		expect(shepherd.prepare(context("claude", cwd))).toMatchObject({
			extraAllowRules: {
				rules: [`Read(/${shared}/**)`],
				additionalDirectories: [shared],
			},
		});
		const onCodex = shepherd.prepare(context("codex", cwd));
		expect(onCodex).not.toHaveProperty("extraAllowRules");
		expect(onCodex).toHaveProperty("systemPromptFragments");
	});

	test("Codex never receives a rule object, and Claude gets none without an enclosing workspace", () => {
		for (const name of Object.keys(FIXTURE_SET)) {
			const { cwd } = build(name);
			expect(shepherd.prepare(context("codex", cwd))).not.toHaveProperty(
				"extraAllowRules",
			);
			const enclosed = FIXTURE_SET[name]?.cwd.includes("/");
			expect(
				Object.hasOwn(
					shepherd.prepare(context("claude", cwd)),
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

describe("composition order (B-008, AC #1)", () => {
	test("core, built-ins, inherited (sorted), charter, local (sorted), header", async () => {
		const { cwd } = build("nested-local");
		const { systemPrompt } = await preview([], cwd);
		const parts = systemPrompt.split(PROMPT_SEPARATOR);
		expect(parts.slice(0, 3)).toEqual([
			text("system-prompts/shepherd/core.md"),
			text("system-prompts/shepherd/integrations/herdr.md"),
			text("system-prompts/shepherd/integrations/inter-agent.md"),
		]);
		expect(parts.slice(3, 6)).toEqual([
			"# Flock\n\nThe shared flock module.\n",
			"# Child charter\n\nBelow a directory that is not a workspace.\n",
			"# A local\n\nNot inherited, sorts before the flock module by name.\n",
		]);
		expect(parts[6]?.startsWith("# Shepherd session context\n")).toBe(true);
		expect(parts).toHaveLength(7);
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

	test("an uninitiated workspace says so and still gets core and built-ins", async () => {
		const { cwd } = build("uninitiated");
		const { systemPrompt } = await preview([], cwd);
		expect(systemPrompt).toContain(
			"- Charter: none, this workspace is uninitiated",
		);
		expect(systemPrompt).toContain(
			"- Workspace-local integrations loaded: none",
		);
		expect(systemPrompt.split(PROMPT_SEPARATOR)).toHaveLength(4);
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
			expect(header).toBe(
				[
					"# Shepherd session context",
					"",
					`- Launch directory: ${cwd}`,
					`- State directory: ${cwd}/.shepherd`,
					"- Date: 2026-10-02",
					`- Backend: ${label}`,
					"- Enclosing workspace: none",
					"- Charter: loaded",
					"- Workspace-local integrations loaded: local-a.md",
				].join("\n"),
			);
		}
	});
});

describe("core.md against the e18f56b baseline (AC #1, AC #8)", () => {
	const baseline = Bun.spawnSync(
		["git", "show", "e18f56b:system-prompts/shepherd/core.md"],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	);

	test("differs only in the source-reference line, and the Context tiers subsection is byte-identical", () => {
		expect(baseline.exitCode).toBe(0);
		const before = baseline.stdout.toString().split("\n");
		const now = text("system-prompts/shepherd/core.md").split("\n");
		expect(now).toHaveLength(before.length);
		const changed = now.flatMap((line, i) => (line === before[i] ? [] : [i]));
		expect(changed).toHaveLength(1);
		const [at] = changed;
		expect(now[at ?? 0]).toContain(AC8_NEW);
		// The same line also carries the Troupe rename (7202acf).
		expect(before[at ?? 0]).toContain(AC8_OLD);

		const tiers = (lines: string[]) => {
			const start = lines.findIndex((line) => /^#+ Context tiers/.test(line));
			const level = (lines[start]?.match(/^#+/) ?? [""])[0].length;
			const end = lines.findIndex(
				(line, i) =>
					i > start &&
					/^#+ /.test(line) &&
					(line.match(/^#+/)?.[0].length ?? 9) <= level,
			);
			return lines.slice(start, end === -1 ? undefined : end).join("\n");
		};
		expect(tiers(now).length).toBeGreaterThan(100);
		expect(tiers(now)).toBe(tiers(before));
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
});

describe("framework flags and passthrough (D-028, AC #6)", () => {
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
