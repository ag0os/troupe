import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGatedPath } from "../evals/shepherd/gated-paths";
import { EVALUATION_MODULES } from "../evals/shepherd/identity";
import { result } from "../evals/shepherd/testing";
import { ALWAYS_GATED, verifyResults } from "../evals/shepherd/verify";
import {
	compileAgent,
	GATED_MODULES,
	gitStamp,
	IDENTITY_MODULE,
	isSourcePath,
	readWorktreeSource,
} from "./eval-source";
import { initShepherdRepo, testGit, writeAt } from "./eval-source-fixture";
import { PACKAGE_ROOT } from "./shepherd-definition";
import { EVAL_SEAM, evaluationInputs } from "./shepherd-source-v2";

// The eval seam is an evaluation input: v2's source membership does not
// select it, so the seam names it among the always gated modules.
describe("the package eval gate covers its build seam", () => {
	test("the identity module and the seam are gated under every policy", () => {
		expect([...GATED_MODULES].sort()).toEqual(
			[IDENTITY_MODULE, "scripts/eval-source.ts"].sort(),
		);
		for (const path of GATED_MODULES) {
			expect([path, isGatedPath(path)]).toEqual([path, true]);
			expect([path, ALWAYS_GATED.includes(path)]).toEqual([path, true]);
		}
	});

	test("the evaluation identity hashes the seam, as v2's evaluation inputs select it", () => {
		expect(isSourcePath(EVAL_SEAM)).toBe(false);
		expect(EVALUATION_MODULES).toEqual([EVAL_SEAM]);
		expect(evaluationInputs(PACKAGE_ROOT).files).toEqual([
			...EVALUATION_MODULES,
		]);
	});
});

// A3: the version line's framework part is the lockfile of the package the
// build was captured from, and the verifier reads the checked-out package's.
describe("the eval version line follows the captured package", () => {
	const scratch = realpathSync(
		mkdtempSync(join(tmpdir(), "shepherd-eval-version-")),
	);
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));
	const EVALS = join(PACKAGE_ROOT, "evals/shepherd");

	function fixture(name: string, troupe: string): string {
		const root = join(scratch, name);
		mkdirSync(root);
		initShepherdRepo(root, {
			// The fixture's default ignores itself, leaving the package dirty.
			".gitignore": "bin/\n",
			"package.json": `${JSON.stringify({ dependencies: { troupe } })}\n`,
			"bun.lock": `{\n  "lockfileVersion": 1,\n  "packages": {\n    "troupe": ["troupe@${troupe}", {}],\n  },\n}\n`,
			"evals/shepherd/rubric.json": readFileSync(
				join(EVALS, "rubric.json"),
				"utf8",
			),
			"evals/shepherd/policy.json": readFileSync(
				join(EVALS, "policy.json"),
				"utf8",
			),
		});
		return root;
	}

	/** The line a build of `root` prints, read from the entry the compiler generated. */
	async function builtLine(root: string): Promise<string> {
		let line = "";
		await compileAgent({
			root,
			file: "agents/shepherd.md",
			outFile: join(scratch, `${root.split("/").at(-1)}-shepherd`),
			stamp: gitStamp(testGit),
			build: async (request) => {
				writeFileSync(request.outFile, "");
				const entry = readFileSync(request.entry, "utf8");
				line =
					entry.match(/shepherd troupe-agent-source-v2 [^"\\\n]+/)?.[0] ?? "";
			},
		});
		return line;
	}

	/** Problems verify reports about version output for a result recording `version`. */
	function versionProblems(root: string, version: string): string[] {
		const source = readWorktreeSource(root, { git: testGit });
		const value = result();
		value.source = { hash: source.source, manifest: source.entries };
		const build = value.evaluation.invocations[0]?.build;
		if (!build) throw new Error("the handmade result has no build");
		build.revision = git(root);
		build.dirty = false;
		build.sourceDirty = false;
		build.version = `${version}\n`;
		writeAt(
			root,
			`evals/shepherd/results/${source.source.slice(7)}.json`,
			`${JSON.stringify(value, null, "\t")}\n`,
		);
		return verifyResults(root, { git: testGit }).problems.filter((problem) =>
			problem.includes("version output"),
		);
	}

	const git = (root: string) =>
		new TextDecoder()
			.decode(testGit(["rev-parse", "HEAD"], root).stdout)
			.trim();

	test("two packages with different troupe resolutions each get their own line", async () => {
		const lines: Record<string, string> = {};
		for (const [name, troupe] of [
			["alpha", "file:../alpha-troupe"],
			["beta", "file:../beta-troupe"],
		] as const) {
			const root = fixture(name, troupe);
			const source = readWorktreeSource(root, { git: testGit }).source;
			const expected = `shepherd troupe-agent-source-v2 framework/troupe=${troupe}+local package/shepherd=${git(root)} source=${source}`;
			expect([name, await builtLine(root)]).toEqual([name, expected]);
			expect([name, versionProblems(root, expected)]).toEqual([name, []]);
			lines[name] = expected;
		}
		// Each verifier reads its own package's lock: the other's line is refused.
		const alpha = join(scratch, "alpha");
		const swapped = (lines.alpha ?? "").replace("alpha-troupe", "beta-troupe");
		expect(versionProblems(alpha, swapped)).toHaveLength(1);
	});
});
