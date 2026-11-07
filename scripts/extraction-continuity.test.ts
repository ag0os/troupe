import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
	expectedVersionLine,
	formatSnapshot,
	guardEvidence,
	guardWorkspace,
	liveSnapshot,
	MANIFEST_HEADING,
	readBaseline,
	sameSnapshot,
	versionProblem,
	writeEvidence,
} from "./extraction-continuity";

// O32: the continuity scripts refuse the live installation, require
// initialized hooks, never write evidence into the live root, and compare
// content-bearing live snapshots against a recorded baseline. Fixtures only;
// no real installation is read here.

const root = realpathSync(mkdtempSync(join(tmpdir(), "continuity-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, text: string, mode = 0o644): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	chmodSync(path, mode);
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

let lives = 0;
/** A fresh fake live installation. */
function makeLive(): string {
	const live = join(root, `live-${lives++}`);
	put(join(live, "bin/shepherd"), "binary\n", 0o755);
	put(join(live, "packages/software/MODULE.md"), "module\n");
	put(join(live, "packages/software/tools/contract"), "#!/bin/sh\n", 0o755);
	return live;
}

function baselineFor(file: string, live: string): string {
	const snapshot = liveSnapshot(live);
	writeFileSync(
		file,
		`# Baseline\n\n\`\`\`\n${snapshot.binary}  bin/shepherd\nshepherd revision=x\n\`\`\`\n\n${MANIFEST_HEADING}\n\`\`\`\n${snapshot.packages.join("\n")}\n\`\`\`\n`,
	);
	return file;
}

describe("guardWorkspace", () => {
	test("refuses the live installation and anything inside it", () => {
		const live = makeLive();
		mkdirSync(join(live, ".husky/_"), { recursive: true });
		expect(() => guardWorkspace(live, live)).toThrow("live installation");
		mkdirSync(join(live, "nested/.husky/_"), { recursive: true });
		expect(() => guardWorkspace(join(live, "nested"), live)).toThrow(
			"live installation",
		);
	});

	test("requires initialized hooks", () => {
		const live = makeLive();
		const worktree = join(root, "worktree");
		mkdirSync(worktree, { recursive: true });
		expect(() => guardWorkspace(worktree, live)).toThrow("run bun install");
		mkdirSync(join(worktree, ".husky/_"), { recursive: true });
		expect(() => guardWorkspace(worktree, live)).not.toThrow();
	});
});

describe("evidence destination", () => {
	test("refuses an evidence directory inside the live root", () => {
		const live = makeLive();
		const before = liveSnapshot(live);
		expect(() => guardEvidence(join(live, "packages/evidence"), live)).toThrow(
			"inside the live root",
		);
		expect(() => guardEvidence(live, live)).toThrow("inside the live root");
		expect(existsSync(join(live, "packages/evidence"))).toBe(false);
		expect(sameSnapshot(before, liveSnapshot(live))).toBe(true);
	});

	test("refuses evidence reached through a symlinked directory into it", () => {
		const live = makeLive();
		const before = liveSnapshot(live);
		const link = join(root, "evidence-link");
		symlinkSync(join(live, "packages"), link);
		expect(() => guardEvidence(join(link, "round-1"), live)).toThrow(
			"inside the live root",
		);
		expect(existsSync(join(live, "packages/round-1"))).toBe(false);
		expect(sameSnapshot(before, liveSnapshot(live))).toBe(true);
	});

	test("refuses an existing live-root entry whose name starts with two dots", () => {
		const live = makeLive();
		mkdirSync(join(live, "..evidence"));
		const before = liveSnapshot(live);
		for (const target of [
			join(live, "..evidence"),
			join(live, "..evidence/round-2"),
		]) {
			expect(() => guardEvidence(target, live)).toThrow("inside the live root");
		}
		expect(existsSync(join(live, "..evidence/round-2"))).toBe(false);
		expect(sameSnapshot(before, liveSnapshot(live))).toBe(true);
	});

	test("refuses a symlink into a two-dot entry of the live root", () => {
		const live = makeLive();
		mkdirSync(join(live, "..evidence"));
		const before = liveSnapshot(live);
		const link = join(root, `dotdot-link-${lives}`);
		symlinkSync(join(live, "..evidence"), link);
		expect(() => guardEvidence(link, live)).toThrow("inside the live root");
		expect(() => guardEvidence(join(link, "round-2"), live)).toThrow(
			"inside the live root",
		);
		expect(existsSync(join(live, "..evidence/round-2"))).toBe(false);
		expect(sameSnapshot(before, liveSnapshot(live))).toBe(true);
	});

	test("refuses a worktree in a two-dot entry of the live root", () => {
		const live = makeLive();
		mkdirSync(join(live, "..worktree/.husky/_"), { recursive: true });
		expect(() => guardWorkspace(join(live, "..worktree"), live)).toThrow(
			"live installation",
		);
	});

	test("accepts a directory outside the live root", () => {
		const live = makeLive();
		expect(() =>
			guardEvidence(join(root, "outside/evidence"), live),
		).not.toThrow();
	});

	test("refuses to write through a symlinked evidence file", () => {
		const live = makeLive();
		const dir = join(root, "evidence-files");
		mkdirSync(dir, { recursive: true });
		symlinkSync(join(live, "packages/software/MODULE.md"), join(dir, "a.txt"));
		expect(() => writeEvidence(dir, "a.txt", "overwrite\n")).toThrow(
			"through the symlink",
		);
		expect(Bun.file(join(live, "packages/software/MODULE.md")).size).toBe(7);
	});
});

describe("live snapshots", () => {
	test("lists packages with bytes, modes and content hashes, sorted", () => {
		const live = makeLive();
		const snapshot = liveSnapshot(live);
		expect(snapshot.packages).toEqual([
			`packages/software/MODULE.md 7 644 ${sha256("module\n")}`,
			`packages/software/tools/contract 10 755 ${sha256("#!/bin/sh\n")}`,
		]);
		expect(snapshot.binary).toMatch(/^[0-9a-f]{64}$/);
		expect(formatSnapshot("x", snapshot)).toContain("bin/shepherd");
	});

	test("reads a recorded baseline and detects a mode change", () => {
		const live = makeLive();
		const baseline = baselineFor(join(root, "baseline-mode.md"), live);
		expect(sameSnapshot(readBaseline(baseline), liveSnapshot(live))).toBe(true);
		chmodSync(join(live, "packages/software/tools/contract"), 0o644);
		expect(sameSnapshot(readBaseline(baseline), liveSnapshot(live))).toBe(
			false,
		);
	});

	test("detects a same-length content change", () => {
		const live = makeLive();
		const baseline = baselineFor(join(root, "baseline-content.md"), live);
		writeFileSync(join(live, "packages/software/MODULE.md"), "MODULE\n");
		const after = liveSnapshot(live);
		expect(after.packages[0]).toStartWith("packages/software/MODULE.md 7 644 ");
		expect(sameSnapshot(readBaseline(baseline), after)).toBe(false);
	});

	test("records a symlink by its target", () => {
		const live = makeLive();
		symlinkSync("MODULE.md", join(live, "packages/software/LINK.md"));
		expect(liveSnapshot(live).packages).toContain(
			"packages/software/LINK.md symlink MODULE.md",
		);
	});

	test("refuses a baseline without the content-bearing manifest", () => {
		const file = join(root, "baseline-old.md");
		writeFileSync(
			file,
			`\`\`\`\n${"a".repeat(64)}  bin/shepherd\n\`\`\`\n\n## packages/ manifest (path, bytes, mode)\n\`\`\`\nx 1 644\n\`\`\`\n`,
		);
		expect(() => readBaseline(file)).toThrow(MANIFEST_HEADING);
	});
});

describe("version line", () => {
	const commit = "a".repeat(40);
	const expected = `shepherd revision=${commit} dirty=false source=sha256:${"1".repeat(64)}`;

	test("accepts the exact expected line", () => {
		expect(
			versionProblem({ code: 0, stdout: `${expected}\n` }, expected),
		).toBeUndefined();
	});

	test("rejects a right revision and dirty flag with a wrong digest", () => {
		const wrong = `shepherd revision=${commit} dirty=false source=sha256:${"2".repeat(64)}`;
		expect(versionProblem({ code: 0, stdout: wrong }, expected)).toContain(
			"is not",
		);
	});

	test("rejects the exact line when the command exits nonzero", () => {
		expect(versionProblem({ code: 1, stdout: `${expected}\n` }, expected)).toBe(
			"--version exit 1",
		);
		expect(versionProblem({ code: null, stdout: expected }, expected)).toBe(
			"--version exit null",
		);
	});

	test("rejects a missing expectation", () => {
		expect(versionProblem({ code: 0, stdout: expected }, undefined)).toBe(
			"expected --version line unavailable",
		);
	});
});

describe("expected --version line per commit (C5)", () => {
	const source = `sha256:${"0".repeat(64)}`;
	const commit = "c".repeat(40);
	function slot(name: string, module: string): string {
		const dir = join(root, "c5", name);
		mkdirSync(join(dir, "scripts"), { recursive: true });
		writeFileSync(join(dir, "scripts/shepherd-source.ts"), module);
		return dir;
	}
	const reader = `export function readCommitSource() {\n\treturn { source: "${source}", entries: [] };\n}\n`;

	const template = `shepherd revision=${commit} dirty=false source=${source}`;
	const policy = (body: string) =>
		`${reader}export function legacyStampPolicy() {\n\treturn { versionLine: (id: string, s: { manifest: { source: string }; provenance: { revision: string } }) => ${body} };\n}\n`;

	test("a policy whose line differs from the v1 template fails", () => {
		const dir = slot(
			"policy-differs",
			policy(
				'id + " policy " + s.provenance.revision + " " + s.manifest.source',
			),
		);
		const expected = expectedVersionLine(dir, commit);
		expect(expected.line).toBe(template);
		expect(expected.problem).toBe(
			`legacyStampPolicy line ${JSON.stringify(`shepherd policy ${commit} ${source}`)} is not the v1 template ${JSON.stringify(template)}`,
		);
	});

	test("a policy that prints the v1 template passes", () => {
		const dir = slot(
			"policy-template",
			policy(
				'id + " revision=" + s.provenance.revision + " dirty=false source=" + s.manifest.source',
			),
		);
		const expected = expectedVersionLine(dir, commit);
		expect(expected.line).toBe(template);
		expect(expected.problem).toBeUndefined();
	});

	test("an older commit without the policy keeps the derived v1 line", () => {
		const dir = slot("older", reader);
		expect(expectedVersionLine(dir, commit).line).toBe(
			`shepherd revision=${commit} dirty=false source=${source}`,
		);
	});
});
