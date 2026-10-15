import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkWorkspace } from "./check";
import {
	DEFAULT_HANDOFF_CEILINGS,
	DEFAULT_MARKS,
	DEFAULT_START,
	DEFAULT_WINDOWS,
} from "./config";
import { statusItems } from "./query-items";
import { listedSessions, noNext } from "./status-parse";
import { makeTree, OFF_SHAPE_CURRENT } from "./test-support";
import { discoverTree } from "./tree";

describe("statusItems", () => {
	test("is the query's entry shape: off-shape entries are skipped", () => {
		expect(
			statusItems(OFF_SHAPE_CURRENT).map(({ word, known, line }) => ({
				word,
				known,
				line,
			})),
		).toEqual([
			{ word: "NEXT", known: true, line: 7 },
			{ word: "CANDIDATE", known: true, line: 10 },
			{ word: "BLOCKED", known: false, line: 11 },
		]);
	});

	test("warns on off-shape entries and keeps the unknown word finding", () => {
		const fixture = makeTree({
			"root/.shepherd/charter.md": "Charter",
			"root/.shepherd/CURRENT.md": OFF_SHAPE_CURRENT,
		});
		try {
			const tree = discoverTree(join(fixture.root, "root"));
			const findings = checkWorkspace(
				tree.root,
				tree,
				{
					marks: { ...DEFAULT_MARKS },
					windows: { ...DEFAULT_WINDOWS },
					start: { ...DEFAULT_START },
					handoffCeilings: { ...DEFAULT_HANDOFF_CEILINGS },
					codex: {},
					problems: [],
				},
				new Date(2026, 9, 15),
			);
			expect(
				findings
					.filter(({ code }) => code.startsWith("status-"))
					.map(({ level, code, line }) => ({ level, code, line })),
			).toEqual([
				{ level: "warn", code: "status-entry-off-shape", line: 8 },
				{ level: "warn", code: "status-entry-off-shape", line: 9 },
				{ level: "warn", code: "status-word-unknown", line: 11 },
			]);
			expect(
				findings.find(({ code }) => code === "status-entry-off-shape")?.message,
			).toBe(
				'entry starts with **ASK: consulting**; core\'s shape is "- **WORD** text"; query items skips it',
			);
		} finally {
			fixture.cleanup();
		}
	});

	test("warns when CURRENT has no Items section", () => {
		const fixture = makeTree({
			"root/.shepherd/charter.md": "Charter",
			"root/.shepherd/CURRENT.md": "Updated: 2026-10-15\n- **NEXT** loose\n",
		});
		try {
			const tree = discoverTree(join(fixture.root, "root"));
			const findings = checkWorkspace(
				tree.root,
				tree,
				{
					marks: { ...DEFAULT_MARKS },
					windows: { ...DEFAULT_WINDOWS },
					start: { ...DEFAULT_START },
					handoffCeilings: { ...DEFAULT_HANDOFF_CEILINGS },
					codex: {},
					problems: [],
				},
				new Date(2026, 9, 15),
			);
			expect(statusItems("Updated: 2026-10-15\n- **NEXT** loose\n")).toEqual(
				[],
			);
			expect(
				findings.find(({ code }) => code === "items-section-missing"),
			).toMatchObject({ level: "warn", file: "CURRENT.md" });
		} finally {
			fixture.cleanup();
		}
	});

	test("finds all five known words in Items and detects no NEXT", () => {
		const text = `**NEXT**: outside Items is prose
## Items
- **NEXT**: first
- **ASK** - second
- **WAITING** (third)
* **SCHEDULED** fourth
- **CANDIDATE**: fifth
## Notes
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

	test("counts a legend only inside Items", () => {
		const legend = `## Legend
- **NEXT**: what is next
- **ASK**: waiting on the user
- **WAITING**: waiting elsewhere`;
		expect(statusItems(legend)).toEqual([]);
		expect(
			statusItems(
				`## Items\n- **NEXT**: one\n- **ASK**: two\n- **NEXT**: three`,
			),
		).toHaveLength(3);
	});

	test("takes known and unknown words from Items only", () => {
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
			`## Items\n- **NEXT**: Read [the plan](docs/plan.md)\n- **CHECK**: ${long}`,
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
					start: { ...DEFAULT_START },
					handoffCeilings: { ...DEFAULT_HANDOFF_CEILINGS },
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
