import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayOf, monthOf } from "./dates";
import {
	closedDate,
	frontmatter,
	journalSections,
	mdFiles,
	proseLines,
	summaryLine,
	walk,
	words,
	wordsIn,
} from "./text";

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
