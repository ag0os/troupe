import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	assessCheckpoint,
	type Checkpoint,
	coveredPaths,
	fallbackSections,
	hashPaths,
	readCheckpoint,
} from "./checkpoint";
import { contentHash, readDroppedSources } from "./current-prev";
import { fakeClock, fakeToolEnv, makeTree } from "./test-support";
import { journalChain } from "./text";
import type { Workspace } from "./tree";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
const original =
	"## 2026-10-06\n- 09:00 first\n## 2026-10-07\n- 10:00 second\n";
function fixture(files: Record<string, string> = {}) {
	const tree = makeTree({
		".shepherd/CURRENT.md": "# Current\nKeep this important line\n",
		".shepherd/journal.md": original,
		...Object.fromEntries(
			Object.entries(files).map(([path, text]) => [`.shepherd/${path}`, text]),
		),
	});
	cleanups.push(tree.cleanup);
	const workspace: Workspace = {
		name: "test",
		dir: tree.root,
		state: join(tree.root, ".shepherd"),
	};
	const env = fakeToolEnv({
		home: tree.root,
		clock: fakeClock("2026-10-08T12:00:00Z").clock,
	});
	function put(path: string, text: string) {
		const full = join(workspace.state, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	function certify(change?: (checkpoint: Checkpoint) => void) {
		const entries = journalChain(workspace.state).entries;
		const checkpoint: Checkpoint = {
			schema: 1,
			revision: 1,
			written: "2026-10-08T09:00:00-03:00",
			snapshot: "checkpoints/CURRENT.r1",
			journal: {
				from: entries[0]?.id ?? null,
				to: entries.at(-1)?.id ?? null,
				count: entries.length,
			},
			files: hashPaths(workspace, coveredPaths(workspace.state)),
			evidence: {},
		};
		put(checkpoint.snapshot, "# Current\nKeep this important line\n");
		change?.(checkpoint);
		put("checkpoint.json", JSON.stringify(checkpoint));
		return checkpoint;
	}
	return {
		workspace,
		env,
		put,
		certify,
		assess: () => assessCheckpoint(workspace, env),
		remove: (path: string) =>
			rmSync(join(workspace.state, path), { recursive: true, force: true }),
	};
}

describe("checkpoint validation", () => {
	test("absent checkpoint yields fallback and no checkpoint", () => {
		const f = fixture();
		expect(readCheckpoint(f.workspace.state)).toEqual({ status: "none" });
		expect(f.assess().reasons[0]).toBe("no checkpoint");
		expect(f.assess().unreviewed.entries).toHaveLength(2);
	});
	test("truncated JSON is invalid", () => {
		const f = fixture();
		f.put("checkpoint.json", "{");
		expect(readCheckpoint(f.workspace.state).status).toBe("invalid");
	});
	test("wrong schema is invalid", () => {
		const f = fixture();
		f.certify((c) => {
			Object.assign(c, { schema: 2 });
		});
		expect(readCheckpoint(f.workspace.state)).toEqual({
			status: "invalid",
			reason: "schema must be 1",
		});
	});
	test("manifest missing a fixed path is invalid", () => {
		const f = fixture();
		f.certify((c) => {
			delete c.files["pending.md"];
		});
		expect(readCheckpoint(f.workspace.state)).toEqual({
			status: "invalid",
			reason: "files missing pending.md",
		});
	});
	test("a manifest key containing .. is invalid", () => {
		const f = fixture();
		f.certify((c) => {
			c.files["docs/../outside.md"] = null;
		});
		expect(readCheckpoint(f.workspace.state).status).toBe("invalid");
	});
	test("checkpoint symlinks are invalid", () => {
		const f = fixture();
		f.certify();
		f.remove("checkpoint.json");
		symlinkSync("CURRENT.md", join(f.workspace.state, "checkpoint.json"));
		expect(readCheckpoint(f.workspace.state)).toEqual({
			status: "invalid",
			reason: "checkpoint.json is a symlink",
		});
	});
	for (const [name, change, reason] of [
		[
			"revision",
			(c: Checkpoint) => {
				c.revision = 0;
			},
			"revision must be a positive integer",
		],
		[
			"snapshot",
			(c: Checkpoint) => {
				c.snapshot = "/checkpoints/CURRENT.r1";
			},
			"snapshot must be a relative path under checkpoints/",
		],
		[
			"journal from",
			(c: Checkpoint) => {
				Object.assign(c.journal, { from: 1 });
			},
			"journal.from must be a string or null",
		],
		[
			"journal count",
			(c: Checkpoint) => {
				c.journal.count = -1;
			},
			"journal.count must be a non-negative integer",
		],
		[
			"files hash",
			(c: Checkpoint) => {
				c.files["CURRENT.md"] = "sha256:no";
			},
			"invalid files hash: CURRENT.md",
		],
		[
			"evidence hash",
			(c: Checkpoint) => {
				c.evidence["memories/a.md"] = "invalid";
			},
			"invalid evidence hash: memories/a.md",
		],
	] as const)
		test(`invalid ${name} has its own reason`, () => {
			const f = fixture();
			f.certify(change);
			expect(readCheckpoint(f.workspace.state)).toEqual({
				status: "invalid",
				reason,
			});
		});
	for (const key of [
		"../outside.md",
		"/outside.md",
		"other:shared/a.md",
		"enclosing:other/a.md",
		"enclosing:shared/sub/a.md",
	])
		test(`unsafe evidence key ${key} is invalid`, () => {
			const f = fixture();
			f.certify((c) => {
				c.evidence[key] = contentHash("copy");
			});
			expect(readCheckpoint(f.workspace.state).status).toBe("invalid");
		});
});

describe("checkpoint journal assessment", () => {
	test("boundary found reports only later entries", () => {
		const f = fixture();
		f.certify();
		f.put("journal.md", `${original}- 11:00 third\n`);
		const a = f.assess();
		expect(a.boundary).toMatchObject({ state: "found", position: 2 });
		expect(a.unreviewed.entries.map((e) => e.text)).toEqual(["11:00 third"]);
	});
	test("boundary survives an inserted heading", () => {
		const f = fixture();
		f.certify();
		f.put("journal.md", original.replace("- 10:00", "## 2026-10-08\n- 10:00"));
		expect(f.assess().verdict).toBe("CLEAN");
		expect(f.assess().boundary).toMatchObject({ state: "found", line: 5 });
	});
	test("rotation preserves the boundary and all rotated unreviewed entries", () => {
		const f = fixture();
		f.certify();
		f.put("archive/journal/2026-09.md", `${original}- 11:00 third\n`);
		f.put("archive/journal/2026-10.md", "## 2026-10-08\n- 12:00 fourth\n");
		f.put("journal.md", "## 2026-10-09\n- 13:00 fifth\n");
		const a = f.assess();
		expect(a.boundary).toMatchObject({
			state: "found",
			position: 2,
			file: "archive/journal/2026-09.md",
		});
		expect(a.unreviewed.entries.map((e) => e.text)).toEqual([
			"11:00 third",
			"12:00 fourth",
			"13:00 fifth",
		]);
	});
	test("early edit loses the boundary", () => {
		const f = fixture();
		f.certify();
		f.put("journal.md", original.replace("first", "edited"));
		expect(f.assess().boundary).toEqual({
			state: "lost",
			position: null,
			file: null,
			line: null,
		});
		expect(f.assess().reasons[0]).toBe(
			"boundary lost: the journal changed before the certified entry",
		);
	});
	test("null endpoints with entries present report all entries", () => {
		const f = fixture();
		f.certify((c) => {
			c.journal = { from: null, to: null, count: 0 };
		});
		expect(f.assess().boundary).toEqual({
			state: "null",
			position: 0,
			file: null,
			line: null,
		});
		expect(f.assess().unreviewed.entries).toHaveLength(2);
	});
	test("from missing while to is intact loses the boundary", () => {
		const f = fixture();
		f.certify((c) => {
			c.journal.from = "edited-away";
		});
		expect(f.assess().boundary).toEqual({
			state: "lost",
			position: null,
			file: null,
			line: null,
		});
	});
	test("empty current headings fall back to archived entries", () => {
		const f = fixture({
			"archive/journal/2026-07.md": original,
			"journal.md": "## 2026-10-08\n## 2026-10-09\n",
		});
		const a = f.assess();
		expect(a.unreviewed.sections?.map((s) => s.file)).toEqual([
			"archive/journal/2026-07.md",
			"archive/journal/2026-07.md",
		]);
		expect(a.unreviewed.entries).toHaveLength(2);
	});
	test("an empty latest archive falls back to the preceding archive", () => {
		const f = fixture({
			"archive/journal/2026-09.md": original,
			"archive/journal/2026-10.md": "## 2026-10-08\n",
			"journal.md": "",
		});
		expect(f.assess().unreviewed.entries).toHaveLength(2);
	});
	test("duplicate headings are separate fallback sections", () => {
		const f = fixture({
			"journal.md":
				"## 2026-10-06\n- old\n## 2026-10-07\n- first\n## 2026-10-07\n- second\n",
		});
		const chain = journalChain(f.workspace.state);
		const sections = fallbackSections(
			f.workspace.state,
			chain.entries,
			chain.files,
		);
		expect(sections.map((s) => s.headingLine)).toEqual([3, 5]);
		expect(sections.map((s) => s.entries[0]?.text)).toEqual([
			"first",
			"second",
		]);
		expect(f.assess().uncertified).toBe(1);
	});
	test("orphans outside fallback range remain reported", () => {
		const f = fixture({
			"archive/journal/2026-09.md": "- orphan\n## 2026-10-05\n- old\n",
		});
		const a = f.assess();
		expect(a.orphans).toHaveLength(1);
		expect(a.unreviewed.entries.some((e) => e.day === undefined)).toBe(false);
		expect(a.reasons).toContain(
			"1 entries without a heading (archive/journal/2026-09.md:1)",
		);
		expect(a.uncertified).toBe(2);
	});
	test("an orphan after the boundary requires reconcile", () => {
		const f = fixture();
		f.certify();
		f.put("archive/journal/2026-09.md", original);
		f.put("journal.md", "- orphan\n");
		const a = f.assess();
		expect(a.boundary.state).toBe("found");
		expect(a.unreviewed.entries).toEqual([]);
		expect(a.verdict).toBe("RECONCILE");
		expect(a.reasons).toContain("1 entries without a heading (journal.md:1)");
	});
	test("orphans before a found boundary are certified and counted before from", () => {
		const f = fixture({ "journal.md": `- orphan\n${original}` });
		f.certify((c) => {
			c.journal.from = journalChain(f.workspace.state).entries[1]?.id ?? null;
		});
		const a = f.assess();
		expect(a.orphans).toHaveLength(1);
		expect(a.uncertified).toBe(1);
		expect(a.verdict).toBe("CLEAN");
	});
	test("unreadable journal file has its own reason", () => {
		const f = fixture();
		f.certify();
		f.remove("journal.md");
		mkdirSync(join(f.workspace.state, "journal.md"));
		expect(f.assess().reasons).toContain(
			"journal unreadable: journal.md: is not a regular file",
		);
	});
});

describe("checkpoint records and verdict", () => {
	test("clean workspace is CLEAN and freshness without transcripts is unknown", () => {
		const f = fixture();
		f.certify();
		const a = f.assess();
		expect(a.status).toBe("ok");
		expect(a.verdict).toBe("CLEAN");
		expect(a.reasons).toEqual([]);
		expect(a.freshness).toBe("unknown");
		expect(a.lock).toBe("free");
	});
	for (const kind of ["changed", "appeared", "removed"] as const)
		test(`STATUS ${kind} requires reconcile without a CURRENT edit`, () => {
			const path = "work/in-progress/item/STATUS.md";
			const f = fixture(kind === "appeared" ? {} : { [path]: "old" });
			f.certify();
			if (kind === "removed") f.remove(path);
			else f.put(path, "new");
			const a = f.assess();
			expect(a.changed).toEqual([{ path, kind }]);
			expect(a.verdict).toBe("RECONCILE");
		});
	test("pending removed is reported", () => {
		const f = fixture({ "pending.md": "pending" });
		f.certify();
		f.remove("pending.md");
		expect(f.assess().changed).toEqual([
			{ path: "pending.md", kind: "removed" },
		]);
	});
	test("lost snapshot invalidates checkpoint and uses fallback", () => {
		const f = fixture();
		const c = f.certify();
		f.remove(c.snapshot);
		const a = f.assess();
		expect(a.status).toBe("invalid");
		expect(a.reason).toBe("snapshot missing or does not match");
		expect(a.boundary.state).toBe("none");
		expect(a.unreviewed.mode).toBe("fallback");
		expect(a.changed).toEqual([]);
	});
	test("snapshot hash mismatch invalidates checkpoint", () => {
		const f = fixture();
		const c = f.certify();
		f.put(c.snapshot, "wrong");
		expect(f.assess().reason).toBe("snapshot missing or does not match");
	});
	test("null CURRENT hash needs no baseline", () => {
		const f = fixture();
		f.remove("CURRENT.md");
		f.certify();
		f.remove("checkpoints/CURRENT.r1");
		expect(f.assess().verdict).toBe("CLEAN");
		expect(f.assess().dropped).toBeUndefined();
	});
	test("stale lock is reported without altering verdict", () => {
		const f = fixture();
		f.certify();
		f.put(
			".state.lock/owner",
			JSON.stringify({ pid: 98765, started: "2026-10-08T12:00:00Z" }),
		);
		const a = f.assess();
		expect(a.lock).toBe("stale, left by pid 98765");
		expect(a.verdict).toBe("CLEAN");
	});
	test("live lock is reported", () => {
		const f = fixture();
		f.certify();
		f.put(
			".state.lock/owner",
			JSON.stringify({ pid: 123, started: "2026-10-08T12:00:00Z" }),
		);
		expect(
			assessCheckpoint(
				f.workspace,
				fakeToolEnv({ home: f.workspace.dir, alivePids: [123] }),
			).lock,
		).toBe("held by live pid 123");
	});
	for (const kind of ["changed", "missing"] as const)
		test(`evidence ${kind} requires reconcile`, () => {
			const path = "memories/copy.md";
			const f = fixture({ [path]: "copy" });
			f.certify((c) => {
				c.evidence[path] = contentHash("copy");
			});
			if (kind === "missing") f.remove(path);
			else f.put(path, "edited");
			const a = f.assess();
			expect(a.evidenceLost).toEqual([{ path, kind }]);
			expect(a.verdict).toBe("RECONCILE");
			expect(a.reasons).toEqual([
				`${path} held the copy of a dropped CURRENT line; check the copy is still there`,
				"1 CURRENT lines dropped and not accounted for",
			]);
		});
	test("dropped CURRENT lines are assessed against preservation sources", () => {
		const f = fixture();
		f.certify();
		f.put("CURRENT.md", "# Current\n");
		expect(f.assess().dropped?.unaccounted).toHaveLength(1);
		f.put("memories/copy.md", "Keep this important line\n");
		expect(f.assess().dropped?.accounted).toHaveLength(1);
		expect(f.assess().dropped?.unaccounted).toEqual([]);
	});
	test("reasons follow the required order", () => {
		const f = fixture({ "memories/copy.md": "copy", "pending.md": "old" });
		f.certify((c) => {
			c.journal.from = "lost";
			c.evidence["memories/copy.md"] = contentHash("copy");
		});
		f.put("archive/journal/2026-08.md", "- orphan\n");
		f.put("archive/journal/2026-09.md", "");
		f.remove("archive/journal/2026-09.md");
		mkdirSync(join(f.workspace.state, "archive/journal/2026-09.md"));
		f.put("pending.md", "new");
		f.put("memories/copy.md", "edited");
		f.put("CURRENT.md", "# Current\n");
		const reasons = f.assess().reasons;
		expect(reasons[0]).toStartWith("boundary lost:");
		expect(reasons[1]).toStartWith("journal unreadable:");
		expect(reasons[2]).toStartWith("2 entries in the fallback");
		expect(reasons[3]).toStartWith("1 entries without a heading");
		expect(reasons.slice(4)).toEqual([
			"CURRENT.md changed",
			"pending.md changed",
			"memories/copy.md held the copy of a dropped CURRENT line; check the copy is still there",
			"2 CURRENT lines dropped and not accounted for",
		]);
	});
	test("coverage includes sorted direct live STATUS files only", () => {
		const f = fixture({
			"work/todo/z/STATUS.md": "z",
			"work/in-progress/a/STATUS.md": "a",
			"work/done/b/STATUS.md": "b",
			"work/todo/z/nested/STATUS.md": "nested",
		});
		expect(coveredPaths(f.workspace.state).slice(5)).toEqual([
			"work/in-progress/a/STATUS.md",
			"work/todo/z/STATUS.md",
		]);
	});
	test("hashes use bytes and enclosing shared evidence resolves to parent workspace", () => {
		const tree = makeTree({
			".shepherd/shared/copy.md": "copy",
			"child/.shepherd/CURRENT.md": "current",
		});
		cleanups.push(tree.cleanup);
		const workspace = {
			name: "child",
			dir: join(tree.root, "child"),
			state: join(tree.root, "child/.shepherd"),
		};
		expect(
			hashPaths(workspace, [
				"enclosing:shared/copy.md",
				"CURRENT.md",
				"missing.md",
			]),
		).toEqual({
			"enclosing:shared/copy.md": contentHash("copy"),
			"CURRENT.md": contentHash("current"),
			"missing.md": null,
		});
	});
});

describe("unsafe checkpoint inputs", () => {
	const root = process.getuid?.() === 0;
	test.skipIf(root)(
		"unreadable MEMORY appearing after absent certification requires reconcile",
		() => {
			const f = fixture();
			f.certify();
			f.put("MEMORY.md", "unreadable");
			chmodSync(join(f.workspace.state, "MEMORY.md"), 0);
			const a = f.assess();
			expect(a.verdict).toBe("RECONCILE");
			expect(a.changed[0]).toMatchObject({ path: "MEMORY.md", kind: "unsafe" });
			expect(a.reasons[0]).toStartWith("MEMORY.md unsafe: ");
			expect(hashPaths(f.workspace, ["MEMORY.md"])["MEMORY.md"]).toStartWith(
				"unsafe:",
			);
		},
	);
	for (const path of [
		"pending.md",
		"work/todo/item/STATUS.md",
		"work/in-progress/item/STATUS.md",
	]) {
		test(`${path} symlink appearing after absent certification requires reconcile`, () => {
			const f = fixture();
			f.certify();
			mkdirSync(dirname(join(f.workspace.state, path)), { recursive: true });
			symlinkSync(
				join(f.workspace.state, "CURRENT.md"),
				join(f.workspace.state, path),
			);
			const a = f.assess();
			expect(a.changed).toEqual([
				{ path, kind: "unsafe", reason: "is a symlink" },
			]);
			expect(a.verdict).toBe("RECONCILE");
			expect(a.reasons).toEqual([`${path} unsafe: is a symlink`]);
		});
	}
	test("a directory appearing at a certified absent fixed path is unsafe", () => {
		const f = fixture();
		f.certify();
		mkdirSync(join(f.workspace.state, "MEMORY.md"));
		expect(f.assess().changed).toEqual([
			{ path: "MEMORY.md", kind: "unsafe", reason: "is not a regular file" },
		]);
	});
	test.skipIf(root)(
		"unreadable journal regular file yields a reconcile reason without throwing",
		() => {
			const f = fixture();
			f.certify();
			chmodSync(join(f.workspace.state, "journal.md"), 0);
			const a = f.assess();
			expect(a.verdict).toBe("RECONCILE");
			expect(a.unreadable[0]?.file).toBe("journal.md");
			expect(
				a.reasons.some((reason) =>
					reason.startsWith("journal unreadable: journal.md: "),
				),
			).toBe(true);
			expect(
				readDroppedSources(f.workspace, "").destinations["journal.md"],
			).toBeUndefined();
		},
	);
	test.skipIf(root)("unreadable CURRENT yields unsafe without throwing", () => {
		const f = fixture();
		f.certify();
		chmodSync(join(f.workspace.state, "CURRENT.md"), 0);
		const a = f.assess();
		expect(a.verdict).toBe("RECONCILE");
		expect(a.changed[0]).toMatchObject({ path: "CURRENT.md", kind: "unsafe" });
		expect(a.dropped).toBeUndefined();
	});
	test("symlinked preservation evidence is lost", () => {
		const f = fixture({ "memories/copy.md": "copy" });
		f.certify((c) => {
			c.evidence["memories/copy.md"] = contentHash("copy");
		});
		f.remove("memories/copy.md");
		symlinkSync(
			join(f.workspace.state, "CURRENT.md"),
			join(f.workspace.state, "memories/copy.md"),
		);
		const a = f.assess();
		expect(a.verdict).toBe("RECONCILE");
		expect(a.evidenceLost).toEqual([
			{ path: "memories/copy.md", kind: "missing" },
		]);
		expect(
			readDroppedSources(f.workspace, "").destinations["memories/copy.md"],
		).toBeUndefined();
	});
	test.skipIf(root)(
		"unreadable preservation evidence cannot account for dropped lines",
		() => {
			const f = fixture({ "memories/copy.md": "Keep this important line" });
			f.certify((c) => {
				c.evidence["memories/copy.md"] = contentHash(
					"Keep this important line",
				);
			});
			f.put("CURRENT.md", "# Current\n");
			chmodSync(join(f.workspace.state, "memories/copy.md"), 0);
			const a = f.assess();
			expect(a.verdict).toBe("RECONCILE");
			expect(a.evidenceLost).toEqual([
				{ path: "memories/copy.md", kind: "missing" },
			]);
			expect(a.dropped?.unaccounted).toHaveLength(2);
		},
	);
	test.skipIf(root)(
		"unreadable destination directory is skipped and marks coverage unsafe",
		() => {
			const f = fixture({
				"docs/INDEX.md": "index",
				"docs/copy.md": "Keep this important line",
			});
			f.certify();
			const dir = join(f.workspace.state, "docs");
			chmodSync(dir, 0);
			try {
				const a = f.assess();
				expect(a.verdict).toBe("RECONCILE");
				expect(a.changed[0]).toMatchObject({
					path: "docs/INDEX.md",
					kind: "unsafe",
				});
				expect(
					readDroppedSources(f.workspace, "").destinations["docs/copy.md"],
				).toBeUndefined();
			} finally {
				chmodSync(dir, 0o755);
			}
		},
	);
});

for (const evidenceLines of [
	[],
	null,
	{ "../bad": ["text"] },
	{ "memories/missing.md": ["text"] },
	{ "memories/copy.md": "text" },
	{ "memories/copy.md": [1] },
])
	test(`malformed evidenceLines ${JSON.stringify(evidenceLines)} is invalid`, () => {
		const f = fixture();
		const checkpoint = f.certify();
		f.put(
			"checkpoint.json",
			JSON.stringify({
				...checkpoint,
				evidence: { "memories/copy.md": contentHash("copy") },
				evidenceLines,
			}),
		);
		expect(readCheckpoint(f.workspace.state).status).toBe("invalid");
	});
