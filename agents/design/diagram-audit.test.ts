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
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCli } from "../../lib/agent-format/cli";
import { installFakeClis, readRecords } from "../../lib/agent-format/fake-cli";
import {
	type AgentExtension,
	executeAgent,
	previewAgent,
} from "../../lib/agent-format/run";
import type { AgentSpec, Backend } from "../../lib/agent-format/types";
import {
	compileAgent,
	generateEntry,
	inspectExtension,
	type LoadedAgent,
	loadAgentDefinition,
	planBuild,
} from "../../scripts/agent-compiler";
import * as audit from "./audit";
import * as all from "./diagram/all";
import * as consolidate from "./diagram/consolidate";
import * as topic from "./diagram/topic";

const repo = resolve(import.meta.dir, "../..");

// Several tests launch the fake CLIs once per agent; a loaded machine needs
// more than the 5s default, and a timed-out run leaks into the next test.
setDefaultTimeout(60_000);

interface Subject {
	source: string;
	extension: AgentExtension;
	/** Positionals used for the envelopes and runs. */
	args: string[];
	/** Output directory relative to the cwd. */
	outputDir: string;
	/** Today's banners, with `<cwd>` for the project. */
	before: string[];
	after: string[];
}

const SUBJECTS: Record<string, Subject> = {
	"design:audit": {
		source: "agents/design/audit.md",
		extension: { prepare: audit.prepare },
		args: ["hello world"],
		outputDir: "ai/design-audit",
		before: [
			"✅ Created/verified directory: <cwd>/ai/design-audit",
			"🔎 Starting design system audit...",
			"📁 Project: <cwd>",
			"🗂️  Output: <cwd>/ai/design-audit",
		],
		after: [
			"\n✨ Design audit complete!",
			"📁 Reports saved to: <cwd>/ai/design-audit",
		],
	},
	"design:diagram:all": {
		source: "agents/design/diagram/all.md",
		extension: { prepare: all.prepare },
		args: ["hello world"],
		outputDir: "ai/diagrams",
		before: [
			"✅ Created/verified directory: <cwd>/ai/diagrams",
			"🔍 Starting project-wide diagram generation...",
			"📁 Target project: <cwd>",
			"📊 Diagrams will be saved to: <cwd>/ai/diagrams",
		],
		after: [
			"\n✨ Event flow diagram generation complete!",
			"📁 Diagrams saved to: <cwd>/ai/diagrams",
		],
	},
	"design:diagram:consolidate": {
		source: "agents/design/diagram/consolidate.md",
		extension: { prepare: consolidate.prepare },
		args: ["hello world"],
		outputDir: "ai/diagrams",
		before: [
			"✅ Created/verified directory: <cwd>/ai/diagrams",
			"🧹 Starting diagram consolidation...",
			"📁 Diagrams root: <cwd>/ai/diagrams",
			"📦 Consolidated output: <cwd>/ai/diagrams",
		],
		after: [
			"\n✨ Consolidation complete!",
			"📁 Consolidated diagrams saved to: <cwd>/ai/diagrams",
		],
	},
	"design:diagram:topic": {
		source: "agents/design/diagram/topic.md",
		extension: { prepare: topic.prepare },
		args: ["Auth Login", "extra words"],
		outputDir: "ai/diagrams",
		before: [
			"✅ Created/verified directory: <cwd>/ai/diagrams",
			"🎯 Starting topic-focused diagram generation...",
			"🏷️ Topic: Auth Login (slug: auth-login)",
			"📁 Target project: <cwd>",
			"📊 Diagrams will be saved to: <cwd>/ai/diagrams",
		],
		after: [
			"\n✨ Topic-focused diagram generation complete!",
			"📁 Diagrams saved to: <cwd>/ai/diagrams",
		],
	},
};

const IDS = Object.keys(SUBJECTS);
const BACKENDS: Backend[] = ["claude", "codex"];

const agents = new Map<string, LoadedAgent>();
let root: string;

beforeAll(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "diagram-audit-")));
	for (const [id, subject] of Object.entries(SUBJECTS)) {
		agents.set(id, await loadAgentDefinition(repo, subject.source));
	}
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function subject(id: string): Subject {
	const found = SUBJECTS[id];
	if (!found) throw new Error(`${id} is not a subject`);
	return found;
}

function spec(id: string): AgentSpec {
	const agent = agents.get(id);
	if (!agent) throw new Error(`${id} not loaded`);
	return agent.spec;
}

let counter = 0;
/** A fresh, empty workspace directory under the test root. */
function workspace(): string {
	const dir = join(root, `ws-${counter++}`);
	mkdirSync(dir);
	return dir;
}

/** Every entry under `dir` with type, mode, size and mtime, for byte-level comparisons. */
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

const withCwd = (lines: string[], cwd: string) =>
	lines.map((line) => line.replaceAll("<cwd>", cwd));

interface Envelope {
	text: string;
	stderr: string;
	code: number;
	systemPrompt: string;
	initialPrompt: string;
	argv: string[];
}

/** `--show-prompt` through the runner's preview; preparation may run no command. */
async function preview(
	id: string,
	argv: string[],
	cwd: string,
): Promise<Envelope> {
	const outcome = parseCli(spec(id), argv, { cwd });
	if (outcome.kind !== "run") throw new Error("unexpected help");
	let text = "";
	let stderr = "";
	const code = await previewAgent(
		spec(id),
		subject(id).extension,
		outcome.invocation,
		{
			stdout: (chunk) => {
				text += chunk;
			},
			stderr: (chunk) => {
				stderr += chunk;
			},
			isDirectory: () => true,
			runCommand: async () => {
				throw new Error("preview of a diagram or audit agent runs no command");
			},
		},
	);
	const match =
		/^Backend: \w+\n--- System prompt ---\n([\s\S]*)\n--- Initial prompt ---\n([\s\S]*)\n--- Argv ---\n(.*)\n$/.exec(
			text,
		);
	return {
		text,
		stderr,
		code,
		systemPrompt: match?.[1] ?? "",
		initialPrompt: match?.[2] ?? "",
		argv: match ? JSON.parse(match[3] ?? "[]") : [],
	};
}

/**
 * The envelope with the workspace path replaced by `<cwd>` and the argv copy
 * of the system prompt replaced by a marker, after checking that the copy is
 * exactly the previewed prompt on that backend's transport.
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
	expect(argv).toContain(
		backend === "claude" ? marker : `developer_instructions=${marker}`,
	);
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
	/** Runner writes in order, each tagged with whether the backend had launched. */
	writes: { stream: "stdout" | "stderr"; text: string; launched: boolean }[];
	records: ReturnType<typeof readRecords>;
}

/** Execute through the runner with the fake CLIs first on PATH. */
async function execute(
	id: string,
	argv: string[],
	cwd: string,
	scenario = "ok",
): Promise<Execution> {
	const base = join(root, `run-${counter++}`);
	const bin = join(base, "bin");
	const tmp = join(base, "tmp");
	mkdirSync(bin, { recursive: true });
	mkdirSync(tmp);
	installFakeClis(bin);
	const recordFile = join(base, "records.jsonl");
	const outcome = parseCli(spec(id), argv, { cwd });
	if (outcome.kind !== "run") throw new Error("unexpected help");
	const result: Execution = {
		code: 0,
		stdout: "",
		stderr: "",
		writes: [],
		records: [],
	};
	const write = (stream: "stdout" | "stderr") => (text: string) => {
		result[stream] += text;
		result.writes.push({ stream, text, launched: existsSync(recordFile) });
	};
	result.code = await executeAgent(
		spec(id),
		subject(id).extension,
		outcome.invocation,
		{
			stdout: write("stdout"),
			stderr: write("stderr"),
			isDirectory: (path) => existsSync(path) || "missing",
			env: {
				PATH: `${bin}:${process.env.PATH}`,
				HOME: process.env.HOME,
				FAKE_RECORD: recordFile,
				FAKE_SCENARIO: scenario,
			},
			tmpRoot: tmp,
		},
	);
	result.records = readRecords(recordFile);
	expect(readdirSync(tmp)).toEqual([]);
	return result;
}

describe("declarations paired with extensions (D-001, D-015)", () => {
	test("each of the four is a path-named declaration whose same-stem .ts is its prepare extension", () => {
		for (const [id, { source }] of Object.entries(SUBJECTS)) {
			const agent = agents.get(id);
			expect(agent?.file).toBe(source);
			expect(agent?.spec.id).toBe(id);
			expect(agent?.extension).toEqual({
				file: join(repo, source.replace(/\.md$/, ".ts")),
				exports: ["prepare"],
			});
			expect(agent?.spec.backends).toEqual(["claude", "codex"]);
			expect(agent?.spec.promptMode).toBe("append");
			expect(agent?.spec.mode).toBe("interactive");
		}
	});

	test("builds each pair as declaration plus extension, never the hook as entry", async () => {
		const plan = await planBuild({ root: repo });
		for (const [id, { source }] of Object.entries(SUBJECTS)) {
			const entries = plan.entries.filter((entry) => entry.id === id);
			expect(entries).toHaveLength(1);
			const [entry] = entries;
			expect(entry?.source).toBe(source);
			if (!entry) continue;
			const extensionFile = join(repo, source.replace(/\.md$/, ".ts"));
			expect(entry.agent.extension?.file).toBe(extensionFile);
			const generated = generateEntry(entry.agent);
			expect(generated).toContain(
				`import { prepare } from ${JSON.stringify(extensionFile)};`,
			);
			expect(generated).toContain("const extension = { prepare };");
		}
	});

	test("each extension passes the static side-effect inspection with no problems", () => {
		for (const { source } of Object.values(SUBJECTS)) {
			const file = source.replace(/\.md$/, ".ts");
			const inspection = inspectExtension(
				file,
				readFileSync(join(repo, file), "utf8"),
			);
			expect({
				file,
				exportProblems: inspection.exportProblems,
				sideEffects: inspection.sideEffects,
			}).toEqual({ file, exportProblems: [], sideEffects: [] });
			expect(inspection.exports).toEqual(["prepare"]);
		}
	});

	test("importing each extension spawns no process, writes nothing and does not exit", () => {
		for (const { source } of Object.values(SUBJECTS)) {
			const cwd = workspace();
			const base = join(root, `import-${counter++}`);
			const bin = join(base, "bin");
			mkdirSync(bin, { recursive: true });
			installFakeClis(bin);
			const recordFile = join(base, "records.jsonl");
			const file = join(repo, source.replace(/\.md$/, ".ts"));
			const child = Bun.spawnSync(
				[
					process.execPath,
					"-e",
					`const mod = await import(${JSON.stringify(file)}); console.log("imported", Object.keys(mod).sort().join(","));`,
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
			const exports =
				source === "agents/design/diagram/topic.md"
					? "prepare,slugify"
					: "prepare";
			expect({
				source,
				code: child.exitCode,
				stdout: child.stdout.toString(),
				stderr: child.stderr.toString(),
			}).toEqual({
				source,
				code: 0,
				stdout: `imported ${exports}\n`,
				stderr: "",
			});
			expect(existsSync(recordFile)).toBe(false);
			expect(readdirSync(cwd)).toEqual([]);
		}
	});
});

describe("--show-prompt envelopes per declared backend (B-003)", () => {
	for (const id of IDS) {
		for (const backend of BACKENDS) {
			test(`${id} on ${backend}`, async () => {
				const cwd = workspace();
				const envelope = await preview(
					id,
					["--backend", backend, ...subject(id).args],
					cwd,
				);
				expect(envelope.stderr).toBe("");
				expect(envelope.code).toBe(0);
				expect(envelope.text.startsWith(`Backend: ${backend}\n`)).toBe(true);
				expect(envelope.argv[0]).toBe(backend);
				expect(envelope.systemPrompt).toBe(spec(id).systemPrompt);
				expect(envelope.argv.slice(-2)).toEqual(["--", envelope.initialPrompt]);
				expect(compact(envelope, backend, cwd)).toMatchSnapshot();
			});
		}
	}

	test("the initial prompts are today's text, with and without arguments", async () => {
		const cwd = workspace();
		const prompt = async (id: string, args: string[]) =>
			(await preview(id, args, cwd)).initialPrompt;
		expect(await prompt("design:audit", ["auth", "marketing"])).toEndWith(
			`3. Write ONLY into ${cwd}/ai/design-audit following the system prompt's output contract.\n4. Prioritize focus areas: auth, marketing.`,
		);
		expect(await prompt("design:audit", [])).toEndWith(
			`3. Write ONLY into ${cwd}/ai/design-audit following the system prompt's output contract.`,
		);
		expect(await prompt("design:diagram:all", ["auth", "flows"])).toContain(
			"own diagram\n\n\nFocus Area (optional filter): auth flows\n\nStart by scanning",
		);
		expect(await prompt("design:diagram:all", [])).toContain(
			"own diagram\n\n\nAnalyze ALL flows comprehensively\n\nStart by scanning",
		);
		expect(await prompt("design:diagram:consolidate", ["a", "b"])).toContain(
			"\n\nScope filters: a b\n\n",
		);
		expect(await prompt("design:diagram:consolidate", [])).toContain(
			"\n\nScope filters: (none)\n\n",
		);
		expect(await prompt("design:diagram:topic", ["Payments"])).toStartWith(
			`Analyze the codebase at ${cwd} and generate event flow diagrams ONLY for the specified topic.\n\nTopic: Payments\n\n\nTarget output directory: ${cwd}/ai/diagrams\n`,
		);
	});
});

describe("preview is side-effect free (D-012, AC #3)", () => {
	test("previewing leaves the workspace byte-for-byte unchanged and prints only the envelope", async () => {
		for (const id of IDS) {
			for (const backend of BACKENDS) {
				const cwd = workspace();
				writeFileSync(join(cwd, "keep.txt"), "untouched\n");
				const before = snapshotTree(cwd);
				const envelope = await preview(
					id,
					["--backend", backend, ...subject(id).args],
					cwd,
				);
				expect(envelope.code).toBe(0);
				expect(envelope.stderr).toBe("");
				expect(snapshotTree(cwd)).toEqual(before);
				expect(existsSync(join(cwd, "ai"))).toBe(false);
				for (const line of [...subject(id).before, ...subject(id).after]) {
					const text = line.replaceAll("<cwd>", cwd).trim();
					expect([id, backend, envelope.text.includes(text)]).toEqual([
						id,
						backend,
						false,
					]);
				}
			}
		}
	});

	test("prepare returns the same prompt data in preview and in execution", async () => {
		for (const id of IDS) {
			for (const mode of ["interactive", "print"] as const) {
				const cwd = workspace();
				const ctx = (preview: boolean) => ({
					flags: {},
					args: subject(id).args,
					passthrough: [],
					cwd,
					backend: "claude" as const,
					modelFromFlag: false,
					mode,
					preview,
					spec: spec(id),
					signal: new AbortController().signal,
					runCommand: async () => {
						throw new Error("no command expected");
					},
				});
				const previewed = await subject(id).extension.prepare?.(ctx(true));
				expect(existsSync(join(cwd, "ai"))).toBe(false);
				const executed = await subject(id).extension.prepare?.(ctx(false));
				expect(existsSync(join(cwd, subject(id).outputDir))).toBe(true);
				expect(previewed as unknown).toEqual(executed);
			}
		}
	});
});

describe("execution through the fake CLIs (D-016, D-019, AC #4)", () => {
	for (const id of IDS) {
		for (const backend of BACKENDS) {
			test(`${id} on ${backend}: directory created, start banner before the child, completion after it`, async () => {
				const cwd = workspace();
				const { args, before, after, outputDir } = subject(id);
				const run = await execute(id, ["--backend", backend, ...args], cwd);
				expect(run.code).toBe(0);
				expect(run.stderr).toBe("");
				expect(lstatSync(join(cwd, outputDir)).isDirectory()).toBe(true);
				expect(run.records).toHaveLength(1);
				const [record] = run.records;
				expect(record?.name).toBe(backend);
				expect(record?.cwd).toBe(cwd);
				expect(run.writes).toEqual([
					...withCwd(before, cwd).map((text) => ({
						stream: "stdout" as const,
						text: `${text}\n`,
						launched: false,
					})),
					...withCwd(after, cwd).map((text) => ({
						stream: "stdout" as const,
						text: `${text}\n`,
						launched: true,
					})),
				]);
				// The child received the same prompt the preview shows.
				const previewed = await preview(
					id,
					["--backend", backend, ...args],
					cwd,
				);
				expect(record?.argv.slice(-2)).toEqual(["--", previewed.initialPrompt]);
			});
		}
	}

	test("a failing child gets the start banner but no completion message", async () => {
		for (const id of IDS) {
			const cwd = workspace();
			const run = await execute(id, subject(id).args, cwd, "fail");
			expect(run.code).toBe(3);
			expect(run.stdout).toBe(
				withCwd(subject(id).before, cwd)
					.map((line) => `${line}\n`)
					.join(""),
			);
		}
	});

	test("--print keeps the payload clean: no banners, directory still created", async () => {
		for (const id of IDS) {
			const cwd = workspace();
			const run = await execute(id, ["--print", ...subject(id).args], cwd);
			expect(run.code).toBe(0);
			expect(run.stdout).toBe("claude result\n");
			expect(run.stderr).toBe("");
			expect(lstatSync(join(cwd, subject(id).outputDir)).isDirectory()).toBe(
				true,
			);
		}
	});

	const FAILURES: Record<string, string> = {
		"design:audit": "Failed to create audit directory: ",
		"design:diagram:all": "Failed to create diagrams directory: ",
		"design:diagram:consolidate": "Failed to create consolidated directory: ",
		"design:diagram:topic": "Failed to create diagrams directory: ",
	};

	/** A workspace where `ai` is a file, so the output directory cannot be created. */
	function blockedWorkspace(): string {
		const cwd = workspace();
		writeFileSync(join(cwd, "ai"), "a file where the directory should be\n");
		return cwd;
	}

	test("interactive: an uncreatable directory is the first start banner and the run continues, as today", async () => {
		for (const id of IDS) {
			const cwd = blockedWorkspace();
			const run = await execute(id, subject(id).args, cwd);
			expect([id, run.code, run.stderr]).toEqual([id, 0, ""]);
			expect(run.records).toHaveLength(1);
			const [first, ...rest] = run.writes;
			expect(first?.stream).toBe("stdout");
			expect(first?.launched).toBe(false);
			expect(first?.text).toStartWith(FAILURES[id] as string);
			expect(first?.text).toEndWith("\n");
			expect(rest.map((write) => write.text)).toEqual(
				withCwd(
					[...subject(id).before.slice(1), ...subject(id).after],
					cwd,
				).map((line) => `${line}\n`),
			);
		}
	});

	test("--print: an uncreatable directory is a stderr early exit with code 1 and no backend", async () => {
		for (const id of IDS) {
			const cwd = blockedWorkspace();
			const run = await execute(id, ["--print", ...subject(id).args], cwd);
			expect([id, run.code, run.stdout, run.records]).toEqual([id, 1, "", []]);
			expect(run.writes).toHaveLength(1);
			expect(run.writes[0]?.stream).toBe("stderr");
			expect(run.stderr).toStartWith(FAILURES[id] as string);
			expect(run.stderr).toEndWith("\n");
			expect(run.stderr.split("\n")).toHaveLength(2);
		}
	});
});

describe("topic argument (D-016)", () => {
	const USAGE =
		"Missing required topic.\nUsage: design:diagram:topic <topic> [extra focus words]\n";

	test("a missing topic exits 1 on stderr before any directory or child", async () => {
		for (const backend of BACKENDS) {
			const cwd = workspace();
			const run = await execute(
				"design:diagram:topic",
				["--backend", backend],
				cwd,
			);
			expect(run).toMatchObject({
				code: 1,
				stdout: "",
				stderr: USAGE,
				records: [],
			});
			expect(readdirSync(cwd)).toEqual([]);
		}
	});

	test("an empty topic is missing too", async () => {
		const cwd = workspace();
		const run = await execute("design:diagram:topic", [""], cwd);
		expect(run).toMatchObject({ code: 1, stderr: USAGE, records: [] });
	});

	test("previewing without a topic is a stderr diagnostic with exit 1 (D-030)", async () => {
		const cwd = workspace();
		const before = snapshotTree(cwd);
		const envelope = await preview("design:diagram:topic", [], cwd);
		expect(envelope).toMatchObject({ code: 1, text: "", stderr: USAGE });
		expect(snapshotTree(cwd)).toEqual(before);
	});

	test("slug cases", () => {
		const cases: [string, string][] = [
			["Auth Login", "auth-login"],
			["auth", "auth"],
			["  Payments/Stripe Webhooks  ", "payments-stripe-webhooks"],
			["--Weird__Name!!", "weird-name"],
			["user_profile.v2", "user-profile-v2"],
			["Café Über", "caf-ber"],
			["!!!", ""],
			["x".repeat(100), "x".repeat(80)],
		];
		for (const [input, slug] of cases) {
			expect([input, topic.slugify(input)]).toEqual([input, slug]);
		}
	});

	test("the slug reaches the filename example and the banner; the topic stays verbatim", async () => {
		const cwd = workspace();
		const args = ["Payments/Stripe Webhooks", "retry", "logic"];
		const envelope = await preview("design:diagram:topic", args, cwd);
		expect(envelope.initialPrompt).toContain(
			"Topic: Payments/Stripe Webhooks\nExtra focus: retry logic\n",
		);
		expect(envelope.initialPrompt).toContain(
			"(e.g., payments-stripe-webhooks-auth-login-flow.md)",
		);
		const run = await execute("design:diagram:topic", args, cwd);
		expect(run.stdout).toContain(
			"🏷️ Topic: Payments/Stripe Webhooks (slug: payments-stripe-webhooks)\n",
		);
	});
});

describe("compiled binaries (B-003, B-006)", () => {
	test("each binary previews without touching the workspace and runs with banners around the child", async () => {
		const out = join(root, "compiled");
		mkdirSync(out);
		// The fake claude, behind a wrapper that marks the child's place in stdout.
		const bin = join(root, "compiled-fake-bin");
		mkdirSync(bin);
		installFakeClis(bin);
		renameSync(join(bin, "claude"), join(bin, "claude-fake"));
		writeFileSync(
			join(bin, "claude"),
			`#!/bin/sh\necho "<child>"\nexec "${join(bin, "claude-fake")}" "$@"\n`,
		);
		chmodSync(join(bin, "claude"), 0o755);

		for (const [
			id,
			{ source, args, before, after, outputDir },
		] of Object.entries(SUBJECTS)) {
			const outFile = join(out, id);
			await compileAgent({ root: repo, file: source, outFile });
			const cwd = workspace();
			const recordFile = join(root, `compiled-${counter++}.jsonl`);
			const runBinary = (...argv: string[]) => {
				const child = Bun.spawnSync([outFile, ...argv], {
					cwd,
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						FAKE_RECORD: recordFile,
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				return {
					code: child.exitCode,
					stdout: child.stdout.toString(),
					stderr: child.stderr.toString(),
				};
			};

			const help = runBinary("--help");
			expect(help.code).toBe(0);
			expect(help.stdout).toContain(spec(id).description);

			const pristine = snapshotTree(cwd);
			for (const backend of BACKENDS) {
				const shown = runBinary("--backend", backend, "--show-prompt", ...args);
				expect(shown.code).toBe(0);
				expect(shown.stderr).toBe("");
				expect(shown.stdout).toBe(
					(await preview(id, ["--backend", backend, ...args], cwd)).text,
				);
			}
			expect(snapshotTree(cwd)).toEqual(pristine);
			expect(existsSync(recordFile)).toBe(false);

			const ran = runBinary(...args);
			expect(ran.stderr).toBe("");
			expect(ran.code).toBe(0);
			expect(ran.stdout).toBe(
				[...withCwd(before, cwd), "<child>", ...withCwd(after, cwd), ""].join(
					"\n",
				),
			);
			expect(lstatSync(join(cwd, outputDir)).isDirectory()).toBe(true);
			expect(readRecords(recordFile)).toHaveLength(1);
		}
	}, 120_000);
});
