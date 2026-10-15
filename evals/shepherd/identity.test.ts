import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	framedDigest,
	ShepherdSourceError,
} from "../../scripts/shepherd-source";
import { git, testGit, writeAt } from "../../scripts/shepherd-source-fixture";
import {
	EVALUATION_DOMAIN,
	evaluationIdentity,
	HARNESS_VERSION,
	isEvaluationPath,
} from "./identity";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-evals-identity-")));
	writeAt(root, "evals/shepherd/harness.py", "print('harness')\n");
	writeAt(root, "evals/shepherd/policy.json", "{}\n");
	writeAt(root, "README.md", "outside\n");
	writeAt(root, ".gitignore", ".DS_Store\n");
	git(root, "init", "-q", "-b", "main");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "fixture");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const identity = () => evaluationIdentity(root, { git: testGit });
const paths = () => identity().entries.map((entry) => entry.path);
const bytes = (text: string) => new TextEncoder().encode(text);

describe("evaluation identity (6.2)", () => {
	test("hashes the evaluation files with section 1 framing and its own domain", () => {
		expect(EVALUATION_DOMAIN).toBe("troupe-shepherd-evals-v1");
		expect(HARNESS_VERSION).toBe(1);
		const expected = framedDigest(EVALUATION_DOMAIN, [
			{
				path: "evals/shepherd/harness.py",
				content: bytes("print('harness')\n"),
			},
			{ path: "evals/shepherd/policy.json", content: bytes("{}\n") },
		]);
		const result = identity();
		expect(result.harnessVersion).toBe(1);
		expect(result.hash).toBe(`sha256:${expected}`);
		expect(paths()).toEqual([
			"evals/shepherd/harness.py",
			"evals/shepherd/policy.json",
		]);
	});

	test("leaves out results, artifacts, validation, bytecode and ignored files", () => {
		const before = identity().hash;
		for (const path of [
			"evals/shepherd/results/abc.json",
			"evals/shepherd/artifacts/abc/run/A/claude.jsonl",
			"evals/shepherd/validation/abc/run/x.json",
			"evals/shepherd/__pycache__/harness.cpython-314.pyc",
			"evals/shepherd/nested/__pycache__/x.py",
			"evals/shepherd/stray.pyc",
			"evals/shepherd/.DS_Store",
		]) {
			writeAt(root, path, "noise\n");
		}
		expect(identity().hash).toBe(before);
		expect(isEvaluationPath("evals/shepherd/results/x.json")).toBe(false);
		expect(isEvaluationPath("evals/shepherd/check-harness.py")).toBe(true);
		expect(isEvaluationPath("evals/shepherd/tests/results/x.py")).toBe(true);
		expect(isEvaluationPath("evals/other/x.py")).toBe(false);
	});

	test("marks untracked files and changes with bytes, additions and deletions", () => {
		const before = identity().hash;
		writeAt(root, "evals/shepherd/run.ts", "export {};\n");
		const added = identity();
		expect(added.hash).not.toBe(before);
		expect(
			added.entries.find((entry) => entry.path === "evals/shepherd/run.ts")
				?.untracked,
		).toBe(true);
		rmSync(join(root, "evals/shepherd/run.ts"));
		expect(identity().hash).toBe(before);
		writeFileSync(join(root, "evals/shepherd/policy.json"), "{ }\n");
		expect(identity().hash).not.toBe(before);
		rmSync(join(root, "evals/shepherd/policy.json"));
		expect(paths()).toEqual(["evals/shepherd/harness.py"]);
	});

	test("files outside evals/shepherd never count", () => {
		const before = identity().hash;
		writeFileSync(join(root, "README.md"), "changed\n");
		writeAt(root, "evals/other.py", "x\n");
		expect(identity().hash).toBe(before);
	});

	test("refuses symlinks and symlinked directories", () => {
		symlinkSync("harness.py", join(root, "evals/shepherd/link.py"));
		expect(() => identity()).toThrow(ShepherdSourceError);
		rmSync(join(root, "evals/shepherd/link.py"));
		mkdirSync(join(root, "elsewhere"));
		writeFileSync(join(root, "elsewhere/x.py"), "x\n");
		symlinkSync("../elsewhere", join(root, "evals/shepherd/linked"));
		expect(() => identity()).toThrow(/symlink/);
	});

	test("requires the repository root", () => {
		expect(() =>
			evaluationIdentity(join(root, "evals"), { git: testGit }),
		).toThrow(/repository root/);
	});
});
