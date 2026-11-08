import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyArchive, planArchive } from "./archive";
import {
	type Config,
	DEFAULT_HANDOFF_CEILINGS,
	DEFAULT_MARKS,
	DEFAULT_START,
	DEFAULT_WINDOWS,
} from "./config";
import { dayOf, monthOf } from "./dates";
import { makeTree } from "./test-support";
import {
	closedDate,
	frontmatter,
	journalChain,
	journalDuplicateHeadings,
	journalEntries,
	journalMisorderedHeadings,
	journalOrphans,
	journalSections,
	journalTimeSlips,
	mdFiles,
	proseLines,
	summaryLine,
	walk,
	words,
	wordsIn,
} from "./text";
import { discoverTree } from "./tree";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "shepherd-text-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("file and text helpers", () => {
	test("counts words in existing files", () => {
		const first = join(root, "first.md");
		const missing = join(root, "missing.md");
		writeFileSync(first, "one  two\nthree\n");
		expect(words(" one\n two ")).toBe(2);
		expect(wordsIn([first, missing])).toBe(3);
	});

	test("walk sorts matches, honors skips, and does not follow symlinks", () => {
		const nested = join(root, "nested");
		const skipped = join(nested, "skip.md");
		mkdirSync(nested);
		writeFileSync(join(root, "b.md"), "b");
		writeFileSync(join(root, "plain.txt"), "plain");
		writeFileSync(join(nested, "a.md"), "a");
		writeFileSync(skipped, "skip");
		symlinkSync(nested, join(root, "linked"));

		expect(mdFiles(root, [skipped])).toEqual([
			join(root, "b.md"),
			join(nested, "a.md"),
		]);
		expect(walk(join(root, "absent"), () => true)).toEqual([]);
	});

	test("reads simple frontmatter fields", () => {
		expect(
			frontmatter(
				"---\nname: sample\ndescription: useful # note\ntype: reference\n---\nBody\n",
			),
		).toEqual({
			name: "sample",
			description: "useful",
			type: "reference",
		});
		expect(frontmatter("Body only\n")).toBeUndefined();
	});

	test("prose lines omit backtick and tilde fenced blocks", () => {
		const text = [
			"first",
			"```ts",
			"hidden one",
			"```",
			"middle",
			"~~~",
			"hidden two",
			"~~~",
			"last",
		].join("\n");
		expect(proseLines(text)).toEqual([
			{ n: 1, line: "first" },
			{ n: 5, line: "middle" },
			{ n: 9, line: "last" },
		]);
	});

	test("splits dated journal sections from the preamble", () => {
		const result = journalSections(
			"Journal\n\n## 2026-10-04\nFirst\n## 2026-10-05\nSecond\n",
		);
		expect(result.preamble).toBe("Journal\n\n");
		expect(result.days.map(({ date }) => date)).toEqual([
			"2026-10-04",
			"2026-10-05",
		]);
	});

	test("uses a valid closed field as an exact date", () => {
		const item = join(root, "item");
		mkdirSync(item);
		writeFileSync(
			join(item, "STATUS.md"),
			"---\nclosed: 2026-09-30\n---\n# item\n",
		);
		const result = closedDate(item);
		expect(result.approximate).toBe(false);
		expect(monthOf(result.date)).toBe("2026-09");
		expect(dayOf(result.date)).toBe("2026-09-30");
	});

	test("falls back to STATUS and directory modification times", () => {
		const withStatus = join(root, "with-status");
		const withoutStatus = join(root, "without-status");
		mkdirSync(withStatus);
		mkdirSync(withoutStatus);
		const status = join(withStatus, "STATUS.md");
		writeFileSync(status, "---\nclosed: unknown\n---\n# Item\n");
		const statusStamp = new Date(2026, 7, 12, 18, 30);
		const directoryStamp = new Date(2026, 7, 13, 9, 15);
		utimesSync(status, statusStamp, statusStamp);
		utimesSync(withoutStatus, directoryStamp, directoryStamp);

		const fromStatus = closedDate(withStatus);
		const fromDirectory = closedDate(withoutStatus);
		expect(fromStatus.approximate).toBe(true);
		expect(dayOf(fromStatus.date)).toBe("2026-08-12");
		expect(fromDirectory.approximate).toBe(true);
		expect(dayOf(fromDirectory.date)).toBe("2026-08-13");
	});

	test("selects an index summary from title, outcome, heading, or absence", () => {
		const cases = [
			["title", "# title: Concise title\n", "Concise title"],
			[
				"outcome",
				"# outcome\n\n## Outcome\n**Shipped.** More detail.\n",
				"Shipped.",
			],
			["heading", "# Plain heading\n", "Plain heading"],
		] as const;
		for (const [name, text, expected] of cases) {
			const item = join(root, name);
			mkdirSync(item);
			writeFileSync(join(item, "STATUS.md"), text);
			expect(summaryLine(item)).toBe(expected);
		}
		expect(summaryLine(join(root, "missing"))).toBe("(no STATUS.md)");
	});
});

function ids(text: string): string[] {
	return journalEntries(text).map(({ id }) => id);
}

describe("journal entries and ids", () => {
	test("appending keeps earlier ids and identical entries get distinct ids", () => {
		const text = "## 2026-10-01\n- 10:52 The user: OK\n";
		const before = journalEntries(text);
		const after = journalEntries(`${text}- 10:52 The user: OK\n`);
		expect(after.slice(0, 1)).toEqual(before);
		expect(after[1]?.id).not.toBe(after[0]?.id);
		expect(before[0]?.id).toBe(
			createHash("sha256")
				.update("root\n10:52 The user: OK")
				.digest("hex")
				.slice(0, 10),
		);
		expect(after.every(({ id }) => /^[a-f0-9]{10}$/.test(id))).toBe(true);
	});

	test("editing or removing an early entry changes all later ids", () => {
		const text = "## 2026-10-01\n- First\n- Second\n- Last\n";
		const before = ids(text);
		const after = ids(text.replace("First", "Changed"));
		expect(after.every((id, index) => id !== before[index])).toBe(true);
		expect(ids(text.replace("- First\n", "")).at(-1)).not.toBe(before.at(-1));
	});

	test("inserting and fixing headings leaves ids unchanged", () => {
		const text = "- Orphan\n## 2026-10-01\n- First\n- Second\n";
		expect(ids(`## 2026-09-30\n${text}`)).toEqual(ids(text));
		expect(ids(text.replace("2026-10-01", "2026-10-02"))).toEqual(ids(text));
	});

	test("continuations collapse whitespace and edits change the entry id", () => {
		const text =
			"## 2026-10-01\n- 10:52 The   user: OK\n  More\twords\n\tlast\n";
		expect(journalEntries(text)[0]).toMatchObject({
			line: 2,
			day: "2026-10-01",
			time: "10:52",
			text: "10:52 The user: OK More words last",
		});
		expect(ids(text.replace("More", "Different"))).not.toEqual(ids(text));
	});

	test("indented hash continuations contribute to entry text and chained ids", () => {
		const text =
			"## 2026-10-01\n- 10:00 Fixed issue\n  #123\n  confirmed\n- 10:01 Next\n";
		const before = journalEntries(text);
		const after = journalEntries(text.replace("#123", "#124"));
		expect(before).toHaveLength(2);
		expect(before[0]?.text).toBe("10:00 Fixed issue #123 confirmed");
		expect(after[0]?.text).toBe("10:00 Fixed issue #124 confirmed");
		expect(after[0]?.id).not.toBe(before[0]?.id);
		expect(after[1]?.id).not.toBe(before[1]?.id);
	});

	test("blank lines, headings, unindented text and bullets end continuations", () => {
		const text = [
			"- One",
			"",
			"  excluded",
			"- Two",
			"plain",
			"  excluded",
			"- Three",
			"## Other heading",
			"  excluded",
			"- Four",
			"## 2026-10-01",
			"  excluded",
			"- Five",
			"  included",
			"- Six",
		].join("\n");
		expect(journalEntries(text).map(({ text }) => text)).toEqual([
			"One",
			"Two",
			"Three",
			"Four",
			"Five included",
			"Six",
		]);
	});

	test("orphans remain in the chain while fenced entries and headings are ignored", () => {
		const text = [
			"- Orphan",
			"  continued",
			"```md",
			"## 2026-09-01",
			"- Hidden",
			"```",
			"  excluded",
			"- Still orphan",
			"## 2026-10-01",
			"- Visible",
			"~~~",
			"## 2026-11-01",
			"- Hidden too",
			"~~~",
			"- Last",
		].join("\n");
		const entries = journalEntries(text);
		expect(entries.map(({ line, day, text }) => ({ line, day, text }))).toEqual(
			[
				{ line: 1, day: undefined, text: "Orphan continued" },
				{ line: 8, day: undefined, text: "Still orphan" },
				{ line: 10, day: "2026-10-01", text: "Visible" },
				{ line: 15, day: "2026-10-01", text: "Last" },
			],
		);
		expect(journalOrphans(text)).toEqual(entries.slice(0, 2));
		expect(journalOrphans("## 2026-10-01\n- First")).toEqual([]);
	});

	test("parses modern and legacy time prefixes but rejects other prefixes", () => {
		const entries = journalEntries(
			[
				"- 09:31 x",
				"- 09:31 UTC: x",
				"- 09:31: x",
				"- 09:31 UTC x",
				"- Untimed",
				"- 9:31 x",
				"- 09:31x",
				"- 09:31",
			].join("\n"),
		);
		expect(entries.map(({ time }) => time)).toEqual([
			"09:31",
			"09:31",
			"09:31",
			"09:31",
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});

describe("journal chain", () => {
	test("reads archive filenames in order then the journal with ids carried across files", () => {
		const archive = join(root, "archive/journal");
		mkdirSync(archive, { recursive: true });
		writeFileSync(join(archive, "2026-09.md"), "## 2026-09-01\n- Second\n");
		writeFileSync(join(archive, "2026-08.md"), "- First\n");
		writeFileSync(join(archive, "2026-08-empty.md"), "# Empty\n");
		writeFileSync(join(archive, "ignored.txt"), "- Ignored\n");
		writeFileSync(join(root, "journal.md"), "## 2026-10-01\n- Third\n");
		const chain = journalChain(root);
		expect(chain.files).toEqual([
			"archive/journal/2026-08.md",
			"archive/journal/2026-09.md",
			"journal.md",
		]);
		expect(chain.entries.map(({ id }) => id)).toEqual(
			ids("- First\n- Second\n- Third\n"),
		);
		expect(chain.entries.map(({ file }) => file)).toEqual([
			"archive/journal/2026-08.md",
			"archive/journal/2026-09.md",
			"journal.md",
		]);
		expect(chain.entries[0]?.day).toBeUndefined();
		expect(chain.unreadable).toEqual([]);
	});

	test("missing archive directory and current journal are harmless", () => {
		expect(journalChain(root)).toEqual({
			entries: [],
			files: [],
			unreadable: [],
		});
		writeFileSync(join(root, "journal.md"), "- Only\n");
		expect(journalChain(root).files).toEqual(["journal.md"]);
	});

	test("reports symlinked and non-regular files without adding entries", () => {
		const archive = join(root, "archive/journal");
		mkdirSync(archive, { recursive: true });
		writeFileSync(join(root, "target.md"), "- Hidden\n");
		symlinkSync(join(root, "target.md"), join(archive, "2026-08.md"));
		symlinkSync(join(root, "missing"), join(archive, "2026-09.md"));
		mkdirSync(join(archive, "2026-10.md"));
		symlinkSync(join(root, "target.md"), join(root, "journal.md"));
		expect(journalChain(root)).toEqual({
			entries: [],
			files: [],
			unreadable: [
				{ file: "archive/journal/2026-08.md", reason: "is a symlink" },
				{ file: "archive/journal/2026-09.md", reason: "is a symlink" },
				{ file: "archive/journal/2026-10.md", reason: "is not a regular file" },
				{ file: "journal.md", reason: "is a symlink" },
			],
		});
	});

	test.skipIf(process.getuid?.() === 0)(
		"read failures are reported and readable files retain their chain order",
		() => {
			const archive = join(root, "archive/journal");
			mkdirSync(archive, { recursive: true });
			const blocked = join(archive, "2026-09.md");
			writeFileSync(join(archive, "2026-08.md"), "- First\n");
			writeFileSync(blocked, "- Unreadable\n");
			writeFileSync(join(root, "journal.md"), "- Last\n");
			chmodSync(blocked, 0);
			try {
				const chain = journalChain(root);
				expect(chain.files).toEqual([
					"archive/journal/2026-08.md",
					"journal.md",
				]);
				expect(chain.entries.map(({ id }) => id)).toEqual(
					ids("- First\n- Last\n"),
				);
				expect(chain.unreadable).toHaveLength(1);
				expect(chain.unreadable[0]?.file).toBe("archive/journal/2026-09.md");
				expect(chain.unreadable[0]?.reason).toContain("EACCES");
			} finally {
				chmodSync(blocked, 0o600);
			}
		},
	);

	test("ids survive an applyArchive month rotation that preserves entry order", () => {
		const fixture = makeTree({
			"root/.shepherd/charter.md": "Charter",
			"root/.shepherd/archive/journal/2026-08.md": "## 2026-08-01\n- Earlier\n",
			"root/.shepherd/archive/journal/2026-09.md":
				"## 2026-09-01\n- Existing\n",
			"root/.shepherd/journal.md":
				"# Journal\n\n## 2026-09-30\n- Old\n  continued\n\n## 2026-10-01\n- Current\n",
		});
		try {
			const tree = discoverTree(join(fixture.root, "root"));
			const config: Config = {
				marks: { ...DEFAULT_MARKS },
				windows: { ...DEFAULT_WINDOWS },
				start: { ...DEFAULT_START },
				handoffCeilings: { ...DEFAULT_HANDOFF_CEILINGS },
				codex: {},
				problems: [],
			};
			const before = journalChain(tree.root.state);
			const applied = applyArchive(
				planArchive([tree.root], config, new Date(2026, 9, 5)),
				tree,
			);
			expect(applied.workspaces[0]?.moves[0]?.status).toBe("moved");
			const after = journalChain(tree.root.state);
			expect(after.entries.map(({ text, id }) => ({ text, id }))).toEqual(
				before.entries.map(({ text, id }) => ({ text, id })),
			);
		} finally {
			fixture.cleanup();
		}
	});
});

describe("journal slip helpers", () => {
	test("time slips count per heading, tolerate small steps and skip untimed entries", () => {
		const text = [
			"- 23:00 Orphan",
			"## 2026-10-01",
			"- 10:00 First",
			"- 09:57 Small step",
			"- Untimed",
			"- 09:51 First slip",
			"- 09:46 Exactly five",
			"- 09:30 Second slip",
			"```",
			"## 2026-10-02",
			"- 01:00 Hidden",
			"```",
			"- 09:00 Third slip",
			"## 2026-10-01",
			"- 01:00 Reset",
			"- 00:50 New section slip",
			"## 2026-10-03",
			"- 00:01 Reset again",
		].join("\n");
		expect(journalTimeSlips(text)).toEqual([
			{ day: "2026-10-01", headingLine: 2, count: 3, firstLine: 6 },
			{ day: "2026-10-01", headingLine: 14, count: 1, firstLine: 16 },
		]);
		expect(journalTimeSlips("- 10:00 Orphan\n- 09:00 Orphan")).toEqual([]);
	});

	test("duplicate headings include empty sections and ignore fenced headings", () => {
		const text =
			"## 2026-10-01\n## 2026-10-02\n~~~\n## 2026-10-02\n~~~\n## 2026-10-01\n## 2026-10-01\n";
		expect(journalDuplicateHeadings(text)).toEqual([
			{ day: "2026-10-01", lines: [1, 6, 7] },
		]);
	});

	test("misordered headings compare with the previous heading and ignore fences", () => {
		const text =
			"## 2026-10-03\n## 2026-10-02\n```\n## 2026-11-01\n```\n## 2026-10-02\n## 2026-10-04\n## 2026-10-01\n";
		expect(journalMisorderedHeadings(text)).toEqual([
			{ day: "2026-10-02", line: 2, previous: "2026-10-03" },
			{ day: "2026-10-01", line: 8, previous: "2026-10-04" },
		]);
	});
});

describe("journal reader integrity", () => {
	test("unreadable journal fences carry a structured opening line", () => {
		writeFileSync(join(root, "journal.md"), "# Journal\n```\npasted\n");
		expect(journalChain(root).unreadable[0]?.line).toBe(2);
	});

	test("a different or shorter fence cannot close the opening fence", () => {
		expect(
			journalEntries("~~~~\n```\n~~~~\n- visible\n").map(({ text }) => text),
		).toEqual(["visible"]);
		expect(
			journalEntries(
				"````\n```\n- hidden\n```` trailing\n- hidden too\n````\n- visible\n",
			).map(({ text }) => text),
		).toEqual(["visible"]);
	});

	test("rotation between the current read and archive listing retains unreviewed entries", () => {
		mkdirSync(join(root, "archive/journal"), { recursive: true });
		writeFileSync(
			join(root, "archive/journal/2026-08.md"),
			"## 2026-08-31\n- boundary\n",
		);
		writeFileSync(join(root, "journal.md"), "## 2026-09-30\n- unreviewed\n");
		let rotated = false;
		const chain = journalChain(root, () => {
			rotated = true;
			writeFileSync(
				join(root, "archive/journal/2026-09.md"),
				"## 2026-09-30\n- unreviewed\n",
			);
			writeFileSync(join(root, "journal.md"), "# Journal\n");
		});
		expect(
			chain.entries.filter(({ text }) => text === "unreviewed").length,
		).toBeGreaterThanOrEqual(1);
		expect(rotated).toBe(true);
	});

	test("walk skips state and unlock lock directories including temporary siblings", () => {
		for (const name of [
			".state.lock",
			".state.lock.1.tmp",
			".state.lock.1.uuid.gone",
			".unlock.lock",
			".unlock.lock.1.tmp",
			".unlock.lock.1.uuid.gone",
		]) {
			mkdirSync(join(root, name));
			writeFileSync(join(root, name, "hidden.md"), "hidden");
		}
		writeFileSync(join(root, "visible.md"), "visible");
		expect(mdFiles(root)).toEqual([join(root, "visible.md")]);
	});

	test("walk skips files and directories removed between listing and inspection", () => {
		mkdirSync(join(root, "gone"));
		writeFileSync(join(root, "gone.md"), "gone");
		writeFileSync(join(root, "visible.md"), "visible");
		expect(
			walk(
				root,
				(path) => path.endsWith(".md"),
				[],
				(path) => {
					if (path.endsWith("gone") || path.endsWith("gone.md"))
						rmSync(path, { recursive: true });
				},
			),
		).toEqual([join(root, "visible.md")]);
	});

	test("journalChain ignores non-month Markdown files", () => {
		mkdirSync(join(root, "archive/journal"), { recursive: true });
		writeFileSync(join(root, "archive/journal/README.md"), "- ignored\n");
		writeFileSync(
			join(root, "archive/journal/2026-09.md"),
			"## 2026-09-01\n- archived\n",
		);
		expect(journalChain(root).entries.map(({ text }) => text)).toEqual([
			"archived",
		]);
	});
});

test("journal sections split only at dated headings outside fences", () => {
	const text =
		"preamble\n## 2026-09-30\n```\n## 2026-10-01\n```\n## 2026-10-02\n- keep\n";
	const sections = journalSections(text);
	expect(sections.days.map(({ date }) => date)).toEqual([
		"2026-09-30",
		"2026-10-02",
	]);
	expect(
		sections.preamble + sections.days.map(({ body }) => body).join(""),
	).toBe(text);
});
