import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createGitRunner,
	readWorktreeSource,
} from "../../scripts/shepherd-source";
import {
	git,
	initShepherdRepo,
	TEST_GIT_ENV,
	testGit,
	writeAt,
} from "../../scripts/shepherd-source-fixture";
import { artifactType } from "./export";
import {
	binaryValues,
	type ChecksOutput,
	contentText,
	pythonChecks,
	sessionValidity,
} from "./gate";
import {
	ADOPTED_GATED_PATHS,
	type GatedPathPolicy,
	isGatedPath,
} from "./gated-paths";
import { evaluationIdentity } from "./identity";
import {
	type Attempt,
	loadRubric,
	type MustOutcome,
	policyHash,
	type Result,
	type ScorerInvocation,
	totalCost,
} from "./schema";
import { buildPacket, PACKET_FILES, validateDecisions } from "./scorer";
import {
	attempt,
	behavioral,
	invocation,
	RUN_ID,
	result,
	scorerOutput,
} from "./testing";
import {
	ALWAYS_GATED,
	changedPaths,
	checkOutcome,
	ciGate,
	githubReport,
	type VerifyOptions,
	verifyResults,
} from "./verify";

const CODE_DIR = import.meta.dir;
const sha256 = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-evals-verify-")));
	initShepherdRepo(root, {
		"README.md": "outside\n",
		"docs/notes.md": "notes\n",
		"evals/shepherd/rubric.json": readFileSync(
			join(CODE_DIR, "rubric.json"),
			"utf8",
		),
		"evals/shepherd/policy.json": readFileSync(
			join(CODE_DIR, "policy.json"),
			"utf8",
		),
		"evals/shepherd/must-check.py":
			"import sys\nprint(open(sys.argv[2] + '/must-check.json').read())\n",
	});
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const head = () => git(root, "rev-parse", "HEAD").trim();
const commitAll = (message: string) => {
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", message);
	return head();
};

/** The truth the mechanical checker reports: every mechanical Must passes. */
function truthChecks(
	overrides: Record<string, MustOutcome> = {},
): (trial: string, dir: string) => ChecksOutput {
	return (trial) => {
		const value = result();
		const attempt = value.evaluation.trials.find((t) => t.trial === trial)
			?.attempts[0] as Attempt;
		const musts: Record<
			string,
			{
				class: "mechanical" | "judged";
				outcome: MustOutcome | null;
				rationale: string;
				evidence: [];
			}
		> = {};
		for (const must of attempt.musts) {
			musts[must.id] = {
				class: must.class,
				outcome:
					must.class === "mechanical" ? (overrides[must.id] ?? "pass") : null,
				rationale: "recomputed",
				evidence: [],
			};
		}
		return { checkerVersion: "must-check/1", trial, musts };
	};
}

const options = (extra: VerifyOptions = {}): VerifyOptions => ({
	git: testGit,
	checks: truthChecks(),
	...extra,
});

/**
 * A result for the working tree at `root`: its source manifest, evaluation
 * identity, rubric and policy, with every attempt's evidence written beneath
 * `evals/shepherd/artifacts/` and hashed. `edit` changes the record before
 * the evidence is written.
 */
function writeResult(
	edit: (value: Result) => void = () => {},
	base: Result = result(),
): { value: Result; path: string; hex: string } {
	const source = readWorktreeSource(root, { git: testGit });
	const identity = evaluationIdentity(root, { git: testGit });
	const evals = join(root, "evals/shepherd");
	const policy = JSON.parse(readFileSync(join(evals, "policy.json"), "utf8"));
	const hex = source.source.replace(/^sha256:/, "");
	const value = structuredClone(base);
	const revision = head();
	value.source = { hash: source.source, manifest: source.entries };
	const evaluation = value.evaluation;
	evaluation.hash = identity.hash;
	evaluation.rubricSha256 = `sha256:${sha256(readFileSync(join(evals, "rubric.json")))}`;
	evaluation.policy = policy;
	evaluation.policySha256 = policyHash(policy);
	evaluation.scorer = {
		family: policy.scorer.family,
		model: policy.scorer.model,
		effort: policy.scorer.effort,
	};
	const build = evaluation.invocations[0]?.build;
	if (build) {
		build.revision = revision;
		build.dirty = false;
		build.sourceDirty = false;
		build.version = `shepherd revision=${revision} dirty=false source=${source.source}\n`;
	}
	for (const trial of evaluation.trials) {
		for (const attempt of trial.attempts) {
			attempt.artifactDir = `artifacts/${hex}/${RUN_ID}/${trial.trial}/attempt-${attempt.ordinal}`;
			const extra: [string, string][] = [["claude-run.json", "run-manifest"]];
			if (attempt.kind === "behavioral")
				extra.push(
					["claude-baseline.json", "snapshot"],
					["must-check.json", "mechanical-checks"],
				);
			// A scored attempt archives every file its packet shows.
			if (attempt.scoring)
				for (const [name] of PACKET_FILES)
					extra.push([name, artifactType(name)]);
			for (const [path, type] of extra) {
				if (attempt.artifacts.some((a) => a.path === path)) continue;
				attempt.artifacts.push({
					path,
					sha256: "",
					bytes: 0,
					type,
					redactions: 0,
				});
			}
			for (const artifact of attempt.artifacts)
				putArtifact(attempt, artifact.path, evidence(attempt, artifact.path));
			if (attempt.scoring) archiveScoring(attempt);
		}
	}
	edit(value);
	const path = join(evals, "results", `${hex}.json`);
	writeAt(
		root,
		`evals/shepherd/results/${hex}.json`,
		`${JSON.stringify(value, null, "\t")}\n`,
	);
	return { value, path, hex };
}

const text = (lines: string[]) => lines.join("\n");

const STDOUT = "Done the NEXT first.";

/** Write an archived artifact, listing it if it is not, with its hash and length. */
function putArtifact(a: Attempt, name: string, content: string) {
	writeAt(join(root, "evals/shepherd"), `${a.artifactDir}/${name}`, content);
	let artifact = a.artifacts.find((x) => x.path === name);
	if (!artifact) {
		artifact = {
			path: name,
			sha256: "",
			bytes: 0,
			type: artifactType(name),
			redactions: 0,
		};
		a.artifacts.push(artifact);
	}
	artifact.sha256 = sha256(content);
	artifact.bytes = Buffer.byteLength(content);
}

/** Real-shaped evidence of one archived file of `attempt`. */
function evidence(attempt: Attempt, name: string): string {
	const snapshot = () =>
		`${JSON.stringify({
			snapshotVersion: 1,
			files: {
				".shepherd/CURRENT.md": {
					type: "file",
					encoding: "utf-8",
					content: "Updated: 2026-10-13\nFirst move: held\n",
				},
			},
		})}\n`;
	switch (name) {
		case "claude-run.json":
			return `${JSON.stringify(runManifest(attempt))}\n`;
		case "claude.jsonl":
			return sessionLog(
				attempt.binaryEvidence.expected,
				attempt.binaryEvidence.callIds,
			);
		case "claude-baseline.json":
		case "claude-final.json":
			return snapshot();
		case "claude-stdout.txt":
			return `${STDOUT}\n`;
		default:
			return `${attempt.trial} ${attempt.ordinal} ${name}\n`;
	}
}

/**
 * The archived packet and one scorer output per invocation, as the gate
 * writes them: a verdict's output decides the requested Musts as recorded,
 * citing the final answer, and the recorded Musts are its validated decisions.
 */
function archiveScoring(attempt: Attempt) {
	const scoring = attempt.scoring;
	if (!scoring) return;
	const packet = buildPacket({
		trial: attempt.trial,
		dir: join(root, "evals/shepherd", attempt.artifactDir),
		requested: scoring.requested,
		rubric: loadRubric(),
	});
	putArtifact(attempt, scoring.packet, packet.text);
	scoring.packetSha256 = packet.sha256;
	scoring.invocations.forEach((invocation, index) => {
		invocation.packetSha256 = packet.sha256;
		let output: string;
		if (invocation.failure === null) {
			const reply = JSON.stringify({
				decisions: scoring.requested.map((id) => {
					const must = attempt.musts.find((m) => m.id === id);
					return {
						id,
						outcome: must?.outcome ?? "inconclusive",
						rationale: must?.rationale ?? "handmade",
						evidence: [
							{ artifact: "claude-stdout.txt", line: 1, quote: STDOUT },
						],
					};
				}),
			});
			const checked = validateDecisions(reply, scoring.requested, packet);
			if ("failure" in checked) throw new Error(checked.failure);
			for (const decision of checked.decisions) {
				const must = attempt.musts.find((m) => m.id === decision.id);
				if (must) {
					must.outcome = decision.outcome;
					must.rationale = decision.rationale;
					must.evidence = decision.evidence;
				}
			}
			output = scorerOutput(reply, invocation);
		} else output = scorerOutput("not a reply", invocation);
		putArtifact(
			attempt,
			`scorer-${index + 1}-r${invocation.round}.json`,
			output,
		);
	});
}

/** The harness's `claude-run.json` as the gate would have read it for `attempt`. */
function runManifest(attempt: Attempt) {
	return {
		argv: attempt.subject?.argv,
		validity: { valid: attempt.valid, void_reasons: attempt.voidReasons },
		provenance: [
			{
				expected_binary: attempt.binaryEvidence.expected,
				evidence_call_ids: attempt.binaryEvidence.callIds,
				unexpected_binaries: attempt.binaryEvidence.unexpected.map((u) => ({
					call_id: u.callId,
					binary: u.binary,
				})),
			},
		],
		started_at: attempt.startedAt,
		ended_at: attempt.endedAt,
	};
}

describe("gated paths (7.3)", () => {
	const SOURCE = [
		"agents/shepherd.md",
		"agents/shepherd.ts",
		"system-prompts/shepherd/core.md",
		"system-prompts/shepherd/integrations/herdr.md",
		"lib/shepherd/tool.ts",
		"lib/agent-format/cli.ts",
		"scripts/compile.ts",
		"scripts/compile-all.ts",
		"scripts/agent-compiler.ts",
		"scripts/binary-name.ts",
		"scripts/shepherd-source.ts",
		"package.json",
		"bun.lock",
		"tsconfig.json",
	];
	const EVALUATION = [
		"evals/shepherd/policy.json",
		"evals/shepherd/rubric.json",
		"evals/shepherd/scorer-prompt.md",
		"evals/shepherd/must-check.py",
		"evals/shepherd/harness.py",
		"evals/shepherd/schema.ts",
		"evals/shepherd/verify.ts",
		"evals/shepherd/gated-paths.ts",
		"evals/shepherd/testdata/A.jsonl",
	];
	const NEVER = [
		"README.md",
		"docs/SHEPHERD.md",
		"docs/SHEPHERD-EVALS.md",
		".github/workflows/ci.yml",
		"agents/coach.md",
		"scripts/watch-agents.ts",
		"evals/shepherd/results/abc.json",
		"evals/shepherd/results/abc.md",
		"evals/shepherd/artifacts/abc/run/A/attempt-1/claude.jsonl",
		"evals/shepherd/validation/abc/run/A/attempt-1/claude.jsonl",
		"evals/shepherd/__pycache__/harness.cpython-314.pyc",
		"evals/shepherd/harness.pyc",
		"evals/other/policy.json",
	];

	test("the adopted policy is the expanded recommendation", () => {
		expect(ADOPTED_GATED_PATHS).toBe("expanded");
	});

	test("expanded: every section 1 source path and the evaluation implementation and policy", () => {
		for (const path of [...SOURCE, ...EVALUATION]) {
			expect([path, isGatedPath(path)]).toEqual([path, true]);
		}
		for (const path of [
			...NEVER,
			"lib/shepherd/tool.test.ts",
			"lib/agent-format/cli.spec.ts",
			"lib/agent-format/__fixtures__/a.md",
			"lib/shepherd/__snapshots__/tool.snap",
		]) {
			expect([path, isGatedPath(path)]).toEqual([path, false]);
		}
	});

	test("narrower: the agreed candidate, and the gaps it leaves", () => {
		const narrower: GatedPathPolicy = "narrower";
		for (const path of [
			"system-prompts/shepherd/core.md",
			"agents/shepherd.ts",
			"lib/shepherd/tool.ts",
			"lib/shepherd/tool.test.ts",
		]) {
			expect([path, isGatedPath(path, narrower)]).toEqual([path, true]);
		}
		for (const path of [
			...NEVER,
			"agents/shepherd.md",
			"lib/agent-format/cli.ts",
			"scripts/agent-compiler.ts",
			"package.json",
			"evals/shepherd/rubric.json",
			"evals/shepherd/policy.json",
		]) {
			expect([path, isGatedPath(path, narrower)]).toEqual([path, false]);
		}
	});
});

describe("changed paths (7.2)", () => {
	test("diffs from the merge base, so base-only changes are not the PR's", () => {
		const fork = head();
		git(root, "checkout", "-q", "-b", "pr");
		writeAt(root, "docs/notes.md", "pr notes\n");
		const tip = commitAll("pr");
		git(root, "checkout", "-q", "main");
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		const base = commitAll("base moves on");
		git(root, "checkout", "-q", "pr");
		const changed = changedPaths(root, base, tip, { git: testGit });
		expect(changed).toEqual({
			base,
			head: tip,
			mergeBase: fork,
			paths: ["docs/notes.md"],
		});
	});

	test("includes deletions, both sides of renames and unusual names", () => {
		const base = head();
		git(root, "mv", "lib/shepherd/tool.ts", "docs/tool.ts");
		git(root, "mv", "docs/notes.md", "system-prompts/shepherd/notes.md");
		git(root, "rm", "-q", "lib/agent-format/run.ts");
		writeAt(root, "docs/odd name\twith tab é.md", "odd\n");
		const tip = commitAll("renames");
		const { paths } = changedPaths(root, base, tip, { git: testGit });
		expect(paths.sort()).toEqual(
			[
				"docs/notes.md",
				"docs/odd name\twith tab é.md",
				"docs/tool.ts",
				"lib/agent-format/run.ts",
				"lib/shepherd/tool.ts",
				"system-prompts/shepherd/notes.md",
			].sort(),
		);
		expect(paths.filter((path) => isGatedPath(path)).sort()).toEqual([
			"lib/agent-format/run.ts",
			"lib/shepherd/tool.ts",
			"system-prompts/shepherd/notes.md",
		]);
	});

	test("an unresolvable revision or a missing merge base fails closed", () => {
		const tip = head();
		expect(() =>
			changedPaths(root, "0".repeat(40), tip, { git: testGit }),
		).toThrow(/base/);
		expect(() =>
			changedPaths(root, tip, "no-such-ref", { git: testGit }),
		).toThrow(/head/);
		git(root, "checkout", "-q", "--orphan", "unrelated");
		writeAt(root, "README.md", "unrelated\n");
		const other = commitAll("unrelated");
		expect(() => changedPaths(root, tip, other, { git: testGit })).toThrow(
			/merge base/,
		);
	});

	test("a failing diff fails closed", () => {
		const tip = head();
		const failingDiff: typeof testGit = (args, cwd, input) =>
			args.includes("diff")
				? { code: 128, stdout: new Uint8Array(), stderr: "fatal: bad object" }
				: testGit(args, cwd, input);
		expect(() => changedPaths(root, tip, tip, { git: failingDiff })).toThrow(
			/diff/,
		);
	});
});

describe("CI gate (7.4, 7.5)", () => {
	test("outside gated paths succeeds without evaluation and names the compared revisions", () => {
		const base = head();
		writeAt(root, "README.md", "changed\n");
		writeAt(root, "lib/shepherd/tool.test.ts", "test\n");
		const tip = commitAll("docs");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		expect(text(outcome.lines)).toContain("Shepherd evals not required");
		expect(text(outcome.lines)).toContain(base);
		expect(text(outcome.lines)).toContain(tip);
	});

	test("a result-only commit needs no evaluation and keeps the source identity", () => {
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		const base = commitAll("source");
		const before = readWorktreeSource(root, { git: testGit }).source;
		writeResult();
		writeAt(
			root,
			"evals/shepherd/validation/x/run/A/attempt-1/claude.jsonl",
			"v\n",
		);
		const tip = commitAll("results");
		expect(readWorktreeSource(root, { git: testGit }).source).toBe(before);
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		expect(text(outcome.lines)).toContain("Shepherd evals not required");
	});

	test("a gated change without a result succeeds with a notice naming the expected file", () => {
		const base = head();
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		const tip = commitAll("source");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		expect(text(outcome.lines)).toMatch(/no result/i);
		const hex = readWorktreeSource(root, { git: testGit }).source.slice(7);
		expect(text(outcome.lines)).toContain(`results/${hex}.json`);
		expect(text(outcome.lines)).toContain("lib/shepherd/tool.ts");
	});

	test("a matching passing result succeeds and reports its provenance", () => {
		const base = head();
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		commitAll("source");
		writeResult();
		const tip = commitAll("results");
		const outcome = ciGate(root, base, tip, options());
		expect(text(outcome.lines)).not.toContain("problem");
		expect(outcome.code).toBe(0);
		const out = text(outcome.lines);
		expect(out).toContain("pass");
		expect(out).toMatch(/revision=[0-9a-f]{40} dirty=false sourceDirty=false/);
	});

	test("a result for an earlier source is not this tree's: only the exact source hash counts", () => {
		const base = head();
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		commitAll("source");
		writeResult();
		commitAll("results");
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 3;\n");
		const tip = commitAll("source changed after evaluation");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		expect(text(outcome.lines)).toMatch(/no result/i);
		expect(text(outcome.lines)).not.toContain("result verified");
	});

	test("the checkout must be the PR head, not a merge checkout", () => {
		const base = head();
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		const tip = commitAll("source");
		git(root, "checkout", "-q", base);
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(1);
		expect(text(outcome.lines)).toMatch(/not the PR head/);
	});

	test("revision failures fail closed", () => {
		const outcome = ciGate(root, "no-such-base", head(), options());
		expect(outcome.code).toBe(1);
		expect(text(outcome.lines)).toMatch(/base/);
	});
});

describe("verification (7.4)", () => {
	const verify = (extra: VerifyOptions = {}) =>
		verifyResults(root, options(extra));

	test("a missing result is found missing, not a problem, and names the exact file", () => {
		const outcome = verify();
		expect([outcome.found, outcome.ok, outcome.problems]).toEqual([
			false,
			false,
			[],
		]);
		const hex = readWorktreeSource(root, { git: testGit }).source.slice(7);
		expect(text(outcome.notes)).toMatch(/no result/i);
		expect(text(outcome.notes)).toContain(`results/${hex}.json`);
	});

	test("a matching result passes", () => {
		writeResult();
		const outcome = verify();
		expect(outcome.problems).toEqual([]);
		expect(outcome.ok).toBe(true);
	});

	test("the default checker is the verified tree's must-check.py", () => {
		writeResult((value) => {
			for (const trial of value.evaluation.trials) {
				for (const attempt of trial.attempts) {
					const dir = join(root, "evals/shepherd", attempt.artifactDir);
					const checked = truthChecks()(trial.trial, dir);
					const body = `${JSON.stringify(checked)}\n`;
					writeFileSync(join(dir, "must-check.json"), body);
					const artifact = attempt.artifacts.find(
						(a) => a.path === "must-check.json",
					);
					if (artifact) {
						artifact.sha256 = sha256(body);
						artifact.bytes = Buffer.byteLength(body);
					}
				}
			}
		});
		const outcome = verifyResults(root, { git: testGit });
		expect(outcome.problems).toEqual([]);
	});

	test("a rubric change makes the result stale: not verified, not a problem", () => {
		const { value } = writeResult();
		writeAt(
			root,
			"evals/shepherd/rubric.json",
			`${readFileSync(join(root, "evals/shepherd/rubric.json"), "utf8")}\n`,
		);
		const outcome = verify();
		expect([outcome.ok, outcome.problems, outcome.outcome]).toEqual([
			false,
			[],
			undefined,
		]);
		expect(outcome.stale).toMatchObject({
			recorded: value.evaluation.hash,
			current: evaluationIdentity(root, { git: testGit }).hash,
		});
	});

	test("a policy change makes the result stale: not verified, not a problem", () => {
		writeResult();
		const path = join(root, "evals/shepherd/policy.json");
		const policy = JSON.parse(readFileSync(path, "utf8"));
		policy.subjectTimeoutSeconds = 600;
		writeFileSync(path, JSON.stringify(policy));
		const outcome = verify();
		expect([outcome.ok, outcome.problems]).toEqual([false, []]);
		expect(outcome.stale?.current).toBe(
			evaluationIdentity(root, { git: testGit }).hash,
		);
	});

	test("a recorded rubric hash, policy or scorer that differs from the tree fails", () => {
		writeResult((value) => {
			value.evaluation.rubricSha256 = `sha256:${"1".repeat(64)}`;
		});
		expect(text(verify().problems)).toMatch(/rubric/);
		writeResult((value) => {
			value.evaluation.policy = { ...value.evaluation.policy, effort: "low" };
			value.evaluation.policySha256 = policyHash(value.evaluation.policy);
		});
		expect(text(verify().problems)).toMatch(/policy/);
		writeResult((value) => {
			value.evaluation.scorer.model = "claude-haiku-5-5";
		});
		expect(text(verify().problems)).toMatch(/scorer/);
	});

	test("bad provenance fails: version line, binary markers, subject and scorer models", () => {
		writeResult((value) => {
			const build = value.evaluation.invocations[0]?.build;
			if (build)
				build.version = build.version.replace(
					/source=sha256:./,
					"source=sha256:0",
				);
		});
		expect(text(verify().problems)).toMatch(/version/);
		writeResult((value) => {
			const attempt = value.evaluation.trials[0]?.attempts[0];
			attempt?.binaryEvidence.unexpected.push({
				callId: "toolu_x",
				binary: "/Users/someone/Projects/troupe/bin/shepherd",
			});
		});
		expect(text(verify().problems)).toMatch(/binary/);
		writeResult((value) => {
			const attempt = value.evaluation.trials[1]?.attempts[0];
			if (attempt) attempt.binaryEvidence.callIds = [];
		});
		expect(text(verify().problems)).toMatch(/binary/);
		writeResult((value) => {
			const subject = value.evaluation.trials[2]?.attempts[0]?.subject;
			if (subject) subject.observedModels = ["claude-sonnet-5-5"];
		});
		expect(text(verify().problems)).toMatch(/model/);
		writeResult((value) => {
			const invocation =
				value.evaluation.trials[3]?.attempts[0]?.scoring?.invocations[0];
			if (invocation) invocation.requestedModel = "claude-haiku-5-5";
		});
		expect(text(verify().problems)).toMatch(/scorer/);
		writeResult((value) => {
			const recheck = value.evaluation.invocations[0]?.recheck;
			if (recheck) {
				recheck.valid = false;
				recheck.reasons = ["binary bytes changed"];
			}
		});
		expect(text(verify().problems)).toMatch(/recheck/);
	});

	test("a forged aggregate status fails; an honest blocked one verifies and reads blocked", () => {
		writeResult(
			(value) => {
				value.outcome = "pass";
				value.evaluation.outcome = "pass";
			},
			result({ "G-neg.M2": "fail" }),
		);
		expect(
			text(verify({ checks: truthChecks({ "G-neg.M2": "fail" }) }).problems),
		).toMatch(/does not match/);
		writeResult(() => {}, result({ "G-neg.M2": "fail" }));
		const blocked = verify({ checks: truthChecks({ "G-neg.M2": "fail" }) });
		expect(blocked.problems).toEqual([]);
		expect(blocked.ok).toBe(true);
		expect(blocked.outcome?.aggregate).toBe("blocked");
		expect(text(blocked.notes)).toMatch(/Outcome blocked: .*G-neg pending/);
	});

	test("missing and duplicate Musts fail", () => {
		writeResult((value) => {
			value.evaluation.trials[0]?.attempts[0]?.musts.pop();
		});
		expect(text(verify().problems)).toMatch(/missing Musts/);
		writeResult((value) => {
			const musts = value.evaluation.trials[0]?.attempts[0]?.musts;
			if (musts?.[0]) musts.push(structuredClone(musts[0]));
		});
		expect(text(verify().problems)).toMatch(/duplicate Must/);
	});

	test("recomputed mechanical checks must match the recorded outcomes", () => {
		writeResult();
		const forged = verify({ checks: truthChecks({ "G.M2": "fail" }) });
		expect(forged.ok).toBe(false);
		expect(text(forged.problems)).toMatch(/G\.M2/);
		const corrupted = verify({
			checks: (trial) =>
				trial === "D"
					? { error: "claude-final.json: corrupted" }
					: truthChecks()(trial, ""),
		});
		expect(corrupted.ok).toBe(false);
		expect(text(corrupted.problems)).toMatch(/corrupted/);
	});

	test("evidence corruption fails: changed bytes, a missing file, a symlink", () => {
		const { value } = writeResult();
		const dir = (n: number) =>
			join(
				root,
				"evals/shepherd",
				value.evaluation.trials[n]?.attempts[0]?.artifactDir ?? "",
			);
		writeFileSync(join(dir(0), "claude.jsonl"), "tampered\n");
		rmSync(join(dir(1), "claude-final.json"));
		const copy = join(root, "elsewhere.json");
		cpSync(join(dir(2), "claude-final.json"), copy);
		rmSync(join(dir(2), "claude-final.json"));
		symlinkSync(copy, join(dir(2), "claude-final.json"));
		const problems = text(verify().problems);
		expect(problems).toMatch(/A attempt 1: .*claude\.jsonl does not match/);
		expect(problems).toMatch(/D attempt 1: .*claude-final\.json is missing/);
		expect(problems).toMatch(
			/E attempt 1: .*claude-final\.json is missing or not a regular file/,
		);
	});

	test("set-aside partial exports and unreferenced files are ignored", () => {
		const { value } = writeResult();
		const dir = join(
			root,
			"evals/shepherd",
			value.evaluation.trials[0]?.attempts[0]?.artifactDir ?? "",
		);
		writeAt(
			root,
			`${dir.slice(root.length + 1)}.partial/claude.jsonl`,
			"partial\n",
		);
		writeAt(root, `${dir.slice(root.length + 1)}/stray.txt`, "stray\n");
		expect(verify().problems).toEqual([]);
	});

	test("never reads validation output or other result files", () => {
		writeResult();
		const other = "evals/shepherd/results/0000.json";
		const validation =
			"evals/shepherd/validation/x/run/A/attempt-1/claude.jsonl";
		writeAt(root, other, "not json\n");
		writeAt(root, validation, "not evidence\n");
		chmodSync(join(root, other), 0);
		chmodSync(join(root, validation), 0);
		try {
			expect(verify().problems).toEqual([]);
		} finally {
			chmodSync(join(root, other), 0o644);
			chmodSync(join(root, validation), 0o644);
		}
	});

	test("a validation result for the same source never stands in for the gate's", () => {
		const { path, hex } = writeResult();
		// Where a validation run of this source keeps its result and evidence.
		const dir = `evals/shepherd/validation/${hex}/${RUN_ID}`;
		writeAt(root, `${dir}/result.json`, readFileSync(path, "utf8"));
		rmSync(path);
		const outcome = verify();
		expect([outcome.found, outcome.ok, outcome.problems]).toEqual([
			false,
			false,
			[],
		]);
		expect(text(outcome.notes)).toMatch(/no result/i);
	});

	test("dirty builds are reported, not rejected", () => {
		writeResult((value) => {
			const build = value.evaluation.invocations[0]?.build;
			if (build) {
				build.dirty = true;
				build.sourceDirty = true;
				build.version = build.version.replace("dirty=false", "dirty=true");
			}
		});
		const outcome = verify();
		expect(outcome.problems).toEqual([]);
		expect(text(outcome.notes)).toMatch(/dirty=true sourceDirty=true/);
	});

	test("a flaky pass verifies and is reported", () => {
		const first = behavioral("G-neg", "pass", 1, { "G-neg.M3": "fail" });
		const flaky = result(
			{},
			{ "G-neg": [first, behavioral("G-neg", "pass", 2)] },
		);
		writeResult(() => {}, flaky);
		const outcome = verify();
		expect(outcome.problems).toEqual([]);
		expect(text(outcome.notes)).toMatch(/flaky-pass/);
	});

	test("a rebased branch with an identical manifest verifies without its build revision in history", () => {
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		commitAll("source");
		const { value } = writeResult();
		const evaluated = value.evaluation.invocations[0]?.build.revision ?? "";
		commitAll("results");
		// Replay the same tree on a new root commit: the evaluated revision is gone.
		git(root, "checkout", "-q", "--orphan", "rebased");
		writeAt(root, "README.md", "a new base\n");
		const tip = commitAll("rebased");
		expect(
			testGit(["merge-base", "--is-ancestor", evaluated, tip], root).code,
		).toBe(1);
		const outcome = verify();
		expect(outcome.problems).toEqual([]);
		expect(text(outcome.notes)).toContain(evaluated);
	});

	test("an untracked source entry committed since compares equal and is reported (R3)", () => {
		writeAt(root, "lib/shepherd/new.ts", "export const fresh = 1;\n");
		writeResult();
		commitAll("stage the new source");
		const outcome = verify();
		expect(outcome.problems).toEqual([]);
		expect(text(outcome.notes)).toContain("lib/shepherd/new.ts");
	});

	test("an untracked source entry cannot silently disappear", () => {
		writeAt(root, "lib/shepherd/new.ts", "export const fresh = 1;\n");
		writeResult();
		rmSync(join(root, "lib/shepherd/new.ts"));
		expect(verify().ok).toBe(false);
		const { value } = writeResult();
		// A record whose manifest lists an entry the tree lacks, under the tree's hash.
		value.source.manifest.push({
			path: "lib/shepherd/gone.ts",
			bytes: 1,
			sha256: "c".repeat(64),
			untracked: true,
		});
		const hex = value.source.hash.slice(7);
		writeAt(root, `evals/shepherd/results/${hex}.json`, JSON.stringify(value));
		const outcome = verify();
		expect(outcome.ok).toBe(false);
		expect(text(outcome.problems)).toContain("lib/shepherd/gone.ts");
	});

	test("evidence outside the source hash's artifact directory fails", () => {
		writeResult((value) => {
			const attempt = value.evaluation.trials[0]?.attempts[0];
			if (!attempt) return;
			const elsewhere = attempt.artifactDir.replace(
				/^artifacts\/[0-9a-f]+/,
				`artifacts/${"d".repeat(64)}`,
			);
			const evals = join(root, "evals/shepherd");
			cpSync(join(evals, attempt.artifactDir), join(evals, elsewhere), {
				recursive: true,
			});
			attempt.artifactDir = elsewhere;
		});
		expect(verify().problems).toEqual([
			expect.stringMatching(
				/^A attempt 1: artifact directory artifacts\/d{64}\/.* is not artifacts\/[0-9a-f]{64}\/[^/]+\/A\/attempt-1$/,
			),
		]);
	});
});

describe("fix round 1 (review-c4)", () => {
	const verify = (extra: VerifyOptions = {}) =>
		verifyResults(root, options(extra));
	const evalsAt = (attemptDir: string) =>
		join(root, "evals/shepherd", attemptDir);
	const rewrite = (dir: string, name: string, text: string) =>
		writeFileSync(join(dir, name), text);

	test("F1: the core files are gated whatever the policy predicates say", () => {
		expect([...ALWAYS_GATED].sort()).toEqual([
			"evals/shepherd/gated-paths.ts",
			"evals/shepherd/identity.ts",
			"evals/shepherd/verify.ts",
			"scripts/shepherd-source.ts",
		]);
		for (const path of ALWAYS_GATED) {
			const base = head();
			writeAt(root, path, `// changed ${path}\n`);
			const tip = commitAll(`change ${path}`);
			const outcome = ciGate(
				root,
				base,
				tip,
				options({ isGated: () => false }),
			);
			expect([path, outcome.code]).toEqual([path, 0]);
			expect(text(outcome.lines)).toContain(path);
			expect(text(outcome.lines)).toMatch(/no result/);
			expect(text(outcome.lines)).not.toContain("not required");
		}
	});

	test("F2: the checker sees only listed, hash-verified artifacts, copied to a fresh directory", () => {
		const { value } = writeResult();
		const a = value.evaluation.trials[0]?.attempts[0] as Attempt;
		writeAt(root, `evals/shepherd/${a.artifactDir}/stray.json`, "{}\n");
		const seen: { dir: string; names: string[] }[] = [];
		const outcome = verify({
			checks: (trial, dir) => {
				seen.push({ dir, names: readdirSync(dir).sort() });
				return truthChecks()(trial, dir);
			},
		});
		expect(outcome.problems).toEqual([]);
		expect(seen).toHaveLength(6);
		for (const { dir } of seen) expect(dir.startsWith(root)).toBe(false);
		expect(seen[0]?.names).toEqual(a.artifacts.map((x) => x.path).sort());
	});

	test("F2: claude-run.json must be archived, regular and hash-matching", () => {
		const { value } = writeResult();
		const dir = (n: number) =>
			evalsAt(value.evaluation.trials[n]?.attempts[0]?.artifactDir ?? "");
		rewrite(dir(0), "claude-run.json", '{"validity":{"valid":true}}\n');
		const copy = join(root, "elsewhere.json");
		cpSync(join(dir(1), "claude-run.json"), copy);
		rmSync(join(dir(1), "claude-run.json"));
		symlinkSync(copy, join(dir(1), "claude-run.json"));
		const seen: string[] = [];
		const problems = text(
			verify({
				checks: (trial, d) => {
					seen.push(`${trial}:${readdirSync(d).includes("claude-run.json")}`);
					return truthChecks()(trial, d);
				},
			}).problems,
		);
		expect(problems).toMatch(/A attempt 1: .*claude-run\.json does not match/);
		expect(problems).toMatch(
			/D attempt 1: .*claude-run\.json is missing or not a regular file/,
		);
		// Neither unverified copy reached the checker.
		expect(
			seen.filter((s) => s.startsWith("A:") || s.startsWith("D:")),
		).toEqual(["A:false", "D:false"]);
		writeResult((v) => {
			const t = v.evaluation.trials[2]?.attempts[0];
			if (t)
				t.artifacts = t.artifacts.filter((x) => x.path !== "claude-run.json");
		});
		expect(text(verify().problems)).toMatch(
			/E attempt 1: evidence claude-run\.json is not archived/,
		);
	});

	test("F3: a symlinked result file is refused", () => {
		const { path, hex } = writeResult();
		const moved = `evals/shepherd/validation/${hex}/run/result.json`;
		writeAt(root, moved, readFileSync(path, "utf8"));
		rmSync(path);
		symlinkSync(`../validation/${hex}/run/result.json`, path);
		const outcome = verify();
		expect(outcome.ok).toBe(false);
		expect(text(outcome.problems)).toMatch(/not a regular file/);
	});

	test("F4: a valid session relabelled void before a pass fails (probe P1)", () => {
		const relabelled = attempt("A", "void");
		relabelled.valid = true;
		relabelled.voidReasons = ["relabelled"];
		relabelled.binaryEvidence.callIds = ["toolu_start"];
		const pass = behavioral("A", "pass", 1);
		pass.ordinal = 2;
		pass.artifactDir = pass.artifactDir.replace(/attempt-1$/, "attempt-2");
		writeResult(() => {}, result({}, { A: [relabelled, pass] }));
		expect(text(verify().problems)).toMatch(
			/A attempt 1: a void attempt is recorded valid/,
		);
	});

	test("F4: a valid session recorded void whose checks run fails", () => {
		const hidden = attempt("A", "void");
		hidden.valid = true;
		hidden.voidReasons = [];
		hidden.binaryEvidence.callIds = ["toolu_start"];
		const pass = behavioral("A", "pass", 1);
		pass.ordinal = 2;
		pass.artifactDir = pass.artifactDir.replace(/attempt-1$/, "attempt-2");
		writeResult(
			(v) => {
				const first = v.evaluation.trials[0]?.attempts[0];
				if (first) {
					first.valid = false;
					first.voidReasons = ["relabelled"];
				}
			},
			result({}, { A: [hidden, pass] }),
		);
		expect(text(verify().problems)).toMatch(/A attempt 1: .*recorded void/);
	});

	test("F4: binary evidence must match the archived claude-run.json", () => {
		writeResult((v) => {
			const a = v.evaluation.trials[3]?.attempts[0];
			if (a) a.binaryEvidence.callIds = ["toolu_other"];
		});
		expect(text(verify().problems)).toMatch(/G attempt 1: .*binary evidence/);
	});

	test("F5: the checker never runs cached bytecode", () => {
		const dir = realpathSync(
			mkdtempSync(join(tmpdir(), "shepherd-evals-pyc-")),
		);
		try {
			const helper = join(dir, "helper.py");
			const checker = join(dir, "checker.py");
			writeFileSync(
				checker,
				"import importlib.util, json, os, sys\n" +
					"here = os.path.dirname(os.path.abspath(__file__))\n" +
					"spec = importlib.util.spec_from_file_location('helper', os.path.join(here, 'helper.py'))\n" +
					"m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n" +
					"print(json.dumps({'checkerVersion': m.VALUE, 'trial': sys.argv[1], 'musts': {}}))\n",
			);
			writeFileSync(helper, "VALUE = 'planted'\n");
			const plant = Bun.spawnSync([
				"python3",
				"-c",
				"import importlib.util, py_compile, sys\n" +
					"py_compile.compile(sys.argv[1], cfile=importlib.util.cache_from_source(sys.argv[1]), invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)",
				helper,
			]);
			expect(plant.exitCode).toBe(0);
			writeFileSync(helper, "VALUE = 'source'\n");
			const out = pythonChecks("A", dir, checker);
			expect(out).toMatchObject({ checkerVersion: "source" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("F6 (M15, M14): a behavioural attempt without archived checks fails; an interrupted one passes", () => {
		writeResult((v) => {
			const a = v.evaluation.trials[1]?.attempts[0];
			if (a)
				a.artifacts = a.artifacts.filter((x) => x.path !== "must-check.json");
		});
		expect(text(verify().problems)).toMatch(
			/D attempt 1: no archived mechanical checks/,
		);
		const interrupted = behavioral("D", "inconclusive", 1);
		interrupted.interrupted = 0;
		interrupted.scoring = null;
		interrupted.cost.scorer = [];
		interrupted.musts = interrupted.musts.map((m) => ({
			...m,
			checkerVersion: "gate:interrupted",
			scorer: null,
			evidence: [],
		}));
		interrupted.artifacts = interrupted.artifacts.filter(
			(x) => x.path !== "packet.md",
		);
		const pass = behavioral("D", "pass", 2);
		writeResult(
			(v) => {
				const a = v.evaluation.trials[1]?.attempts[0];
				if (!a) return;
				a.artifacts = a.artifacts.filter((x) => x.path !== "must-check.json");
				// Resolved from a pending launch: the harness never finished, so its
				// manifest still holds the placeholder validity written at start.
				const placeholder = `${JSON.stringify({ validity: { valid: false, void_reasons: [] }, provenance: [], ended_at: null })}\n`;
				rewrite(evalsAt(a.artifactDir), "claude-run.json", placeholder);
				const run = a.artifacts.find((x) => x.path === "claude-run.json");
				if (run) {
					run.sha256 = sha256(placeholder);
					run.bytes = Buffer.byteLength(placeholder);
				}
				setArtifact(
					a,
					"claude.jsonl",
					sessionLog(a.binaryEvidence.expected, a.binaryEvidence.callIds),
				);
			},
			result({}, { D: [interrupted, pass] }),
		);
		expect(verify().problems).toEqual([]);
	});

	test("F6 (M6): a checked attempt must archive its snapshots", () => {
		writeResult((v) => {
			const a = v.evaluation.trials[1]?.attempts[0];
			if (a)
				a.artifacts = a.artifacts.filter(
					(x) => x.path !== "claude-baseline.json",
				);
		});
		expect(text(verify().problems)).toMatch(
			/D attempt 1: evidence claude-baseline\.json is not archived/,
		);
	});

	test("F6 (M1): a verdict from another scorer model fails", () => {
		writeResult((v) => {
			const i = v.evaluation.trials[2]?.attempts[0]?.scoring?.invocations[0];
			if (i) i.observedModels = ["claude-sonnet-5-5"];
		});
		expect(text(verify().problems)).toMatch(
			/E attempt 1: scorer invocation 0 observed claude-sonnet-5-5/,
		);
	});

	test("F6 (M7): a void attempt holding mechanical checks fails", () => {
		const v1 = attempt("G", "void");
		v1.artifacts.push({
			path: "must-check.json",
			sha256: "",
			bytes: 0,
			type: "mechanical-checks",
			redactions: 0,
		});
		const pass = behavioral("G", "pass", 1);
		pass.ordinal = 2;
		pass.artifactDir = pass.artifactDir.replace(/attempt-1$/, "attempt-2");
		writeResult(() => {}, result({}, { G: [v1, pass] }));
		expect(text(verify().problems)).toMatch(
			/G attempt 1: a void attempt holds mechanical checks/,
		);
	});

	test("F6 (M10): a valid attempt with no expected binary fails", () => {
		const a = behavioral("E-neg", "pass", 1);
		a.binaryEvidence.expected = "";
		writeResult(() => {}, result({}, { "E-neg": [a] }));
		expect(text(verify().problems)).toMatch(
			/E-neg attempt 1: no in-session binary marker/,
		);
	});

	test("F6 (M9): a diff path that is not UTF-8 fails closed", () => {
		const tip = head();
		const latin1: typeof testGit = (args, cwd, input) =>
			args.includes("diff")
				? { code: 0, stdout: new Uint8Array([0x61, 0xff, 0x62, 0]), stderr: "" }
				: testGit(args, cwd, input);
		expect(() => changedPaths(root, tip, tip, { git: latin1 })).toThrow(
			/UTF-8/,
		);
	});

	test("F7: the scored packet must be the archived packet", () => {
		writeResult((v) => {
			const s = v.evaluation.trials[2]?.attempts[0]?.scoring;
			if (s) {
				s.packetSha256 = `sha256:${"9".repeat(64)}`;
				for (const i of s.invocations) i.packetSha256 = s.packetSha256;
			}
		});
		expect(text(verify().problems)).toMatch(/E attempt 1: .*packet/);
	});

	test("F8: every non-void attempt names its subject", () => {
		writeResult((v) => {
			const a = v.evaluation.trials[4]?.attempts[0];
			if (a) a.subject = null;
		});
		expect(text(verify().problems)).toMatch(/E-neg attempt 1: .*subject/);
	});

	test("artifact directories are exactly <evidence>/<trial>/attempt-<n>, one per attempt", () => {
		writeResult((v) => {
			const a = v.evaluation.trials[0]?.attempts[0];
			const d = v.evaluation.trials[1]?.attempts[0];
			if (a && d) {
				d.artifactDir = a.artifactDir;
				d.artifacts = structuredClone(a.artifacts);
			}
		});
		expect(text(verify().problems)).toMatch(
			/D attempt 1: artifact directory .* is not .*\/D\/attempt-1/,
		);
	});
});

/** Replace an archived artifact's bytes and its recorded hash and length. */
function setArtifact(a: Attempt, name: string, content: string) {
	writeFileSync(join(root, "evals/shepherd", a.artifactDir, name), content);
	const artifact = a.artifacts.find((x) => x.path === name);
	if (artifact) {
		artifact.sha256 = sha256(content);
		artifact.bytes = Buffer.byteLength(content);
	}
}

/**
 * A native log whose tool results, one per call id, prove `binary`, under
 * `model`; one call `toolu_s` when no call id is given.
 */
function sessionLog(
	binary: string,
	callIds: string[] = [],
	model = "claude-opus-5-5",
): string {
	return `${(callIds.length > 0 ? callIds : ["toolu_s"])
		.flatMap((id) => [
			{
				type: "assistant",
				message: {
					model,
					content: [{ type: "tool_use", id, name: "Bash" }],
				},
			},
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: id,
							content: `binary: ${binary}\n`,
						},
					],
				},
			},
		])
		.map((e) => JSON.stringify(e))
		.join("\n")}\n`;
}

describe("fix round 2 (review-c4 verification round 1)", () => {
	const verify = (extra: VerifyOptions = {}) =>
		verifyResults(root, options(extra));
	const voidThenPass = (first: Attempt) => {
		const pass = behavioral(first.trial, "pass", 1);
		pass.ordinal = 2;
		pass.artifactDir = pass.artifactDir.replace(/attempt-1$/, "attempt-2");
		return result({}, { [first.trial]: [first, pass] });
	};

	test("R1-2 (probe Q1): a session log without its run manifest fails", () => {
		const relabelled = attempt("A", "void");
		relabelled.voidReasons = ["relabelled"];
		writeResult((v) => {
			const a = v.evaluation.trials[0]?.attempts[0];
			if (a)
				a.artifacts = a.artifacts.filter((x) => x.path !== "claude-run.json");
		}, voidThenPass(relabelled));
		expect(text(verify().problems)).toMatch(
			/A attempt 1: claude\.jsonl is archived without claude-run\.json/,
		);
	});

	test("R1-2: an interrupted attempt may archive its log alone", () => {
		const interrupted = attempt("A", "void");
		interrupted.interrupted = 0;
		interrupted.voidReasons = [
			"interrupted: the invocation ended before the attempt was recorded",
		];
		writeResult((v) => {
			const a = v.evaluation.trials[0]?.attempts[0];
			if (a)
				a.artifacts = a.artifacts.filter((x) => x.path !== "claude-run.json");
		}, voidThenPass(interrupted));
		expect(verify().problems).toEqual([]);
	});

	test("an interrupted behavioural attempt resolved from its log verifies without marker call ids", () => {
		const interrupted = behavioral("D", "inconclusive", 1);
		interrupted.interrupted = 0;
		interrupted.binaryEvidence.callIds = [];
		interrupted.scoring = null;
		interrupted.cost.scorer = [];
		interrupted.musts = interrupted.musts.map((m) => ({
			...m,
			checkerVersion: "gate:interrupted",
			scorer: null,
			evidence: [],
		}));
		interrupted.artifacts = interrupted.artifacts.filter(
			(x) => x.path !== "packet.md",
		);
		writeResult(
			(v) => {
				const a = v.evaluation.trials[1]?.attempts[0];
				if (!a) return;
				a.artifacts = a.artifacts.filter((x) => x.path !== "must-check.json");
				setArtifact(a, "claude.jsonl", sessionLog(a.binaryEvidence.expected));
			},
			result({}, { D: [interrupted, behavioral("D", "pass", 2)] }),
		);
		expect(verify().problems).toEqual([]);
	});

	/** A log-resolved behavioural attempt, as the gate records one after a kill. */
	const resolved = (trial: string, ordinal: number) => {
		const a = behavioral(trial, "inconclusive", ordinal);
		a.interrupted = 0;
		a.binaryEvidence.callIds = [];
		a.scoring = null;
		a.cost.scorer = [];
		a.musts = a.musts.map((m) => ({
			...m,
			checkerVersion: "gate:interrupted",
			scorer: null,
			evidence: [],
		}));
		a.artifacts = a.artifacts.filter((x) => x.path !== "packet.md");
		return a;
	};

	test("R2-1 (probe Q2): a log-resolved attempt must prove its binary in its archived log", () => {
		const first = attempt("A", "void");
		const forged = resolved("A", 1);
		forged.ordinal = 2;
		forged.artifactDir = forged.artifactDir.replace(/attempt-1$/, "attempt-2");
		const pass = behavioral("A", "pass", 2);
		pass.ordinal = 3;
		pass.artifactDir = pass.artifactDir.replace(/attempt-2$/, "attempt-3");
		const forge = (v: Result) => {
			const a = v.evaluation.trials[0]?.attempts[1];
			if (a)
				a.artifacts = a.artifacts.filter(
					(x) => x.path !== "must-check.json" && x.path !== "claude-run.json",
				);
			return a;
		};
		// No marker in the archived log.
		writeResult(
			(v) => {
				const a = forge(v);
				if (a)
					setArtifact(
						a,
						"claude.jsonl",
						`${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [] } })}\n`,
					);
			},
			result({}, { A: [first, forged, pass] }),
		);
		expect(text(verify().problems)).toMatch(
			/A attempt 2: session: no tool-result binary evidence proves/,
		);
		// No archived log at all.
		writeResult(
			(v) => {
				const a = forge(v);
				if (a)
					a.artifacts = a.artifacts.filter((x) => x.path !== "claude.jsonl");
			},
			result({}, { A: [first, forged, pass] }),
		);
		expect(text(verify().problems)).toMatch(
			/A attempt 2: a session resolved from its log archives no verified claude\.jsonl/,
		);
	});

	test("R2-2: a scored, harness-interrupted attempt still needs marker call ids", () => {
		const scored = behavioral("E-neg", "inconclusive", 1);
		scored.interrupted = 2;
		scored.binaryEvidence.callIds = [];
		writeResult(
			() => {},
			result({}, { "E-neg": [scored, behavioral("E-neg", "pass", 2)] }),
		);
		expect(text(verify().problems)).toMatch(
			/E-neg attempt 1: no in-session binary marker/,
		);
	});

	test("N2: a void reason of the archived manifest must be recorded", () => {
		const v1 = attempt("G", "void");
		v1.voidReasons = ["session: no tool-result binary evidence"];
		writeResult((v) => {
			const a = v.evaluation.trials[3]?.attempts[0];
			if (a) a.voidReasons = ["something else"];
		}, voidThenPass(v1));
		expect(text(verify().problems)).toMatch(
			/G attempt 1: void reasons of its archived claude-run\.json are not recorded/,
		);
	});

	test("N8: a record cannot be valid when its archived manifest is not", () => {
		const timedOut = behavioral("E", "inconclusive", 1);
		timedOut.valid = false;
		writeResult(
			(v) => {
				const a = v.evaluation.trials[2]?.attempts[0];
				if (a) a.valid = true;
			},
			result({}, { E: [timedOut, behavioral("E", "pass", 2)] }),
		);
		expect(text(verify().problems)).toMatch(
			/E attempt 1: recorded valid, but its archived claude-run\.json is not/,
		);
	});
});

describe("fix round 3 (S1, S6): judged verdicts and session facts re-derived", () => {
	const verify = (extra: VerifyOptions = {}) =>
		verifyResults(root, options(extra));
	const at = (v: Result, trial: string) =>
		v.evaluation.trials.find((t) => t.trial === trial)?.attempts[0] as Attempt;
	const reply = (outcome: MustOutcome) =>
		JSON.stringify({
			decisions: [
				{
					id: "E.M1",
					outcome,
					rationale: "no warning persisted",
					evidence: [{ artifact: "claude-stdout.txt", line: 1, quote: STDOUT }],
				},
			],
		});

	test("S1 (SYNTH fable-1/astra-4): an archived scorer output saying fail, from another model, beside a recorded pass fails", () => {
		writeResult((v) => {
			const e = at(v, "E");
			putArtifact(
				e,
				"scorer-1-r1.json",
				`${JSON.stringify({ result: reply("fail"), modelUsage: { "claude-haiku-5-5": {} }, total_cost_usd: 9 })}\n`,
			);
		});
		const outcome = verify();
		expect(outcome.ok).toBe(false);
		const problems = text(outcome.problems);
		expect(problems).toMatch(
			/E attempt 1: scorer invocation 0 is recorded a verdict, but its archived output reads schema-invalid output: observed model claude-haiku-5-5/,
		);
		expect(problems).toMatch(
			/E attempt 1: E\.M1 is recorded pass by the scorer, but no archived verdict decides it/,
		);
	});

	test("S1: a judged outcome, rationale or evidence that differs from the archived verdict fails", () => {
		writeResult((v) => {
			const e = at(v, "E");
			const verdict = e.scoring?.invocations[0];
			if (verdict)
				putArtifact(
					e,
					"scorer-1-r1.json",
					scorerOutput(reply("fail"), verdict),
				);
		});
		expect(text(verify().problems)).toMatch(
			/E attempt 1: E\.M1 is recorded pass, but its archived scorer output decides fail/,
		);
		writeResult((v) => {
			const must = at(v, "D").musts.find((m) => m.id === "D.M1");
			if (must) must.rationale = "edited";
		});
		expect(text(verify().problems)).toMatch(
			/D attempt 1: D\.M1 is recorded pass, but its archived scorer output decides pass/,
		);
	});

	test("S1: a scorer cost, session id or observed model that differs from the archived output fails", () => {
		writeResult((v) => {
			const e = at(v, "E");
			const verdict = e.scoring?.invocations[0];
			if (!verdict) return;
			const archived = { ...verdict, cost: { ...verdict.cost, usd: 9 } };
			archived.sessionId = "00000000-0000-4000-8000-0000000000ff";
			putArtifact(e, "scorer-1-r1.json", scorerOutput(reply("pass"), archived));
		});
		const problems = text(verify().problems);
		expect(problems).toMatch(
			/E attempt 1: scorer invocation 0 is recorded at \$0\.2, but its archived output reports 9/,
		);
		expect(problems).toMatch(
			/E attempt 1: scorer invocation 0 is recorded as session .*0001, but its archived output names .*00ff/,
		);
	});

	test("S1: every scorer invocation must archive its output", () => {
		writeResult((v) => {
			const d = at(v, "D");
			d.artifacts = d.artifacts.filter((x) => x.path !== "scorer-1-r1.json");
		});
		expect(text(verify().problems)).toMatch(
			/D attempt 1: scorer invocation 0 has no verified archived output scorer-1-r1\.json/,
		);
	});

	test("S1: a scored attempt must archive every packet file", () => {
		writeResult((v) => {
			const g = at(v, "G");
			g.artifacts = g.artifacts.filter((x) => x.path !== "claude-diff.patch");
		});
		expect(text(verify().problems)).toMatch(
			/G attempt 1: the scored packet's files are not all archived: claude-diff\.patch/,
		);
	});

	test("S1: a recorded binary call id the archived log does not prove fails", () => {
		writeResult((v) => {
			const g = at(v, "G");
			g.binaryEvidence.callIds = ["toolu_other"];
			putArtifact(g, "claude-run.json", `${JSON.stringify(runManifest(g))}\n`);
		});
		expect(text(verify().problems)).toMatch(
			/G attempt 1: call toolu_other returns no binary marker for .* in its archived claude\.jsonl/,
		);
	});

	test("S1: a session log model other than the recorded observed models fails", () => {
		writeResult((v) => {
			const a = at(v, "A");
			putArtifact(
				a,
				"claude.jsonl",
				sessionLog(
					a.binaryEvidence.expected,
					a.binaryEvidence.callIds,
					"claude-sonnet-5-5",
				),
			);
		});
		expect(text(verify().problems)).toMatch(
			/A attempt 1: its archived claude\.jsonl observed claude-sonnet-5-5, but the record says claude-opus-5-5/,
		);
	});

	test("S1: a subject launched without the policy model and effort fails", () => {
		writeResult((v) => {
			const subject = at(v, "E-neg").subject;
			if (subject)
				subject.argv = subject.argv.map((arg) =>
					arg === "high" ? "low" : arg,
				);
		});
		expect(text(verify().problems)).toMatch(
			/E-neg attempt 1: the subject argv does not request --model claude-opus-5-5 --effort high/,
		);
	});

	test("S6 (SYNTH fable-3): a never-finished claude-run.json on an attempt that was not interrupted fails", () => {
		const placeholder = `${JSON.stringify({ validity: { valid: false, void_reasons: [] }, provenance: [], ended_at: null })}\n`;
		writeResult((v) => putArtifact(at(v, "E"), "claude-run.json", placeholder));
		expect(text(verify().problems)).toMatch(
			/E attempt 1: its archived claude-run\.json never finished, but the attempt was not interrupted/,
		);
	});
});

describe("G1 fix round 1 (review-g1)", () => {
	const verify = (extra: VerifyOptions = {}) =>
		verifyResults(root, options(extra));
	const at = (v: Result, trial: string) =>
		v.evaluation.trials.find((t) => t.trial === trial)?.attempts[0] as Attempt;
	const failReply = JSON.stringify({
		decisions: [
			{
				id: "E.M1",
				outcome: "fail",
				rationale: "the warning was never persisted",
				evidence: [{ artifact: "claude-stdout.txt", line: 1, quote: STDOUT }],
			},
		],
	});
	/** E scored twice: invocation 0 recorded as `relabel` says, invocation 1 the pass verdict. */
	const twice = (relabel: Partial<ScorerInvocation>) => {
		const e = behavioral("E", "pass");
		const first = invocation({
			sessionId: "00000000-0000-4000-8000-0000000000aa",
			...relabel,
		});
		const second = invocation({
			retryReason:
				relabel.failure === "cancelled" ? null : (relabel.failure ?? null),
		});
		if (e.scoring) e.scoring.invocations = [first, second];
		e.cost.scorer = [first.cost, second.cost];
		for (const m of e.musts) if (m.scorer) m.scorer.invocation = 1;
		return result({}, { E: [e] });
	};
	/** Invocation 0's archived output is a genuine fail verdict. */
	const genuineFail = (v: Result) => {
		const e = at(v, "E");
		const first = e.scoring?.invocations[0];
		if (first)
			putArtifact(e, "scorer-1-r1.json", scorerOutput(failReply, first));
	};
	const relabelled =
		/E attempt 1: scorer invocation 0 is recorded a failure, but its archived output reads a verdict/;

	test("1: a fail verdict relabelled cancelled, timed out, killed or schema-invalid fails (P1a, P1b, M3b)", () => {
		for (const relabel of [
			{ failure: "cancelled", exitStatus: null, signal: "SIGKILL" },
			{
				failure: "timeout after 300 s",
				timedOut: true,
				exitStatus: null,
				signal: "SIGKILL",
			},
			{ failure: "nonzero exit 1: boom", exitStatus: 1 },
			{ failure: "schema-invalid output: missing decision for E.M1" },
		]) {
			writeResult(genuineFail, twice(relabel));
			expect([relabel.failure, text(verify().problems)]).toEqual([
				relabel.failure,
				expect.stringMatching(relabelled),
			]);
		}
	});

	test("1: an honest verdict printed before a timeout, recorded as a verdict, verifies", () => {
		writeResult(
			() => {},
			result(
				{},
				{
					E: [
						(() => {
							const e = behavioral("E", "pass");
							if (e.scoring)
								e.scoring.invocations = [
									invocation({
										timedOut: true,
										exitStatus: null,
										signal: "SIGKILL",
									}),
								];
							return e;
						})(),
					],
				},
			),
		);
		expect(verify().problems).toEqual([]);
	});

	test("2: a marker the harness reads from a JSON-wrapped tool result verifies (P3); another path still fails", () => {
		const wrapped = (binary: (expected: string) => string) => (v: Result) => {
			const e = at(v, "E");
			e.binaryEvidence.callIds = ["toolu_w"];
			const log = [
				{
					type: "assistant",
					message: {
						model: "claude-opus-5-5",
						content: [
							{
								type: "tool_use",
								id: "toolu_w",
								name: "mcp__x__run",
								input: {},
							},
						],
					},
				},
				{
					type: "user",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "toolu_w",
								content: JSON.stringify({
									exit: 0,
									stdout: JSON.stringify({
										text: `# Shepherd start: /w\n2026-10-14\nbinary: ${binary(e.binaryEvidence.expected)}\n`,
									}),
								}),
							},
						],
					},
				},
			];
			putArtifact(
				e,
				"claude.jsonl",
				`${log.map((l) => JSON.stringify(l)).join("\n")}\n`,
			);
			putArtifact(e, "claude-run.json", `${JSON.stringify(runManifest(e))}\n`);
		};
		writeResult(wrapped((expected) => expected));
		expect(verify().problems).toEqual([]);
		writeResult(wrapped(() => "/tmp/shepherd-evals-y/bin/shepherd"));
		expect(text(verify().problems)).toMatch(
			/E attempt 1: call toolu_w returns no binary marker for/,
		);
	});

	test("3: the archived claude-run.json argv must be the record's (P2)", () => {
		writeResult((v) => {
			const e = at(v, "E");
			const manifest = {
				...runManifest(e),
				argv: (e.subject?.argv ?? []).map((a) => (a === "high" ? "low" : a)),
			};
			putArtifact(e, "claude-run.json", `${JSON.stringify(manifest)}\n`);
		});
		expect(text(verify().problems)).toMatch(
			/E attempt 1: the argv of its archived claude-run\.json is not the record's/,
		);
	});

	test("4: an edited judged evidence pointer fails (Mev)", () => {
		writeResult((v) => {
			const must = at(v, "E").musts.find((m) => m.id === "E.M1");
			const pointer = must?.evidence[0];
			if (pointer) pointer.quote = "Done";
		});
		expect(text(verify().problems)).toMatch(
			/E attempt 1: E\.M1 is recorded pass, but its archived scorer output decides pass with another rationale or evidence/,
		);
	});

	test("4: a judged Must citing another session fails (M1)", () => {
		writeResult((v) => {
			const must = at(v, "E").musts.find((m) => m.id === "E.M1");
			if (must?.scorer)
				must.scorer.sessionId = "00000000-0000-4000-8000-0000000000bb";
		});
		expect(text(verify().problems)).toMatch(
			/E attempt 1: E\.M1 is recorded pass by the scorer, but no archived verdict decides it/,
		);
	});

	test("5: archived text is decoded as the gate decodes it, a byte order mark included", () => {
		const unreported = {
			observedModels: [],
			cost: {
				usd: null,
				reason: "the scorer output reports no cost",
				usage: null,
				source: "scorer output",
			},
		};
		// The CLI's reply after a byte order mark: the gate cannot parse it.
		writeResult(
			(v) => {
				const e = at(v, "E");
				putArtifact(
					e,
					"scorer-1-r1.json",
					`\uFEFF${scorerOutput(failReply, invocation({ sessionId: "00000000-0000-4000-8000-0000000000aa" }))}`,
				);
			},
			twice({ failure: "unparsable CLI output", ...unreported }),
		);
		expect(verify().problems).toEqual([]);
	});
});

describe("G1 fix round 1, verification round 1 (V1)", () => {
	const verify = () => verifyResults(root, options());
	/** E's one marker call returns `output`, wrapped `depth` times in JSON as a tool might. */
	const marked =
		(output: (expected: string) => string, depth: number) => (v: Result) => {
			const e = v.evaluation.trials.find((t) => t.trial === "E")
				?.attempts[0] as Attempt;
			e.binaryEvidence.callIds = ["toolu_w"];
			let content = output(e.binaryEvidence.expected);
			for (let n = 0; n < depth; n++)
				content = JSON.stringify({ exit: 0, stdout: content });
			const log = [
				{
					type: "assistant",
					message: {
						model: "claude-opus-5-5",
						content: [
							{ type: "tool_use", id: "toolu_w", name: "Bash", input: {} },
						],
					},
				},
				{
					type: "user",
					message: {
						content: [{ type: "tool_result", tool_use_id: "toolu_w", content }],
					},
				},
			];
			putArtifact(
				e,
				"claude.jsonl",
				`${log.map((l) => JSON.stringify(l)).join("\n")}\n`,
			);
			putArtifact(e, "claude-run.json", `${JSON.stringify(runManifest(e))}\n`);
		};

	test("a path that only contains the expected one is no marker for it, at every escape level", () => {
		for (const depth of [0, 1, 2, 3]) {
			writeResult(
				marked((x) => `# Shepherd start: /w\nbinary:\t${x}\n`, depth),
			);
			expect([depth, verify().problems]).toEqual([depth, []]);
			for (const near of [
				(x: string) => `${x}-old`,
				(x: string) => `${x}/../x`,
				(x: string) => `/mnt${x}`,
			]) {
				writeResult(
					marked((x) => `# Shepherd start: /w\nbinary: ${near(x)}\n`, depth),
				);
				expect([depth, near("X"), text(verify().problems)]).toEqual([
					depth,
					near("X"),
					expect.stringMatching(
						/E attempt 1: call toolu_w returns no binary marker for/,
					),
				]);
			}
		}
	});
});

describe("G1 fix round 1, verification round 1 (V1 additions)", () => {
	const verify = () => verifyResults(root, options());
	const NON_ASCII = "/tmp/shepherd-évals-ü/bin/shepherd";
	/** Python's `json.dumps` with `ensure_ascii`, for an ASCII-only reading. */
	const pyDumps = (value: unknown) =>
		JSON.stringify(value).replace(
			/[^\p{ASCII}]/gu,
			(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
	/** E's one marker call returns `content(expected)`, with `expected` set first. */
	const marked =
		(content: (x: string) => string, expected?: string) => (v: Result) => {
			const e = v.evaluation.trials.find((t) => t.trial === "E")
				?.attempts[0] as Attempt;
			if (expected) e.binaryEvidence.expected = expected;
			e.binaryEvidence.callIds = ["toolu_w"];
			const log = [
				{
					type: "assistant",
					message: {
						model: "claude-opus-5-5",
						content: [
							{ type: "tool_use", id: "toolu_w", name: "Bash", input: {} },
						],
					},
				},
				{
					type: "user",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: "toolu_w",
								content: content(e.binaryEvidence.expected),
							},
						],
					},
				},
			];
			putArtifact(
				e,
				"claude.jsonl",
				`${log.map((l) => JSON.stringify(l)).join("\n")}\n`,
			);
			putArtifact(e, "claude-run.json", `${JSON.stringify(runManifest(e))}\n`);
		};
	const noMarker = /E attempt 1: call toolu_w returns no binary marker for/;

	test("a bare mention of the path, without a marker, is no marker", () => {
		for (const content of [
			(x: string) => `${x}\n`,
			(x: string) => `which shepherd\n${x}\n`,
			(x: string) => JSON.stringify({ path: x }),
			(x: string) => `not binary: ${x}\n`,
			(x: string) => `binary: ${x} and more\n`,
		]) {
			writeResult(marked(content));
			expect([content("X"), text(verify().problems)]).toEqual([
				content("X"),
				expect.stringMatching(noMarker),
			]);
		}
	});

	test("a non-ASCII path is found in JavaScript and Python ensure_ascii spellings, as a line or a field", () => {
		const line = (x: string) => `# Shepherd start: /w\nbinary: ${x}\n`;
		for (const content of [
			line,
			(x: string) => `binary: "${x}"\n`,
			(x: string) => JSON.stringify({ stdout: line(x) }),
			(x: string) => pyDumps({ stdout: line(x) }),
			(x: string) => pyDumps({ result: pyDumps({ stdout: line(x) }) }),
			(x: string) => JSON.stringify({ result: pyDumps({ stdout: line(x) }) }),
			(x: string) => pyDumps({ binary: x }),
			(x: string) => `prose then ${JSON.stringify({ binary: x })}`,
			(x: string) => JSON.stringify({ wrapped: pyDumps({ binary: x }) }),
		]) {
			writeResult(marked(content, NON_ASCII));
			expect([content(NON_ASCII), verify().problems]).toEqual([
				content(NON_ASCII),
				[],
			]);
		}
		for (const content of [
			(x: string) => pyDumps({ stdout: line(`${x}-old`) }),
			(x: string) => pyDumps({ binary: `/mnt${x}` }),
			(x: string) => pyDumps({ path: x }),
		]) {
			writeResult(marked(content, NON_ASCII));
			expect([content(NON_ASCII), text(verify().problems)]).toEqual([
				content(NON_ASCII),
				expect.stringMatching(noMarker),
			]);
		}
	});
});

describe("fix round 3, G4: markers read as binary_values reads them; scorer cost duplicates", () => {
	const verify = () => verifyResults(root, options());
	/** E's one marker call returns `content(expected)`. */
	const marked = (content: (x: string) => string) => (v: Result) => {
		const e = v.evaluation.trials.find((t) => t.trial === "E")
			?.attempts[0] as Attempt;
		e.binaryEvidence.callIds = ["toolu_w"];
		const log = [
			{
				type: "assistant",
				message: {
					model: "claude-opus-5-5",
					content: [
						{ type: "tool_use", id: "toolu_w", name: "Bash", input: {} },
					],
				},
			},
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_w",
							content: content(e.binaryEvidence.expected),
						},
					],
				},
			},
		];
		putArtifact(
			e,
			"claude.jsonl",
			`${log.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
		putArtifact(e, "claude-run.json", `${JSON.stringify(runManifest(e))}\n`);
	};
	const wrapped = (depth: number, line: string) => {
		let content = line;
		for (let n = 0; n < depth; n++)
			content = JSON.stringify({ stdout: content });
		return content;
	};
	const noMarker = /E attempt 1: call toolu_w returns no binary marker for/;

	test("a marker wrapped four or more times in JSON verifies; a near miss so wrapped still fails", () => {
		for (const depth of [4, 5, 8]) {
			writeResult(marked((x) => wrapped(depth, `binary: ${x}\n`)));
			expect([depth, verify().problems]).toEqual([depth, []]);
			writeResult(marked((x) => wrapped(depth, `binary: ${x}-old\n`)));
			expect([depth, text(verify().problems)]).toEqual([
				depth,
				expect.stringMatching(noMarker),
			]);
		}
	});

	test("an escaped binary key verifies", () => {
		for (const content of [
			(x: string) => `{"\\u0062inary":"${x}"}`,
			(x: string) => JSON.stringify({ stdout: `{"bin\\u0061ry": "${x}"}` }),
		]) {
			writeResult(marked(content));
			expect([content("X"), verify().problems]).toEqual([content("X"), []]);
		}
	});

	test("an attempt's scorer cost that differs from its invocation's fails, unknown cost included", () => {
		for (const changed of [
			{ usd: 0, reason: null },
			{ usd: null, reason: "the scorer output reports no cost" },
		]) {
			writeResult((v) => {
				const e = v.evaluation.trials.find((t) => t.trial === "E")
					?.attempts[0] as Attempt;
				const cost = e.cost.scorer[0];
				if (cost) e.cost.scorer[0] = { ...cost, ...changed };
				v.cost = totalCost(v);
			});
			expect([changed.usd, text(verify().problems)]).toEqual([
				changed.usd,
				expect.stringMatching(
					/E attempt 1: scorer cost 0 differs from its invocation's/,
				),
			]);
		}
	});
});

describe("fix round 3, G4: binaryValues matches the harness's binary_values", () => {
	const Q = "/w/bin/shepherd";
	const P = "/tmp/shepherd-évals-ü/bin/shepherd";
	/** Python's `json.dumps` with `ensure_ascii`: every non-ASCII UTF-16 unit escaped. */
	const pyDumps = (value: unknown) =>
		JSON.stringify(value).replace(
			/[\u0080-\uffff]/g,
			(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
	const wrapped = (depth: number, line: string) => {
		let content = line;
		for (let n = 0; n < depth; n++)
			content = JSON.stringify({ stdout: content });
		return content;
	};
	const vectors: string[] = [
		// Line markers: bare, quoted, JSON-quoted, and lines that are none.
		`binary: ${Q}`,
		`  \tbinary:\t ${Q} \t\nnext`,
		`head\nbinary: "${Q}"\nbinary: '${Q}'\nbinary: ${P}\n`,
		`binary: "${Q}" trailing\nbinary: "unterminated\n`,
		`binary: '\nbinary: '${Q}\nbinary: ''\n`,
		`binary: "\\u00e9\\ud800"\n`,
		"binary:   \n",
		`binary:${Q}\nnot binary: ${Q}\nbinary: ${Q} and more\n`,
		`binary: ${Q}\r\nbinary: ${Q}\r`,
		`\rbinary: ${Q}\u2028binary: /x\u2029y\n\u2028binary: /z`,
		// The whole string as JSON.
		JSON.stringify({ binary: Q }),
		`  ${JSON.stringify({ binary: Q, nested: [{ binary: P }, { binary: 7 }, "binary: /in-string"] })}  \n`,
		JSON.stringify(`binary: ${Q}\n`),
		JSON.stringify([
			1,
			true,
			null,
			{ binary: null },
			{ binary: { binary: Q } },
		]),
		"null",
		"null\nbinary: /after-null",
		"42",
		"NaN",
		"-Infinity",
		`"just text"`,
		`{"a": NaN, "b": Infinity, "c": -Infinity, "binary": "${Q}"}`,
		`{"binary": "/first", "binary": "/second"}`,
		`{"x": {"binary": "/1"}, "binary": "/2", "x": 5}`,
		`{"b": {"binary": "/b"}, "1": {"binary": "/1"}, "__proto__": {"binary": "/proto"}}`,
		`{"binary": "/lone\\ud800", "pair": {"binary": "/\\ud83d\\ude00"}, "low": {"binary": "\\udc00x"}}`,
		`{"binary": "/high-then-other\\ud800\\u0041"}`,
		`{"\\u0062inary": "${Q}"}`,
		`\uFEFF{"binary": "/bom"}`,
		// Prose mixed with several fragments, malformed ones among them.
		`start {"binary": "/1"} middle [{"binary": "/2"}] then\nbinary: /3\n {broken {"binary": "/4"} [1, 2,] {"a": 1,} [01] [1.] [-] [1e5, 1.5E-3, -0, {"binary": "/5"}]`,
		`prose [NaN, {"binary": "/nan"}] and [-Inf, {"binary": "/bad"}]`,
		`{{"binary": "/inner"}`,
		`{"binary": "/unterminated"`,
		`{"binary": "/tab\there"} {"binary": "/esc\\x"} {"binary": "/hex\\u12G4"} {"binary": "/ok\\/slash\\b\\f\\n\\r\\t\\"\\\\"}`,
		`{ "binary" :\n\t"/spaced" }`,
		`{"stdout": "{\\"binary\\": \\"/inner-wrapped\\"}"} tail`,
		`{"a": 1,\nbinary: /line-in-broken\n}`,
		`[] {} [[]] {"": {"binary": ""}}`,
		// Deep wrapping.
		wrapped(10, `binary: ${Q}\n`),
		wrapped(
			6,
			`prose ${JSON.stringify({ binary: P })} binary: no\nbinary: ${P}\n`,
		),
		// Non-ASCII paths, written as JavaScript and as ensure_ascii writes them.
		pyDumps({ stdout: `binary: ${P}\n` }),
		pyDumps({ result: pyDumps({ binary: P }) }),
		JSON.stringify({ result: pyDumps({ stdout: `binary: ${P}\n` }) }),
		`binary: ${P}\n${pyDumps({ binary: `${P}-old` })}`,
		pyDumps({ binary: "/emoji/\u{1F600}/bin" }),
		"binary: /emoji/\u{1F600}\n",
		// Numbers and blanks JSON refuses (review-g4 mutants C and D).
		'[01, "binary: /x"]',
		'[1., "binary: /y"]',
		'{\f"binary": "/x"}',
		'{"binary":\v"/z"}',
	];

	test("the TypeScript port and harness.py agree on every vector", () => {
		const python = spawnSync(
			"python3",
			[
				"-I",
				"-B",
				"-c",
				"import importlib.util, json, sys\n" +
					"spec = importlib.util.spec_from_file_location('harness', sys.argv[1])\n" +
					"harness = importlib.util.module_from_spec(spec); spec.loader.exec_module(harness)\n" +
					"vectors = json.loads(sys.stdin.buffer.read().decode('utf-8'))\n" +
					"sys.stdout.write(json.dumps([harness.binary_values(v) for v in vectors]))\n",
				join(CODE_DIR, "harness.py"),
			],
			{ input: JSON.stringify(vectors), encoding: "utf8" },
		);
		expect([python.status, python.stderr]).toEqual([0, ""]);
		const expected: string[][] = JSON.parse(python.stdout);
		// The vectors reach the branches they are meant to.
		const of = (vector: string) => expected[vectors.indexOf(vector)];
		expect(of(`{"binary": "/first", "binary": "/second"}`)).toEqual([
			"/second",
		]);
		expect(
			of(
				`{"b": {"binary": "/b"}, "1": {"binary": "/1"}, "__proto__": {"binary": "/proto"}}`,
			),
		).toEqual(["/b", "/1", "/proto"]);
		expect(
			of(`{"a": NaN, "b": Infinity, "c": -Infinity, "binary": "${Q}"}`),
		).toEqual([Q]);
		const ported = vectors.map((v) => binaryValues(v));
		vectors.forEach((vector, i) => {
			expect([vector, ported[i]]).toEqual([vector, expected[i] ?? []]);
		});
	});
});

describe("G4 fix round 1: tool-result text, resolved sessions, and the review's mutants", () => {
	const verify = () => verifyResults(root, options());
	const noMarker = /E attempt 1: call toolu_w returns no binary marker for/;
	/** A native log whose one tool result, call `toolu_w`, has `content`. */
	const nativeLog = (content: unknown) =>
		`${[
			{
				type: "assistant",
				message: {
					model: "claude-opus-5-5",
					content: [
						{ type: "tool_use", id: "toolu_w", name: "Bash", input: {} },
					],
				},
			},
			{
				type: "user",
				message: {
					content: [{ type: "tool_result", tool_use_id: "toolu_w", content }],
				},
			},
		]
			.map((l) => JSON.stringify(l))
			.join("\n")}\n`;
	/** E's one marker call returns `content(expected)`. */
	const marked = (content: (x: string) => unknown) => (v: Result) => {
		const e = v.evaluation.trials.find((t) => t.trial === "E")
			?.attempts[0] as Attempt;
		e.binaryEvidence.callIds = ["toolu_w"];
		putArtifact(
			e,
			"claude.jsonl",
			nativeLog(content(e.binaryEvidence.expected)),
		);
		putArtifact(e, "claude-run.json", `${JSON.stringify(runManifest(e))}\n`);
	};

	test("tool-result text is read as transcript.content_text reads it", () => {
		writeResult(marked((x) => [`binary: ${x}`, "more"]));
		expect(verify().problems).toEqual([]);
		writeResult(
			marked((x) => [`which shepherd`, { type: "text", text: `binary: ${x}` }]),
		);
		expect(verify().problems).toEqual([]);
		// The harness reads a part's `content`, never its other keys.
		writeResult(
			marked((x) => [
				{
					type: "search_result",
					content: [{ type: "text", text: "ok" }],
					title: JSON.stringify({ binary: x }),
				},
			]),
		);
		expect(text(verify().problems)).toMatch(noMarker);
	});

	test("contentText matches transcript.content_text", () => {
		const X = "/w/bin/shepherd";
		const values: unknown[] = [
			"plain",
			"",
			[],
			[`binary: ${X}`, "more"],
			["a", ["b", ["c"]], { text: "d" }],
			{ text: `binary: ${X}`, content: "never" },
			{ content: [{ type: "text", text: "inner" }, "tail"], title: "kept out" },
			{ type: "image", source: { data: "abc", media: "image/png" } },
			{ type: "search_result", title: JSON.stringify({ binary: X }) },
			{ text: null },
			{ content: { nested: [1, true, null, "s"] } },
			null,
			42,
			true,
			{},
			[{}, [], { a: [] }],
			{ type: "x", note: 'é ü \u{1F600} "quoted" \\ \n\t\u0001' },
		];
		const python = spawnSync(
			"python3",
			[
				"-I",
				"-B",
				"-c",
				"import importlib.util, json, sys\n" +
					"spec = importlib.util.spec_from_file_location('transcript', sys.argv[1])\n" +
					"transcript = importlib.util.module_from_spec(spec); spec.loader.exec_module(transcript)\n" +
					"values = json.loads(sys.stdin.buffer.read().decode('utf-8'))\n" +
					"sys.stdout.write(json.dumps([transcript.content_text(v) for v in values]))\n",
				join(CODE_DIR, "transcript.py"),
			],
			{ input: JSON.stringify(values), encoding: "utf8" },
		);
		expect([python.status, python.stderr]).toEqual([0, ""]);
		const expected: string[] = JSON.parse(python.stdout);
		values.forEach((value, i) => {
			expect([value, contentText(value)]).toEqual([value, expected[i]]);
		});
	});

	test("a session resolved from its log reads markers as binary_values reads them", () => {
		const X = "/w/bin/shepherd";
		let deep = `binary: ${X}\n`;
		for (let n = 0; n < 4; n++) deep = JSON.stringify({ stdout: deep });
		const problems = (content: unknown) =>
			sessionValidity(nativeLog(content), X, "claude-opus-5-5");
		expect(problems(deep)).toEqual([]);
		expect(problems(`{"\\u0062inary": "${X}"}`)).toEqual([]);
		// An unclosed quote is no marker to the harness.
		expect(problems(`binary: '${X}\n`)).toEqual([
			`session: no tool-result binary evidence proves ${X}`,
		]);
	});

	test("a quoted path with inner blanks is another path", () => {
		writeResult(marked((x) => `binary: ' ${x} '\n`));
		expect(text(verify().problems)).toMatch(noMarker);
		writeResult(marked((x) => `binary: " ${x}"\n`));
		expect(text(verify().problems)).toMatch(noMarker);
	});

	test("a retried scoring's second scorer cost must match its invocation's", () => {
		const retried = () => {
			const e = behavioral("E", "pass");
			const first = invocation({
				sessionId: "00000000-0000-4000-8000-0000000000aa",
				failure: "nonzero exit 1: boom",
				exitStatus: 1,
			});
			const second = invocation({ retryReason: "nonzero exit 1: boom" });
			if (e.scoring) e.scoring.invocations = [first, second];
			e.cost.scorer = [first.cost, second.cost];
			for (const m of e.musts) if (m.scorer) m.scorer.invocation = 1;
			return result({}, { E: [e] });
		};
		writeResult(() => {}, retried());
		expect(verify().problems).toEqual([]);
		writeResult((v) => {
			const e = v.evaluation.trials.find((t) => t.trial === "E")
				?.attempts[0] as Attempt;
			const cost = e.cost.scorer[1];
			if (cost) e.cost.scorer[1] = { ...cost, usd: 0 };
			v.cost = totalCost(v);
		}, retried());
		expect(text(verify().problems)).toMatch(
			/E attempt 1: scorer cost 1 differs from its invocation's/,
		);
	});
});

describe("G4 fix round 2: a resolved session's unexpected markers", () => {
	test("a second tool result naming another binary is reported", () => {
		const X = "/w/bin/shepherd";
		const result = (id: string, content: string) => ({
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: id, content }],
			},
		});
		const log = [
			{ type: "assistant", message: { model: "claude-opus-5-5", content: [] } },
			result("toolu_a", `binary: ${X}\n`),
			result("toolu_b", JSON.stringify({ binary: "/other" })),
		]
			.map((l) => JSON.stringify(l))
			.join("\n");
		expect(sessionValidity(log, X, "claude-opus-5-5")).toEqual([
			"session: a tool result names unexpected binary /other",
		]);
	});
});

describe("fix round 4, H1: the CI check is informational", () => {
	const blockedChecks = () => truthChecks({ "G-neg.M2": "fail" });
	const sourceHash = () => readWorktreeSource(root, { git: testGit }).source;
	const gatedChange = (value = 2) => {
		writeAt(root, "lib/shepherd/tool.ts", `export const tool = ${value};\n`);
		return commitAll(`source ${value}`);
	};

	test("1: no gated path changed succeeds as not required, in the job summary too", () => {
		const base = head();
		writeAt(root, "README.md", "changed\n");
		const tip = commitAll("docs");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		expect(text(outcome.lines)).toContain("Shepherd evals not required");
		expect(text(outcome.summary)).toContain("not required");
		expect(outcome.notice).toBeUndefined();
	});

	test("2: a gated change without a result succeeds, naming the hash, when no result is committed", () => {
		const base = head();
		const tip = gatedChange();
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		const out = text(outcome.lines);
		expect(out).toContain(`No result for source ${sourceHash()}`);
		expect(out).toContain("No result is committed.");
		expect(out).not.toMatch(/fail/i);
		expect(outcome.notice).toContain(sourceHash());
		expect(text(outcome.summary)).toContain(sourceHash());
	});

	test("2: the notice names the newest committed result, by commit order, with its revision and outcome", () => {
		const base = head();
		const first = gatedChange(2);
		const older = writeResult(() => {}, result({ "G-neg.M2": "fail" }));
		commitAll("older result");
		const second = gatedChange(3);
		const newer = writeResult();
		commitAll("newer result");
		let tip = gatedChange(4);
		let out = text(ciGate(root, base, tip, options()).lines);
		expect(out).toContain(
			`Newest committed result: evals/shepherd/results/${newer.hex}.json, revision ${second}, outcome pass`,
		);
		// Republishing the older file makes it the newest change to results/.
		writeAt(
			root,
			`evals/shepherd/results/${older.hex}.json`,
			JSON.stringify(older.value),
		);
		commitAll("republish the older result");
		tip = gatedChange(5);
		const outcome = ciGate(root, base, tip, options());
		out = text(outcome.lines);
		expect(outcome.code).toBe(0);
		expect(out).toContain(
			`Newest committed result: evals/shepherd/results/${older.hex}.json, revision ${first}, outcome blocked`,
		);
		expect(out).toContain("recorded, not verified against this tree");
		expect(outcome.notice).toContain(`revision ${first}, outcome blocked`);
	});

	test("2: an unreadable newest committed result is named and still succeeds; a deleted one is skipped", () => {
		const base = head();
		const forged = result();
		forged.outcome = "pass\n::error::injected" as Result["outcome"];
		writeAt(
			root,
			`evals/shepherd/results/${"f".repeat(64)}.json`,
			JSON.stringify(forged),
		);
		commitAll("an older result with a forged outcome");
		writeAt(root, `evals/shepherd/results/${"e".repeat(64)}.json`, "{\n");
		commitAll("a broken older result");
		const tip = gatedChange();
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		expect(text(outcome.lines)).toContain(
			`Newest committed result: evals/shepherd/results/${"e".repeat(64)}.json, which cannot be read as a result`,
		);
		git(root, "rm", "-q", `evals/shepherd/results/${"e".repeat(64)}.json`);
		const later = gatedChange(3);
		const next = ciGate(root, base, later, options());
		expect(text(next.lines)).toContain(
			`Newest committed result: evals/shepherd/results/${"f".repeat(64)}.json, which cannot be read as a result`,
		);
		expect(text(next.lines)).not.toContain("::error::");
	});

	test("3: a verifying blocked result succeeds and prints its outcome and each Must", () => {
		const base = head();
		gatedChange();
		const failed = (n: number) =>
			behavioral("G-neg", "pass", n, { "G-neg.M2": "fail" });
		writeResult(() => {}, result({}, { "G-neg": [failed(1), failed(2)] }));
		const tip = commitAll("results");
		const outcome = ciGate(
			root,
			base,
			tip,
			options({ checks: blockedChecks() }),
		);
		expect(outcome.code).toBe(0);
		const out = text(outcome.lines);
		expect(out).toContain("Shepherd evals result verified: outcome blocked.");
		expect(out).toMatch(/G-neg fail/);
		expect(out).toMatch(
			/G-neg attempt 1: G-neg\.M1 pass, G-neg\.M2 fail, G-neg\.M3 pass/,
		);
		expect(out).toMatch(
			/G-neg attempt 2: G-neg\.M1 pass, G-neg\.M2 fail, G-neg\.M3 pass/,
		);
		expect(out).toMatch(/A attempt 1: A\.M1 pass, A\.M2 pass/);
		const summary = text(outcome.summary);
		expect(summary).toContain("blocked");
		expect(summary).toContain("G-neg.M2 fail");
		expect(outcome.notice).toBeUndefined();
	});

	test("3: a verifying flaky pass succeeds and keeps the first failure in view", () => {
		const base = head();
		gatedChange();
		const first = behavioral("G-neg", "pass", 1, { "G-neg.M3": "fail" });
		writeResult(
			() => {},
			result({}, { "G-neg": [first, behavioral("G-neg", "pass", 2)] }),
		);
		const tip = commitAll("results");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		const out = text(outcome.lines);
		expect(out).toContain("outcome flaky-pass");
		expect(out).toMatch(/G-neg attempt 1: .*G-neg\.M3 fail/);
		expect(out).toMatch(/G-neg attempt 2: .*G-neg\.M3 pass/);
	});

	test("4: a result that does not verify fails the job: forged, hand-edited, symlinked, evidence mismatch", () => {
		const base = head();
		gatedChange();
		// The symlinked case comes last: a later writeResult would write through it.
		const broken: [string, () => void, RegExp][] = [
			[
				"forged",
				() =>
					writeResult(
						(value) => {
							value.outcome = "pass";
							value.evaluation.outcome = "pass";
						},
						result({ "G-neg.M2": "fail" }),
					),
				/does not match/,
			],
			[
				"hand-edited",
				() => {
					const { value, path } = writeResult();
					const must = value.evaluation.trials[0]?.attempts[0]?.musts[1];
					if (must) must.rationale = "edited by hand";
					writeFileSync(path, JSON.stringify(value));
				},
				/A attempt 1/,
			],
			[
				"evidence mismatch",
				() => {
					const { value } = writeResult();
					const dir = value.evaluation.trials[0]?.attempts[0]?.artifactDir;
					writeFileSync(
						join(root, "evals/shepherd", dir ?? "", "claude.jsonl"),
						"tampered\n",
					);
				},
				/claude\.jsonl does not match/,
			],
			[
				"symlinked",
				() => {
					const { path, hex } = writeResult();
					const moved = `evals/shepherd/validation/${hex}/run/result.json`;
					writeAt(root, moved, readFileSync(path, "utf8"));
					rmSync(path);
					symlinkSync(`../validation/${hex}/run/result.json`, path);
				},
				/not a regular file/,
			],
		];
		for (const [name, breakIt, problem] of broken) {
			breakIt();
			const tip = commitAll(`${name} result`);
			const outcome = ciGate(root, base, tip, options());
			expect([name, outcome.code]).toEqual([name, 1]);
			expect(text(outcome.lines)).toContain(
				"Shepherd evals result does not verify:",
			);
			expect(text(outcome.lines)).toMatch(problem);
			expect(text(outcome.summary)).toMatch(problem);
		}
	});

	test("GitHub output: the job summary is appended when set; under Actions the lines run with commands stopped, then the notice", () => {
		const base = head();
		const tip = gatedChange();
		const outcome = ciGate(root, base, tip, options());
		const summaryFile = join(root, "step-summary.md");
		writeFileSync(summaryFile, "earlier step\n");
		const commands = githubReport(outcome, {
			GITHUB_ACTIONS: "true",
			GITHUB_STEP_SUMMARY: summaryFile,
		});
		const written = readFileSync(summaryFile, "utf8");
		expect(written.startsWith("earlier step\n")).toBe(true);
		expect(written).toContain(sourceHash());
		const token = commands[0]?.match(/^::stop-commands::([0-9a-f]{32})$/)?.[1];
		expect(token).toBeDefined();
		expect(commands.slice(1, -2)).toEqual(outcome.lines);
		expect(commands.at(-2)).toBe(`::${token}::`);
		expect(commands.at(-1)).toMatch(
			/^::notice title=Shepherd evals::No result for source sha256:[0-9a-f]{64}/,
		);
		expect(commands.at(-1)).not.toMatch(/[\r\n]/);
		expect(githubReport(outcome, {})).toEqual(outcome.lines);
	});
});

describe("H1 fix round 1", () => {
	const identity = () => evaluationIdentity(root, { git: testGit }).hash;
	const gatedChange = (value = 2) => {
		writeAt(root, "lib/shepherd/tool.ts", `export const tool = ${value};\n`);
		return commitAll(`source ${value}`);
	};
	/** No line breaks inside a line, and no line a runner could read as a workflow command. */
	const safe = (lines: string[]) => {
		const control = (c: string) => {
			const n = c.codePointAt(0) ?? 0;
			return (
				n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029
			);
		};
		for (const line of lines) {
			expect([...line].filter(control)).toEqual([]);
			expect(line.trimStart().startsWith("::")).toBe(false);
		}
	};

	test("0: a stale but honest result succeeds with a notice naming both identities", () => {
		const base = head();
		gatedChange();
		const { value } = writeResult();
		commitAll("results");
		writeAt(root, "evals/shepherd/scorer-prompt.md", "changed\n");
		const tip = commitAll("the evaluation implementation changed");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		const out = text(outcome.lines);
		expect(out).toContain(
			`is out of date and was not verified: it records evaluation identity ${value.evaluation.hash}, and this tree computes ${identity()}`,
		);
		expect(out).not.toContain("result verified");
		expect(outcome.notice).toContain(value.evaluation.hash);
		expect(outcome.notice).toContain(identity());
		expect(text(outcome.summary)).toContain(identity());
	});

	test("0: a stale result that is also hand-edited, symlinked or evidence-mismatched fails", () => {
		const base = head();
		gatedChange();
		// The symlinked case comes last: a later writeResult would write through it.
		const broken: [string, () => void, RegExp][] = [
			[
				"hand-edited",
				() => {
					const { value, path } = writeResult();
					const artifact =
						value.evaluation.trials[0]?.attempts[0]?.artifacts[0];
					if (artifact) artifact.bytes += 1;
					writeFileSync(path, JSON.stringify(value));
				},
				/A attempt 1/,
			],
			[
				"evidence mismatch",
				() => {
					const { value } = writeResult();
					const dir = value.evaluation.trials[0]?.attempts[0]?.artifactDir;
					writeFileSync(
						join(root, "evals/shepherd", dir ?? "", "claude.jsonl"),
						"tampered\n",
					);
				},
				/claude\.jsonl does not match/,
			],
			[
				"symlinked",
				() => {
					const { path, hex } = writeResult();
					const moved = `evals/shepherd/validation/${hex}/run/result.json`;
					writeAt(root, moved, readFileSync(path, "utf8"));
					rmSync(path);
					symlinkSync(`../validation/${hex}/run/result.json`, path);
				},
				/not a regular file/,
			],
		];
		for (const [name, breakIt, problem] of broken) {
			breakIt();
			writeAt(root, "evals/shepherd/scorer-prompt.md", `stale ${name}\n`);
			const tip = commitAll(`${name}, then stale`);
			const outcome = ciGate(root, base, tip, options());
			expect([name, outcome.code]).toEqual([name, 1]);
			expect(text(outcome.lines)).toContain(
				"Shepherd evals result does not verify:",
			);
			expect(text(outcome.lines)).toMatch(problem);
		}
	});

	test("3: a tree whose identities cannot be computed fails closed", () => {
		const base = head();
		symlinkSync("tool.ts", join(root, "lib/shepherd/link.ts"));
		const tip = commitAll("a symlinked gated source");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(1);
		expect(text(outcome.lines)).toContain(
			"Shepherd evals check failed closed:",
		);
		expect(text(outcome.lines)).not.toMatch(/no result/i);
	});

	test("4: record strings that no evidence binds cannot start a workflow command or close the summary fence", () => {
		const base = head();
		gatedChange();
		const crafted =
			"linux\n::error title=Shepherd evals::Result verified, outcome pass\n```\n![x](https://example.invalid/x.png)\r::warning::cr\u001b[31m\u0085::warning::nel\u2028::warning::ls";
		writeResult((value) => {
			const build = value.evaluation.invocations[0]?.build;
			if (build) build.platform = crafted;
		});
		const tip = commitAll("results");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		safe(outcome.lines);
		expect(text(outcome.lines)).toContain(
			"linux\\n::error title=Shepherd evals::Result verified",
		);
		// A fence closes only on a backtick run at least as long as its own.
		const fences = outcome.summary.filter((line) => /^`{3,}/.test(line));
		const fence = fences[1] ?? "";
		expect(fences).toEqual([`${fence}text`, fence]);
		const inside = outcome.summary.slice(
			outcome.summary.indexOf(`${fence}text`) + 1,
			outcome.summary.lastIndexOf(fence),
		);
		expect(text(inside)).toContain("```");
		const longest = Math.max(
			...[...text(inside).matchAll(/`+/g)].map((m) => m[0].length),
		);
		expect(fence.length).toBeGreaterThan(longest);
		safe(outcome.summary);
		const printed = githubReport(outcome, { GITHUB_ACTIONS: "true" });
		const token = printed[0]?.replace("::stop-commands::", "") ?? "";
		expect(text(printed.slice(1, -1))).not.toContain(token);
	});

	test("4: a gated path holding a newline is printed escaped, and the notice still follows", () => {
		const base = head();
		const name = "lib/shepherd/x\n::stop-commands::tok\n.ts";
		writeAt(root, name, "export const x = 1;\n");
		const tip = commitAll("a crafted path");
		const outcome = ciGate(root, base, tip, options());
		safe(outcome.lines);
		safe(outcome.summary);
		expect(text(outcome.lines)).toContain(
			"lib/shepherd/x\\n::stop-commands::tok\\n.ts",
		);
		const printed = githubReport(outcome, { GITHUB_ACTIONS: "true" });
		expect(printed[0]).toMatch(/^::stop-commands::[0-9a-f]{32}$/);
		if (outcome.notice)
			expect(printed.at(-1)).toMatch(/^::notice title=Shepherd evals::/);
	});

	test("6: newest is the latest commit time among commits touching a result, also after a merge, where topological order differs", () => {
		const at = (date: string) =>
			createGitRunner({
				...TEST_GIT_ENV,
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_DATE: date,
			});
		const commitAt = (date: string, message: string) => {
			const run = at(date);
			expect(run(["add", "-A"], root).code).toBe(0);
			expect(run(["commit", "-q", "-m", message], root).code).toBe(0);
			return head();
		};
		const base = head();
		const trunk = git(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
		git(root, "checkout", "-q", "-b", "side");
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		commitAt("2026-10-01T10:00:00Z", "side source");
		const side = writeResult();
		commitAt("2026-10-01T11:00:00Z", "side result");
		git(root, "checkout", "-q", trunk);
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 3;\n");
		const trunkRevision = commitAt("2026-10-05T10:00:00Z", "trunk source");
		const later = writeResult();
		commitAt("2026-10-05T11:00:00Z", "trunk result");
		const merge = at("2026-10-09T10:00:00Z")(
			["merge", "-q", "--no-edit", "-X", "ours", "side"],
			root,
		);
		expect(merge.code).toBe(0);
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 4;\n");
		const tip = commitAt("2026-10-10T10:00:00Z", "tip");
		expect(
			git(
				root,
				"log",
				"--topo-order",
				"--no-merges",
				"--format=%s",
				"--",
				"evals/shepherd/results/",
			)
				.trim()
				.split("\n")[0],
		).toBe("side result");
		const out = text(ciGate(root, base, tip, options()).lines);
		expect(out).toContain(
			`Newest committed result: evals/shepherd/results/${later.hex}.json, revision ${trunkRevision}, outcome pass`,
		);
		expect(side.hex).not.toBe(later.hex);
	});

	test("7: a committed revision that is not 40 hex is never printed", () => {
		const base = head();
		const forged = result();
		const build = forged.evaluation.invocations[0]?.build;
		if (build) build.revision = "x\n::error::y";
		writeAt(
			root,
			`evals/shepherd/results/${"d".repeat(64)}.json`,
			JSON.stringify(forged),
		);
		commitAll("an older result with a forged revision");
		const tip = gatedChange();
		const out = text(ciGate(root, base, tip, options()).lines);
		expect(out).toContain(
			`Newest committed result: evals/shepherd/results/${"d".repeat(64)}.json, which cannot be read as a result`,
		);
		expect(out).not.toContain("::error::");
	});

	test("7: the notice escapes percent, CR and LF as workflow command data", () => {
		const printed = githubReport(
			{ code: 0, lines: [], summary: [], notice: "a%b\rc\nd" },
			{ GITHUB_ACTIONS: "true" },
		);
		expect(printed.at(-1)).toBe("::notice title=Shepherd evals::a%25b%0Dc%0Ad");
	});
});

describe("H1 fix round 2", () => {
	const identity = () => evaluationIdentity(root, { git: testGit }).hash;
	const gatedChange = (value = 2) => {
		writeAt(root, "lib/shepherd/tool.ts", `export const tool = ${value};\n`);
		return commitAll(`source ${value}`);
	};
	const makeStale = (n = 1) => {
		writeAt(root, "evals/shepherd/scorer-prompt.md", `changed ${n}\n`);
		return commitAll(`the evaluation implementation changed ${n}`);
	};
	/** A result an earlier schema wrote: this tree's schema cannot read it. */
	const earlierSchema = (value: Result) => {
		(value as { schemaVersion: number }).schemaVersion = 0;
	};

	test("12: an honest stale result this tree's schema cannot read gives the stale notice, naming both identities", () => {
		const base = head();
		gatedChange();
		const { value } = writeResult(earlierSchema);
		commitAll("results");
		const tip = makeStale();
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		const note = `is out of date and this tree's schema cannot read it, so it was not verified: it records evaluation identity ${value.evaluation.hash}, and this tree computes ${identity()}`;
		expect(text(outcome.lines)).toContain(note);
		expect(outcome.notice).toContain(note);
		expect(text(outcome.lines)).not.toContain("does not verify");
	});

	test("12: a result for the current identity that fails the schema still fails", () => {
		const base = head();
		gatedChange();
		writeResult(earlierSchema);
		const tip = commitAll("results");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(1);
		expect(text(outcome.lines)).toMatch(/is not a valid result: schemaVersion/);
	});

	test("12: an unreadable stale result still fails on tampered evidence, another source, an escaping artifact directory or an unreadable identity", () => {
		const base = head();
		gatedChange();
		const cases: [string, (value: Result, hex: string) => void, RegExp][] = [
			[
				"tampered",
				(value) => {
					const dir = value.evaluation.trials[0]?.attempts[0]?.artifactDir;
					writeFileSync(
						join(root, "evals/shepherd", dir ?? "", "claude.jsonl"),
						"tampered\n",
					);
				},
				/claude\.jsonl does not match/,
			],
			[
				"another source",
				(value) => {
					value.source.hash = `sha256:${"9".repeat(64)}`;
				},
				/records source sha256:9{64}/,
			],
			[
				"escaping directory",
				(value, hex) => {
					const a = value.evaluation.trials[0]?.attempts[0];
					if (a) a.artifactDir = `artifacts/${hex}/../../results`;
				},
				/evidence cannot be read/,
			],
			[
				"unreadable identity",
				(value) => {
					value.evaluation.hash = "not an identity";
				},
				/is not a valid result/,
			],
		];
		let n = 0;
		for (const [name, breakIt, problem] of cases) {
			const { value, path, hex } = writeResult(earlierSchema);
			breakIt(value, hex);
			writeFileSync(path, JSON.stringify(value));
			const tip = makeStale(++n);
			const outcome = ciGate(root, base, tip, options());
			expect([name, outcome.code]).toEqual([name, 1]);
			expect([name, text(outcome.lines)]).toEqual([
				name,
				expect.stringMatching(problem),
			]);
		}
	});

	test("12: a stale record with a forged aggregate breaks the schema and passes as unreadable: the widened limit", () => {
		const base = head();
		gatedChange();
		writeResult(
			(value) => {
				value.outcome = "pass";
				value.evaluation.outcome = "pass";
			},
			result({ "G-neg.M2": "fail" }),
		);
		commitAll("a forged result");
		const tip = makeStale();
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		expect(outcome.notice).toContain("this tree's schema cannot read it");
		expect(outcome.notice).not.toContain("outcome");
	});

	test("14: the stale notice is the stale note, whatever a path in another note says", () => {
		const base = head();
		writeAt(root, "lib/shepherd/out of date.ts", "export const x = 1;\n");
		const { value } = writeResult();
		commitAll("source and results, the new file evaluated untracked");
		const tip = makeStale();
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(0);
		expect(text(outcome.lines)).toContain("lib/shepherd/out of date.ts");
		expect(outcome.notice).toMatch(/^Result evals\/shepherd\/results\//);
		expect(outcome.notice).toContain(value.evaluation.hash);
		expect(outcome.notice).toContain(identity());
	});

	test("16: the notice is printable whatever it holds", () => {
		const outcome = checkOutcome(
			[],
			0,
			"headline",
			["detail"],
			"n\u001b\u2028\u0085\r\n",
		);
		expect(outcome.notice).toBe("n\\u001b\\u2028\\u0085\\r\\n");
	});
});
