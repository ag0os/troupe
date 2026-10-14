import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { readWorktreeSource } from "../../scripts/shepherd-source";
import {
	git,
	initShepherdRepo,
	testGit,
	writeAt,
} from "../../scripts/shepherd-source-fixture";
import { type ChecksOutput, pythonChecks } from "./gate";
import {
	ADOPTED_GATED_PATHS,
	type GatedPathPolicy,
	isGatedPath,
} from "./gated-paths";
import { evaluationIdentity } from "./identity";
import {
	type Attempt,
	type MustOutcome,
	policyHash,
	type Result,
} from "./schema";
import { attempt, behavioral, RUN_ID, result } from "./testing";
import {
	ALWAYS_GATED,
	changedPaths,
	ciGate,
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
			for (const [path, type] of extra) {
				attempt.artifacts.push({
					path,
					sha256: "",
					bytes: 0,
					type,
					redactions: 0,
				});
			}
			for (const artifact of attempt.artifacts) {
				const text =
					artifact.path === "claude-run.json"
						? `${JSON.stringify(runManifest(attempt))}\n`
						: `${trial.trial} ${attempt.ordinal} ${artifact.path}\n`;
				writeAt(evals, `${attempt.artifactDir}/${artifact.path}`, text);
				artifact.sha256 = sha256(text);
				artifact.bytes = Buffer.byteLength(text);
			}
			// The scored packet is the archived one.
			const packet = attempt.artifacts.find((a) => a.path === "packet.md");
			if (attempt.scoring && packet) {
				attempt.scoring.packetSha256 = `sha256:${packet.sha256}`;
				for (const invocation of attempt.scoring.invocations)
					invocation.packetSha256 = `sha256:${packet.sha256}`;
			}
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

/** The harness's `claude-run.json` as the gate would have read it for `attempt`. */
function runManifest(attempt: Attempt) {
	return {
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

	test("a gated change without a result fails", () => {
		const base = head();
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		const tip = commitAll("source");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(1);
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

	test("a stale result for an earlier source fails: only the exact source hash counts", () => {
		const base = head();
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		commitAll("source");
		writeResult();
		commitAll("results");
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 3;\n");
		const tip = commitAll("source changed after evaluation");
		const outcome = ciGate(root, base, tip, options());
		expect(outcome.code).toBe(1);
		expect(text(outcome.lines)).toMatch(/no result/i);
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

	test("a missing result fails and names the exact file", () => {
		const outcome = verify();
		expect(outcome.ok).toBe(false);
		expect(text(outcome.problems)).toMatch(/no result/i);
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

	test("a rubric change makes the result stale", () => {
		writeResult();
		writeAt(
			root,
			"evals/shepherd/rubric.json",
			`${readFileSync(join(root, "evals/shepherd/rubric.json"), "utf8")}\n`,
		);
		const outcome = verify();
		expect(outcome.ok).toBe(false);
		expect(text(outcome.problems)).toMatch(/evaluation identity/);
	});

	test("a policy change makes the result stale", () => {
		writeResult();
		const path = join(root, "evals/shepherd/policy.json");
		const policy = JSON.parse(readFileSync(path, "utf8"));
		policy.subjectTimeoutSeconds = 600;
		writeFileSync(path, JSON.stringify(policy));
		const outcome = verify();
		expect(outcome.ok).toBe(false);
		expect(text(outcome.problems)).toMatch(/evaluation identity/);
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

	test("a forged aggregate status fails, and so does an honest blocked one", () => {
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
		expect(blocked.ok).toBe(false);
		expect(text(blocked.problems)).toMatch(/blocked/);
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
		expect(outcome.ok).toBe(false);
		expect(text(outcome.problems)).toMatch(/no result/i);
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
			expect([path, outcome.code]).toEqual([path, 1]);
			expect(text(outcome.lines)).toMatch(/no result/);
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
				setArtifact(a, "claude.jsonl", sessionLog(a.binaryEvidence.expected));
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

/** A native log whose one tool result proves `binary`, under the policy model. */
function sessionLog(binary: string): string {
	return `${[
		{
			type: "assistant",
			message: {
				model: "claude-opus-5-5",
				content: [{ type: "tool_use", id: "toolu_s", name: "Bash" }],
			},
		},
		{
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_s",
						content: `binary: ${binary}\n`,
					},
				],
			},
		},
	]
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
		writeResult(forge, result({}, { A: [first, forged, pass] }));
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
