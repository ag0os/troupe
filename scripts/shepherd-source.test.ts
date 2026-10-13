import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildManifest,
	captureProvenance,
	compareUtf8,
	framedDigest,
	isSourcePath,
	readCommitSource,
	readWorktreeSource,
	ShepherdSourceError,
	SOURCE_DOMAIN,
	sameSource,
	versionLine,
} from "./shepherd-source";
import {
	git,
	initShepherdRepo,
	testGit,
	writeAt,
} from "./shepherd-source-fixture";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-source-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) =>
	new Bun.CryptoHasher("sha256").update(text).digest("hex");
const worktree = () => readWorktreeSource(root, { git: testGit });
const provenance = () => captureProvenance(root, { git: testGit });
const paths = () => worktree().entries.map((entry) => entry.path);

function problemsOf(read: () => unknown): string[] {
	try {
		read();
	} catch (error) {
		if (error instanceof ShepherdSourceError) return error.problems;
		throw error;
	}
	throw new Error("expected a ShepherdSourceError");
}

describe("framing (1.5)", () => {
	test("matches golden digests computed independently", () => {
		expect(
			framedDigest(SOURCE_DOMAIN, [
				{ path: "b.txt", content: bytes("two\n") },
				{ path: "a.txt", content: bytes("one") },
			]),
		).toBe("62977a6741ecee0933377171efd1e9e8874c98f78048126d84b04814bcd6e4eb");
		expect(framedDigest(SOURCE_DOMAIN, [])).toBe(
			"9fc3a18936290c81c8bc28bfbc8e2c26b5f1eb973afe9a3350e1489374661df9",
		);
	});

	test("sorts by unsigned UTF-8 bytes, not UTF-16 code units", () => {
		const tilde = "～.md";
		const emoji = "\u{1f600}.md";
		expect([emoji, tilde].sort()).toEqual([emoji, tilde]);
		expect([emoji, tilde].sort(compareUtf8)).toEqual([tilde, emoji]);
		expect(
			framedDigest(SOURCE_DOMAIN, [
				{ path: emoji, content: bytes("y") },
				{ path: tilde, content: bytes("x") },
			]),
		).toBe("8c979248e7760487adca116d738d523e03eb07ecdb15e088af5acbd58693f47a");
	});

	test("does not normalize line endings, and the domain separates identities", () => {
		expect(
			framedDigest(SOURCE_DOMAIN, [
				{ path: "a.txt", content: bytes("one\r\n") },
			]),
		).toBe("7af48e100ac74f6cdb4699d025331bf13220a96073785dc6e4e1b2a13565ec56");
		expect(framedDigest("troupe-shepherd-evals-v1", [])).not.toBe(
			framedDigest(SOURCE_DOMAIN, []),
		);
	});

	test("refuses duplicate paths", () => {
		expect(() =>
			framedDigest(SOURCE_DOMAIN, [
				{ path: "a", content: bytes("1") },
				{ path: "a", content: bytes("1") },
			]),
		).toThrow("duplicate");
	});

	test("the manifest records path, length, content hash and tracking, outside the hash", () => {
		const tracked = buildManifest([
			{ path: "b", content: bytes("two") },
			{ path: "a", content: bytes("one"), untracked: true },
		]);
		expect(tracked).toEqual({
			source: `sha256:${framedDigest(SOURCE_DOMAIN, [
				{ path: "a", content: bytes("one") },
				{ path: "b", content: bytes("two") },
			])}`,
			entries: [
				{ path: "a", bytes: 3, sha256: sha("one"), untracked: true },
				{ path: "b", bytes: 3, sha256: sha("two"), untracked: false },
			],
		});
		const committed = buildManifest([
			{ path: "a", content: bytes("one") },
			{ path: "b", content: bytes("two") },
		]);
		expect(committed.source).toBe(tracked.source);
		expect(sameSource(tracked, committed)).toBe(true);
		expect(
			sameSource(
				tracked,
				buildManifest([{ path: "a", content: bytes("one") }]),
			),
		).toBe(false);
	});
});

describe("membership (1.4)", () => {
	test("selects the listed files and trees, without tests, fixtures or snapshots", () => {
		for (const path of [
			"agents/shepherd.md",
			"agents/shepherd.ts",
			"system-prompts/shepherd/core.md",
			"system-prompts/shepherd/deep/notes.test.ts",
			"lib/shepherd/check.ts",
			"lib/agent-format/adapters/claude.ts",
			"scripts/compile.ts",
			"scripts/compile-all.ts",
			"scripts/agent-compiler.ts",
			"scripts/binary-name.ts",
			"scripts/shepherd-source.ts",
			"package.json",
			"bun.lock",
			"tsconfig.json",
		]) {
			expect([path, isSourcePath(path)]).toEqual([path, true]);
		}
		for (const path of [
			"agents/shepherd.test.ts",
			"agents/plan/planner.md",
			"lib/shepherd/check.test.ts",
			"lib/agent-format/cli.spec.ts",
			"lib/shepherd/__fixtures__/a.md",
			"lib/agent-format/x/__snapshots__/y.snap",
			"lib/shepherdish/a.ts",
			"system-prompts/shared.md",
			"scripts/watch-agents.ts",
			"scripts/shepherd-source.test.ts",
			"evals/shepherd/results/abc.json",
			"docs/SHEPHERD.md",
		]) {
			expect([path, isSourcePath(path)]).toEqual([path, false]);
		}
	});

	test("reads the selected working-tree files of a repository", () => {
		initShepherdRepo(root, {
			"lib/shepherd/check.test.ts": "test\n",
			"lib/agent-format/__fixtures__/a.ts": "fixture\n",
			"README.md": "readme\n",
		});
		expect(paths()).toEqual(
			[
				"agents/shepherd.md",
				"agents/shepherd.ts",
				"bun.lock",
				"lib/agent-format/run.ts",
				"lib/shepherd/tool.ts",
				"package.json",
				"scripts/agent-compiler.ts",
				"scripts/binary-name.ts",
				"scripts/compile-all.ts",
				"scripts/compile.ts",
				"scripts/shepherd-source.ts",
				"system-prompts/shepherd/core.md",
				"tsconfig.json",
			].sort(compareUtf8),
		);
		expect(worktree().entries.every((entry) => !entry.untracked)).toBe(true);
	});

	test("hashes working-tree bytes, staged or not", () => {
		initShepherdRepo(root);
		const before = worktree();
		writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		const after = worktree();
		expect(after.source).not.toBe(before.source);
		expect(
			after.entries.find((entry) => entry.path === "lib/shepherd/tool.ts")
				?.sha256,
		).toBe(sha("export const tool = 2;\n"));
	});

	test("a rename changes the source identity even with identical bytes", () => {
		initShepherdRepo(root);
		const before = worktree();
		renameSync(
			join(root, "lib/shepherd/tool.ts"),
			join(root, "lib/shepherd/tools.ts"),
		);
		const after = worktree();
		expect(after.entries.map((entry) => entry.sha256).sort()).toEqual(
			before.entries.map((entry) => entry.sha256).sort(),
		);
		expect(after.source).not.toBe(before.source);
	});

	test("an untracked source file is included and marked", () => {
		initShepherdRepo(root);
		const before = worktree();
		writeAt(root, "lib/shepherd/new.ts", "export const fresh = 1;\n");
		const after = worktree();
		expect(after.source).not.toBe(before.source);
		expect(
			after.entries.find((entry) => entry.path === "lib/shepherd/new.ts"),
		).toEqual({
			path: "lib/shepherd/new.ts",
			bytes: 24,
			sha256: sha("export const fresh = 1;\n"),
			untracked: true,
		});
	});

	test("an ignored untracked .DS_Store does not change the hash", () => {
		initShepherdRepo(root, { ".gitignore": ".DS_Store\n" });
		const before = worktree();
		writeAt(root, "lib/shepherd/.DS_Store", "finder");
		writeAt(root, "system-prompts/shepherd/.DS_Store", "finder");
		expect(worktree()).toEqual(before);
	});

	test("a tracked file stays selected when an ignore pattern matches it", () => {
		initShepherdRepo(root, { "lib/shepherd/kept.log": "kept\n" });
		writeAt(root, ".gitignore", "*.log\n");
		git(root, "add", ".gitignore");
		git(root, "commit", "-q", "-m", "ignore logs");
		expect(paths()).toContain("lib/shepherd/kept.log");
		writeAt(root, "lib/shepherd/other.log", "ignored\n");
		expect(paths()).not.toContain("lib/shepherd/other.log");
	});

	test("a file deleted from a recursive selection is absent, not an error", () => {
		initShepherdRepo(root, { "lib/shepherd/gone.ts": "gone\n" });
		rmSync(join(root, "lib/shepherd/gone.ts"));
		expect(paths()).not.toContain("lib/shepherd/gone.ts");
	});

	test("a missing required file is an error, deleted from the working tree or never present", () => {
		initShepherdRepo(root);
		rmSync(join(root, "agents/shepherd.ts"));
		expect(problemsOf(worktree).join("\n")).toContain("agents/shepherd.ts");
		git(root, "rm", "-q", "--cached", "agents/shepherd.ts");
		expect(problemsOf(worktree).join("\n")).toContain("agents/shepherd.ts");
	});

	test("an ignored untracked required file is still missing", () => {
		initShepherdRepo(root);
		git(root, "rm", "-q", "--cached", "bun.lock");
		writeAt(root, ".gitignore", "bun.lock\n");
		expect(problemsOf(worktree).join("\n")).toContain("bun.lock");
	});

	test("a symlink in the selection is an error", () => {
		initShepherdRepo(root);
		symlinkSync("tool.ts", join(root, "lib/shepherd/link.ts"));
		expect(problemsOf(worktree).join("\n")).toContain("lib/shepherd/link.ts");
	});

	test("a symlinked required file is an error", () => {
		initShepherdRepo(root);
		renameSync(join(root, "tsconfig.json"), join(root, "real-tsconfig.json"));
		symlinkSync("real-tsconfig.json", join(root, "tsconfig.json"));
		expect(problemsOf(worktree).join("\n")).toContain("tsconfig.json");
	});

	test("a symlinked ancestor directory is an error", () => {
		initShepherdRepo(root);
		renameSync(join(root, "lib/shepherd"), join(root, "elsewhere"));
		symlinkSync("../elsewhere", join(root, "lib/shepherd"));
		expect(problemsOf(worktree).join("\n")).toContain("lib/shepherd");
	});

	test("a symlinked directory inside a selection is an error", () => {
		initShepherdRepo(root, { "lib/shepherd/sub/a.ts": "a\n" });
		renameSync(join(root, "lib/shepherd/sub"), join(root, "sub-real"));
		symlinkSync("../../sub-real", join(root, "lib/shepherd/sub"));
		expect(problemsOf(worktree).join("\n")).toContain("lib/shepherd/sub");
	});

	test("a selected path that is not a regular file is an error", () => {
		initShepherdRepo(root, { "lib/shepherd/odd.ts": "odd\n" });
		rmSync(join(root, "lib/shepherd/odd.ts"));
		mkdirSync(join(root, "lib/shepherd/odd.ts"));
		writeFileSync(join(root, "lib/shepherd/odd.ts/inner.ts"), "inner\n");
		expect(problemsOf(worktree).join("\n")).toContain("lib/shepherd/odd.ts");
	});

	test("the compiler root must be the repository root", () => {
		initShepherdRepo(root);
		expect(
			problemsOf(() =>
				readWorktreeSource(join(root, "lib"), { git: testGit }),
			).join("\n"),
		).toContain("repository root");
	});
});

describe("commit manifests", () => {
	test("a clean tree's manifest equals HEAD's", () => {
		const revision = initShepherdRepo(root);
		expect(readCommitSource(root, revision, { git: testGit })).toEqual(
			worktree(),
		);
	});

	test("strict reading at a commit requires the individual files", () => {
		initShepherdRepo(root);
		git(root, "rm", "-q", "bun.lock");
		git(root, "commit", "-q", "-m", "drop lock");
		expect(
			problemsOf(() => readCommitSource(root, "HEAD", { git: testGit })).join(
				"\n",
			),
		).toContain("bun.lock");
		expect(
			readCommitSource(root, "HEAD", { git: testGit, strict: false })
				.entries.map((entry) => entry.path)
				.includes("bun.lock"),
		).toBe(false);
	});

	test("a committed symlink in the selection is an error", () => {
		initShepherdRepo(root);
		symlinkSync("tool.ts", join(root, "lib/shepherd/link.ts"));
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "link");
		expect(
			problemsOf(() => readCommitSource(root, "HEAD", { git: testGit })).join(
				"\n",
			),
		).toContain("lib/shepherd/link.ts");
	});
});

describe("revision and dirty flags (1.6)", () => {
	test("a clean repository is neither dirty nor source-dirty", () => {
		const revision = initShepherdRepo(root);
		const captured = provenance();
		expect(captured.revision).toBe(revision);
		expect(captured.revision).toMatch(/^[0-9a-f]{40}$/);
		expect(captured.dirty).toBe(false);
		expect(captured.sourceDirty).toBe(false);
		expect(captured.manifest).toEqual(worktree());
	});

	test("an untracked file outside the sources makes only dirty true", () => {
		initShepherdRepo(root);
		writeAt(root, "notes/todo.txt", "later\n");
		expect(provenance()).toMatchObject({ dirty: true, sourceDirty: false });
	});

	test("an ignored untracked file leaves the repository clean", () => {
		initShepherdRepo(root, { ".gitignore": ".DS_Store\n" });
		writeAt(root, "lib/shepherd/.DS_Store", "finder");
		expect(provenance()).toMatchObject({ dirty: false, sourceDirty: false });
	});

	test("staged, unstaged and untracked source changes make both flags true", () => {
		initShepherdRepo(root);
		writeAt(root, "lib/shepherd/tool.ts", "changed\n");
		expect(provenance()).toMatchObject({ dirty: true, sourceDirty: true });
		git(root, "add", "-A");
		expect(provenance()).toMatchObject({ dirty: true, sourceDirty: true });
		git(root, "commit", "-q", "-m", "change");
		writeAt(root, "system-prompts/shepherd/new.md", "new\n");
		expect(provenance()).toMatchObject({ dirty: true, sourceDirty: true });
	});

	test("a staged change outside the sources makes only dirty true", () => {
		initShepherdRepo(root);
		writeAt(root, "lib/shepherd/tool.test.ts", "test\n");
		git(root, "add", "-A");
		expect(provenance()).toMatchObject({ dirty: true, sourceDirty: false });
	});

	test("a repository without a commit has no revision", () => {
		writeAt(root, "a.txt", "a\n");
		git(root, "init", "-q");
		expect(problemsOf(provenance).join("\n")).toContain("revision");
	});

	test("a directory outside any repository has no revision", () => {
		expect(problemsOf(provenance).join("\n")).toContain("Git");
	});

	test("the version line has the exact stamp form", () => {
		const revision = initShepherdRepo(root);
		const captured = provenance();
		expect(versionLine(captured)).toBe(
			`shepherd revision=${revision} dirty=false source=${captured.manifest.source}`,
		);
		expect(versionLine(captured)).toMatch(
			/^shepherd revision=[0-9a-f]{40} dirty=(true|false) source=sha256:[0-9a-f]{64}$/,
		);
	});
});

describe("result commits (1.7)", () => {
	test("committing results, evidence and validation output keeps the source identity", () => {
		const first = initShepherdRepo(root);
		const before = provenance();
		writeAt(root, "evals/shepherd/results/abc.json", "{}\n");
		writeAt(root, "evals/shepherd/results/abc.md", "# Result\n");
		writeAt(root, "evals/shepherd/artifacts/abc/run/log.jsonl", "{}\n");
		writeAt(root, "evals/shepherd/validation/abc/run/log.jsonl", "{}\n");
		expect(provenance()).toMatchObject({ dirty: true, sourceDirty: false });
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "results");
		const after = provenance();
		expect(after.revision).not.toBe(first);
		expect(after.manifest).toEqual(before.manifest);
		expect(after).toMatchObject({ dirty: false, sourceDirty: false });
		expect(readCommitSource(root, first, { git: testGit })).toEqual(
			readCommitSource(root, "HEAD", { git: testGit }),
		);
	});

	test("an untracked source entry committed later compares equal", () => {
		initShepherdRepo(root);
		writeAt(root, "lib/shepherd/new.ts", "new\n");
		const evaluated = worktree();
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "stage new source");
		const committed = readCommitSource(root, "HEAD", { git: testGit });
		expect(committed.source).toBe(evaluated.source);
		expect(sameSource(evaluated, committed)).toBe(true);
		expect(readFileSync(join(root, "lib/shepherd/new.ts"), "utf8")).toBe(
			"new\n",
		);
	});
});
