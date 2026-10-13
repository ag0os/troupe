import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assessCheckpoint, readCheckpoint } from "./checkpoint";
import {
	captureState,
	certifyRange,
	checkpointToken,
	commitCheckpoint,
	nextCheckpoint,
} from "./checkpoint-write";
import { contentHash, readDroppedSources } from "./current-prev";
import { fakeClock, fakeToolEnv, makeTree } from "./test-support";
import { journalChain, journalEntries } from "./text";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
const journal = "## 2026-10-06\n- 09:00 A\n## 2026-10-07\n- 10:00 B\n";
const current = "# Current\nPreserve this important line\n";
function fixture(files: Record<string, string> = {}) {
	const tree = makeTree(
		Object.fromEntries(
			Object.entries({
				"CURRENT.md": current,
				"journal.md": journal,
				...files,
			}).map(([path, text]) => [`.shepherd/${path}`, text]),
		),
	);
	cleanups.push(tree.cleanup);
	const workspace = {
		name: "test",
		dir: tree.root,
		state: join(tree.root, ".shepherd"),
	};
	const clock = fakeClock("2026-10-08T12:00:00Z");
	const env = fakeToolEnv({ home: tree.root, clock: clock.clock });
	const put = (path: string, text: string) => {
		const full = join(workspace.state, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	};
	const remove = (path: string) =>
		rmSync(join(workspace.state, path), { recursive: true, force: true });
	const read = (path: string) =>
		readFileSync(join(workspace.state, path), "utf8");
	const capture = () => captureState(workspace, env);
	const apply = (hooks?: Parameters<typeof commitCheckpoint>[3]) => {
		const held = capture();
		const next = nextCheckpoint(held, {
			written: clock.clock().toISOString(),
			session: "test-session",
		});
		commitCheckpoint(workspace.state, held, next, hooks);
		return next;
	};
	const lost = () => {
		const c = apply();
		c.journal.from = "lost";
		put("checkpoint.json", JSON.stringify(c));
	};
	return {
		workspace,
		env,
		put,
		remove,
		read,
		capture,
		apply,
		lost,
		assess: () => assessCheckpoint(workspace, env),
	};
}

for (const [name, edit] of [
	[
		"journal append",
		(f: ReturnType<typeof fixture>) =>
			f.put("journal.md", `${journal}- 11:00 C\n`),
	],
	[
		"STATUS edit",
		(f: ReturnType<typeof fixture>) => f.put("work/todo/item/STATUS.md", "new"),
	],
	[
		"STATUS appearance",
		(f: ReturnType<typeof fixture>) =>
			f.put("work/in-progress/new/STATUS.md", "new"),
	],
] as const)
	test(`token changes after ${name}`, () => {
		const f = fixture({ "work/todo/item/STATUS.md": "old" });
		f.apply();
		const before = f.capture().token;
		edit(f);
		expect(f.capture().token).not.toBe(before);
	});

test("token changes when a destination loses its exact copy", () => {
	const f = fixture({ "memories/copy.md": "Preserve this important line\n" });
	f.apply();
	f.put("CURRENT.md", "# Current\n");
	const held = f.capture();
	expect(held.dropped?.accounted).toHaveLength(1);
	f.put("memories/copy.md", "edited");
	expect(f.capture().token).not.toBe(held.token);
});
test("token changes when an exempt item is removed", () => {
	const f = fixture({
		"CURRENT.md": "## Items\n- [item](work/todo/item/STATUS.md)\n",
		"work/todo/item/STATUS.md": "live",
	});
	f.apply();
	f.put("CURRENT.md", "# Current\n");
	const held = f.capture();
	expect(held.dropped?.candidates[0]?.disposition.kind).toBe("exempt");
	f.remove("work/todo/item");
	expect(f.capture().token).not.toBe(held.token);
});
test("unsafe coverage changes the token and cannot enter a manifest", () => {
	const f = fixture();
	const before = f.capture().token;
	symlinkSync("CURRENT.md", join(f.workspace.state, "MEMORY.md"));
	const held = f.capture();
	expect(held.files["MEMORY.md"]).toEqual({
		bytes: null,
		hash: "unsafe:is a symlink",
	});
	expect(held.unsafe).toEqual([{ path: "MEMORY.md", reason: "is a symlink" }]);
	expect(held.token).not.toBe(before);
	expect(() => nextCheckpoint(held, { written: "now" })).toThrow(
		"unsafe file: MEMORY.md",
	);
});
test("two interruptions before rename preserve the old snapshot and a third commit succeeds", () => {
	const f = fixture();
	const old = f.apply();
	const manifest = f.read("checkpoint.json");
	f.put("CURRENT.md", "validated");
	for (let attempt = 0; attempt < 2; attempt++) {
		expect(() =>
			f.apply({
				afterSnapshot: () => {
					throw new Error("crash");
				},
			}),
		).toThrow("crash");
		expect(f.read("checkpoint.json")).toBe(manifest);
		expect(f.read(old.snapshot)).toBe(current);
		expect(f.capture().status).toBe("ok");
	}
	const next = f.apply();
	expect(next.revision).toBe(2);
	expect(f.read(next.snapshot)).toBe("validated");
});
test("interruption after rename leaves a valid checkpoint and stale snapshots prune next time", () => {
	const f = fixture();
	const old = f.apply();
	f.put("CURRENT.md", "held replacement bytes");
	const held = f.capture();
	const committed = nextCheckpoint(held, { written: "now" });
	expect(() =>
		commitCheckpoint(f.workspace.state, held, committed, {
			afterRename: () => {
				throw new Error("crash");
			},
		}),
	).toThrow("crash");
	const assessment = f.assess();
	expect(assessment.status).toBe("ok");
	expect(assessment.checkpoint?.revision).toBe(2);
	const snapshot = fs.readFileSync(join(f.workspace.state, committed.snapshot));
	expect(snapshot).toEqual(Buffer.from(held.files["CURRENT.md"]?.bytes ?? []));
	expect(held.files["CURRENT.md"]?.hash).toBe(contentHash(snapshot));
	expect(committed.files["CURRENT.md"]).toBe(contentHash(snapshot));
	expect(f.read(old.snapshot)).toBe(current);
	const next = f.apply();
	expect(next.revision).toBe(3);
	expect(() => f.read(old.snapshot)).toThrow();
	expect(() => f.read("checkpoints/CURRENT.r2")).toThrow();
});

test("an interrupted orphan snapshot with different bytes is replaced", () => {
	const f = fixture();
	f.apply();
	f.put("checkpoints/CURRENT.r2", "orphan");
	const next = f.apply();
	expect(f.read(next.snapshot)).toBe(current);
});
for (const path of ["checkpoint.json", "checkpoint.json.tmp", "checkpoints"])
	test(`commit refuses symlinked ${path}`, () => {
		const f = fixture();
		const held = f.capture();
		const next = nextCheckpoint(held, { written: "now" });
		symlinkSync("CURRENT.md", join(f.workspace.state, path));
		expect(() => commitCheckpoint(f.workspace.state, held, next)).toThrow(
			`unsafe file: ${path}: is a symlink`,
		);
		expect(f.read("CURRENT.md")).toBe(current);
	});
test("revision advances exactly one and from is carried on subsequent commits", () => {
	const f = fixture();
	const first = f.apply();
	f.put("journal.md", `${journal}- 11:00 C\n`);
	const held = f.capture();
	expect(held.range).toMatchObject({
		ok: true,
		start: 2,
		fromReset: false,
		uncertified: 0,
	});
	const second = f.apply();
	expect(first.revision).toBe(1);
	expect(second.revision).toBe(2);
	expect(second.journal.from).toBe(first.journal.from);
	expect(second.journal.count).toBe(3);
	expect(f.assess().verdict).toBe("CLEAN");
});
test("empty chain writes null endpoints and a later entry sets from", () => {
	const f = fixture({ "journal.md": "## 2026-10-08\n" });
	expect(f.capture().range).toMatchObject({ ok: true, entries: [] });
	expect(f.apply().journal).toEqual({ from: null, to: null, count: 0 });
	f.put("journal.md", journal);
	const next = f.apply();
	expect(next.journal.from).toBe(
		journalChain(f.workspace.state).entries[0]?.id ?? null,
	);
	expect(next.journal.count).toBe(2);
});
test("repair after a lost boundary resets from and assesses CLEAN", () => {
	const f = fixture();
	const old = f.apply();
	f.put("journal.md", journal.replace("A", "edited A"));
	const held = f.capture();
	expect(held.range).toMatchObject({ ok: true, fromReset: true });
	const next = f.apply();
	expect(next.journal.from).not.toBe(old.journal.from);
	expect(next.journal.from).toBe(held.chain[0]?.id ?? null);
	expect(f.assess().verdict).toBe("CLEAN");
});
for (const live of ["", "## 2026-10-09\n## 2026-10-10\n"])
	test(`lost boundary with ${live ? "empty headings" : "rotated journal"} uses the last two archived sections`, () => {
		const f = fixture();
		f.lost();
		f.put("archive/journal/2026-09.md", `## 2026-10-05\n- older\n${journal}`);
		f.put("journal.md", live);
		const held = f.capture();
		expect(held.range).toMatchObject({
			ok: true,
			start: 1,
			fromReset: true,
			uncertified: 1,
		});
		if (held.range.ok)
			expect(held.range.entries.map((e) => e.text)).toEqual([
				"09:00 A",
				"10:00 B",
			]);
		const next = f.apply();
		expect(next.journal.from).toBe(held.chain[1]?.id ?? null);
		expect(f.assess().verdict).toBe("CLEAN");
	});
test("empty latest archive is skipped", () => {
	const f = fixture({
		"archive/journal/2026-09.md": journal,
		"archive/journal/2026-10.md": "## 2026-10-09\n",
		"journal.md": "",
	});
	const held = f.capture();
	expect(held.range).toMatchObject({ ok: true, start: 0 });
	if (held.range.ok) expect(held.range.entries).toHaveLength(2);
});
test("duplicate date headings retain separate fallback sections", () => {
	const f = fixture({
		"journal.md":
			"## 2026-10-07\n- older\n## 2026-10-07\n- A\n## 2026-10-07\n- B\n",
	});
	const held = f.capture();
	expect(held.range).toMatchObject({ ok: true, start: 1, uncertified: 1 });
	expect(certifyRange({ ...held, chain: [...held.chain] })).toEqual(held.range);
});
test("fallback beginning in journal leaves prior archive and orphans uncertified", () => {
	const f = fixture({
		"archive/journal/2026-09.md": "## 2026-10-05\n- old\n",
		"journal.md": `- orphan\n${journal}`,
	});
	const held = f.capture();
	expect(held.range).toMatchObject({ ok: true, start: 2, uncertified: 2 });
	if (held.range.ok)
		expect(held.range.entries.map((e) => e.text)).toEqual([
			"09:00 A",
			"10:00 B",
		]);
});
for (const boundary of ["lost", "valid"] as const)
	test(`${boundary} archived boundary followed by an orphan refuses until a heading is added`, () => {
		const f = fixture();
		if (boundary === "lost") f.lost();
		else f.apply();
		f.put("archive/journal/2026-09.md", journal);
		f.put("journal.md", "- orphan\n## 2026-10-08\n- C\n");
		const held = f.capture();
		expect(held.range.ok).toBe(false);
		expect(held.token).toMatch(/^r1-[a-f0-9]{12}$/);
		if (!held.range.ok)
			expect(held.range.message).toBe(
				"1 entries without a heading at journal.md:1 sit inside the range; put a `## YYYY-MM-DD` heading (their day, or today's) above the first of them, which changes no id, then run the dry run again",
			);
		expect(() => nextCheckpoint(held, { written: "now" })).toThrow(
			"entries without a heading",
		);
		f.put("journal.md", "## 2026-10-08\n- orphan\n## 2026-10-08\n- C\n");
		expect(f.capture().range.ok).toBe(true);
	});
test("orphan-only chain refuses and certifies after a heading is added", () => {
	const f = fixture({ "journal.md": "- O\n" });
	expect(f.capture().range.ok).toBe(false);
	f.put("journal.md", "## 2026-10-08\n- O\n");
	expect(f.capture().range.ok).toBe(true);
});
test("accounted evidence uses held memory bytes and a later edit reports it lost", () => {
	const f = fixture({ "memories/copy.md": "Preserve this important line\n" });
	f.apply();
	f.put("CURRENT.md", "# Current\n");
	const held = f.capture();
	f.put("memories/copy.md", "edited after capture");
	const next = nextCheckpoint(held, { written: "now" });
	expect(next.evidence).toEqual({
		"memories/copy.md": contentHash("Preserve this important line\n"),
	});
	commitCheckpoint(f.workspace.state, held, next);
	expect(f.assess().evidenceLost).toEqual([
		{ path: "memories/copy.md", kind: "changed" },
	]);
	expect(f.assess().verdict).toBe("RECONCILE");
});
test("held CURRENT bytes are committed even after the disk changes", () => {
	const f = fixture();
	const held = f.capture();
	f.put("CURRENT.md", "edited after validation");
	const next = nextCheckpoint(held, { written: "now" });
	commitCheckpoint(f.workspace.state, held, next);
	expect(f.read(next.snapshot)).toBe(current);
	expect(next.files["CURRENT.md"]).toBe(contentHash(current));
	expect(f.assess().changed).toContainEqual({
		path: "CURRENT.md",
		kind: "changed",
	});
});
test("removed manifest STATUS stays in the token union but is omitted from next manifest", () => {
	const path = "work/todo/item/STATUS.md";
	const f = fixture({ [path]: "old" });
	f.apply();
	f.remove("work/todo/item");
	const held = f.capture();
	expect(held.files[path]).toEqual({ bytes: null, hash: null });
	expect(nextCheckpoint(held, { written: "now" }).files[path]).toBeUndefined();
});
test("verified appends set the last boundary, count, day and shortened text", () => {
	const f = fixture({ "journal.md": "" });
	const held = f.capture();
	f.put("journal.md", `## 2026-10-08\n- ${"x".repeat(100)}\n`);
	const appended = journalChain(f.workspace.state).entries;
	const next = nextCheckpoint(held, { written: "now", appended });
	expect(next.journal).toEqual({
		from: appended[0]?.id ?? null,
		to: appended[0]?.id ?? null,
		count: 1,
		day: "2026-10-08",
		text: "x".repeat(80),
	});
	expect(next.session).toBeUndefined();
});
test("missing CURRENT cannot produce a checkpoint", () => {
	const f = fixture();
	f.remove("CURRENT.md");
	expect(() => nextCheckpoint(f.capture(), { written: "now" })).toThrow(
		"nothing to certify without CURRENT.md",
	);
});
test("invalid snapshot preserves the parsed revision and resets the fallback", () => {
	const f = fixture();
	f.apply();
	f.remove("checkpoints/CURRENT.r1");
	const held = f.capture();
	expect(held.status).toBe("invalid");
	expect(held.revision).toBe(1);
	expect(held.baseline).toBeUndefined();
	expect(held.range).toMatchObject({ ok: true, fromReset: true });
});
test("range and token helpers reproduce captured values without disk access", () => {
	const f = fixture();
	const held = f.capture();
	f.remove("journal.md");
	f.remove("CURRENT.md");
	expect(certifyRange(held)).toEqual(held.range);
	expect(checkpointToken(held)).toBe(held.token);
});
test("checkpoint output is pretty JSON with a trailing newline", () => {
	const f = fixture();
	const next = f.apply();
	expect(f.read("checkpoint.json")).toBe(`${JSON.stringify(next, null, 2)}\n`);
	expect(readCheckpoint(f.workspace.state)).toEqual({
		status: "ok",
		checkpoint: next,
	});
});

test("capture reads overlapping covered records, journal and destinations once", () => {
	const f = fixture({
		"docs/INDEX.md": "index",
		"pending.md": "pending",
		"work/todo/item/STATUS.md": "status",
		"memories/copy.md": "copy",
	});
	const before = f.apply();
	before.files[before.snapshot] = before.files["CURRENT.md"] ?? null;
	before.files["checkpoint.json"] = contentHash("older checkpoint bytes");
	const manifest = JSON.stringify(before);
	f.put("checkpoint.json", manifest);
	const originalRead = fs.readFileSync;
	const reads: string[] = [];
	const spy = spyOn(fs, "readFileSync").mockImplementation(((
		...args: Parameters<typeof fs.readFileSync>
	) => {
		reads.push(String(args[0]));
		return originalRead(...args);
	}) as typeof fs.readFileSync);
	try {
		const held = f.capture();
		for (const path of [
			"checkpoint.json",
			"checkpoints/CURRENT.r1",
			"CURRENT.md",
			"docs/INDEX.md",
			"pending.md",
			"work/todo/item/STATUS.md",
			"journal.md",
			"memories/copy.md",
		])
			expect(
				reads.filter((read) => read === join(f.workspace.state, path)),
			).toHaveLength(1);
		const count = reads.length;
		const next = nextCheckpoint(held, { written: "now" });
		checkpointToken(held);
		certifyRange(held);
		commitCheckpoint(f.workspace.state, held, next);
		expect(reads).toHaveLength(count);
	} finally {
		spy.mockRestore();
	}
});
for (const journalText of [journal, ""])
	test(`token uses exactly the specified sorted newline serialization (${journalText ? "entries" : "empty"})`, () => {
		const f = fixture({ "journal.md": journalText });
		const held = f.capture();
		const lines = [
			`range ${held.chain[0]?.id ?? "none"} ${held.chain.at(-1)?.id ?? "none"}`,
			`chain ${held.chain.at(-1)?.id ?? "none"} ${held.chain.length}`,
			...Object.keys(held.files)
				.sort()
				.map((path) => `file ${path} ${held.files[path]?.hash ?? "null"}`),
			"baseline none",
			"digest none",
		];
		expect(held.token).toBe(
			`r0-${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12)}`,
		);
	});
test("found boundary counts uncertified entries before from, including old orphans", () => {
	const f = fixture({ "journal.md": `- orphan\n${journal}` });
	f.apply();
	const held = f.capture();
	expect(held.range).toMatchObject({
		ok: true,
		entries: [],
		start: 3,
		fromReset: false,
		uncertified: 1,
	});
});
test("a symlinked parent of a covered STATUS is unsafe", () => {
	const f = fixture({ "work/done/item/STATUS.md": "status" });
	mkdirSync(join(f.workspace.state, "work/todo"), { recursive: true });
	symlinkSync("../done/item", join(f.workspace.state, "work/todo/item"));
	const held = f.capture();
	expect(held.files["work/todo/item/STATUS.md"]?.hash).toBe(
		"unsafe:is a symlink",
	);
	expect(() => nextCheckpoint(held, { written: "now" })).toThrow("unsafe file");
});
test("item states and destination text match the existing preservation reader", () => {
	const f = fixture({
		"CURRENT.md":
			"## Items\n- [live](work/todo/live/STATUS.md)\n- [done](work/done/done/STATUS.md)\n- [bad](work/done/bad/STATUS.md)\n- [old](archive/2026/old/STATUS.md)\n- [gone](work/todo/gone/STATUS.md)\n",
		"work/todo/live/STATUS.md": "live",
		"work/done/done/STATUS.md": "---\nstate: done\n---\n## Outcome\nFinished",
		"work/done/bad/STATUS.md": "---\nstate: done\n---\n````\n## Outcome\n````",
		"archive/2026/old/STATUS.md": "old",
		"docs/copy.md": "copy",
	});
	f.apply();
	const held = f.capture();
	const sources = readDroppedSources(f.workspace, held.baseline?.text ?? "");
	expect(held.items).toEqual(sources.items);
	expect(held.destinations).toEqual(sources.destinations);
});
test("repairing an invalid baseline preserves the referenced snapshot until rename", () => {
	const f = fixture();
	f.apply();
	f.put("checkpoints/CURRENT.r1", "damaged");
	const held = f.capture();
	const next = nextCheckpoint(held, { written: "now" });
	expect(next.revision).toBe(2);
	expect(() =>
		commitCheckpoint(f.workspace.state, held, next, {
			afterSnapshot: () => {
				throw new Error("crash");
			},
		}),
	).toThrow("crash");
	expect(f.read("checkpoints/CURRENT.r1")).toBe("damaged");
	commitCheckpoint(f.workspace.state, held, next);
	expect(f.capture().status).toBe("ok");
	expect(f.assess().verdict).toBe("CLEAN");
});

test("lost boundary with archived A and B followed only by orphan O refuses", () => {
	const f = fixture();
	f.lost();
	f.put("archive/journal/2026-09.md", journal);
	f.put("journal.md", "- O\n");
	const held = f.capture();
	expect(held.range).toMatchObject({ ok: false });
	if (!held.range.ok)
		expect(held.range.message).toStartWith(
			"1 entries without a heading at journal.md:1 sit inside the range;",
		);
	f.put("journal.md", "## 2026-10-08\n- O\n");
	expect(f.capture().range.ok).toBe(true);
});
test("commit never replaces a referenced snapshot even with an unexpected snapshot name", () => {
	const f = fixture();
	const old = f.apply();
	old.snapshot = "checkpoints/CURRENT.r2";
	f.put(old.snapshot, current);
	f.put("checkpoint.json", JSON.stringify(old));
	const held = f.capture();
	const next = nextCheckpoint(held, { written: "now" });
	expect(() => commitCheckpoint(f.workspace.state, held, next)).toThrow(
		"snapshot is referenced by checkpoint.json",
	);
	expect(f.read(old.snapshot)).toBe(current);
	expect(readCheckpoint(f.workspace.state)).toEqual({
		status: "ok",
		checkpoint: old,
	});
});

test("section identity survives copied, re-read and extended chains", () => {
	const f = fixture({
		"archive/journal/2026-09.md": "## 2026-10-05\n- old\n",
		"journal.md": "## 2026-10-07\n- A\n## 2026-10-07\n- B\n",
	});
	const held = f.capture();
	expect(held.range).toMatchObject({ ok: true, start: 1, uncertified: 1 });
	if (held.range.ok)
		expect(held.range.entries.map((entry) => entry.text)).toEqual(["A", "B"]);
	expect(
		certifyRange({ ...held, chain: held.chain.map((entry) => ({ ...entry })) }),
	).toEqual(held.range);
	expect(
		certifyRange({ ...held, chain: journalChain(f.workspace.state).entries }),
	).toEqual(held.range);
	const extendedText =
		"## 2026-10-07\n- A\n## 2026-10-07\n- B\n- accepted dropped line\n";
	f.put("journal.md", extendedText);
	const appended = journalChain(f.workspace.state).entries.at(-1);
	expect(appended).toBeDefined();
	if (!appended) throw new Error("missing appended entry");
	const extended = certifyRange({ ...held, chain: [...held.chain, appended] });
	expect(extended).toMatchObject({ ok: true, start: 1, uncertified: 1 });
	if (extended.ok)
		expect(extended.entries).toEqual([...held.chain.slice(1), appended]);
});
test("fenced heading-like text leaves assessment and capture fallback in agreement", () => {
	const f = fixture({
		"archive/journal/2026-09.md": "## 2026-10-05\n- old\n",
		"journal.md":
			"## 2026-10-07\n- A\n```\n## 2026-10-08\n```\n- B\n## 2026-10-09\n- C\n",
	});
	const held = f.capture();
	const assessment = f.assess();
	expect(
		assessment.unreviewed.sections?.map((section) => section.headingLine),
	).toEqual([1, 7]);
	if (!held.range.ok) throw new Error(held.range.message);
	expect(held.range.entries.map((entry) => entry.text)).toEqual([
		"A",
		"B",
		"C",
	]);
	expect(assessment.unreviewed.entries).toEqual(held.range.entries);
});
test("journal heading lines are explicit data and never affect entry ids", () => {
	const original = journalEntries(
		"- O\n## 2026-10-07\n- A\n## 2026-10-07\n- B\n",
	);
	expect(original.map((entry) => entry.heading)).toEqual([undefined, 2, 4]);
	const headed = journalEntries(
		"## 2026-10-06\n- O\n## 2026-10-07\n- A\n## 2026-10-07\n- B\n",
	);
	expect(headed.map((entry) => entry.id)).toEqual(
		original.map((entry) => entry.id),
	);
	expect(headed.map((entry) => entry.heading)).toEqual([1, 3, 5]);
});
test("symlinked archive buckets classify missing items consistently with start", () => {
	const f = fixture({
		"CURRENT.md": "## Items\n- [item](archive/2026/item/STATUS.md)\n",
		"elsewhere/item/STATUS.md": "old",
	});
	mkdirSync(join(f.workspace.state, "archive"), { recursive: true });
	symlinkSync("../elsewhere", join(f.workspace.state, "archive/2026"));
	f.apply();
	f.put("CURRENT.md", "# Current\n");
	const held = f.capture();
	expect(held.items).toEqual({ item: "missing" });
	expect(held.items).toEqual(
		readDroppedSources(f.workspace, held.baseline?.text ?? "").items,
	);
	expect(held.dropped?.candidates[0]?.disposition).toEqual({
		kind: "unaccounted",
	});
	const assessed = f.assess().dropped;
	if (!held.dropped || !assessed) throw new Error("missing dropped assessment");
	expect(held.dropped).toEqual(assessed);
});
const caseInsensitive = (() => {
	const tree = makeTree({ probe: "" });
	try {
		return (
			fs.lstatSync(join(tree.root, "PROBE")).ino ===
			fs.lstatSync(join(tree.root, "probe")).ino
		);
	} catch {
		return false;
	} finally {
		tree.cleanup();
	}
})();
test.skipIf(!caseInsensitive)(
	"commit refuses a differently cased reference to the orphan target",
	() => {
		const f = fixture();
		const old = f.apply();
		old.snapshot = "checkpoints/current.R2";
		f.put(old.snapshot, current);
		f.put("checkpoint.json", JSON.stringify(old));
		const held = f.capture();
		const next = nextCheckpoint(held, { written: "now" });
		expect(() => commitCheckpoint(f.workspace.state, held, next)).toThrow(
			"snapshot is referenced by checkpoint.json",
		);
		expect(f.read(old.snapshot)).toBe(current);
		expect(readCheckpoint(f.workspace.state)).toEqual({
			status: "ok",
			checkpoint: old,
		});
	},
);
test("commit refuses a hard-linked reference to the orphan target", () => {
	const f = fixture();
	const old = f.apply();
	fs.linkSync(
		join(f.workspace.state, old.snapshot),
		join(f.workspace.state, "checkpoints/CURRENT.r2"),
	);
	const held = f.capture();
	const next = nextCheckpoint(held, { written: "now" });
	expect(() => commitCheckpoint(f.workspace.state, held, next)).toThrow(
		"snapshot is referenced by checkpoint.json",
	);
	expect(f.read(old.snapshot)).toBe(current);
});

for (const [bucket, expected, links] of [
	[
		"work/done",
		"done",
		["work", "work/done", "work/done/task", "work/done/task/STATUS.md"],
	],
	[
		"work/todo",
		"live",
		["work", "work/todo", "work/todo/task", "work/todo/task/STATUS.md"],
	],
	[
		"archive/2026",
		"archived",
		[
			"archive",
			"archive/2026",
			"archive/2026/task",
			"archive/2026/task/STATUS.md",
		],
	],
] as const) {
	for (const link of [undefined, ...links]) {
		test(`${bucket} item classification agrees with start through ${link ?? "ordinary directories"}`, () => {
			const baseline = `## Items\n- [task](${bucket}/task/STATUS.md)\n`;
			const f = fixture({
				"CURRENT.md": baseline,
				[`${bucket}/task/STATUS.md`]:
					"---\nstate: done\n---\n## Outcome\nFinished\n",
			});
			f.apply();
			if (link) {
				fs.renameSync(
					join(f.workspace.state, link),
					join(f.workspace.state, "elsewhere"),
				);
				symlinkSync(
					join(f.workspace.state, "elsewhere"),
					join(f.workspace.state, link),
				);
			}
			f.put("CURRENT.md", "# Current\n");
			const held = f.capture();
			const sources = readDroppedSources(f.workspace, baseline);
			expect(held.items).toEqual({ task: link ? "missing" : expected });
			expect(sources.items).toEqual(held.items);
			expect(sources.destinations).toEqual(held.destinations);
			expect(held.dropped?.candidates[0]?.disposition.kind).toBe(
				link ? "unaccounted" : "exempt",
			);
			const assessed = f.assess().dropped;
			if (!held.dropped || !assessed)
				throw new Error("missing dropped assessment");
			expect(held.dropped).toEqual(assessed);
		});
	}
}

test("a symlinked live bucket does not hide an item resolved through a real live bucket", () => {
	const baseline = "## Items\n- [task](work/todo/task/STATUS.md)\n";
	const f = fixture({
		"CURRENT.md": baseline,
		"work/todo/task/STATUS.md": "todo",
		"work/in-progress/task/STATUS.md": "active",
	});
	f.apply();
	fs.renameSync(
		join(f.workspace.state, "work/todo"),
		join(f.workspace.state, "elsewhere"),
	);
	symlinkSync(
		join(f.workspace.state, "elsewhere"),
		join(f.workspace.state, "work/todo"),
	);
	f.put("CURRENT.md", "# Current\n");
	const held = f.capture();
	expect(held.items).toEqual({ task: "live" });
	expect(readDroppedSources(f.workspace, baseline).items).toEqual(held.items);
	expect(held.dropped?.candidates[0]?.disposition.kind).toBe("exempt");
});

for (const edit of ["delete", "rewrite"] as const)
	test(`empty-range token binds the complete chain after journal ${edit}`, () => {
		const f = fixture();
		f.apply();
		const before = f.capture();
		expect(before.range).toMatchObject({ ok: true, entries: [] });
		if (edit === "delete") f.remove("journal.md");
		else f.put("journal.md", journal.replace("A", "rewritten A"));
		const after = f.capture();
		expect(after.files).toEqual(before.files);
		expect(after.token).not.toBe(before.token);
	});
