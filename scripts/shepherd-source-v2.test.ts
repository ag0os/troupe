import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	readSourceInputs,
	SourceInputError,
} from "../lib/agent-format/provenance";
import {
	dependencyIdentity,
	evaluationInputs,
	isSourcePath,
	PACKAGE_FILES,
	readV2Source,
	shepherdStampV2,
	type V2Layout,
} from "./shepherd-source-v2";

// O15: v2 membership is a table, read from the filesystem; fixtures only.

describe("package-relative membership table (O15)", () => {
	const rows: [string, boolean, string][] = [
		["package.json", true, "metadata"],
		["bun.lock", true, "lockfile"],
		["tsconfig.json", true, "configuration"],
		[".gitignore", true, "the package's ignore file"],
		["scripts/shepherd-source.ts", true, "v1 policy"],
		["scripts/shepherd-source-v2.ts", true, "v2 policy"],
		["scripts/watch-agents.ts", true, "watch wrapper (C4)"],
		["scripts/compile.ts", true, "build wrapper"],
		["agents/shepherd.md", true, "declaration"],
		["agents/shepherd.ts", true, "extension"],
		["system-prompts/shepherd/core.md", true, "prompts"],
		["packages/software/MODULE.md", true, "module"],
		["packages/software/tools/publish-check", true, "runtime tool"],
		["packages/software/tests/x.test.ts", true, "software tests"],
		["lib/shepherd/compose.ts", true, "library"],
		["lib/shepherd/test-helpers.ts", true, "library helper"],
		["lib/shepherd/compose.test.ts", false, "library test"],
		["lib/shepherd/__fixtures__/a.md", false, "library fixture"],
		["lib/shepherd/__snapshots__/a.snap", false, "library snapshot"],
		["bin/shepherd", false, "output"],
		["extractions/.troupe-dist/troupe/package.json", false, "staging"],
		["evals/shepherd/results/x.json", false, "eval evidence"],
		["evals/shepherd/rubric.yaml", false, "evaluation input"],
		["packages/software/.DS_Store", false, "host byproduct"],
		["packages/software/tools/__pycache__/x.pyc", false, "bytecode"],
		["agents/webfetch.md", false, "other agent"],
		["lib/agent-format/compiler.ts", false, "framework, not package"],
	];
	for (const [path, selected, why] of rows) {
		test(`${path}: ${selected ? "selected" : "not selected"} (${why})`, () => {
			expect(isSourcePath(path)).toBe(selected);
		});
	}

	test("the v1 policy and watch wrapper are listed files", () => {
		expect(PACKAGE_FILES).toContain("scripts/watch-agents.ts");
		expect(PACKAGE_FILES).toContain(".gitignore");
	});
});

describe("v2 identity on miniature fixtures (O14, O15, O16)", () => {
	let dir: string;
	let layout: V2Layout;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-v2-")));
		layout = {
			packageRoot: join(dir, "package"),
			troupeRoot: join(dir, "dist/troupe"),
		};
		for (const file of PACKAGE_FILES) put(`package/${file}`, `${file}\n`);
		put(
			"package/package.json",
			JSON.stringify({ dependencies: { troupe: "file:../dist/troupe" } }),
		);
		put(
			"package/bun.lock",
			'{\n  "packages": {\n    "troupe": ["troupe@file:../dist/troupe", {},],\n  },\n}\n',
		);
		put("package/packages/software/MODULE.md", "module\n");
		put("package/packages/software/tools/publish-check", "#!/bin/sh\n");
		chmodSync(
			join(dir, "package/packages/software/tools/publish-check"),
			0o755,
		);
		put("package/lib/shepherd/a.ts", "a\n");
		put("package/lib/shepherd/a.test.ts", "test\n");
		put("package/bin/shepherd", "binary\n");
		put("package/evals/shepherd/results/r.json", "{}\n");
		put("dist/troupe/package.json", "{}\n");
		put("dist/troupe/lib/agent-format/compiler.ts", "compiler\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function put(path: string, text: string) {
		const full = join(dir, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}

	test("both origins are namespaced; outputs, evidence and tests are not hashed", () => {
		const paths = readV2Source(layout).entries.map((entry) => entry.path);
		expect(paths).toContain("framework/troupe/lib/agent-format/compiler.ts");
		expect(paths).toContain("package/shepherd/packages/software/MODULE.md");
		expect(paths).toContain(
			"package/shepherd/packages/software/tools/publish-check",
		);
		expect(paths).toContain("package/shepherd/lib/shepherd/a.ts");
		expect(paths).toContain("package/shepherd/.gitignore");
		expect(paths).not.toContain("package/shepherd/lib/shepherd/a.test.ts");
		expect(paths.some((path) => path.includes("/bin/"))).toBe(false);
		expect(paths.some((path) => path.includes("/results/"))).toBe(false);
	});

	test("ignore rules do not change membership, and .gitignore is itself an input", () => {
		const before = readV2Source(layout);
		put("package/.gitignore", "packages/\nlib/\n");
		const after = readV2Source(layout);
		expect(after.source).not.toBe(before.source);
		expect(after.entries.map((entry) => entry.path)).toEqual(
			before.entries.map((entry) => entry.path),
		);
	});

	test("a runtime tool's executable status is bound", () => {
		const before = readV2Source(layout);
		const tool = before.entries.find((entry) =>
			entry.path.endsWith("tools/publish-check"),
		);
		expect(tool?.executable).toBe(true);
		chmodSync(
			join(dir, "package/packages/software/tools/publish-check"),
			0o644,
		);
		expect(readV2Source(layout).source).not.toBe(before.source);
	});

	test("symlink and nonregular inputs are refused", () => {
		symlinkSync(
			join(dir, "package/packages/software/MODULE.md"),
			join(dir, "package/packages/software/LINK.md"),
		);
		expect(() => readV2Source(layout)).toThrow(SourceInputError);
		rmSync(join(dir, "package/packages/software/LINK.md"));
		expect(
			spawnSync("mkfifo", [join(dir, "package/packages/software/pipe")]).status,
		).toBe(0);
		expect(() => readV2Source(layout)).toThrow(
			"packages/software/pipe: an input must be a regular file",
		);
	});

	test("dependency identity comes from the consumer lockfile", () => {
		expect(dependencyIdentity(layout.packageRoot)).toEqual({
			requested: "file:../dist/troupe",
			resolved: "troupe@file:../dist/troupe",
		});
	});

	test("the policy records origins with unknown revisions and a v2 line", async () => {
		const policy = shepherdStampV2(layout);
		const context = {
			agentId: "shepherd",
			consumerRoot: layout.packageRoot,
			declarationRoot: join(layout.packageRoot, "agents"),
			outDir: join(layout.packageRoot, "bin"),
		};
		const captured = await policy.capture(context);
		expect(captured.provenance.origins).toEqual([
			expect.objectContaining({
				origin: "framework/troupe",
				revision: "unknown",
				dependency: {
					requested: "file:../dist/troupe",
					resolved: "troupe@file:../dist/troupe",
				},
			}),
			expect.objectContaining({
				origin: "package/shepherd",
				revision: "unknown",
			}),
		]);
		expect(policy.versionLine("shepherd", captured)).toBe(
			`shepherd troupe-agent-source-v2 framework/troupe=unknown package/shepherd=unknown source=${captured.manifest.source}`,
		);
		expect((await policy.recheck(context, captured)).source).toBe(
			captured.manifest.source,
		);
		put("dist/troupe/lib/agent-format/compiler.ts", "restaged\n");
		expect((await policy.recheck(context, captured)).source).not.toBe(
			captured.manifest.source,
		);
	});

	test("evaluation inputs are a separate selector without evidence", () => {
		put("package/evals/shepherd/rubric.yaml", "r\n");
		const evaluation = readSourceInputs(evaluationInputs(layout.packageRoot));
		expect(evaluation.files.map((file) => file.path)).toEqual([
			"evals/shepherd/rubric.yaml",
		]);
	});
});
