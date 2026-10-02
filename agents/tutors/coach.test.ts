import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCli, resolveCli } from "../../lib/agent-format/cli";
import { installFakeClis, readRecords } from "../../lib/agent-format/fake-cli";
import { executeAgent, previewAgent } from "../../lib/agent-format/run";
import { PROMPT_SEPARATOR } from "../../lib/agent-format/schema";
import type {
	AgentSpec,
	Backend,
	PrepareContext,
} from "../../lib/agent-format/types";
import {
	compileAgent,
	generateEntry,
	type LoadedAgent,
	loadAgentDefinition,
	planBuild,
} from "../../scripts/agent-compiler";
import * as coach from "./coach";

const repo = resolve(import.meta.dir, "../..");
const SOURCE = "agents/tutors/coach.md";
const EXTENSION_FILE = join(repo, "agents/tutors/coach.ts");
const extension = { prepare: coach.prepare };
const BACKENDS: Backend[] = ["claude", "codex"];

// Runs launch the fake CLIs; a loaded machine needs more than the 5s default.
setDefaultTimeout(60_000);

let agent: LoadedAgent;
let root: string;

beforeAll(async () => {
	// The coordinator's root header carries the date: pin it (fake time).
	setSystemTime(new Date("2026-10-02T12:00:00Z"));
	agent = await loadAgentDefinition(repo, SOURCE);
	root = realpathSync(mkdtempSync(join(tmpdir(), "coach-")));
});

afterAll(() => {
	setSystemTime();
	rmSync(root, { recursive: true, force: true });
});

const spec = (): AgentSpec => agent.spec;
const text = (path: string) => readFileSync(join(repo, path), "utf8");

let counter = 0;
/** A fresh, empty training root under the test root (never the real home). */
function workspace(): string {
	const dir = join(root, `ws-${counter++}`);
	mkdirSync(dir);
	return dir;
}

function write(path: string, content: string) {
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

const LOCAL_PACK = `---
slug: go-concurrency
name: Go Concurrency
scope: Goroutines, channels, sync primitives
session: 30 min · drill / theory
allow: WebFetch, WebSearch
---

# Pack — Go Concurrency

**Axis:** Does this leak a goroutine?
`;

/**
 * An initialized root with its own student, one local pack (so the built-in
 * roster is gone), and two local integrations.
 */
function initializedWorkspace(): string {
	const dir = workspace();
	write(join(dir, ".coach/student.md"), "# The student\n\nLocal profile.\n");
	write(join(dir, ".coach/packs/go-concurrency.md"), LOCAL_PACK);
	write(join(dir, ".coach/integrations/b-local.md"), "# Local B\n\nB text\n");
	write(join(dir, ".coach/integrations/a-local.md"), "# Local A\n\nA text\n");
	return dir;
}

/** Every entry under `dir` with type, mode, size, times and content. */
function snapshotTree(dir: string): string[] {
	const out: string[] = [];
	const walk = (path: string, rel: string) => {
		const stat = lstatSync(path);
		const content = stat.isFile() ? readFileSync(path, "base64") : "";
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
		runCommand: async () => {
			throw new Error("a Coach preview runs no command");
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

/**
 * The envelope with the workspace path as `<cwd>` and the argv copy of the
 * system prompt as a marker, after checking the copy is exactly the prompt.
 */
function compact(envelope: Envelope, backend: Backend, cwd: string): string {
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
		.replaceAll(cwd, "<cwd>");
}

interface Execution {
	code: number;
	stdout: string;
	stderr: string;
	records: ReturnType<typeof readRecords>;
}

/** Execute through the runner with the fake CLIs first on PATH. */
async function execute(argv: string[], cwd: string): Promise<Execution> {
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
	args: string[] = [],
): PrepareContext {
	return {
		flags: {},
		args,
		cwd,
		backend,
		mode: "interactive",
		preview: true,
		spec: spec(),
		signal: new AbortController().signal,
		runCommand: async () => {
			throw new Error("Coach runs no command");
		},
	};
}

const BASE_RULES = ["Read(.coach/**)", "Write(.coach/**)", "Edit(.coach/**)"];

describe("declaration paired with its extension (D-001, D-015, AC #3)", () => {
	test("tutors:coach is a dual-backend declaration whose same-stem .ts is its prepare extension", () => {
		expect(agent.file).toBe(SOURCE);
		expect(agent.spec.id).toBe("tutors:coach");
		expect(agent.extension).toEqual({
			file: EXTENSION_FILE,
			exports: ["prepare"],
		});
		expect(agent.spec.backends).toEqual(["claude", "codex"]);
		expect(agent.spec.promptMode).toBe("append");
		expect(agent.spec.mode).toBe("interactive");
		// Composition is all runtime: no static body, no includes.
		expect(agent.spec.systemPrompt).toBe("");
		expect(Object.keys(agent.spec.flags).sort()).toEqual(["init", "list"]);
	});

	test("mixed mode builds the pair as declaration plus extension, never the hook as entry", async () => {
		const plan = await planBuild({ root: repo, mode: "mixed" });
		const entries = plan.entries.filter((entry) => entry.id === "tutors:coach");
		expect(entries).toHaveLength(1);
		const [entry] = entries;
		expect(entry?.kind).toBe("declaration");
		expect(entry?.source).toBe(SOURCE);
		if (entry?.kind !== "declaration") return;
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
		const cwd = workspace();
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

describe("--show-prompt envelopes (B-003, AC #5)", () => {
	for (const backend of BACKENDS) {
		test(`fresh root, coordinator, on ${backend}`, async () => {
			const cwd = workspace();
			const envelope = await preview(["--backend", backend], cwd);
			expect(envelope.code).toBe(0);
			expect(compact(envelope, backend, cwd)).toMatchSnapshot();
		});

		test(`fresh root, rails with a message, on ${backend}`, async () => {
			const cwd = workspace();
			const envelope = await preview(
				["rails", "review", "my", "migration", "--backend", backend],
				cwd,
			);
			expect(envelope.code).toBe(0);
			expect(envelope.initialPrompt).toBe("review my migration");
			expect(compact(envelope, backend, cwd)).toMatchSnapshot();
		});

		test(`initialized root, coordinator, on ${backend}`, async () => {
			const cwd = initializedWorkspace();
			const envelope = await preview(["--backend", backend], cwd);
			expect(envelope.code).toBe(0);
			expect(compact(envelope, backend, cwd)).toMatchSnapshot();
		});

		test(`initialized root, local subject, on ${backend}`, async () => {
			const cwd = initializedWorkspace();
			const envelope = await preview(
				["go-concurrency", "--backend", backend],
				cwd,
			);
			expect(envelope.code).toBe(0);
			expect(compact(envelope, backend, cwd)).toMatchSnapshot();
		});
	}
});

describe("nested workspace (AC #2)", () => {
	test("a Codex preview of a nested directory shows its own prompt and cwd, with no rule error", async () => {
		const parent = initializedWorkspace();
		const cwd = join(parent, "sub", "dir");
		mkdirSync(cwd, { recursive: true });
		const envelope = await preview(["--backend", "codex"], cwd);
		expect({ code: envelope.code, stderr: envelope.stderr }).toEqual({
			code: 0,
			stderr: "",
		});
		// Coach does not walk up to an enclosing `.coach/`, as today: the nested
		// directory is its own training root, with the built-in roster and the
		// scaffold student, and nothing from the parent.
		expect(envelope.systemPrompt).toContain(`- Root: \`${cwd}\``);
		expect(envelope.systemPrompt).toContain("No `.coach/student.md` exists");
		expect(envelope.systemPrompt).toContain("`tutors:coach rails`");
		expect(envelope.systemPrompt).not.toContain("Local profile.");
		expect(envelope.systemPrompt).not.toContain("go-concurrency");
		expect(envelope.systemPrompt).not.toContain("Local A");
		expect(envelope.argv.some((arg) => arg.includes("--settings"))).toBe(false);
		expect(compact(envelope, "codex", parent)).toMatchSnapshot();
	});

	test("the same nested directory on Claude carries the rules", async () => {
		const parent = initializedWorkspace();
		const cwd = join(parent, "sub");
		mkdirSync(cwd);
		const envelope = await preview(["--backend", "claude"], cwd);
		expect(envelope.code).toBe(0);
		expect(envelope.argv).toContain(
			JSON.stringify({
				permissions: { allow: [...BASE_RULES, "Bash(herdr:*)"] },
			}),
		);
	});
});

describe("dynamic rules are Claude-only (D-016, AC #1, AC #2)", () => {
	test("Claude gets .coach/ rules plus the pack's allow, or herdr for the coordinator", async () => {
		const cwd = initializedWorkspace();
		expect(
			coach.prepare(context("claude", cwd, ["go-concurrency"])),
		).toMatchObject({
			extraAllowRules: { rules: [...BASE_RULES, "WebFetch", "WebSearch"] },
		});
		expect(coach.prepare(context("claude", cwd))).toMatchObject({
			extraAllowRules: { rules: [...BASE_RULES, "Bash(herdr:*)"] },
		});
		const fresh = workspace();
		expect(coach.prepare(context("claude", fresh, ["rails"]))).toMatchObject({
			extraAllowRules: { rules: BASE_RULES },
		});
	});

	test("Codex never receives a rule object, for any root or subject", async () => {
		const cwd = initializedWorkspace();
		for (const args of [[], ["go-concurrency"], ["plan my week"]]) {
			const result = coach.prepare(context("codex", cwd, args));
			expect(result).not.toHaveProperty("extraAllowRules");
			expect(result).toHaveProperty("systemPromptFragments");
		}
	});

	test("the Codex argv has no settings or rules at all", async () => {
		const cwd = initializedWorkspace();
		const envelope = await preview(
			["go-concurrency", "--backend", "codex"],
			cwd,
		);
		expect(envelope.argv).toEqual([
			"codex",
			"-c",
			`developer_instructions=${JSON.stringify(envelope.systemPrompt)}`,
		]);
	});
});

describe("composition matches the legacy launcher (AC #1)", () => {
	test("subject order: student, core, roster, subject section", async () => {
		const cwd = workspace();
		const { systemPrompt } = await preview(["rails"], cwd);
		const parts = systemPrompt.split(PROMPT_SEPARATOR);
		expect(
			parts[0]?.startsWith(text("system-prompts/coach/student.md").trim()),
		).toBe(true);
		expect(parts[0]).toContain("No `.coach/student.md` exists");
		expect(systemPrompt).toContain(
			`${PROMPT_SEPARATOR}${text("system-prompts/coach/core.md")}${PROMPT_SEPARATOR}# The roster`,
		);
		expect(systemPrompt).toContain(
			"# This session's subject\n\nSlug: `rails` — your state directory is `.coach/rails/`.",
		);
		expect(systemPrompt).not.toContain(
			text("system-prompts/coach/coordinator.md"),
		);
		expect(systemPrompt).not.toContain("# This training root");
	});

	test("coordinator order: student, roster, coordinator, herdr, sorted locals, root header", async () => {
		const cwd = initializedWorkspace();
		const { systemPrompt } = await preview([], cwd);
		const order = [
			"# The student\n\nLocal profile.",
			"# The roster",
			text("system-prompts/coach/coordinator.md"),
			text("system-prompts/coach/integrations/herdr.md"),
			"# Local A",
			"# Local B",
			"# This training root",
		].map((part) => systemPrompt.indexOf(part));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(systemPrompt).toContain(
			"- Local integrations loaded: a-local.md, b-local.md",
		);
		expect(systemPrompt).toContain("- Date: 2026-10-02");
		expect(systemPrompt).toContain(
			`append \`--cwd ${cwd}\` unless they will already be in that directory.`,
		);
		expect(systemPrompt).toContain(
			"_This profile is `.coach/student.md` in the training root.",
		);
	});

	test("a root with .coach/packs/ owns its roster; an empty one falls back to the built-ins", async () => {
		const owned = initializedWorkspace();
		const { systemPrompt } = await preview([], owned);
		expect(systemPrompt).toContain(
			"| `tutors:coach go-concurrency` | Go Concurrency *(local)* |",
		);
		expect(systemPrompt).not.toContain("`tutors:coach rails`");

		const halfMade = workspace();
		mkdirSync(join(halfMade, ".coach/packs"), { recursive: true });
		const fallback = await preview([], halfMade);
		expect(fallback.systemPrompt).toContain("`tutors:coach rails`");
	});

	test("a non-slug message goes to the coordinator as its initial prompt", async () => {
		const cwd = workspace();
		const envelope = await preview(["plan my week"], cwd);
		expect(envelope.code).toBe(0);
		expect(envelope.initialPrompt).toBe("plan my week");
		expect(envelope.systemPrompt).toContain("# This training root");
	});
});

describe("init and list (D-012, D-030)", () => {
	test("--init seeds the root and reports on stdout with code 0, keeping what exists", async () => {
		const cwd = workspace();
		const first = await execute(["--init"], cwd);
		expect(first).toMatchObject({ code: 0, stderr: "", records: [] });
		expect(first.stdout).toBe(
			`Seeded ${cwd}/.coach\n\n  student.md   written\n  packs written  coding, data-modeling, rails, system-design, testing, ts-react\n\nThis directory is now the roster. Delete a pack file to retire the subject;\nadd one to create a subject. No recompile either way.\n`,
		);
		expect(readdirSync(join(cwd, ".coach/packs")).sort()).toEqual([
			"coding.md",
			"data-modeling.md",
			"rails.md",
			"system-design.md",
			"testing.md",
			"ts-react.md",
		]);
		expect(readFileSync(join(cwd, ".coach/packs/rails.md"), "utf8")).toBe(
			text("system-prompts/coach/packs/rails.md"),
		);
		expect(readFileSync(join(cwd, ".coach/student.md"), "utf8")).toBe(
			text("system-prompts/coach/student.md"),
		);

		const second = await execute(["--init"], cwd);
		expect(second.stdout).toContain("  student.md   kept (already present)");
		expect(second.stdout).toContain(
			"  packs kept     coding, data-modeling, rails, system-design, testing, ts-react",
		);
	});

	test("--init wins over --list and a subject, as today", async () => {
		const cwd = workspace();
		const run = await execute(["rails", "--list", "--init"], cwd);
		expect(run.stdout.startsWith(`Seeded ${cwd}/.coach`)).toBe(true);
	});

	test("--list prints the roster on stdout with code 0 and launches nothing", async () => {
		const cwd = initializedWorkspace();
		const run = await execute(["--list"], cwd);
		expect(run).toMatchObject({ code: 0, stderr: "", records: [] });
		expect(run.stdout).toBe(
			`Subjects:\n\n  tutors:coach go-concurrency  Go Concurrency (local)\n  ${" ".repeat(29)}Goroutines, channels, sync primitives\n\nRun \`tutors:coach\` with no subject to plan a session.\n`,
		);
	});

	test("an unknown subject is a stderr early exit with code 1 carrying the roster", async () => {
		const cwd = workspace();
		const run = await execute(["bogus"], cwd);
		expect(run).toMatchObject({ code: 1, stdout: "", records: [] });
		expect(
			run.stderr.startsWith("Unknown subject: bogus\n\nSubjects:\n\n"),
		).toBe(true);
		expect(run.stderr).toContain("  tutors:coach rails");
	});

	test("previewing --init is a stderr diagnostic with exit 1 and leaves the root byte-for-byte unchanged", async () => {
		for (const cwd of [workspace(), initializedWorkspace()]) {
			const before = snapshotTree(cwd);
			const envelope = await preview(["--init"], cwd);
			expect(envelope).toMatchObject({ code: 1, text: "" });
			expect(envelope.stderr).toContain("--init seeds");
			expect(snapshotTree(cwd)).toEqual(before);
		}
	});

	test("previewing --list is a stderr diagnostic with exit 1 carrying the roster", async () => {
		const cwd = workspace();
		const envelope = await preview(["--list"], cwd);
		expect(envelope).toMatchObject({ code: 1, text: "" });
		expect(envelope.stderr).toContain("Subjects:");
	});
});

describe("preview is side-effect free (D-012)", () => {
	test("every preview leaves the workspace byte-for-byte unchanged and prints only the envelope", async () => {
		for (const cwd of [workspace(), initializedWorkspace()]) {
			for (const argv of [[], ["rails"], ["go-concurrency"], ["bogus"]]) {
				for (const backend of BACKENDS) {
					const before = snapshotTree(cwd);
					const envelope = await preview([...argv, "--backend", backend], cwd);
					expect(snapshotTree(cwd)).toEqual(before);
					if (envelope.code === 0) {
						expect(envelope.stderr).toBe("");
						expect(envelope.text.startsWith(`Backend: ${backend}\n`)).toBe(
							true,
						);
					}
				}
			}
		}
	});
});

describe("framework flags and passthrough (D-028, AC #4, AC #6)", () => {
	test.each([
		["--resume", "abc"],
		["--permission-mode", "plan"],
	])(
		"%s after -- reaches the backend argv on both backends",
		async (flag, value) => {
			const cwd = workspace();
			for (const backend of BACKENDS) {
				const run = await execute(
					["rails", "hi", "--backend", backend, "--", flag, value],
					cwd,
				);
				expect(run.code).toBe(0);
				const [record] = run.records;
				expect(record?.cwd).toBe(cwd);
				const argv = record?.argv ?? [];
				const at = argv.indexOf(flag);
				expect(at).toBeGreaterThan(0);
				expect(argv[at + 1]).toBe(value);
				expect(argv.slice(-2)).toEqual(["--", "hi"]);
			}
		},
	);

	test("--resume and --permission-mode before -- fail as unknown flags, before prepare", () => {
		for (const flag of ["--resume", "--permission-mode"]) {
			let stderr = "";
			const outcome = resolveCli(spec(), ["rails", flag, "x"], {
				cwd: workspace(),
				stdout: () => {},
				stderr: (chunk) => {
					stderr += chunk;
				},
				isDirectory: () => true,
			});
			expect(outcome).toMatchObject({ exitCode: 2 });
			expect(stderr).toContain(`unknown option "${flag}"`);
		}
	});

	test("--cwd picks the training root and never reaches prepare's flags or the backend", async () => {
		const target = initializedWorkspace();
		const elsewhere = workspace();
		let seen: PrepareContext | undefined;
		const outcome = parseCli(
			spec(),
			["--cwd", target, "go-concurrency", "--show-prompt"],
			{ cwd: elsewhere },
		);
		if (outcome.kind !== "run") throw new Error("unexpected help");
		let out = "";
		const code = await previewAgent(
			spec(),
			{
				prepare: (ctx) => {
					seen = ctx;
					return coach.prepare(ctx);
				},
			},
			outcome.invocation,
			{
				stdout: (chunk) => {
					out += chunk;
				},
				stderr: () => {},
				isDirectory: () => true,
			},
		);
		expect(code).toBe(0);
		expect(seen?.cwd).toBe(target);
		expect(Object.keys(seen?.flags ?? {}).sort()).toEqual(["init", "list"]);
		expect(out).toContain("Go Concurrency");
		expect(out).not.toContain('--cwd"');
		expect(out).not.toContain("--show-prompt");
	});

	test("a missing --cwd is the framework's error, before prepare", () => {
		let stderr = "";
		const outcome = resolveCli(
			spec(),
			["--cwd", join(root, "missing"), "--show-prompt"],
			{
				cwd: workspace(),
				stdout: () => {},
				stderr: (chunk) => {
					stderr += chunk;
				},
				isDirectory: () => "missing",
			},
		);
		expect(outcome).toMatchObject({ exitCode: 2 });
		expect(stderr).toContain("tutors:coach: working directory");
	});
});

describe("compiled binary (B-003, AC #3)", () => {
	test("builds into a temp file and previews on both backends from a temp workspace", async () => {
		const outDir = join(root, `binary-${counter++}`);
		mkdirSync(outDir);
		const outFile = join(outDir, "tutors:coach");
		await compileAgent({ root: repo, file: SOURCE, outFile });

		const cwd = initializedWorkspace();
		const before = snapshotTree(cwd);
		const help = Bun.spawnSync([outFile, "--help"], { cwd });
		expect(help.exitCode).toBe(0);
		expect(help.stdout.toString()).toContain("--init");
		for (const backend of BACKENDS) {
			const child = Bun.spawnSync(
				[outFile, "go-concurrency", "--backend", backend, "--show-prompt"],
				{ cwd, stdout: "pipe", stderr: "pipe" },
			);
			expect(child.exitCode).toBe(0);
			expect(child.stderr.toString()).toBe("");
			const out = child.stdout.toString();
			expect(out.startsWith(`Backend: ${backend}\n`)).toBe(true);
			expect(out).toContain(text("system-prompts/coach/core.md"));
			expect(out).toContain("# This session's subject");
		}
		expect(snapshotTree(cwd)).toEqual(before);
	});
});

describe("pack frontmatter edge cases (AC #4: Coach's own content contract)", () => {
	test("a CRLF pack parses: roster row, subject body and allow rules", async () => {
		const cwd = workspace();
		write(
			join(cwd, ".coach/packs/crlf.md"),
			LOCAL_PACK.replace("slug: go-concurrency", "slug: crlf").replaceAll(
				"\n",
				"\r\n",
			),
		);
		const envelope = await preview(["crlf"], cwd);
		expect(envelope.code).toBe(0);
		expect(envelope.systemPrompt).toContain(
			"| `tutors:coach crlf` | Go Concurrency *(local)* | Goroutines, channels, sync primitives | 30 min · drill / theory |",
		);
		expect(envelope.systemPrompt).toContain(
			"Slug: `crlf` — your state directory is `.coach/crlf/`.\n\n# Pack — Go Concurrency",
		);
		expect(coach.prepare(context("claude", cwd, ["crlf"]))).toMatchObject({
			extraAllowRules: { rules: [...BASE_RULES, "WebFetch", "WebSearch"] },
		});
	});

	test("two workspace files with one slug: the later file in directory order wins, as today", async () => {
		const cwd = workspace();
		const pack = (name: string) =>
			`---\nslug: dup\nname: ${name}\n---\n\n# ${name} body\n`;
		write(join(cwd, ".coach/packs/aa-dup.md"), pack("First"));
		write(join(cwd, ".coach/packs/zz-dup.md"), pack("Second"));
		const envelope = await preview(["dup"], cwd);
		expect(envelope.code).toBe(0);
		const later = readdirSync(join(cwd, ".coach/packs")).at(-1);
		const winner = later === "zz-dup.md" ? "Second" : "First";
		expect(envelope.systemPrompt).toContain(
			`| \`tutors:coach dup\` | ${winner} *(local)* |`,
		);
		expect(envelope.systemPrompt).toContain(`# ${winner} body`);
		expect(envelope.systemPrompt.match(/`tutors:coach dup`/g)).toHaveLength(1);
	});

	test("a workspace pack replaces the built-in with the same slug", async () => {
		const cwd = workspace();
		write(
			join(cwd, ".coach/packs/rails.md"),
			"---\nslug: rails\nname: My Rails\nscope: Local scope\n---\n\n# Local rails body\n",
		);
		const envelope = await preview(["rails"], cwd);
		expect(envelope.code).toBe(0);
		expect(envelope.systemPrompt).toContain(
			"| `tutors:coach rails` | My Rails *(local)* | Local scope |  |",
		);
		expect(envelope.systemPrompt).toContain("# Local rails body");
		expect(envelope.systemPrompt).not.toContain(
			text("system-prompts/coach/packs/rails.md").split("---").at(-1)?.trim() ??
				"",
		);
	});

	test("files without frontmatter or slug are skipped; if nothing is left, the built-ins return", async () => {
		const cwd = workspace();
		write(join(cwd, ".coach/packs/plain.md"), "# No frontmatter\n");
		write(
			join(cwd, ".coach/packs/noslug.md"),
			"---\nname: No slug\n---\nBody\n",
		);
		const envelope = await preview([], cwd);
		expect(envelope.systemPrompt).toContain("`tutors:coach rails`");
		expect(envelope.systemPrompt).not.toContain("No slug");
	});
});

describe("--cwd forms (AC #6)", () => {
	test.each([
		["relative", (base: string) => ["sub", join(base, "sub")]],
		[
			"with a space",
			(base: string) => ["with space", join(base, "with space")],
		],
		["through a symlink", (base: string) => ["link", join(base, "link")]],
	])(
		"%s: the root is the resolved path, not its realpath, as today",
		async (kind, paths) => {
			const base = workspace();
			mkdirSync(join(base, "sub"));
			mkdirSync(join(base, "with space"));
			symlinkSync(join(base, "sub"), join(base, "link"));
			const [arg, expected] = paths(base);
			const outcome = parseCli(spec(), ["--cwd", arg ?? "", "--show-prompt"], {
				cwd: base,
			});
			if (outcome.kind !== "run") throw new Error("unexpected help");
			let out = "";
			const code = await previewAgent(spec(), extension, outcome.invocation, {
				stdout: (chunk) => {
					out += chunk;
				},
				stderr: () => {},
				isDirectory: () => true,
			});
			expect({ kind, code }).toEqual({ kind, code: 0 });
			expect(out).toContain(`- Root: \`${expected}\``);
			expect(out).toContain(`append \`--cwd ${expected}\``);
		},
	);
});

describe("unreadable persisted state warns on execution only (D-012)", () => {
	/** A root whose pack, student and integrations directory cannot be read. */
	function unreadableWorkspace() {
		const cwd = workspace();
		write(
			join(cwd, ".coach/packs/ok.md"),
			"---\nslug: ok\nname: Ok\n---\nBody\n",
		);
		write(
			join(cwd, ".coach/packs/locked.md"),
			"---\nslug: locked\n---\nBody\n",
		);
		write(join(cwd, ".coach/student.md"), "# Locked student\n");
		write(join(cwd, ".coach/integrations/x.md"), "# X\n");
		const locked = [
			join(cwd, ".coach/packs/locked.md"),
			join(cwd, ".coach/student.md"),
			join(cwd, ".coach/integrations"),
		];
		for (const path of locked) chmodSync(path, 0o000);
		const unlock = () => {
			chmodSync(locked[0] ?? "", 0o644);
			chmodSync(locked[1] ?? "", 0o644);
			chmodSync(locked[2] ?? "", 0o755);
		};
		return { cwd, unlock };
	}

	test("execution warns through console.warn (stderr) and still launches with the fallbacks", async () => {
		const { cwd, unlock } = unreadableWorkspace();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const run = await execute([], cwd);
			expect(run.code).toBe(0);
			expect(run.records).toHaveLength(1);
			const messages = warn.mock.calls.map((call) => String(call[0]));
			expect(messages).toHaveLength(3);
			expect(messages[0]).toStartWith("Skipping unreadable pack locked.md: ");
			expect(messages[1]).toStartWith(
				"Falling back to the built-in student scaffold: ",
			);
			expect(messages[2]).toStartWith(
				"Skipping unreadable integrations directory: ",
			);
			const argv = run.records[0]?.argv ?? [];
			const prompt = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
			expect(prompt).toContain("No `.coach/student.md` exists");
			expect(prompt).toContain("- Local integrations loaded: none");
			expect(prompt).toContain("`tutors:coach ok`");
		} finally {
			warn.mockRestore();
			unlock();
		}
	});

	test("preview shows the same fallbacks and warns nothing", async () => {
		const { cwd, unlock } = unreadableWorkspace();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const envelope = await preview([], cwd);
			expect(envelope).toMatchObject({ code: 0, stderr: "" });
			expect(warn).not.toHaveBeenCalled();
			expect(envelope.systemPrompt).toContain("No `.coach/student.md` exists");
			expect(envelope.systemPrompt).toContain(
				"- Local integrations loaded: none",
			);
		} finally {
			warn.mockRestore();
			unlock();
		}
	});
});
