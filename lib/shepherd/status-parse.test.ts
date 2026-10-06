import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkWorkspace } from "./check";
import { DEFAULT_MARKS, DEFAULT_WINDOWS } from "./config";
import { listedSessions, noNext, statusItems } from "./status-parse";
import { makeTree } from "./test-support";
import { discoverTree } from "./tree";

describe("statusItems", () => {
	test("finds all five known words anywhere and detects no NEXT", () => {
		const text = `**NEXT**: first
## Notes
- **ASK** - second
**WAITING** (third)
* **SCHEDULED** fourth
**CANDIDATE**: fifth
No NEXT is set`;

		expect(statusItems(text).map(({ word }) => word)).toEqual([
			"NEXT",
			"ASK",
			"WAITING",
			"SCHEDULED",
			"CANDIDATE",
		]);
		expect(noNext(text)).toBeTrue();
	});

	test("skips only unique colon-form legend runs", () => {
		const legend = `- **NEXT**: what is next
- **ASK**: waiting on the user
- **WAITING**: waiting elsewhere`;
		expect(statusItems(legend)).toEqual([]);

		const items = Array.from(
			{ length: 8 },
			(_, index) => `- **NEXT** Work ${index + 1}`,
		).join("\n");
		expect(statusItems(items)).toHaveLength(8);
		expect(
			statusItems(`- **NEXT**: one\n- **ASK**: two\n- **NEXT**: three`),
		).toHaveLength(3);
	});

	test("scopes unknown words to Items but keeps known words elsewhere", () => {
		const items = statusItems(`- **BLOCKED**: outside
**NEXT**: outside known
## Items
- **CHECK**: inside
### Detail
* **PAUSED** waiting
## Notes
- **OTHER**: outside`);

		expect(
			items.map(({ word, known, line }) => ({ word, known, line })),
		).toEqual([
			{ word: "NEXT", known: true, line: 2 },
			{ word: "CHECK", known: false, line: 4 },
			{ word: "PAUSED", known: false, line: 6 },
		]);
	});

	test("detects an unknown word whose colon is inside the bold markers", () => {
		expect(statusItems("## Items\n- **BLOCKED:** needs access")).toEqual([
			{
				word: "BLOCKED",
				known: false,
				text: "needs access",
				line: 2,
			},
		]);
	});

	test("cleans links and bold markers and cuts text to 150 characters", () => {
		const long = "x".repeat(160);
		const items = statusItems(
			`- **NEXT**: Read [the plan](docs/plan.md)\n- **CHECK**: ${long}`,
		);

		expect(items[0]?.text).toBe("Read the plan");
		expect(items[1]?.text).toBe(`${"x".repeat(147)}...`);
		expect(items[1]?.text).toHaveLength(150);
	});

	test("reports unknown status words as findings", () => {
		const fixture = makeTree({
			"root/.shepherd/charter.md": "Charter",
			"root/.shepherd/CURRENT.md":
				"Updated: 2026-10-05\n## Items\n- **BLOCKED**: needs access",
		});
		try {
			const tree = discoverTree(join(fixture.root, "root"));
			const findings = checkWorkspace(
				tree.root,
				tree,
				{
					marks: { ...DEFAULT_MARKS },
					windows: { ...DEFAULT_WINDOWS },
					codex: {},
					problems: [],
				},
				new Date(2026, 9, 5),
			);
			expect(
				findings.find(({ code }) => code === "status-word-unknown"),
			).toEqual({
				level: "warn",
				code: "status-word-unknown",
				file: "CURRENT.md",
				line: 3,
				message: "unknown status word `BLOCKED`",
			});
		} finally {
			fixture.cleanup();
		}
	});
});

describe("listedSessions", () => {
	test("parses active and retired clauses and retired continuations", () => {
		const sessions = listedSessions(`## Live sessions
- forge-main-1 (took over; forge-old-1 retired)
- done-one ended
  done-two
## Notes
- ignored-one`);

		expect(sessions).toEqual([
			{
				name: "forge-main-1",
				line: 2,
				retired: false,
				subagent: false,
				codex: false,
			},
			{
				name: "forge-old-1",
				line: 2,
				retired: true,
				subagent: false,
				codex: false,
			},
			{
				name: "done-one",
				line: 3,
				retired: true,
				subagent: false,
				codex: false,
			},
			{
				name: "done-two",
				line: 4,
				retired: true,
				subagent: false,
				codex: false,
			},
		]);
	});

	test("marks subagent and Codex bullets", () => {
		expect(
			listedSessions(`### Live sessions
* agent-one subagent
* \`agent-two\` codex
* agent-three codex through claude`),
		).toEqual([
			{
				name: "agent-one",
				line: 2,
				retired: false,
				subagent: true,
				codex: false,
			},
			{
				name: "agent-two",
				line: 3,
				retired: false,
				subagent: false,
				codex: true,
			},
			{
				name: "agent-three",
				line: 4,
				retired: false,
				subagent: false,
				codex: false,
			},
		]);
	});
});
