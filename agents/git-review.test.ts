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
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError, parseCli, resolveCli } from "../lib/agent-format/cli";
import { installFakeClis, readRecords } from "../lib/agent-format/fake-cli";
import {
	type AgentExtension,
	createPrepareContext,
	executeAgent,
	previewAgent,
	type RunCommand,
} from "../lib/agent-format/run";
import type {
	AgentSpec,
	Backend,
	CommandRequest,
	PrepareResult,
} from "../lib/agent-format/types";
import {
	compileAgent,
	generateEntry,
	inspectExtension,
	type LoadedAgent,
	loadAgentDefinition,
	planBuild,
} from "../scripts/agent-compiler";
import * as commentReview from "./build/comment-review";
import * as gitFix from "./git/fix";
import * as prReview from "./review/pr";

const repo = resolve(import.meta.dir, "..");

// Execution and binary tests spawn fake CLIs and compiled agents.
setDefaultTimeout(60_000);

/** TASK-011: the git-fix, pr-review and comment-review family (D-019). */
const FAMILY: Record<string, Backend[]> = {
	"build:comment-review": ["claude", "codex"],
	"git:fix": ["claude", "codex"],
	"review:pr": ["claude"],
};

const EXTENSIONS: Record<string, AgentExtension> = {
	"build:comment-review": commentReview,
	"git:fix": gitFix,
	"review:pr": prReview,
};

const sourceOf = (id: string) => `agents/${id.split(":").join("/")}`;

/** The legacy `settings/pr-review.settings.json` allow list, in its order. */
const PR_REVIEW_ALLOW = [
	"Bash(gh issue view:*)",
	"Bash(gh issue list:*)",
	"Bash(gh pr comment:*)",
	"Bash(gh pr diff:*)",
	"Bash(gh pr view:*)",
	"Bash(gh pr list:*)",
	"Bash(gh pr checks:*)",
	"Bash(gh search:*)",
	"Bash(gh api:*)",
	"Bash(git log:*)",
	"Bash(git show:*)",
	"Bash(git diff:*)",
	"Bash(git rev-parse:*)",
	"Read",
	"Glob",
	"Grep",
	"Task",
];

const GIT_FIX_USAGE = `No PR found for current branch.
Usage: git:fix [PR_NUMBER]
Examples:
  git:fix           # Auto-detect PR for current branch
  git:fix 123
`;

const PR_REVIEW_USAGE = `No PR found for current branch.
Usage: review:pr [PR_URL_OR_NUMBER]
Examples:
  review:pr           # Auto-detect PR for current branch
  review:pr 123
  review:pr https://github.com/owner/repo/pull/123
`;

const COMMENT_STEP =
	'If NO issues were found, post a summary comment using `gh pr comment`:\n"No issues found. Checked for bugs and project guideline compliance."';
const REPORT_STEP =
	"If NO issues were found, report this to the user but do not post a comment.";

const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1,3 @@
 const a = 1;
+// increment counter
+const b = a + 1;
`;

/** A fake `gh` that logs every call and answers `pr view` with 42, or fails. */
const FAKE_GH = `#!/bin/sh
echo "gh $*" >> "$FAKE_GH_LOG"
if [ -n "$FAKE_GH_FAIL" ]; then echo "no pull requests found for branch" >&2; exit 1; fi
echo 42
`;

const agents = new Map<string, LoadedAgent>();
let scratch: string;
let cwd: string;
let fakeBin: string;
let ghLog: string;

beforeAll(async () => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "git-review-agents-")));
	cwd = join(scratch, "ws");
	mkdirSync(cwd);
	fakeBin = join(scratch, "fakebin");
	mkdirSync(fakeBin);
	installFakeClis(fakeBin);
	writeFileSync(join(fakeBin, "gh"), FAKE_GH);
	chmodSync(join(fakeBin, "gh"), 0o755);
	ghLog = join(scratch, "gh.log");
	for (const id of Object.keys(FAMILY)) {
		agents.set(id, await loadAgentDefinition(repo, `${sourceOf(id)}.md`));
	}
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function spec(id: string): AgentSpec {
	const agent = agents.get(id);
	if (!agent) throw new Error(`${id} not loaded`);
	return agent.spec;
}

function extension(id: string): AgentExtension {
	return EXTENSIONS[id] as AgentExtension;
}

interface Call {
	argv: string[];
	cwd?: string;
	env?: Record<string, string>;
}

/**
 * A faked `runCommand` that records each request and answers it from
 * `answer`; anything unanswered fails the test.
 */
function fakeRunCommand(
	answer: (argv: string[]) => { exitCode: number; stdout?: string } | undefined,
): { runCommand: RunCommand; calls: Call[] } {
	const calls: Call[] = [];
	const runCommand: RunCommand = async (request: CommandRequest) => {
		calls.push({
			argv: [...request.argv],
			...(request.cwd ? { cwd: request.cwd } : {}),
			...(request.env ? { env: { ...request.env } } : {}),
		});
		const reply = answer(withoutGitConfig(request.argv));
		if (!reply)
			throw new Error(`unexpected command: ${request.argv.join(" ")}`);
		return { exitCode: reply.exitCode, stdout: reply.stdout ?? "", stderr: "" };
	};
	return { runCommand, calls };
}

/** `argv` with git's leading `-c <name>=<value>` pairs removed. */
function withoutGitConfig(argv: readonly string[]): string[] {
	const out = [...argv];
	while (out[0] === "git" && out[1] === "-c") out.splice(1, 2);
	return out;
}

/** `gh pr view` answering 42 (or failing), git commands for comment-review. */
function repoCommands(options: {
	gh?: "42" | "fail";
	base?: "main" | "origin/master" | "none";
	committed?: string;
	staged?: string;
}) {
	return fakeRunCommand((argv) => {
		if (argv[0] === "gh") {
			return options.gh === "fail"
				? { exitCode: 1 }
				: { exitCode: 0, stdout: "42\n" };
		}
		if (argv[0] !== "git") return undefined;
		if (argv[1] === "rev-parse" && argv[2] === "--verify") {
			return { exitCode: argv[3] === (options.base ?? "main") ? 0 : 128 };
		}
		if (argv[1] === "diff" && argv[2] === "--cached") {
			return { exitCode: 0, stdout: options.staged ?? "" };
		}
		if (argv[1] === "diff")
			return { exitCode: 0, stdout: options.committed ?? "" };
		return undefined;
	});
}

/** Call the extension's `prepare` the way the runner would. */
async function prepareWith(
	id: string,
	argv: string[],
	runCommand: RunCommand,
	preview = false,
): Promise<PrepareResult> {
	const outcome = parseCli(spec(id), argv, { cwd });
	if (outcome.kind !== "run") throw new Error("unexpected help");
	const ctx = createPrepareContext(
		spec(id),
		{ ...outcome.invocation, showPrompt: preview },
		{ signal: new AbortController().signal, runCommand },
	);
	const prepare = extension(id).prepare;
	if (!prepare) throw new Error(`${id} has no prepare`);
	return prepare(ctx);
}

interface Envelope {
	text: string;
	systemPrompt: string;
	initialPrompt: string;
	argv: string[];
}

/** `--show-prompt` through the runner's preview with a faked `runCommand`. */
async function preview(
	id: string,
	argv: string[],
	runCommand: RunCommand,
): Promise<{
	code: number;
	stdout: string;
	stderr: string;
	envelope?: Envelope;
}> {
	const outcome = parseCli(spec(id), argv, { cwd });
	if (outcome.kind !== "run") throw new Error("unexpected help");
	let stdout = "";
	let stderr = "";
	const code = await previewAgent(spec(id), extension(id), outcome.invocation, {
		stdout: (chunk) => {
			stdout += chunk;
		},
		stderr: (chunk) => {
			stderr += chunk;
		},
		isDirectory: () => true,
		runCommand,
	});
	const match =
		/^Backend: \w+\n--- System prompt ---\n([\s\S]*)\n--- Initial prompt ---\n([\s\S]*)\n--- Argv ---\n(.*)\n$/.exec(
			stdout,
		);
	if (!match) return { code, stdout, stderr };
	return {
		code,
		stdout,
		stderr,
		envelope: {
			text: stdout,
			systemPrompt: match[1] ?? "",
			initialPrompt: match[2] ?? "",
			argv: JSON.parse(match[3] ?? "[]"),
		},
	};
}

async function envelopeOf(
	id: string,
	argv: string[],
	runCommand: RunCommand,
): Promise<Envelope> {
	const result = await preview(id, argv, runCommand);
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	if (!result.envelope)
		throw new Error(`malformed envelope:\n${result.stdout}`);
	return result.envelope;
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i === -1 ? undefined : argv[i + 1];
}

/**
 * The envelope with the argv copies of the system and initial prompts
 * replaced by markers, after checking each copy is exactly the previewed
 * text on that backend's transport, so the snapshot holds each prompt once.
 */
function compact(envelope: Envelope, backend: Backend): string {
	const system = "<system prompt, as above>";
	const initial = "<initial prompt, as above>";
	const argv = envelope.argv.map((arg, i) => {
		if (
			backend === "claude" &&
			envelope.argv[i - 1] === "--append-system-prompt"
		) {
			expect(arg).toBe(envelope.systemPrompt);
			return system;
		}
		if (backend === "codex" && arg.startsWith("developer_instructions=")) {
			expect(JSON.parse(arg.slice("developer_instructions=".length))).toBe(
				envelope.systemPrompt,
			);
			return `developer_instructions=${system}`;
		}
		return arg;
	});
	expect(argv.slice(-2)).toEqual(["--", envelope.initialPrompt]);
	argv[argv.length - 1] = initial;
	return envelope.text.replace(/--- Argv ---\n.*\n$/, () =>
		["--- Argv ---", JSON.stringify(argv), ""].join("\n"),
	);
}

describe("declarations and extensions (D-001, D-015, D-019)", () => {
	test("each is a path-named Markdown declaration with a prepare-only sibling extension", () => {
		for (const id of Object.keys(FAMILY)) {
			const agent = agents.get(id);
			expect(agent?.file).toBe(`${sourceOf(id)}.md`);
			expect(agent?.spec.id).toBe(id);
			expect(agent?.spec.mode).toBe("interactive");
			expect(agent?.spec.promptMode).toBe("append");
			expect(agent?.extension).toEqual({
				file: join(repo, `${sourceOf(id)}.ts`),
				exports: ["prepare"],
			});
		}
	});

	// Migration check against the legacy prompt files, which TASK-017 deletes at the
	// strict cutover; delete this check with them. The envelope snapshots are
	// the lasting guard.
	test("bodies are the legacy prompt files; git:fix had none and emits no prompt flag", async () => {
		expect(spec("review:pr").systemPrompt).toBe(
			readFileSync(
				join(repo, "system-prompts/pr-review-prompt.md"),
				"utf8",
			).trimEnd(),
		);
		expect(spec("build:comment-review").systemPrompt).toBe(
			readFileSync(
				join(repo, "system-prompts/comment-review-prompt.md"),
				"utf8",
			).trimEnd(),
		);
		expect(spec("git:fix").systemPrompt).toBe("");
		for (const backend of FAMILY["git:fix"] ?? []) {
			const { argv } = await envelopeOf(
				"git:fix",
				["--backend", backend, "7"],
				repoCommands({}).runCommand,
			);
			expect(argv).not.toContain("--append-system-prompt");
			expect(
				argv.some((arg) => arg.startsWith("developer_instructions=")),
			).toBe(false);
		}
	});

	test("mixed mode builds each same-stem pair as declaration plus extension", async () => {
		const plan = await planBuild({ root: repo, mode: "mixed" });
		for (const id of Object.keys(FAMILY)) {
			const entry = plan.entries.find((candidate) => candidate.id === id);
			expect(entry?.kind).toBe("declaration");
			if (entry?.kind !== "declaration") continue;
			expect(entry.source).toBe(`${sourceOf(id)}.md`);
			expect(entry.agent.extension?.exports).toEqual(["prepare"]);
			const source = generateEntry(entry.agent);
			expect(source).toContain(
				`import { prepare } from ${JSON.stringify(join(repo, `${sourceOf(id)}.ts`))};`,
			);
			expect(source).toContain("const extension = { prepare };");
		}
	});
});

describe("importing an extension has no side effects (D-015, B-006)", () => {
	test("static inspection finds no top-level side effects", () => {
		for (const id of Object.keys(FAMILY)) {
			const file = `${sourceOf(id)}.ts`;
			const inspection = inspectExtension(
				file,
				readFileSync(join(repo, file), "utf8"),
			);
			expect({ id, ...inspection }).toEqual({
				id,
				exports: ["prepare"],
				exportProblems: [],
				hidingExportProblems: [],
				sideEffects: [],
			});
		}
	});

	test("a fresh process that imports each extension spawns nothing and does not exit", async () => {
		const files = Object.keys(FAMILY).map((id) =>
			join(repo, `${sourceOf(id)}.ts`),
		);
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
const exported: Record<string, string[]> = {};
for (const file of ${JSON.stringify(files)}) {
	exported[file] = Object.keys(await import(file)).sort();
}
console.log(JSON.stringify({ events, exported }));
`,
		);
		const child = Bun.spawn([process.execPath, probe], {
			cwd: scratch,
			env: {
				...process.env,
				PATH: `${fakeBin}:${process.env.PATH}`,
				FAKE_GH_LOG: ghLog,
				FAKE_RECORD: join(scratch, "import-records.jsonl"),
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
		for (const file of files) {
			expect(result.exported[file]).toContain("prepare");
			expect(result.exported[file]).not.toContain("default");
		}
		expect(existsSync(ghLog)).toBe(false);
		expect(readRecords(join(scratch, "import-records.jsonl"))).toEqual([]);
	});
});

describe("backends (D-005, B-007)", () => {
	test("review:pr is Claude-only; git:fix and comment-review declare claude then codex", () => {
		for (const [id, backends] of Object.entries(FAMILY)) {
			expect({ id, backends: [...spec(id).backends] }).toEqual({
				id,
				backends,
			});
		}
	});

	test("an explicit --backend codex on review:pr fails clearly before prepare", () => {
		expect(() =>
			parseCli(spec("review:pr"), ["--backend", "codex", "123"], { cwd }),
		).toThrow(
			new CliError(
				'review:pr: backend "codex" is not declared by this agent (declared: claude)',
			),
		);
		let stdout = "";
		let stderr = "";
		const result = resolveCli(
			spec("review:pr"),
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
			'review:pr: backend "codex" is not declared by this agent (declared: claude)\n',
		);
	});
});

describe("--show-prompt envelopes per declared backend (B-003)", () => {
	const cases: [string, string[]][] = [
		["git:fix", ["123"]],
		["git:fix", []],
		["review:pr", ["123"]],
		["review:pr", []],
		["review:pr", ["--comment", "123"]],
		["build:comment-review", []],
	];
	for (const [id, args] of cases) {
		for (const backend of FAMILY[id] ?? []) {
			test(`${id} ${args.join(" ")} on ${backend}`, async () => {
				const { runCommand, calls } = repoCommands({ committed: DIFF });
				const envelope = await envelopeOf(
					id,
					["--backend", backend, ...args],
					runCommand,
				);
				expect(envelope.text.startsWith(`Backend: ${backend}\n`)).toBe(true);
				expect(envelope.argv[0]).toBe(backend);
				expect(calls.some((call) => call.argv[0] === "gh")).toBe(false);
				expect(compact(envelope, backend)).toMatchSnapshot();
			});
		}
	}
});

describe("PR resolution for git:fix and review:pr (D-012, D-019)", () => {
	const PROMPT_PR: Record<string, (pr: string) => string> = {
		"git:fix": (pr) =>
			`Fix issues from PR review comments on pull request #${pr}.`,
		"review:pr": (pr) => `Provide a code review for pull request: ${pr}\n`,
	};
	const USAGE: Record<string, string> = {
		"git:fix": GIT_FIX_USAGE,
		"review:pr": PR_REVIEW_USAGE,
	};

	for (const id of ["git:fix", "review:pr"]) {
		const opening = PROMPT_PR[id] as (pr: string) => string;

		test(`${id}: a supplied PR is used as is and gh is never called`, async () => {
			for (const pr of ["123", "https://github.com/owner/repo/pull/123"]) {
				const { runCommand, calls } = repoCommands({});
				const result = await prepareWith(id, [pr], runCommand);
				expect(calls).toEqual([]);
				expect(result).toEqual({
					initialPrompt: expect.stringContaining(
						opening(pr),
					) as unknown as string,
				});
			}
		});

		test(`${id}: without a PR, prepare detects it with gh through runCommand`, async () => {
			const { runCommand, calls } = repoCommands({ gh: "42" });
			const result = await prepareWith(id, [], runCommand);
			expect(calls).toEqual([
				{ argv: ["gh", "pr", "view", "--json", "number", "-q", ".number"] },
			]);
			if ("exit" in result) throw new Error("unexpected exit");
			expect(result.initialPrompt?.startsWith(opening("42"))).toBe(true);
			expect(result.beforeRunMessages).toEqual([
				"Detected PR #42 for current branch",
			]);
		});

		test(`${id}: in print mode the detection notice is not returned`, async () => {
			const { runCommand } = repoCommands({ gh: "42" });
			const result = await prepareWith(id, ["--print"], runCommand);
			if ("exit" in result) throw new Error("unexpected exit");
			expect(result.initialPrompt?.startsWith(opening("42"))).toBe(true);
			expect(result.beforeRunMessages).toBeUndefined();
		});

		test(`${id}: no PR found is a stderr early exit with code 1`, async () => {
			const { runCommand, calls } = repoCommands({ gh: "fail" });
			expect(await prepareWith(id, [], runCommand)).toEqual({
				exit: { message: USAGE[id] as string, code: 1, stream: "stderr" },
			});
			expect(calls).toHaveLength(1);
			const empty = fakeRunCommand(() => ({ exitCode: 0, stdout: "\n" }));
			expect(await prepareWith(id, [], empty.runCommand)).toEqual({
				exit: { message: USAGE[id] as string, code: 1, stream: "stderr" },
			});
		});

		test(`${id}: preview without a PR uses the stable placeholder and spawns no gh`, async () => {
			const { runCommand, calls } = repoCommands({ gh: "42" });
			const envelope = await envelopeOf(id, [], runCommand);
			expect(calls).toEqual([]);
			expect(envelope.initialPrompt.startsWith(opening("<detected:pr>"))).toBe(
				true,
			);
			const again = await envelopeOf(id, [], runCommand);
			expect(again.text).toBe(envelope.text);
		});

		test(`${id}: preview with a PR uses it and spawns no gh`, async () => {
			const { runCommand, calls } = repoCommands({ gh: "42" });
			const envelope = await envelopeOf(id, ["77"], runCommand);
			expect(calls).toEqual([]);
			expect(envelope.initialPrompt.startsWith(opening("77"))).toBe(true);
		});
	}

	test("review:pr --show-prompt with no PR argument spawns no gh (negative test, AC #2)", async () => {
		const { runCommand, calls } = fakeRunCommand(() => {
			throw new Error("preview must not run any command");
		});
		const result = await preview("review:pr", [], runCommand);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(calls).toEqual([]);
		// The real runner command facility, with a logging gh first on PATH.
		const before = process.env.PATH;
		const outcome = parseCli(spec("review:pr"), ["--show-prompt"], { cwd });
		if (outcome.kind !== "run") throw new Error("unexpected help");
		process.env.PATH = `${fakeBin}:${before}`;
		process.env.FAKE_GH_LOG = ghLog;
		try {
			let stdout = "";
			const code = await previewAgent(
				spec("review:pr"),
				prReview,
				outcome.invocation,
				{
					stdout: (text) => {
						stdout += text;
					},
					stderr: () => {},
					isDirectory: () => true,
				},
			);
			expect(code).toBe(0);
			expect(stdout).toContain("pull request: <detected:pr>");
		} finally {
			process.env.PATH = before;
			delete process.env.FAKE_GH_LOG;
		}
		expect(existsSync(ghLog)).toBe(false);
	});
});

describe("review:pr --comment regression (spec Acceptance, D3)", () => {
	test("the flag is consumed, never forwarded, and toggles step 7", async () => {
		const plain = await envelopeOf(
			"review:pr",
			["123"],
			repoCommands({}).runCommand,
		);
		const comment = await envelopeOf(
			"review:pr",
			["--comment", "123"],
			repoCommands({}).runCommand,
		);
		expect(plain.argv).not.toContain("--comment");
		expect(comment.argv).not.toContain("--comment");
		expect(plain.initialPrompt).toContain(REPORT_STEP);
		expect(plain.initialPrompt).not.toContain(COMMENT_STEP);
		expect(comment.initialPrompt).toContain(COMMENT_STEP);
		expect(comment.initialPrompt).not.toContain(REPORT_STEP);
		// Only step 7 differs.
		expect(comment.initialPrompt.replace(COMMENT_STEP, REPORT_STEP)).toBe(
			plain.initialPrompt,
		);
	});

	test("--comment also toggles step 7 for a detected PR", async () => {
		const { runCommand } = repoCommands({ gh: "42" });
		const result = await prepareWith("review:pr", ["--comment"], runCommand);
		if ("exit" in result) throw new Error("unexpected exit");
		expect(result.initialPrompt).toContain(COMMENT_STEP);
	});
});

describe("comment-review diff and empty exit (D-019)", () => {
	test("the committed diff against main and the staged diff are embedded", async () => {
		const { runCommand, calls } = repoCommands({
			committed: DIFF,
			staged: "STAGED\n",
		});
		const result = await prepareWith("build:comment-review", [], runCommand);
		expect(calls.map((call) => call.argv.join(" "))).toEqual([
			"git rev-parse --verify main",
			"git diff main...HEAD",
			"git diff --cached",
		]);
		expect(result).toEqual({
			initialPrompt: `Review the following git diff for newly added comments. Focus only on lines starting with "+" that contain comment syntax (// or /* or # depending on language).

<diff>
${DIFF}
STAGED

</diff>

Analyze these new comments. For any comments that should be removed or improved, edit the files directly to fix them.`,
		});
	});

	test("the base falls back main, origin/main, master, origin/master", async () => {
		const { runCommand, calls } = repoCommands({
			base: "origin/master",
			committed: DIFF,
		});
		await prepareWith("build:comment-review", [], runCommand);
		expect(calls.map((call) => call.argv.join(" "))).toEqual([
			"git rev-parse --verify main",
			"git rev-parse --verify origin/main",
			"git rev-parse --verify master",
			"git rev-parse --verify origin/master",
			"git diff origin/master...HEAD",
			"git diff --cached",
		]);
	});

	test("nothing to review exits 0 on stdout with the legacy message", async () => {
		const { runCommand } = repoCommands({});
		expect(await prepareWith("build:comment-review", [], runCommand)).toEqual({
			exit: {
				message: "No changes found to review.\n",
				code: 0,
				stream: "stdout",
			},
		});
	});

	test("no main or master exits 1 on stderr with the legacy message", async () => {
		const { runCommand } = repoCommands({ base: "none" });
		expect(await prepareWith("build:comment-review", [], runCommand)).toEqual({
			exit: {
				message: "Could not find main or master branch\n",
				code: 1,
				stream: "stderr",
			},
		});
	});

	test("a failing git diff fails preparation instead of reviewing a partial diff", async () => {
		const { runCommand } = fakeRunCommand((argv) =>
			argv[1] === "rev-parse" ? { exitCode: 0 } : { exitCode: 128 },
		);
		await expect(
			prepareWith("build:comment-review", [], runCommand),
		).rejects.toThrow("git diff main...HEAD exited 128");
	});

	test("in preview an empty diff is a stderr diagnostic with code 1 (D-030)", async () => {
		const result = await preview(
			"build:comment-review",
			[],
			repoCommands({}).runCommand,
		);
		expect(result).toEqual({
			code: 1,
			stdout: "",
			stderr: "No changes found to review.\n",
		});
	});
});

describe("Claude rules and dropped settings (AC #2, #3, D-006, D-007)", () => {
	test("comment-review carries Edit/Read/Glob/Grep allow rules in the Claude settings argv only", async () => {
		const claude = await envelopeOf(
			"build:comment-review",
			["--backend", "claude"],
			repoCommands({ committed: DIFF }).runCommand,
		);
		expect(JSON.parse(valueAfter(claude.argv, "--settings") ?? "{}")).toEqual({
			permissions: { allow: ["Edit", "Read", "Glob", "Grep"] },
		});
		const codex = await envelopeOf(
			"build:comment-review",
			["--backend", "codex"],
			repoCommands({ committed: DIFF }).runCommand,
		);
		const config = codex.argv.filter(
			(arg) => !arg.startsWith("developer_instructions="),
		);
		expect(config).not.toContain("--settings");
		expect(config.join("\n")).not.toContain("permissions");
	});

	// Migration check against the legacy settings file, which TASK-017 deletes at the
	// strict cutover; delete this check with them. The envelope snapshots are
	// the lasting guard.
	test("review:pr carries the legacy allow list in order and no empty deny", async () => {
		const { argv } = await envelopeOf(
			"review:pr",
			["123"],
			repoCommands({}).runCommand,
		);
		expect(JSON.parse(valueAfter(argv, "--settings") ?? "{}")).toEqual({
			permissions: { allow: PR_REVIEW_ALLOW },
		});
		const legacy = JSON.parse(
			readFileSync(join(repo, "settings/pr-review.settings.json"), "utf8"),
		);
		expect(legacy.permissions.allow).toEqual(PR_REVIEW_ALLOW);
		expect(legacy.permissions.deny).toEqual([]);
	});

	test("git:fix has no settings, MCP or model on either backend", async () => {
		for (const backend of FAMILY["git:fix"] ?? []) {
			const { argv } = await envelopeOf(
				"git:fix",
				["--backend", backend, "123"],
				repoCommands({}).runCommand,
			);
			expect(argv.slice(0, -2)).toEqual([backend]);
		}
	});

	// Migration check against the legacy settings files, which TASK-017 deletes at the
	// strict cutover; delete this check with them. The envelope snapshots are
	// the lasting guard.
	test("none of the three had a lifecycle echo hook, and none reaches an envelope", async () => {
		for (const file of [
			"settings/pr-review.settings.json",
			"settings/comment-review.settings.json",
		]) {
			expect(
				Object.keys(JSON.parse(readFileSync(join(repo, file), "utf8"))),
			).toEqual(["permissions"]);
		}
		for (const [id, backends] of Object.entries(FAMILY)) {
			expect(Object.keys(spec(id).native?.claude?.settings ?? {})).toEqual(
				id === "git:fix" ? [] : ["permissions"],
			);
			for (const backend of backends) {
				const { argv } = await envelopeOf(
					id,
					["--backend", backend, "123"],
					repoCommands({ committed: DIFF }).runCommand,
				);
				const joined = argv.join("\n");
				for (const dead of ["hooks", "CLAUDE_PROJECT_DIR", '"deny":[]']) {
					expect([id, backend, dead, joined.includes(dead)]).toEqual([
						id,
						backend,
						dead,
						false,
					]);
				}
			}
		}
	});
});

describe("execution with fake gh, git and backend CLIs (B-006)", () => {
	let workspace: string;
	let clean: string;

	const git = (dir: string, ...args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], {
			cwd: dir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
		if (result.exitCode !== 0) throw new Error(String(result.stderr));
	};

	beforeAll(() => {
		workspace = join(scratch, "repo");
		mkdirSync(workspace);
		git(workspace, "init", "-q", "-b", "main");
		writeFileSync(join(workspace, "a.ts"), "const a = 1;\n");
		git(workspace, "add", ".");
		git(workspace, "commit", "-qm", "init");
		git(workspace, "checkout", "-qb", "feature");
		writeFileSync(
			join(workspace, "a.ts"),
			"const a = 1;\n// increment counter\nconst b = a + 1;\n",
		);
		git(workspace, "commit", "-qam", "change");
		clean = join(scratch, "clean");
		mkdirSync(clean);
		git(clean, "init", "-q", "-b", "main");
		writeFileSync(join(clean, "x"), "x\n");
		git(clean, "add", ".");
		git(clean, "commit", "-qm", "init");
	});

	async function execute(
		id: string,
		argv: string[],
		options: { dir: string; ghFail?: boolean },
	) {
		const records = join(scratch, `records-${crypto.randomUUID()}.jsonl`);
		const log = join(scratch, `gh-${crypto.randomUUID()}.log`);
		const outcome = parseCli(spec(id), argv, { cwd: options.dir });
		if (outcome.kind !== "run") throw new Error("unexpected help");
		let stdout = "";
		let stderr = "";
		const code = await executeAgent(
			spec(id),
			extension(id),
			outcome.invocation,
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
					PATH: `${fakeBin}:${process.env.PATH}`,
					FAKE_RECORD: records,
					FAKE_GH_LOG: log,
					...(options.ghFail ? { FAKE_GH_FAIL: "1" } : {}),
				},
			},
		);
		const gh = existsSync(log)
			? readFileSync(log, "utf8").trim().split("\n")
			: [];
		return { code, stdout, stderr, records: readRecords(records), gh };
	}

	for (const id of ["git:fix", "review:pr"]) {
		test(`${id}: a detected PR prints the notice on stdout and launches claude once with that PR`, async () => {
			const run = await execute(id, [], { dir: workspace });
			expect(run.gh).toEqual(["gh pr view --json number -q .number"]);
			expect({
				code: run.code,
				stdout: run.stdout,
				stderr: run.stderr,
			}).toEqual({
				code: 0,
				stdout: "Detected PR #42 for current branch\n",
				stderr: "",
			});
			expect(run.records).toHaveLength(1);
			const argv = run.records[0]?.argv ?? [];
			expect(argv.at(-1)).toContain(
				id === "git:fix" ? "#42." : "pull request: 42\n",
			);
		});

		test(`${id}: no PR is the legacy usage on stderr, code 1, no backend`, async () => {
			const run = await execute(id, [], { dir: workspace, ghFail: true });
			expect({
				code: run.code,
				stdout: run.stdout,
				stderr: run.stderr,
			}).toEqual({
				code: 1,
				stdout: "",
				stderr: id === "git:fix" ? GIT_FIX_USAGE : PR_REVIEW_USAGE,
			});
			expect(run.gh).toHaveLength(1);
			expect(run.records).toEqual([]);
		});
	}

	test("review:pr --comment 9 reaches claude without --comment", async () => {
		const run = await execute("review:pr", ["--comment", "9"], {
			dir: workspace,
		});
		expect(run.code).toBe(0);
		expect(run.gh).toEqual([]);
		const argv = run.records[0]?.argv ?? [];
		expect(argv).not.toContain("--comment");
		expect(argv.at(-1)).toContain(COMMENT_STEP);
	});

	test("comment-review embeds the real branch diff", async () => {
		const run = await execute("build:comment-review", [], { dir: workspace });
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 0,
			stdout: "",
			stderr: "",
		});
		const argv = run.records[0]?.argv ?? [];
		expect(argv.at(-1)).toContain("+// increment counter\n");
		expect(JSON.parse(valueAfter(argv, "--settings") ?? "{}")).toEqual({
			permissions: { allow: ["Edit", "Read", "Glob", "Grep"] },
		});
	});

	test("comment-review with nothing to review prints the legacy message and exits 0", async () => {
		const run = await execute("build:comment-review", [], { dir: clean });
		expect({ code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
			code: 0,
			stdout: "No changes found to review.\n",
			stderr: "",
		});
		expect(run.records).toEqual([]);
	});
});

describe("compiled binaries (B-001, B-003)", () => {
	const binaries = new Map<string, string>();

	beforeAll(async () => {
		const out = join(scratch, "bin");
		mkdirSync(out);
		// One at a time: concurrent `bun build --compile` jobs corrupt outputs (§7).
		for (const id of Object.keys(FAMILY)) {
			const outFile = join(out, id);
			await compileAgent({ root: repo, file: `${sourceOf(id)}.md`, outFile });
			binaries.set(id, outFile);
		}
	});

	async function runBinary(id: string, argv: string[], dir = cwd) {
		const log = join(scratch, `bin-gh-${crypto.randomUUID()}.log`);
		const child = Bun.spawn([binaries.get(id) as string, ...argv], {
			cwd: dir,
			env: {
				...process.env,
				PATH: `${fakeBin}:${process.env.PATH}`,
				FAKE_GH_LOG: log,
				FAKE_RECORD: join(scratch, "bin-records.jsonl"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, stdout, stderr, ghCalled: existsSync(log) };
	}

	test("`review:pr --show-prompt` and `git:fix --show-prompt` with no PR spawn no gh", async () => {
		for (const id of ["review:pr", "git:fix"]) {
			const run = await runBinary(id, ["--show-prompt"]);
			expect({
				id,
				code: run.code,
				stderr: run.stderr,
				gh: run.ghCalled,
			}).toEqual({
				id,
				code: 0,
				stderr: "",
				gh: false,
			});
			expect(run.stdout).toContain("<detected:pr>");
		}
		expect(readRecords(join(scratch, "bin-records.jsonl"))).toEqual([]);
	});

	test("each binary previews like the in-process runner and prints help", async () => {
		const fixed = join(scratch, "bin-ws");
		mkdirSync(fixed, { recursive: true });
		for (const id of ["git:fix", "review:pr"]) {
			const run = await runBinary(id, ["--show-prompt", "123"], fixed);
			expect(run.code).toBe(0);
			const outcome = parseCli(spec(id), ["123"], { cwd: fixed });
			if (outcome.kind !== "run") throw new Error("unexpected help");
			let expected = "";
			await previewAgent(spec(id), extension(id), outcome.invocation, {
				stdout: (text) => {
					expected += text;
				},
				stderr: () => {},
				isDirectory: () => true,
			});
			expect(run.stdout).toBe(expected);
			const help = await runBinary(id, ["--help"]);
			expect(help.code).toBe(0);
			expect(help.stdout).toContain(spec(id).description);
		}
		const prHelp = await runBinary("review:pr", ["--help"]);
		expect(prHelp.stdout).toContain("--comment");
		const cr = await runBinary("build:comment-review", ["--help"]);
		expect(cr.code).toBe(0);
		const crCodex = await runBinary("review:pr", ["--backend", "codex", "1"]);
		expect(crCodex).toEqual({
			code: 2,
			stdout: "",
			stderr:
				'review:pr: backend "codex" is not declared by this agent (declared: claude)\n',
			ghCalled: false,
		});
	});
});

describe("comment-review preview git hardening (D-012)", () => {
	test("preview git commands disable lazy fetch and fsmonitor; execution's are unchanged", async () => {
		const previewed = repoCommands({ committed: DIFF });
		await envelopeOf("build:comment-review", [], previewed.runCommand);
		expect(previewed.calls).toEqual([
			{
				argv: [
					"git",
					"-c",
					"core.fsmonitor=false",
					"rev-parse",
					"--verify",
					"main",
				],
				env: { GIT_NO_LAZY_FETCH: "1" },
			},
			{
				argv: ["git", "-c", "core.fsmonitor=false", "diff", "main...HEAD"],
				env: { GIT_NO_LAZY_FETCH: "1" },
			},
			{
				argv: ["git", "-c", "core.fsmonitor=false", "diff", "--cached"],
				env: { GIT_NO_LAZY_FETCH: "1" },
			},
		]);
		const executed = repoCommands({ committed: DIFF });
		await prepareWith("build:comment-review", [], executed.runCommand);
		expect(executed.calls).toEqual([
			{ argv: ["git", "rev-parse", "--verify", "main"] },
			{ argv: ["git", "diff", "main...HEAD"] },
			{ argv: ["git", "diff", "--cached"] },
		]);
	});
});
