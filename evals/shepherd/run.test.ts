import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
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
import { dirname, join } from "node:path";
import type { Builder } from "../../scripts/agent-compiler";
import { gitStamp, versionLine } from "../../scripts/shepherd-source";
import {
	git,
	initShepherdRepo,
	testGit,
	writeAt,
} from "../../scripts/shepherd-source-fixture";
import {
	buildSubject,
	claimArtifactRoot,
	EVALS_DIR,
	freeze,
	lateStart,
	liveGroupCount,
	loadPolicy,
	parseOptions,
	prepareRun,
	REPO_ROOT,
	readVersion,
	recheck,
	runTrials,
	scoreJobs,
	subjectEnv,
} from "./run";

let scratch: string;

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-evals-run-")));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/** Writes a small executable instead of compiling anything. */
const fakeBuild: Builder = async (request) => {
	writeFileSync(request.outFile, "#!/bin/sh\necho fake\n");
	chmodSync(request.outFile, 0o755);
};

function fixtureRepo(): string {
	const root = join(scratch, "repo");
	mkdirSync(root);
	initShepherdRepo(root, {
		"evals/shepherd/harness.py": "print('harness')\n",
		"evals/shepherd/policy.json": "{}\n",
	});
	return root;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("parameters and build destination (2.3)", () => {
	test("the package script runs the TypeScript wrapper", () => {
		const pkg = JSON.parse(
			readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
		);
		expect(pkg.scripts["evals:shepherd"]).toBe("bun evals/shepherd/run.ts");
		expect(EVALS_DIR).toBe(join(REPO_ROOT, "evals/shepherd"));
	});

	test("harness sources name no fixed binary, scratch or artifact paths", () => {
		for (const name of [
			"harness.py",
			"check-harness.py",
			"fixtures.sh",
			"run-trial.sh",
		]) {
			const text = readFileSync(join(EVALS_DIR, name), "utf8");
			expect(text).not.toContain("Projects/troupe");
			expect(text).not.toMatch(/\bWORKTREE\b/);
			expect(text).not.toMatch(/^MAIN\s*=/m);
			expect(text).not.toContain("dir='/tmp'");
			expect(text).not.toContain("HERE / trial");
		}
	});

	test("builds Shepherd into the run's scratch bin, never the repository bin", async () => {
		const root = fixtureRepo();
		const run = prepareRun({ root, scratchParent: scratch });
		const built = await buildSubject({
			root,
			runDir: run.runDir,
			build: fakeBuild,
			stamp: gitStamp(testGit),
		});
		expect(built.subject).toBe(join(realpathSync(run.runDir), "bin/shepherd"));
		expect(existsSync(join(root, "bin"))).toBe(false);
		expect(readdirSync(join(run.runDir, "bin"))).toEqual(["shepherd"]);
		expect(built.provenance.manifest.source).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("resolves the subject with realpath", async () => {
		const root = fixtureRepo();
		const real = join(scratch, "real");
		mkdirSync(real);
		symlinkSync(real, join(scratch, "alias"));
		const run = prepareRun({ root, scratchParent: join(scratch, "alias") });
		expect(run.runDir.startsWith(`${real}/`)).toBe(true);
		const built = await buildSubject({
			root,
			runDir: run.runDir,
			build: fakeBuild,
			stamp: gitStamp(testGit),
		});
		expect(built.subject).toBe(realpathSync(built.subject));
		expect(built.subject.startsWith(`${real}/`)).toBe(true);
	});

	test("refuses a scratch or build directory inside the repository", async () => {
		const root = fixtureRepo();
		expect(() => prepareRun({ root, scratchParent: root })).toThrow(
			/inside the repository/,
		);
		await expect(
			buildSubject({
				root,
				runDir: root,
				build: fakeBuild,
				stamp: gitStamp(testGit),
			}),
		).rejects.toThrow(/inside the repository/);
		expect(existsSync(join(root, "bin"))).toBe(false);
	});

	test("refuses an unisolated scratch parent before creating anything", () => {
		const root = fixtureRepo();
		const other = join(scratch, "other");
		mkdirSync(other);
		git(other, "init", "-q");
		const workspace = join(scratch, "ws", ".shepherd", "nested");
		mkdirSync(workspace, { recursive: true });
		for (const parent of [other, workspace]) {
			const before = readdirSync(parent);
			expect(() => prepareRun({ root, scratchParent: parent })).toThrow(
				/git repository|\.shepherd/,
			);
			expect(readdirSync(parent)).toEqual(before);
		}
	});

	test("refuses to start after 23:40 local time", () => {
		expect(lateStart(new Date(2026, 9, 13, 23, 41))).toMatch(/23:40/);
		expect(lateStart(new Date(2026, 9, 13, 23, 40))).toBeUndefined();
		expect(lateStart(new Date(2026, 9, 13, 9, 0))).toBeUndefined();
	});

	test("every run gets its own directory and artifact root", () => {
		const root = fixtureRepo();
		const first = prepareRun({ root, scratchParent: scratch });
		const second = prepareRun({ root, scratchParent: scratch });
		expect(first.runDir).not.toBe(second.runDir);
		expect(first.artifactRoot).toBe(join(first.runDir, "artifacts"));
		expect(readdirSync(first.artifactRoot)).toEqual([]);
	});

	test("refuses an artifact root that already holds anything", () => {
		const artifacts = join(scratch, "artifacts");
		mkdirSync(artifacts);
		claimArtifactRoot(artifacts);
		writeFileSync(join(artifacts, "frozen.json"), "{}\n");
		expect(() => claimArtifactRoot(artifacts)).toThrow(/not empty/);
		const root = fixtureRepo();
		expect(() =>
			prepareRun({ root, scratchParent: scratch, artifactRoot: artifacts }),
		).toThrow(/not empty/);
	});

	test("subjects and fixture tools find the scratch binary first on PATH", () => {
		const env = subjectEnv("/scratch/run/bin/shepherd", {
			PATH: "/usr/bin:/bin",
			HOME: "/home/user",
		});
		expect(env.PATH).toBe("/scratch/run/bin:/usr/bin:/bin");
		expect(env.HOME).toBe("/home/user");
	});
});

describe("policy (5.1)", () => {
	test("fixes the six-trial Claude subject policy", () => {
		const { policy, hash } = loadPolicy();
		expect(policy.trials).toEqual(["A", "D", "E", "G", "E-neg", "G-neg"]);
		expect(policy.backend).toBe("claude");
		expect(policy.model).toBe("claude-opus-5-5");
		expect(policy.effort).toBe("high");
		expect(policy.permissionMode).toBe("bypassPermissions");
		expect(policy.disallowedTools).toEqual(["SendMessage", "ListAgents"]);
		expect(policy.maxConcurrentSubjects).toBe(6);
		expect(policy.subjectTimeoutSeconds).toBe(1200);
		expect(policy.toolTimeoutSeconds).toBe(60);
		expect(policy.invocationTimeoutSeconds).toBe(5400);
		expect(policy.shepherdSettings).toEqual({});
		expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("fixes the scorer policy (4.1, 4.5)", () => {
		const { policy } = loadPolicy();
		expect(policy.scorer).toEqual({
			family: "claude",
			model: "claude-opus-5-5",
			effort: "high",
			timeoutSeconds: 300,
			maxConcurrent: 2,
		});
	});
});

describe("frozen inputs (2.5)", () => {
	async function frozenRun() {
		const root = fixtureRepo();
		const run = prepareRun({ root, scratchParent: scratch });
		const built = await buildSubject({
			root,
			runDir: run.runDir,
			stamp: gitStamp(testGit),
			build: async (request) => {
				// The fake prints its own stamp, as a real build would.
				const line = versionLine(await gitStamp(testGit).capture(root));
				writeFileSync(request.outFile, `#!/bin/sh\necho '${line}'\n`);
				chmodSync(request.outFile, 0o755);
			},
		});
		const { policy, hash } = loadPolicy();
		const config = join(run.runDir, "config.json");
		writeFileSync(config, '{"subject": "fixture"}\n');
		const frozen = freeze({
			root,
			runId: run.runId,
			config,
			subject: built.subject,
			provenance: built.provenance,
			versionOutput: readVersion(built.subject),
			policy,
			policyHash: hash,
			git: testGit,
		});
		return { root, built, frozen, config };
	}

	test("captures binary hash, version stamp, manifest, evaluation identity and policy", async () => {
		const { built, frozen } = await frozenRun();
		const bytes = readFileSync(built.subject);
		expect(frozen.binarySha256).toBe(
			new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
		);
		expect(frozen.version).toBe(`${versionLine(built.provenance)}\n`);
		expect(frozen.manifest).toEqual(built.provenance.manifest);
		expect(frozen.evaluation.harnessVersion).toBe(1);
		expect(frozen.evaluation.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(frozen.policy.model).toBe("claude-opus-5-5");
		expect(frozen.policyHash).toMatch(/^sha256:/);
		expect(frozen.subject).toBe(built.subject);
		expect(frozen.rubricSha256).toBe(
			`sha256:${new Bun.CryptoHasher("sha256").update(readFileSync(join(EVALS_DIR, "rubric.json"))).digest("hex")}`,
		);
		expect(frozen.configSha256).toBe(
			new Bun.CryptoHasher("sha256")
				.update('{"subject": "fixture"}\n')
				.digest("hex"),
		);
	});

	test("a changed rubric invalidates the run", async () => {
		const { root, frozen } = await frozenRun();
		expect(
			recheck(
				{ ...frozen, rubricSha256: `sha256:${"0".repeat(64)}` },
				{ root, git: testGit },
			),
		).toEqual([expect.stringMatching(/rubric/)]);
	});

	test("a changed run configuration invalidates the run", async () => {
		const { root, frozen, config } = await frozenRun();
		writeFileSync(config, '{"subject": "elsewhere"}\n');
		expect(recheck(frozen, { root, git: testGit })).toEqual([
			expect.stringMatching(/configuration/),
		]);
	});

	test("refuses a binary whose version stamp does not match its build", async () => {
		const root = fixtureRepo();
		const run = prepareRun({ root, scratchParent: scratch });
		const built = await buildSubject({
			root,
			runDir: run.runDir,
			build: fakeBuild,
			stamp: gitStamp(testGit),
		});
		const { policy, hash } = loadPolicy();
		expect(() =>
			freeze({
				root,
				runId: run.runId,
				config: join(run.runDir, "missing-config.json"),
				subject: built.subject,
				provenance: built.provenance,
				versionOutput: readVersion(built.subject),
				policy,
				policyHash: hash,
				git: testGit,
			}),
		).toThrow(/stamp/);
	});

	test("an unchanged run rechecks clean", async () => {
		const { root, frozen } = await frozenRun();
		expect(recheck(frozen, { root, git: testGit })).toEqual([]);
	});

	test("changed binary bytes, source or evaluation files invalidate the run", async () => {
		const { root, built, frozen } = await frozenRun();
		writeFileSync(built.subject, "#!/bin/sh\necho changed\n");
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		writeAt(root, "evals/shepherd/policy.json", '{"model":"other"}\n');
		const reasons = recheck(frozen, { root, git: testGit });
		expect(reasons).toHaveLength(3);
		expect(reasons.join("\n")).toMatch(/binary/);
		expect(reasons.join("\n")).toMatch(/source/);
		expect(reasons.join("\n")).toMatch(/evaluation/);
	});

	test("results and artifacts written during the run change nothing", async () => {
		const { root, frozen } = await frozenRun();
		writeAt(root, "evals/shepherd/artifacts/x/run/A/claude.jsonl", "{}\n");
		writeAt(root, "evals/shepherd/results/x.json", "{}\n");
		expect(recheck(frozen, { root, git: testGit })).toEqual([]);
	});
});

describe("scheduling and cleanup (5.1)", () => {
	const script = (body: string) => ["bash", "-c", body];

	test("no trial starts once the invocation deadline has passed", async () => {
		for (const timeoutMs of [0, -5]) {
			const outcomes = await runTrials({
				trials: ["a"],
				command: () => script(`touch ${scratch}/started`),
				env: { PATH: process.env.PATH ?? "" },
				cwd: scratch,
				maxConcurrent: 6,
				timeoutMs,
			});
			expect(outcomes[0]?.started).toBe(false);
			expect(existsSync(join(scratch, "started"))).toBe(false);
		}
	});

	test("finished trials' groups leave the sweep set", async () => {
		await runTrials({
			trials: ["a", "b"],
			command: () => script("exit 0"),
			env: { PATH: process.env.PATH ?? "" },
			cwd: scratch,
			maxConcurrent: 1,
			timeoutMs: 20_000,
		});
		expect(liveGroupCount()).toBe(0);
	});

	test("runs at most the configured number of trials at once", async () => {
		const started = Date.now();
		const outcomes = await runTrials({
			trials: ["a", "b", "c", "d", "e"],
			command: () => script("sleep 0.3"),
			env: { PATH: process.env.PATH ?? "" },
			cwd: scratch,
			maxConcurrent: 2,
			timeoutMs: 20_000,
		});
		expect(outcomes.map((outcome) => outcome.exitCode)).toEqual([
			0, 0, 0, 0, 0,
		]);
		// Five 0.3 s trials two at a time need three waves.
		expect(Date.now() - started).toBeGreaterThanOrEqual(850);
		for (const outcome of outcomes) {
			const at = outcome.startedAt ?? 0;
			const concurrent = outcomes.filter(
				(other) => (other.startedAt ?? 0) <= at && at < (other.endedAt ?? 0),
			);
			expect(concurrent.length).toBeLessThanOrEqual(2);
		}
	});

	test("the invocation bound kills every trial's process group", async () => {
		const pids = join(scratch, "pids");
		mkdirSync(pids);
		const started = Date.now();
		const outcomes = await runTrials({
			trials: ["a", "b"],
			command: (trial) =>
				script(
					`trap '' TERM; sleep 60 & echo $! > ${pids}/${trial}; wait; sleep 60`,
				),
			env: { PATH: process.env.PATH ?? "" },
			cwd: scratch,
			maxConcurrent: 6,
			timeoutMs: 500,
			graceMs: 300,
		});
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(outcomes.every((outcome) => outcome.timedOut)).toBe(true);
		for (const trial of ["a", "b"]) {
			const pid = Number(readFileSync(join(pids, trial), "utf8"));
			expect(alive(pid)).toBe(false);
		}
	});

	test("trials not yet started when the bound expires never start", async () => {
		const outcomes = await runTrials({
			trials: ["a", "b"],
			command: (trial) => script(`touch ${scratch}/${trial}; sleep 30`),
			env: { PATH: process.env.PATH ?? "" },
			cwd: scratch,
			maxConcurrent: 1,
			timeoutMs: 300,
			graceMs: 200,
		});
		expect(existsSync(join(scratch, "b"))).toBe(false);
		expect(outcomes.find((outcome) => outcome.trial === "b")?.started).toBe(
			false,
		);
	});

	test("cancellation kills every trial's process group", async () => {
		const pids = join(scratch, "pids");
		mkdirSync(pids);
		const controller = new AbortController();
		const running = runTrials({
			trials: ["a"],
			command: (trial) => script(`sleep 60 & echo $! > ${pids}/${trial}; wait`),
			env: { PATH: process.env.PATH ?? "" },
			cwd: scratch,
			maxConcurrent: 6,
			timeoutMs: 60_000,
			graceMs: 200,
			signal: controller.signal,
		});
		while (!existsSync(join(pids, "a"))) await Bun.sleep(20);
		controller.abort();
		const outcomes = await running;
		expect(outcomes[0]?.cancelled).toBe(true);
		const pid = Number(readFileSync(join(pids, "a"), "utf8"));
		expect(alive(pid)).toBe(false);
	});

	test("a trial's leftover background processes die when it exits", async () => {
		const pids = join(scratch, "pids");
		mkdirSync(pids);
		await runTrials({
			trials: ["a"],
			command: () =>
				script(`nohup sleep 60 >/dev/null 2>&1 & echo $! > ${pids}/a`),
			env: { PATH: process.env.PATH ?? "" },
			cwd: scratch,
			maxConcurrent: 6,
			timeoutMs: 20_000,
			graceMs: 200,
		});
		const pid = Number(readFileSync(join(pids, "a"), "utf8"));
		await Bun.sleep(100);
		expect(alive(pid)).toBe(false);
	});

	test("reports each trial's exit code", async () => {
		const outcomes = await runTrials({
			trials: ["ok", "void"],
			command: (trial) => script(trial === "ok" ? "exit 0" : "exit 3"),
			env: { PATH: process.env.PATH ?? "" },
			cwd: dirname(scratch),
			maxConcurrent: 6,
			timeoutMs: 20_000,
		});
		expect(
			outcomes.map((outcome) => [outcome.trial, outcome.exitCode]),
		).toEqual([
			["ok", 0],
			["void", 3],
		]);
	});
});

describe("regression validation options (8.5)", () => {
	test("--validation with --trials names the gate trials to run", () => {
		expect(parseOptions(["--validation", "--trials", "D"])).toMatchObject({
			validation: ["D"],
		});
		expect(
			parseOptions(["--validation", "--trials", "G,E-neg"]).validation,
		).toEqual(["G", "E-neg"]);
		expect(parseOptions([]).validation).toBeUndefined();
	});

	test("a full run always runs all six: --trials needs --validation", () => {
		expect(() => parseOptions(["--trials", "D"])).toThrow(
			"--trials needs --validation; a full run always runs all six",
		);
		expect(() => parseOptions(["--validation"])).toThrow(/--trials/);
	});

	test("unknown or duplicate trials and --check are refused", () => {
		for (const trials of ["B", "D,D", "D,", "a"]) {
			expect(() => parseOptions(["--validation", "--trials", trials])).toThrow(
				/trial/,
			);
		}
		expect(() =>
			parseOptions(["--validation", "--trials", "D", "--check"]),
		).toThrow(/--check/);
	});

	test("validation never names all six trials (8.5: only the relevant trial)", () => {
		expect(() =>
			parseOptions(["--validation", "--trials", "A,D,E,G,E-neg,G-neg"]),
		).toThrow(/all six/);
		expect(
			parseOptions(["--validation", "--trials", "A,D,E,G,E-neg"]).validation,
		).toHaveLength(5);
	});

	test("a repeated --trials or --validation is refused, not last-wins", () => {
		expect(() =>
			parseOptions(["--validation", "--trials", "D", "--trials", "G"]),
		).toThrow(/once/);
		expect(() =>
			parseOptions(["--validation", "--validation", "--trials", "D"]),
		).toThrow(/once/);
	});
});

describe("the gate's scorer (fix round 3, S3)", () => {
	test("forwards each invocation to the gate as it ends", async () => {
		const dir = realpathSync(
			mkdtempSync(join(tmpdir(), "shepherd-evals-scorejobs-")),
		);
		try {
			// Never a model: a stand-in CLI whose reply is unparsable.
			const claude = join(dir, "claude");
			writeFileSync(claude, "#!/bin/sh\ncat >/dev/null\necho not-json\n");
			chmodSync(claude, 0o755);
			const reported: (string | null)[] = [];
			const scored = await scoreJobs(
				{
					claude,
					model: "claude-opus-5-5",
					effort: "high",
					timeoutMs: 10_000,
					graceMs: 100,
					workRoot: join(dir, "work"),
					env: { PATH: process.env.PATH ?? "" },
					prompt: "p",
				},
				"9.9.9",
			)({
				trial: "E",
				packet: { text: "x", sha256: `sha256:${"0".repeat(64)}`, files: [] },
				requested: ["E.M1"],
				round: 1,
				deadline: Date.now() + 60_000,
				onInvocation: (invocation) => reported.push(invocation.failure),
			});
			expect(scored.invocations).toHaveLength(2);
			expect(reported).toEqual([
				"unparsable CLI output",
				"unparsable CLI output",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
