import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatSnapshot,
	guardWorkspace,
	liveSnapshot,
	readBaseline,
	sameSnapshot,
} from "./extraction-continuity";

// O32: the continuity scripts refuse the live installation, require
// initialized hooks and compare live snapshots against a recorded baseline.
// Fixtures only; no real installation is read here.

const root = realpathSync(mkdtempSync(join(tmpdir(), "continuity-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, text: string, mode = 0o644): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	chmodSync(path, mode);
}

const live = join(root, "live");
put(join(live, "bin/shepherd"), "binary\n", 0o755);
put(join(live, "packages/software/MODULE.md"), "module\n");
put(join(live, "packages/software/tools/contract"), "#!/bin/sh\n", 0o755);

describe("guardWorkspace", () => {
	test("refuses the live installation and anything inside it", () => {
		mkdirSync(join(live, ".husky/_"), { recursive: true });
		expect(() => guardWorkspace(live, live)).toThrow("live installation");
		mkdirSync(join(live, "nested/.husky/_"), { recursive: true });
		expect(() => guardWorkspace(join(live, "nested"), live)).toThrow(
			"live installation",
		);
	});

	test("requires initialized hooks", () => {
		const worktree = join(root, "worktree");
		mkdirSync(worktree, { recursive: true });
		expect(() => guardWorkspace(worktree, live)).toThrow("run bun install");
		mkdirSync(join(worktree, ".husky/_"), { recursive: true });
		expect(() => guardWorkspace(worktree, live)).not.toThrow();
	});
});

describe("live snapshots", () => {
	test("lists packages with bytes and modes, sorted", () => {
		const snapshot = liveSnapshot(live);
		expect(snapshot.packages).toEqual([
			"packages/software/MODULE.md 7 644",
			"packages/software/tools/contract 10 755",
		]);
		expect(snapshot.binary).toMatch(/^[0-9a-f]{64}$/);
	});

	test("reads a recorded baseline and detects a change", () => {
		const snapshot = liveSnapshot(live);
		const baseline = join(root, "live-baseline.md");
		writeFileSync(
			baseline,
			`# Baseline\n\n\`\`\`\n${snapshot.binary}  bin/shepherd\nshepherd revision=x\n\`\`\`\n\n## packages/ manifest (path, bytes, mode)\n\`\`\`\n${snapshot.packages.join("\n")}\n\`\`\`\n`,
		);
		expect(sameSnapshot(readBaseline(baseline), snapshot)).toBe(true);
		chmodSync(join(live, "packages/software/tools/contract"), 0o644);
		expect(sameSnapshot(readBaseline(baseline), liveSnapshot(live))).toBe(
			false,
		);
		expect(formatSnapshot("x", snapshot)).toContain("bin/shepherd");
	});
});
