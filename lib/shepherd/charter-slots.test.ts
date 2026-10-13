import { expect, test } from "bun:test";
import { CORE_SLOTS, parseCharter } from "./charter-slots";

test("canonical slots preserve multiline source, indentation, blank lines and None", () => {
	const raw =
		"## Way of working\r\nOrdinary prose.\r\n  * **software.grants:** Push.\r\n\r\n    Continue.\r\n  Stop.\r\n- **software.plans**: None\r\n- software.empty:   \r\n";
	const { slots } = parseCharter(raw, ["software"]);
	expect(slots.filter((s) => s.kind === "module")).toMatchObject([
		{
			key: "software.grants",
			line: 3,
			value: " Push.\r\n\r\n    Continue.\r\n",
			source: "  * **software.grants:** Push.\r\n\r\n    Continue.\r\n",
		},
		{ key: "software.plans", line: 7, value: " None\r\n" },
		{ key: "software.empty", line: 8, value: "   \r\n" },
	]);
	expect(slots[0]?.value).toBe("Ordinary prose.\r\n  Stop.\r\n");
});

test("eight case-insensitive level-two headings register optional core slots and duplicates", () => {
	const headings = Object.keys(CORE_SLOTS);
	expect(headings).toHaveLength(8);
	expect(Object.values(CORE_SLOTS)).toContain("core.what-lives-where");
	const { slots } = parseCharter(
		`${headings.map((h) => `## ${h.toUpperCase()}\nvalue\n`).join("")}## DONE\n\n## Notes\nother\n`,
	);
	expect(slots.filter((s) => s.kind === "core")).toHaveLength(9);
	expect(slots.filter((s) => s.key === "core.done")).toHaveLength(2);
	expect(slots.at(-1)?.value.trim()).toBe("");
});

test("case-sensitive keys, fences, blockquotes, Grants prose and core bullets", () => {
	const { slots, blocks } = parseCharter(
		"```md\n- software.hidden: code\n## Done\n```\n~~~\n- software.hidden: code\n~~~\n> - software.hidden: quote\n> ## Done\n- Software.grants: uppercase\n- Grants (software module, step 1): Push branches.\n- core.done: None\n- software.grants: None.\n- software.grants:\n",
		["software"],
	);
	expect(slots.map((s) => [s.key, s.line])).toEqual([
		["core.done", 12],
		["software.grants", 13],
		["software.grants", 14],
	]);
	expect(slots.every((s) => s.kind === "module")).toBe(true);
	expect(blocks.map((b) => b.source).join("")).toContain(
		"Grants (software module, step 1)",
	);
});

test("core headings end at unknown level-two headings and slots cannot satisfy them", () => {
	const { slots } = parseCharter(
		"## Done\n- core.done: None\n- software.plans: here\n  continuation\n\n## Notes\nOther\n### Mission\nOther\n",
		["software"],
	);
	expect(slots[0]).toMatchObject({ key: "core.done", kind: "core", line: 1 });
	expect(slots[0]?.value.trim()).toBe("");
});

test("complete list items retain nested lists and headings require separated closing markers", () => {
	const raw =
		"## Done#\nText\n\n- Parent text\n  * Nested text\n\n  Continued text\n- Next item\n\n## Done ###\nNone\n";
	const parsed = parseCharter(raw);
	expect(parsed.slots).toMatchObject([
		{ key: "core.done", line: 10, value: "None\n" },
	]);
	expect(parsed.blocks[1]?.source).toBe(
		"- Parent text\n  * Nested text\n\n  Continued text\n",
	);
});

test("unrecognized dotted bullets remain core prose and restatement blocks", () => {
	const raw =
		"## Structure\n- package.json: scripts\n- biome.json: formatting\n- package.json: more scripts\n- index.ts: entry\n";
	const parsed = parseCharter(raw, ["software"]);
	expect(parsed.slots).toHaveLength(1);
	expect(parsed.slots[0]?.value).toBe(raw.slice("## Structure\n".length));
	expect(parsed.blocks.map((b) => b.source)).toEqual([
		"- package.json: scripts\n",
		"- biome.json: formatting\n",
		"- package.json: more scripts\n",
		"- index.ts: entry\n",
	]);
});

test("level-two headings use at most three spaces and empty headings end core values", () => {
	const parsed = parseCharter(
		"## Mission\nValue\n    ## Done\nStill mission\n# Top\nStill mission\n   ## \t\nExcluded\n  ## Done\nNone\n##\nExcluded too\n",
	);
	expect(
		parsed.slots.map((s) => ({ key: s.key, line: s.line, value: s.value })),
	).toEqual([
		{
			key: "core.mission",
			line: 1,
			value: "Value\n    ## Done\nStill mission\n# Top\nStill mission\n",
		},
		{ key: "core.done", line: 9, value: "None\n" },
	]);
});

test("four-space level-two text remains in restatement prose blocks", () => {
	const raw = "    ## Done\nOrdinary text\n";
	expect(parseCharter(raw).blocks).toEqual([{ source: raw, line: 1 }]);
});

test("all heading levels require zero to three spaces at restatement boundaries", () => {
	for (let level = 1; level <= 6; level++) {
		const marker = "#".repeat(level);
		for (const indentation of ["    ", "\t"]) {
			const raw = `para one\n${indentation}${marker} title\nmore\n`;
			expect(parseCharter(raw).blocks).toEqual([{ source: raw, line: 1 }]);
		}
		for (const indentation of ["", " ", "  ", "   "]) {
			const raw = `para one\n${indentation}${marker} title\nmore\n`;
			expect(parseCharter(raw).blocks).toEqual([
				{ source: "para one\n", line: 1 },
				{ source: "more\n", line: 3 },
			]);
		}
	}
});

test.each([
	[
		"four-backtick close",
		"````\n```\n- software.hidden: code\n````\n- software.value: visible\n",
		[5],
		[" visible\n"],
	],
	[
		"fence marker mismatch",
		"```\n~~~\n- software.hidden: code\n```\n- software.value: visible\n",
		[5],
		[" visible\n"],
	],
	[
		"backtick info containing backtick",
		"```bad`info\n- software.value: visible\n",
		[2],
		[" visible\n"],
	],
	[
		"tilde info containing backticks",
		"~~~ `info`\n- software.hidden: code\n~~~\n- software.value: visible\n",
		[4],
		[" visible\n"],
	],
	[
		"indented fence in list",
		"- Ordinary item\n  ```\n  - software.hidden: code\n  ```\n- software.value: visible\n",
		[5],
		[" visible\n"],
	],
	["unclosed fence", "~~~\n- software.hidden: code\n", [], []],
	[
		"tab columns",
		"  \t- software.value: first\n    sibling at equal columns\n- software.other: next\n",
		[1, 3],
		[" first\n", " next\n"],
	],
	[
		"less-indented sibling",
		"    - software.value: first\n      continuation\n  - software.other: next\n",
		[1, 3],
		[" first\n      continuation\n", " next\n"],
	],
] as const)(
	"fence and indentation table: %s",
	(_, raw, expectedLines, expectedValues) => {
		const parsed = parseCharter(raw, ["software"]);
		expect(parsed.slots.map((s) => s.line)).toEqual([...expectedLines]);
		expect(parsed.slots.map((s) => s.value)).toEqual([...expectedValues]);
	},
);
