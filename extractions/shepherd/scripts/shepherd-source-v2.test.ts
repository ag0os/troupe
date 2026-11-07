import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
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
	createGitRunner,
	readSourceInputs,
	SourceInputError,
} from "troupe/provenance";
import {
	dependencyIdentity,
	evaluationInputs,
	frameworkRevision,
	isSourcePath,
	readV2Source,
	shepherdStampV2,
	type V2Layout,
} from "./shepherd-source-v2";

// O15: v2 membership is the extracted package's table, read from the
// filesystem by the same predicate `isSourcePath` answers. Fixtures only.

/** The miniature package: a literal list, with no v1 adapter or legacy wrapper. */
const PACKAGE: Record<string, string> = {
	"package.json": JSON.stringify({
		dependencies: { troupe: "file:../dist/troupe" },
	}),
	"bun.lock":
		'{\n  "packages": {\n    "troupe": ["troupe@file:../dist/troupe", {},],\n  },\n}\n',
	"tsconfig.json": "{}\n",
	".gitignore": "node_modules\n",
	"agents/shepherd.md": "declaration\n",
	"agents/shepherd.ts": "extension\n",
	"scripts/build.ts": "build\n",
	"scripts/watch.ts": "watch\n",
	"scripts/shepherd-definition.ts": "definition\n",
	"scripts/shepherd-source-v2.ts": "policy\n",
	"scripts/eval-source.ts": "eval seam\n",
};

/** Table rows: created in the fixture, selected or not. */
const ROWS: [string, boolean, string][] = [
	["package.json", true, "metadata"],
	["bun.lock", true, "lockfile"],
	["tsconfig.json", true, "configuration"],
	[".gitignore", true, "the package's ignore file"],
	["scripts/shepherd-source-v2.ts", true, "policy"],
	["scripts/shepherd-definition.ts", true, "build definition"],
	["scripts/build.ts", true, "build script"],
	["scripts/watch.ts", true, "watcher (C4)"],
	["agents/shepherd.md", true, "declaration"],
	["agents/shepherd.ts", true, "extension"],
	["system-prompts/shepherd/core.md", true, "prompts"],
	["packages/software/MODULE.md", true, "module"],
	["packages/software/tools/publish-check", true, "runtime tool"],
	["packages/software/tests/x.test.ts", true, "software test"],
	["lib/shepherd/compose.ts", true, "library"],
	["lib/shepherd/test-helpers.ts", true, "library helper"],
	["lib/shepherd/compose.test.ts", false, "library test"],
	["lib/shepherd/__fixtures__/a.md", false, "library fixture"],
	["lib/shepherd/__snapshots__/a.snap", false, "library snapshot"],
	["bin/shepherd", false, "output"],
	["extractions/.troupe-dist/troupe/package.json", false, "staging"],
	["evals/shepherd/results/x.json", false, "eval evidence"],
	["evals/shepherd/rubric.yaml", false, "evaluation input (own selector)"],
	["scripts/eval-source.ts", false, "eval build seam (evaluation input)"],
	["packages/software/.DS_Store", false, "host byproduct"],
	["packages/software/node_modules/x.ts", false, "installed module"],
	["packages/software/tools/__pycache__/x.pyc", false, "bytecode"],
	["packages/software/old.pyc", false, "bytecode by name"],
	[
		"packages/software/cache.pyc/helper.ts",
		false,
		"beneath a bytecode-named directory (C23)",
	],
	["packages/software/x.pyc.ts", true, "a suffix only in the middle"],
	["scripts/shepherd-source.ts", false, "v1 adapter"],
	["scripts/watch-agents.ts", false, "legacy watcher"],
	["scripts/agent-compiler.ts", false, "legacy wrapper"],
	["agents/webfetch.md", false, "other agent"],
];

let dir: string;
let layout: V2Layout;

function put(path: string, text: string) {
	const full = join(dir, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

const context = () => ({
	agentId: "shepherd",
	consumerRoot: layout.packageRoot,
	declarationRoot: join(layout.packageRoot, "agents"),
	outDir: join(layout.packageRoot, "bin"),
});

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-v2-")));
	layout = {
		packageRoot: join(dir, "package"),
		troupeRoot: join(dir, "dist/troupe"),
	};
	for (const [path, text] of Object.entries(PACKAGE)) {
		put(`package/${path}`, text);
	}
	for (const [path] of ROWS) {
		if (!(path in PACKAGE)) put(`package/${path}`, `${path}\n`);
	}
	chmodSync(join(dir, "package/packages/software/tools/publish-check"), 0o755);
	put("dist/troupe/package.json", "{}\n");
	put("dist/troupe/lib/agent-format/compiler.ts", "compiler\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("package-relative membership table (O15)", () => {
	test("capture succeeds on the miniature package", async () => {
		const captured = await shepherdStampV2(layout).capture(context());
		expect(captured.manifest.source).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("capture succeeds with no v1 adapter or legacy wrapper present (R1)", async () => {
		const legacy = [
			"scripts/shepherd-source.ts",
			"scripts/watch-agents.ts",
			"scripts/agent-compiler.ts",
		];
		for (const path of legacy) rmSync(join(layout.packageRoot, path));
		for (const path of legacy) {
			expect(existsSync(join(layout.packageRoot, path))).toBe(false);
		}
		const captured = await shepherdStampV2(layout).capture(context());
		expect(captured.manifest.source).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(
			captured.manifest.entries.some((entry) =>
				legacy.some((path) => entry.path.endsWith(path)),
			),
		).toBe(false);
	});

	for (const [path, selected, why] of ROWS) {
		test(`${path}: ${selected ? "selected" : "not selected"} (${why})`, () => {
			const paths = readV2Source(layout).entries.map((entry) => entry.path);
			expect(paths.includes(`package/shepherd/${path}`)).toBe(selected);
			expect(isSourcePath(path)).toBe(selected);
		});
	}

	test("a mutation of the build definition changes the identity", () => {
		const before = readV2Source(layout).source;
		put("package/scripts/shepherd-definition.ts", "definition 2\n");
		expect(readV2Source(layout).source).not.toBe(before);
	});
});

describe("v2 identity on miniature fixtures (O14, O15, O16)", () => {
	test("the framework origin is namespaced beside the package", () => {
		const paths = readV2Source(layout).entries.map((entry) => entry.path);
		expect(paths).toContain("framework/troupe/lib/agent-format/compiler.ts");
		expect(paths).toContain("framework/troupe/package.json");
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
		const captured = await policy.capture(context());
		expect(captured.provenance.origins).toEqual([
			expect.objectContaining({
				origin: "framework/troupe",
				revision: "file:../dist/troupe",
				marker: "local",
				dependency: {
					requested: "file:../dist/troupe",
					resolved: "troupe@file:../dist/troupe",
				},
			}),
			expect.objectContaining({
				origin: "package/shepherd",
				revision: "unknown",
				marker: "local",
			}),
		]);
		expect(policy.versionLine("shepherd", captured)).toBe(
			`shepherd troupe-agent-source-v2 framework/troupe=file:../dist/troupe+local package/shepherd=unknown+local source=${captured.manifest.source}`,
		);
		expect((await policy.recheck(context(), captured)).source).toBe(
			captured.manifest.source,
		);
		put("dist/troupe/lib/agent-format/compiler.ts", "restaged\n");
		expect((await policy.recheck(context(), captured)).source).not.toBe(
			captured.manifest.source,
		);
	});

	test("evaluation inputs are a separate selector without evidence", () => {
		const evaluation = readSourceInputs(evaluationInputs(layout.packageRoot));
		expect(evaluation.files.map((file) => file.path)).toEqual([
			"scripts/eval-source.ts",
			"evals/shepherd/rubric.yaml",
		]);
	});
});

// C17: each origin's revision carries a marker when its selected bytes are
// not those of the commit it records. Temporary fixture repositories only.
describe("revision markers (C17)", () => {
	const testGit = createGitRunner({
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	});
	const git = (...args: string[]) => {
		const result = testGit(args, dir);
		expect(result.code).toBe(0);
		return new TextDecoder().decode(result.stdout).trim();
	};
	let head: string;

	/** The fixture committed as a repository at `dir`, the package under `package/`. */
	beforeEach(() => {
		put("package/biome.json", "{}\n");
		git("init", "-q", "-b", "main");
		git("add", "-A");
		git("commit", "-q", "-m", "fixture");
		head = git("rev-parse", "HEAD");
		layout = {
			...layout,
			revision: { gitRoot: dir, prefix: "package", git: testGit },
		};
	});

	const line = async () => {
		const policy = shepherdStampV2(layout);
		const captured = await policy.capture(context());
		return {
			captured,
			line: policy
				.versionLine("shepherd", captured)
				.replace(captured.manifest.source, "<source>"),
		};
	};

	test("a clean Git package with a folder dependency", async () => {
		const { captured, line: version } = await line();
		expect(version).toBe(
			`shepherd troupe-agent-source-v2 framework/troupe=file:../dist/troupe+local package/shepherd=${head} source=<source>`,
		);
		expect(captured.provenance.origins).toEqual([
			expect.objectContaining({
				revision: "file:../dist/troupe",
				marker: "local",
			}),
			expect.objectContaining({
				revision: head,
				prefix: "package",
				marker: null,
			}),
		]);
	});

	test("an empty prefix compares the whole repository's tree", async () => {
		const root = join(dir, "package");
		const result = testGit(["init", "-q", "-b", "main"], root);
		expect(result.code).toBe(0);
		expect(testGit(["add", "-A"], root).code).toBe(0);
		expect(testGit(["commit", "-q", "-m", "nested"], root).code).toBe(0);
		const nested = new TextDecoder()
			.decode(testGit(["rev-parse", "HEAD"], root).stdout)
			.trim();
		layout = {
			...layout,
			revision: { gitRoot: root, prefix: "", git: testGit },
		};
		expect((await line()).line).toContain(`package/shepherd=${nested} `);
		put("package/agents/shepherd.md", "changed\n");
		expect((await line()).line).toContain(`package/shepherd=${nested}+dirty `);
	});

	test("a SHA-256 repository compares blobs in its own hash", async () => {
		rmSync(join(dir, ".git"), { recursive: true, force: true });
		git("init", "-q", "-b", "main", "--object-format=sha256");
		git("add", "-A");
		git("commit", "-q", "-m", "fixture");
		const commit = git("rev-parse", "HEAD");
		expect(commit).toHaveLength(64);
		expect((await line()).line).toContain(`package/shepherd=${commit} `);
		put("package/agents/shepherd.ts", "changed\n");
		expect((await line()).line).toContain(`package/shepherd=${commit}+dirty `);
	});

	test("a modified selected file makes the package dirty", async () => {
		put("package/system-prompts/shepherd/core.md", "edited\n");
		expect((await line()).line).toContain(`package/shepherd=${head}+dirty `);
	});

	test("an added or removed selected file makes the package dirty", async () => {
		put("package/packages/software/NEW.md", "new\n");
		expect((await line()).line).toContain(`package/shepherd=${head}+dirty `);
		rmSync(join(dir, "package/packages/software/NEW.md"));
		rmSync(join(dir, "package/packages/software/MODULE.md"));
		expect((await line()).line).toContain(`package/shepherd=${head}+dirty `);
	});

	test("files outside the selection never make it dirty", async () => {
		put("package/biome.json", '{"changed": true}\n');
		put("package/lib/shepherd/compose.test.ts", "edited test\n");
		put("package/lib/shepherd/new.test.ts", "new test\n");
		put("package/bin/shepherd", "rebuilt\n");
		put("outside.md", "a file outside the package\n");
		expect((await line()).line).toContain(`package/shepherd=${head} `);
	});

	test("an executable-bit flip on a runtime tool makes it dirty", async () => {
		chmodSync(
			join(dir, "package/packages/software/tools/publish-check"),
			0o644,
		);
		expect((await line()).line).toContain(`package/shepherd=${head}+dirty `);
	});

	test("a Git dependency records the lockfile's commit with no marker", async () => {
		const commit = "0123456789abcdef0123456789abcdef01234567";
		put(
			"package/bun.lock",
			`{\n  "packages": {\n    "troupe": ["troupe@github:owner/troupe#${commit}", {},],\n  },\n}\n`,
		);
		const { captured, line: version } = await line();
		expect(version).toContain(` framework/troupe=${commit} `);
		expect(captured.provenance.origins).toEqual([
			expect.objectContaining({ revision: commit, marker: null }),
			expect.anything(),
		]);
	});

	test("lockfile resolutions map to a revision and marker", () => {
		const commit = "0123456789abcdef0123456789abcdef01234567";
		expect(frameworkRevision(`troupe@github:owner/troupe#${commit}`)).toEqual({
			revision: commit,
			marker: null,
		});
		expect(
			frameworkRevision(
				`troupe@git+https://example.invalid/troupe.git#${commit}`,
			),
		).toEqual({ revision: commit, marker: null });
		expect(frameworkRevision("troupe@github:owner/troupe#0123abc")).toEqual({
			revision: "unknown",
			marker: "local",
		});
		expect(
			frameworkRevision("troupe@git+https://example.invalid/troupe.git"),
		).toEqual({
			revision: "unknown",
			marker: "local",
		});
		expect(frameworkRevision("troupe@file:../.troupe-dist/troupe")).toEqual({
			revision: "file:../.troupe-dist/troupe",
			marker: "local",
		});
		expect(frameworkRevision(undefined)).toEqual({
			revision: "unknown",
			marker: "local",
		});
	});

	test("no lockfile entry and no Git give unknown+local", async () => {
		rmSync(join(dir, ".git"), { recursive: true, force: true });
		put("package/bun.lock", '{\n  "packages": {},\n}\n');
		expect((await line()).line).toBe(
			"shepherd troupe-agent-source-v2 framework/troupe=unknown+local package/shepherd=unknown+local source=<source>",
		);
	});
});
