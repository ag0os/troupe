import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkWorkspace, type Finding } from "./check";
import { checkWork } from "./check-work";
import {
	type Config,
	DEFAULT_HANDOFF_CEILINGS,
	DEFAULT_MARKS,
	DEFAULT_START,
	DEFAULT_WINDOWS,
} from "./config";
import { type MakeTreeOptions, makeTree } from "./test-support";
import { discoverTree } from "./tree";

const TODAY = new Date(2026, 9, 5);
const cleanFiles = {
	"root/.shepherd/charter.md": "A charter",
	"root/.shepherd/CURRENT.md": "Updated: 2026-10-05\nCurrent work",
};
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function config(overrides: Partial<Config> = {}): Config {
	return {
		marks: { ...DEFAULT_MARKS },
		windows: { ...DEFAULT_WINDOWS },
		start: { ...DEFAULT_START },
		handoffCeilings: { ...DEFAULT_HANDOFF_CEILINGS },
		codex: {},
		problems: [],
		...overrides,
	};
}

function fixture(
	files: Record<string, string> = {},
	options: MakeTreeOptions = {},
) {
	const result = makeTree({ ...cleanFiles, ...files }, options);
	cleanups.push(result.cleanup);
	const tree = discoverTree(join(result.root, "root"));
	return { tree, workspace: tree.root };
}

function finding(findings: Finding[], code: string): Finding {
	const match = findings.find((candidate) => candidate.code === code);
	if (!match) throw new Error(`missing ${code}: ${JSON.stringify(findings)}`);
	return match;
}

describe("checkWork", () => {
	test("reports item-duplicate", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/todo/release/STATUS.md": "---\nstate: todo\n---",
			"root/.shepherd/work/in-progress/release/STATUS.md":
				"---\nstate: in-progress\n---",
		});

		expect(
			finding(checkWork(workspace, config(), TODAY), "item-duplicate"),
		).toEqual({
			level: "error",
			code: "item-duplicate",
			file: "work/in-progress/release",
			message: "also exists in work/todo/",
		});
	});

	test("reports item-no-status", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/todo/release/note.txt": "No status",
		});

		expect(
			finding(checkWork(workspace, config(), TODAY), "item-no-status"),
		).toMatchObject({
			level: "warn",
			file: "work/todo/release",
			message: "work item has no STATUS.md",
		});
	});

	test("reports item-no-state", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/todo/release/STATUS.md": "# Release",
		});

		expect(
			finding(checkWork(workspace, config(), TODAY), "item-no-state"),
		).toMatchObject({
			level: "info",
			file: "work/todo/release/STATUS.md",
		});
	});

	test("reports item-state-mismatch using the first state word", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/todo/release/STATUS.md":
				"---\nstate: in-progress (active)\n---",
		});

		expect(
			finding(checkWork(workspace, config(), TODAY), "item-state-mismatch"),
		).toMatchObject({
			level: "error",
			message:
				"frontmatter says `in-progress (active)` but the item is in work/todo/",
		});
	});

	test("reports item-no-closed", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/done/release/STATUS.md": "---\nstate: done\n---",
		});

		expect(
			finding(checkWork(workspace, config(), TODAY), "item-no-closed"),
		).toMatchObject({
			level: "info",
			file: "work/done/release/STATUS.md",
			message: "done without a `closed:` date",
		});
	});

	test("reports item-archive-due only after the configured day window", () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = "America/Argentina/Buenos_Aires";
		try {
			const { workspace } = fixture({
				"root/.shepherd/work/done/release/STATUS.md":
					"---\nstate: done\nclosed: 2026-09-05\n---",
			});
			const onDayThirty = checkWork(workspace, config(), new Date(2026, 9, 5));
			const onDayThirtyOne = checkWork(
				workspace,
				config(),
				new Date(2026, 9, 6),
			);

			expect(
				onDayThirty.some(({ code }) => code === "item-archive-due"),
			).toBeFalse();
			expect(finding(onDayThirtyOne, "item-archive-due")).toMatchObject({
				level: "warn",
				message: "closed 31 days ago; archive it (shepherd tool archive)",
			});
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	test("reports item-unlisted for live work absent from CURRENT", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/in-progress/release/STATUS.md":
				"---\nstate: in-progress\n---",
		});

		expect(
			finding(checkWork(workspace, config(), TODAY), "item-unlisted"),
		).toEqual({
			level: "warn",
			code: "item-unlisted",
			file: "CURRENT.md",
			message: "work/in-progress/release is not mentioned in CURRENT.md",
		});
	});

	test("reports archive-index-missing", () => {
		const { workspace } = fixture({
			"root/.shepherd/archive/2026-09/release/STATUS.md": "Archived",
		});

		expect(
			finding(checkWork(workspace, config(), TODAY), "archive-index-missing"),
		).toEqual({
			level: "warn",
			code: "archive-index-missing",
			file: "archive/INDEX.md",
			message: "1 archived items but no archive/INDEX.md",
		});
	});

	test("reports archive-unlisted and accepts a link to an item file", () => {
		const { workspace } = fixture({
			"root/.shepherd/archive/INDEX.md": "[Listed](2026-09/listed/STATUS.md)",
			"root/.shepherd/archive/2026-09/listed/STATUS.md": "Listed",
			"root/.shepherd/archive/2026-09/missing/STATUS.md": "Missing",
		});
		const findings = checkWork(workspace, config(), TODAY).filter(
			({ code }) => code === "archive-unlisted",
		);

		expect(findings).toEqual([
			{
				level: "warn",
				code: "archive-unlisted",
				file: "archive/2026-09/missing",
				message: "not listed in archive/INDEX.md",
			},
		]);
	});

	test("keeps malformed percent escapes literal in the archive index", () => {
		const { workspace } = fixture({
			"root/.shepherd/archive/INDEX.md": "[Listed](2026-09/bad%ZZ/STATUS.md)",
			"root/.shepherd/archive/2026-09/bad%ZZ/STATUS.md": "Listed",
		});

		expect(
			checkWork(workspace, config(), TODAY).filter(
				({ code }) => code === "archive-unlisted",
			),
		).toEqual([]);
	});

	test("skips a stray archive month file", () => {
		const { workspace } = fixture({
			"root/.shepherd/archive/2026-09": "not a directory",
		});

		expect(() => checkWork(workspace, config(), TODAY)).not.toThrow();
	});

	test("reports journal-rotation-due for sections before the local month", () => {
		const { workspace } = fixture({
			"root/.shepherd/journal.md":
				"# Journal\n\n## 2026-09-30\n- Old\n\n## 2026-10-01\n- Current",
		});

		expect(
			finding(checkWork(workspace, config(), TODAY), "journal-rotation-due"),
		).toMatchObject({
			level: "warn",
			message:
				"1 day sections from before 2026-10; rotate them to archive/journal/ (shepherd tool archive)",
		});
	});

	test("reports journal-misfiled with the first bullet line", () => {
		const { workspace } = fixture({
			"root/.shepherd/journal.md":
				"# Journal\n\n## 2026-10-03\n- 2026-10-04 Later\n- **2026-10-05** Also later",
		});

		expect(
			finding(checkWork(workspace, config(), TODAY), "journal-misfiled"),
		).toEqual({
			level: "info",
			code: "journal-misfiled",
			file: "journal.md",
			line: 4,
			message:
				"2 bullets dated later than the heading they sit under (one heading per day)",
		});
	});

	test("reports outbox-item for Markdown files other than README", () => {
		const { workspace } = fixture({
			"root/.shepherd/outbox/README.md": "About",
			"root/.shepherd/outbox/note.md": "For the master",
			"root/.shepherd/outbox/note.txt": "Ignored",
		});

		expect(
			finding(checkWork(workspace, config(), TODAY), "outbox-item"),
		).toEqual({
			level: "info",
			code: "outbox-item",
			file: "outbox/note.md",
			message: "outbox item waiting for the master",
		});
	});

	test("checkWorkspace includes work findings", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/outbox/note.md": "For the master",
		});

		expect(
			finding(checkWorkspace(workspace, tree, config(), TODAY), "outbox-item"),
		).toMatchObject({ file: "outbox/note.md" });
	});
});

describe("staged work findings", () => {
	test("journal-time-backwards counts slips per heading beyond five minutes", () => {
		const { workspace } = fixture({
			"root/.shepherd/journal.md":
				"## 2026-10-05\n- 10:20 First\n- 10:17 Small step\n- 10:11 Slip\n- 10:05 Slip\n## 2026-10-06\n- 09:00 Reset\n- 08:57 Small step",
		});
		expect(
			checkWork(workspace, config(), TODAY).filter(
				({ code }) => code === "journal-time-backwards",
			),
		).toEqual([
			{
				level: "warn",
				code: "journal-time-backwards",
				file: "journal.md",
				line: 4,
				message:
					"2 time steps backwards by more than 5 minutes under 2026-10-05",
			},
		]);
	});

	test("journal-heading-duplicate reports the first heading only for repeated dates", () => {
		for (const duplicate of [true, false]) {
			const { workspace } = fixture({
				"root/.shepherd/journal.md": `## 2026-10-05\n- Entry\n## 2026-10-0${duplicate ? "5" : "6"}\n- Entry`,
			});
			const matches = checkWork(workspace, config(), TODAY).filter(
				({ code }) => code === "journal-heading-duplicate",
			);
			expect(matches).toHaveLength(duplicate ? 1 : 0);
			if (duplicate)
				expect(matches[0]).toMatchObject({
					level: "warn",
					file: "journal.md",
					line: 1,
				});
		}
	});

	test("journal-heading-order reports an earlier heading and ignores ordered headings", () => {
		for (const earlier of [true, false]) {
			const { workspace } = fixture({
				"root/.shepherd/journal.md": `## 2026-10-05\n- Entry\n## 2026-10-0${earlier ? "4" : "6"}\n- Entry`,
			});
			const matches = checkWork(workspace, config(), TODAY).filter(
				({ code }) => code === "journal-heading-order",
			);
			expect(matches).toHaveLength(earlier ? 1 : 0);
			if (earlier)
				expect(matches[0]).toMatchObject({
					level: "warn",
					file: "journal.md",
					line: 3,
				});
		}
	});

	test("journal-orphans reports pre-heading bullets and ignores fenced and headed bullets", () => {
		for (const orphan of [true, false]) {
			const { workspace } = fixture({
				"root/.shepherd/journal.md": `# Journal\n${orphan ? "- Orphan" : "Prose"}\n\`\`\`\n- Fenced\n\`\`\`\n## 2026-10-05\n- Entry`,
			});
			const matches = checkWork(workspace, config(), TODAY).filter(
				({ code }) => code === "journal-orphans",
			);
			expect(matches).toHaveLength(orphan ? 1 : 0);
			if (orphan)
				expect(matches[0]).toMatchObject({
					level: "warn",
					file: "journal.md",
					line: 2,
				});
		}
	});

	test("journal diagnostics apply only to journal.md", () => {
		const { workspace } = fixture({
			"root/.shepherd/archive/journal/2026-09.md":
				"- Orphan\n## 2026-09-02\n- 10:20 First\n- 10:00 Slip\n## 2026-09-01\n## 2026-09-01",
		});
		expect(
			checkWork(workspace, config(), TODAY).filter(({ code }) =>
				[
					"journal-time-backwards",
					"journal-heading-duplicate",
					"journal-heading-order",
					"journal-orphans",
				].includes(code),
			),
		).toEqual([]);
	});

	test("report-no-discoveries checks direct live item reports outside fences even without STATUS", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/todo/release/T9-report.md":
				"```\n## Discoveries\n```",
			"root/.shepherd/work/in-progress/build/report.md": "## Discoveries\nnone",
			"root/.shepherd/work/in-progress/build/other-report.md": "# Report",
			"root/.shepherd/work/in-progress/build/nested/report.md": "# Nested",
			"root/.shepherd/work/done/old/report.md": "# Done",
			"root/.shepherd/work/todo/release/notes.md": "# Notes",
		});
		expect(
			checkWork(workspace, config(), TODAY)
				.filter(({ code }) => code === "report-no-discoveries")
				.map(({ file }) => file),
		).toEqual([
			"work/todo/release/T9-report.md",
			"work/in-progress/build/other-report.md",
		]);
	});

	test("pending-stale respects the configured window edge and ignores fenced bullets", () => {
		const { workspace } = fixture({
			"root/.shepherd/pending.md":
				"- 2026-09-20 Old\n- 2026-09-21 Edge\n```\n- 2026-09-01 Fenced\n```",
		});
		const matches = checkWork(workspace, config(), TODAY).filter(
			({ code }) => code === "pending-stale",
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]).toMatchObject({
			level: "warn",
			file: "pending.md",
			line: 1,
		});
		expect(
			checkWork(
				workspace,
				config({ windows: { ...DEFAULT_WINDOWS, pendingDays: 15 } }),
				TODAY,
			).filter(({ code }) => code === "pending-stale"),
		).toEqual([]);
	});

	test("pending-no-date reports only undated top-level prose bullets", () => {
		const { workspace } = fixture({
			"root/.shepherd/pending.md":
				"- Needs date\n- 2026-10-05 Dated\n  - Nested\n```\n- Fenced\n```",
		});
		expect(
			checkWork(workspace, config(), TODAY).filter(
				({ code }) => code === "pending-no-date",
			),
		).toEqual([
			{
				level: "info",
				code: "pending-no-date",
				file: "pending.md",
				line: 1,
				message: "pending bullet needs a leading YYYY-MM-DD",
			},
		]);
	});
});

test("report-no-discoveries accepts closing hashes and trailing whitespace", () => {
	const { workspace } = fixture({
		"root/.shepherd/work/todo/release/closing-report.md": "## Discoveries ##",
		"root/.shepherd/work/todo/release/spaces-report.md": "## Discoveries   \t",
		"root/.shepherd/work/todo/release/both-report.md": "## Discoveries ### \t",
		"root/.shepherd/work/todo/release/not-heading-report.md":
			"## Discoveries ## extra",
	});
	expect(
		checkWork(workspace, config(), TODAY)
			.filter(({ code }) => code === "report-no-discoveries")
			.map(({ file }) => file),
	).toEqual(["work/todo/release/not-heading-report.md"]);
});

test("warns about unclosed fences in current and archived journals with opening lines", () => {
	const { workspace } = fixture({
		"root/.shepherd/journal.md": "# Journal\n## 2026-10-05\n```\noutput\n",
		"root/.shepherd/archive/journal/2026-09.md":
			"# Journal\n~~~~\n```\noutput\n",
	});
	const findings = checkWork(workspace, config(), TODAY).filter(
		({ code }) => code === "journal-fence-unclosed",
	);
	expect(
		findings.map(({ file, line, level }) => ({ file, line, level })),
	).toEqual([
		{ file: "archive/journal/2026-09.md", line: 2, level: "warn" },
		{ file: "journal.md", line: 3, level: "warn" },
	]);
	for (const finding of findings)
		expect(finding.message).toContain(
			`fence opened at line ${finding.line} is never closed; close or remove it`,
		);
});
