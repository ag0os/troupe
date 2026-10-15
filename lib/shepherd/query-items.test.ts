import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { currentItems, statusProjection } from "./query-items";
import { makeTree } from "./test-support";
import { closedDate } from "./text";

const LONG = `${"word ".repeat(80).trim()} end`;

const CURRENT = `Updated: 2026-10-13 17:26, forge-1013b

## Legend
- **NEXT**: agreed, start
- **ASK**: needs the user
- **WAITING**: blocked outside

**NEXT** in prose outside Items is not an entry.

## Items
- **NEXT** [shepherd-evals](work/in-progress/shepherd-evals/STATUS.md): forge order (2),
  the trials as a merge gate;
  agreed 17:41
- **ASK:** first colon form
- **WAITING**: second colon form
- **SCHEDULED**: third colon form
* **CANDIDATE** a small entry with no link: ${LONG}
- **ODD** (unknown word) see [notes](docs/notes.md)
**NEXT** a bold run without a bullet
\`\`\`
- **NEXT** fenced
\`\`\`
- plain bullet

### Detail inside Items
- **WAITING** (on review) [lock](work/todo/lock/STATUS.md)
- **ASK** [Evals item](./work/in-progress/shepherd-evals/STATUS.md): spelled with ./

## Live sessions
- **NEXT** outside again
`;

function lines(text: string, from: number, to: number): string {
	return text
		.split("\n")
		.slice(from - 1, to)
		.join("\n");
}

describe("currentItems", () => {
	test("takes exactly the Items entries, lossless", () => {
		const parsed = currentItems(CURRENT);

		expect(parsed.problems).toEqual([]);
		expect(parsed.updated).toBe("2026-10-13 17:26, forge-1013b");
		expect(parsed.section).toEqual({ line: 10, endLine: 28 });
		expect(
			parsed.items.map(({ word, known, line, endLine }) => ({
				word,
				known,
				line,
				endLine,
			})),
		).toEqual([
			{ word: "NEXT", known: true, line: 11, endLine: 13 },
			{ word: "ASK", known: true, line: 14, endLine: 14 },
			{ word: "WAITING", known: true, line: 15, endLine: 15 },
			{ word: "SCHEDULED", known: true, line: 16, endLine: 16 },
			{ word: "CANDIDATE", known: true, line: 17, endLine: 17 },
			{ word: "ODD", known: false, line: 18, endLine: 18 },
			{ word: "WAITING", known: true, line: 26, endLine: 26 },
			{ word: "ASK", known: true, line: 27, endLine: 27 },
		]);
		for (const item of parsed.items) {
			expect(item.raw).toBe(lines(CURRENT, item.line, item.endLine));
		}
	});

	test("projects text whole and takes slug and link from the STATUS link", () => {
		const [next, ask, , , candidate, odd, waiting, dotted] =
			currentItems(CURRENT).items;

		expect(next).toMatchObject({
			slug: "shepherd-evals",
			link: "work/in-progress/shepherd-evals/STATUS.md",
			text: "shepherd-evals: forge order (2), the trials as a merge gate; agreed 17:41",
		});
		expect(ask).toMatchObject({
			slug: null,
			link: null,
			text: "first colon form",
		});
		expect(candidate?.text).toBe(`a small entry with no link: ${LONG}`);
		expect(candidate?.text.length).toBeGreaterThan(400);
		expect(candidate?.slug).toBeNull();
		expect(odd).toMatchObject({
			slug: null,
			link: null,
			text: "(unknown word) see notes",
		});
		expect(waiting).toMatchObject({
			slug: "lock",
			link: "work/todo/lock/STATUS.md",
			text: "(on review) lock",
		});
		expect(dotted).toMatchObject({
			slug: "shepherd-evals",
			link: "./work/in-progress/shepherd-evals/STATUS.md",
			text: "Evals item: spelled with ./",
		});
	});

	test("takes the label as slug when the link is not a work item path", () => {
		const parsed = currentItems(
			"## Items\n- **NEXT** [evals](other/place/STATUS.md): x\n",
		);
		expect(parsed.items[0]).toMatchObject({
			slug: "evals",
			link: "other/place/STATUS.md",
		});
	});

	test("reports a missing Items section", () => {
		const parsed = currentItems("Updated: x\n\n- **NEXT** loose\n");
		expect(parsed.items).toEqual([]);
		expect(parsed.section).toBeNull();
		expect(parsed.problems.map(({ code }) => code)).toEqual([
			"items-section-missing",
		]);
	});

	test("reports an unclosed fence with its line", () => {
		const parsed = currentItems("## Items\n- **NEXT** a\n\n```\n- **ASK** b\n");
		expect(parsed.problems).toEqual([
			expect.objectContaining({ code: "fence-unclosed", line: 4 }),
		]);
	});

	test("reads noNext", () => {
		expect(currentItems("## Items\nNo NEXT is set.\n").noNext).toBeTrue();
		expect(currentItems(CURRENT).noNext).toBeFalse();
	});
});

const STATUS = `---
state: in-progress
opened: 2026-10-13
closed: 2026-10-13   # once done
blocked_on: "issue #42"
note: 'keep # this'
state: done
this is not a field
---
# lock: the lock item

Prose before the first section.

## What and origin
The origin.

### Detail
Nested text.
\`\`\`
## not a heading
\`\`\`

## State
Done.
`;

describe("statusProjection", () => {
	test("keeps the raw file and projects the supported frontmatter subset", () => {
		const projection = statusProjection(STATUS);

		expect(projection.raw).toBe(STATUS);
		expect(projection.lines).toBe(24);
		expect(projection.frontmatter?.raw).toBe(lines(STATUS, 2, 8));
		expect(projection.frontmatter?.fields).toEqual({
			state: "in-progress",
			opened: "2026-10-13",
			closed: "2026-10-13",
			blocked_on: "issue #42",
			note: "keep # this",
		});
		expect(projection.problems).toEqual([
			expect.objectContaining({ code: "frontmatter-duplicate-key", line: 7 }),
			expect.objectContaining({ code: "frontmatter-unsupported", line: 8 }),
		]);
	});

	test("agrees with closedDate on the documented closed form", () => {
		const fixture = makeTree({ "item/STATUS.md": STATUS });
		try {
			const closed = closedDate(join(fixture.root, "item"));
			expect(closed.approximate).toBeFalse();
			expect(closed.date.getDate()).toBe(13);
			expect(statusProjection(STATUS).frontmatter?.fields.closed).toBe(
				"2026-10-13",
			);
		} finally {
			fixture.cleanup();
		}
	});

	test("projects title, preamble and sections outside fences", () => {
		const projection = statusProjection(STATUS);

		expect(projection.title).toBe("lock: the lock item");
		expect(projection.preamble).toEqual({
			line: 11,
			endLine: 13,
			text: "Prose before the first section.",
		});
		expect(projection.sections).toEqual([
			{
				heading: "What and origin",
				level: 2,
				line: 14,
				endLine: 16,
				text: "The origin.",
			},
			{
				heading: "Detail",
				level: 3,
				line: 17,
				endLine: 22,
				text: "Nested text. ``` ## not a heading ```",
			},
			{ heading: "State", level: 2, line: 23, endLine: 24, text: "Done." },
		]);
	});

	test("projects a file without frontmatter and flags it", () => {
		const projection = statusProjection("# title\n\n## One\nx\n");
		expect(projection.frontmatter).toBeNull();
		expect(projection.title).toBe("title");
		expect(projection.sections.map(({ heading }) => heading)).toEqual(["One"]);
		expect(projection.problems.map(({ code }) => code)).toEqual([
			"status-no-frontmatter",
		]);
	});

	test("flags an unclosed fence", () => {
		const projection = statusProjection("---\na: b\n---\n# t\n```\n## x\n");
		expect(projection.problems).toEqual([
			expect.objectContaining({ code: "fence-unclosed", line: 5 }),
		]);
	});
});
