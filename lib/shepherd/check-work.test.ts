import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkWorkspace, type Finding } from "./check";
import { checkWork, itemRecord } from "./check-work";
import {
	type Config,
	DEFAULT_HANDOFF_CEILINGS,
	DEFAULT_MARKS,
	DEFAULT_START,
	DEFAULT_WINDOWS,
} from "./config";
import { moduleCatalog, resolveModules } from "./module-resolution";
import { type MakeTreeOptions, makeTree, packageText } from "./test-support";
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

describe("record rules", () => {
	const software = { "root/.shepherd/charter.md": "Modules: software\n" };
	const done = (outcome: string) =>
		`---\nstate: done\nclosed: 2026-10-14\n---\n# Item\n\n## Outcome\n${outcome}\n`;
	const records = (files: Record<string, string>, charter = software) =>
		checkWork(fixture({ ...charter, ...files }).workspace, config(), TODAY)
			.filter(({ code }) => code.startsWith("record-"))
			.map(({ level, code, file, message }) => ({
				level,
				code,
				file,
				message,
			}));
	const codes = (files: Record<string, string>, charter = software) =>
		records(files, charter).map(({ code }) => code);
	const item = "root/.shepherd/work/done/consulting";
	const live = "root/.shepherd/work/in-progress/consulting";

	test("record-note-missing names a done item's PR when no note sits in its directory", () => {
		expect(
			records({
				[`${item}/STATUS.md`]: done(
					"Merged as #23 (2026-10-14). Measurement note: below.",
				),
				[`${item}/notes.md`]: "# Notes",
				[`${item}/gate.log`]: "ok",
			}),
		).toEqual([
			{
				level: "warn",
				code: "record-note-missing",
				file: "work/done/consulting",
				message: "done item consulting names PR #23 and has no measurements.md",
			},
		]);
		expect(
			records({
				[`${item}/STATUS.md`]: done("Fast-forwarded to main at 88a6e379."),
			}),
		).toMatchObject([
			{
				code: "record-note-missing",
				message:
					"done item consulting names merge 88a6e379 and has no measurements.md",
			},
		]);
	});

	test("each note name form counts as the measurement note", () => {
		for (const name of ["measurements.md", "t3-measurements.md"])
			expect(
				codes({
					[`${item}/STATUS.md`]: done("Merged as #23."),
					[`${item}/${name}`]: "# Measurements",
					[`${item}/gate.log`]: "ok",
				}),
			).toEqual([]);
		for (const name of ["measurement.md", "notes-measurements.md"])
			expect(
				codes({
					[`${item}/STATUS.md`]: done("Merged as #23."),
					[`${item}/${name}`]: "# Measurements",
					[`${item}/gate.log`]: "ok",
				}),
			).toEqual(["record-note-missing"]);
	});

	test("record-logs-missing names a note without a raw log beside it", () => {
		expect(
			records({
				[`${item}/STATUS.md`]: done("Merged as #23."),
				[`${item}/measurements.md`]: "# Measurements",
				[`${item}/build-report.md`]: "## Discoveries\nnone",
				[`${item}/brief.md`]: "# Brief",
				[`${item}/logs.md`]: "# Not a log directory",
			}),
		).toEqual([
			{
				level: "warn",
				code: "record-logs-missing",
				file: "work/done/consulting",
				message:
					"done item consulting has a measurement note and no raw log beside it",
			},
		]);
	});

	test("each raw log form counts", () => {
		for (const log of [
			"gate-1.log",
			"fix1-api-red.log",
			"deep/er/session.jsonl",
			"ci-gate/logs/output.txt",
			"repo-layer/logs/run",
			"runs/attempt-1.md",
		])
			expect(
				codes({
					[`${item}/STATUS.md`]: done("Merged as #23."),
					[`${item}/measurements.md`]: "# Measurements",
					[`${item}/${log}`]: "output",
				}),
			).toEqual([]);
	});

	test("scope: items naming no PR or merge, in-progress items, undeclared software and CURRENT entries are out", () => {
		expect(
			codes({
				[`${item}/STATUS.md`]: done("Charter agreed; Q and A answered."),
				"root/.shepherd/CURRENT.md":
					"Updated: 2026-10-05\n## Items\n- **DONE** small fix, PR #9 merged",
			}),
		).toEqual([]);
		expect(
			codes({
				[`${live}/STATUS.md`]:
					"---\nstate: in-progress\n---\n# Item\nPR #23 open.",
			}),
		).toEqual([]);
		expect(
			codes({
				[`${item}/STATUS.md`]: "# Item\n\n## Outcome\nMerged as #23.",
			}),
		).toEqual([]);
		expect(
			codes(
				{ [`${item}/STATUS.md`]: done("Merged as #23.") },
				{ "root/.shepherd/charter.md": "Modules: craft\n" },
			),
		).toEqual([]);
		expect(
			codes(
				{ [`${item}/STATUS.md`]: done("Merged as #23.") },
				{ "root/.shepherd/charter.md": "A charter about software\n" },
			),
		).toEqual([]);
	});

	test("checkWorkspace reports the record rules", () => {
		const { workspace, tree } = fixture({
			...software,
			[`${item}/STATUS.md`]: done("Merged as #23."),
		});
		expect(
			checkWorkspace(workspace, tree, config(), TODAY)
				.filter(({ code }) => code.startsWith("record-"))
				.map(({ code }) => code),
		).toEqual(["record-note-missing"]);
	});

	test("itemRecord extracts PR numbers, merge SHAs and the repo", () => {
		expect(
			itemRecord(
				"---\nstate: done\n---\nPR #3, pull request #4 and PR#5; merged as #6, landed as #7, shipped as #8, issue #99.\nSee https://github.com/ag0os/troupe/pull/6.\n\n## Outcome\nMerged as #6 on 2026-10-14.",
				[
					"# Note\nRepo: `insurance_app`\nMerged 1a2b3c4d, merge commit `88A6E379`, main at b300d88; merged deadbee; merged as #3.\n",
				],
			),
		).toEqual({
			prs: [3, 4, 5, 6, 7, 8],
			shas: ["1a2b3c4d", "88a6e379", "b300d88", "deadbee"],
			repo: "insurance_app",
			done: true,
			outcome: "Merged as #6 on 2026-10-14.",
		});
		expect(
			itemRecord(
				"# Item\nOpened PR #18: https://github.com/ag0os/troupe/pull/18",
				[],
			),
		).toEqual({ prs: [18], shas: [], repo: "ag0os/troupe", done: false });
	});

	const stale = (head: string, outcome = "Merged as #23 (2026-10-14).") =>
		records({
			[`${item}/STATUS.md`]: done(outcome),
			[`${item}/measurements.md`]: `# Consulting page\n\n${head}\n\n## 1. Task\nText.\n`,
			[`${item}/gate.log`]: "ok",
		});

	test("record-note-stale names a note that says not landed against a STATUS that says merged", () => {
		expect(stale("- **Status:** attempted, not landed.")).toEqual([
			{
				level: "warn",
				code: "record-note-stale",
				file: "work/done/consulting/measurements.md",
				message:
					'consulting/measurements.md says "not landed"; STATUS says "Merged as #23"',
			},
		]);
	});

	test("each not-landed phrase is recognized after a Status label or in the head", () => {
		const dash = String.fromCodePoint(0x2014);
		const ellipsis = String.fromCodePoint(0x2026);
		for (const head of [
			"Status: attempted, not landed",
			"status: parked for permission to push",
			`status: ${ellipsis} parked for permission to push`,
			"STATUS: Blocked on review",
			"- **Status:** abandoned.",
			`Status ${dash} parked`,
			`Status: attempted ${dash} not landed`,
			"No merge commit or PR yet.",
			"The branch is not pushed.",
			"Built and measured but not landed.",
		])
			expect(stale(head).map(({ code }) => code)).toEqual([
				"record-note-stale",
			]);
		for (const head of [
			"Status: landed.",
			"Status: unblocked, then merged.",
			"The parked branch was blocked, then abandoned for a rebuild.",
			"status: landed (PR #74 merged 2026-10-19 as 88a6e379, deploy checked; was parked for push permission)",
			"Status: merged as #74; was blocked on review, then parked",
			"Status: merged 88a6e379 after being parked",
		])
			expect(stale(head)).toEqual([]);
		expect(stale("Status: not landed, parked").map(({ code }) => code)).toEqual(
			["record-note-stale"],
		);
	});

	test("free phrases count only in the head and labels only in the first 40 lines", () => {
		expect(
			records({
				[`${item}/STATUS.md`]: done("Merged as #23 (2026-10-14)."),
				[`${item}/measurements.md`]:
					"# Note\n\nLanded.\n\n## 1. Task\nThe first try was not landed.\n",
				[`${item}/gate.log`]: "ok",
			}),
		).toEqual([]);
		for (const [line, expected] of [
			[40, ["record-note-stale"]],
			[41, []],
		] as const)
			expect(
				records({
					[`${item}/STATUS.md`]: done("Merged as #23 (2026-10-14)."),
					[`${item}/measurements.md`]: `# Note\n\n## 1. Task\n${"Text.\n".repeat(line - 4)}Status: parked\n`,
					[`${item}/gate.log`]: "ok",
				}).map(({ code }) => code),
			).toEqual([...expected]);
		expect(
			records({
				[`${item}/STATUS.md`]: done("Merged as #23 (2026-10-14)."),
				[`${item}/measurements.md`]: "# Note\n\n## 1. Task\nStatus: parked\n",
				[`${item}/gate.log`]: "ok",
			}).map(({ code }) => code),
		).toEqual(["record-note-stale"]);
	});

	test("each landed form in STATUS's Outcome is recognized", () => {
		for (const [outcome, says] of [
			["Merged as #23 (2026-10-14).", "Merged as #23"],
			["Landed as #23.", "Landed as #23"],
			["Merged 88a6e379.", "Merged 88a6e379"],
			["Merge commit `88a6e379`.", "Merge commit `88a6e379`"],
			["Fast-forwarded to main at b300d88.", "Fast-forwarded to main"],
			["Fast-forwarded to main; PR #23.", "Fast-forwarded to main"],
			["Live at b300d88 since PR #23.", "Live at b300d88"],
			["Review is not done yet. Merged as #23.", "Merged as #23"],
			["Review is not done\n\nMerged as #23.", "Merged as #23"],
			["- Review not done\n- Merged as #23", "Merged as #23"],
		])
			expect(
				stale("Status: parked", outcome).map(({ message }) => message),
			).toEqual([
				`consulting/measurements.md says "parked"; STATUS says "${says}"`,
			]);
		for (const outcome of [
			"Not merged; the PR #23 stays open.",
			"Live behind a flag, PR #23.",
			"Parked; PR #23 open.",
			"PR #23 merged.",
			"Shipped as #23, 2026-10-14.",
			"PR #23 is not yet merged.",
			"PR #23 merged into the plan.",
			"PR #23 not merged as of 2026-10-14.",
			"Issue #99 opened on 2026-10-14; PR #23 remains open.",
			"Not merged as #23; it was reverted.",
			"Not yet merged 88a6e379 into main.",
			"PR #23 is not\nmerged as #23.",
			"PR #23 is yet to be\nmerged 88a6e379.",
		])
			expect(stale("Status: parked", outcome)).toEqual([]);
		expect(
			records({
				[`${item}/STATUS.md`]:
					"---\nstate: done\n---\n# Item\nMerged as #23.\n",
				[`${item}/measurements.md`]: "# Note\nStatus: parked\n",
				[`${item}/gate.log`]: "ok",
			}),
		).toEqual([]);
	});

	test("record-note-stale covers in-progress items and a head that names a merge", () => {
		expect(
			records({
				[`${live}/STATUS.md`]:
					"---\nstate: in-progress\n---\n# Item\nPR #74 open.",
				[`${live}/t2-measurements.md`]:
					"# Note\nMerged 88a6e379 into main.\n\n## 1. Task\n- status: parked for permission to push\n",
			}),
		).toEqual([
			{
				level: "warn",
				code: "record-note-stale",
				file: "work/in-progress/consulting/t2-measurements.md",
				message:
					'consulting/t2-measurements.md says "parked"; its head names merge 88a6e379',
			},
		]);
		expect(
			records({
				[`${live}/STATUS.md`]:
					"---\nstate: in-progress\n---\n# Item\nPR #74 open.",
				[`${live}/measurements.md`]:
					"# Note\nNo merge commit or PR yet.\n\n## 1. Task\nstatus: parked\n",
			}),
		).toEqual([]);
	});

	test("SHAs of letters only count in scope, in a note's head and as live evidence", () => {
		expect(
			records({ [`${item}/STATUS.md`]: done("Merged abcdefa.") }),
		).toMatchObject([
			{
				code: "record-note-missing",
				message:
					"done item consulting names merge abcdefa and has no measurements.md",
			},
		]);
		expect(
			records({
				[`${live}/STATUS.md`]:
					"---\nstate: in-progress\n---\n# Item\nPR #23 open.",
				[`${live}/measurements.md`]:
					"# Note\nMerge commit abcdefa.\n\n## 1. Task\nStatus: parked\n",
			}).map(({ message }) => message),
		).toEqual([
			'consulting/measurements.md says "parked"; its head names merge abcdefa',
		]);
		expect(
			stale("Status: parked", "Live at abcdefa; PR #23.").map(
				({ message }) => message,
			),
		).toEqual([
			'consulting/measurements.md says "parked"; STATUS says "Live at abcdefa"',
		]);
	});

	test("the gate is the charter's Modules declaration, not module selection", () => {
		expect(
			codes(
				{
					[`${item}/STATUS.md`]: done("Merged as #23."),
					"root/.shepherd/integrations/software.md":
						"---\nname: software\ntype: domain\ndescription: rules\nbudget: 20\n---\nA namesake.\n",
				},
				{ "root/.shepherd/charter.md": "A charter\n" },
			),
		).toEqual([]);
		const { workspace } = fixture({
			...software,
			[`${item}/STATUS.md`]: done("Merged as #23."),
			"packages/software/MODULE.md": packageText(
				"software",
				"",
				"# Software\n",
				"contract: 999\n",
			),
		});
		const catalog = moduleCatalog(workspace.dir, undefined, true, [
			{ dir: join(workspace.dir, "..", "packages"), layer: "builtin" },
		]);
		expect(
			resolveModules(catalog).selected.map((module) => module.name),
		).not.toContain("software");
		expect(
			checkWork(workspace, config(), TODAY, catalog).map(({ code }) => code),
		).toContain("record-note-missing");
	});

	test("symlinked logs are not followed and todo items are out", () => {
		for (const link of ["gate.log", "logs"])
			expect(
				checkWork(
					fixture(
						{
							...software,
							[`${item}/STATUS.md`]: done("Merged as #23."),
							[`${item}/measurements.md`]: "# Measurements",
							"outside/gate.log": "ok",
							"outside/logs/output.txt": "ok",
						},
						{ symlinks: { [`${item}/${link}`]: `outside/${link}` } },
					).workspace,
					config(),
					TODAY,
				)
					.filter(({ code }) => code.startsWith("record-"))
					.map(({ code }) => code),
			).toEqual(["record-logs-missing"]);
		expect(
			codes({
				"root/.shepherd/work/todo/consulting/STATUS.md":
					"---\nstate: todo\n---\n# Item\nPR #23 planned.",
				"root/.shepherd/work/todo/consulting/measurements.md":
					"# Note\nMerged 88a6e379 into main.\n\n## 1. Task\nStatus: parked\n",
			}),
		).toEqual([]);
	});

	const methodDone = (method: string, outcome = "Merged as #23.") =>
		`---\nstate: done\nmethod: ${method}\nclosed: 2026-10-14\n---\n# Item\n\n## Outcome\n${outcome}\n`;

	test("method: none in STATUS's frontmatter skips the note and logs rules, not the stale rule", () => {
		expect(codes({ [`${item}/STATUS.md`]: methodDone("none") })).toEqual([]);
		expect(
			codes({
				[`${item}/STATUS.md`]: methodDone("none"),
				[`${item}/measurements.md`]: "# Measurements",
			}),
		).toEqual([]);
		expect(codes({ [`${item}/STATUS.md`]: done("Merged as #23.") })).toEqual([
			"record-note-missing",
		]);
		for (const method of [
			"None",
			"pilot",
			"none, pre-pilot",
			"none#pilot",
			'"none"',
			"'none'",
		])
			expect(codes({ [`${item}/STATUS.md`]: methodDone(method) })).toEqual([
				"record-note-missing",
			]);
		expect(
			codes({
				[`${item}/STATUS.md`]: methodDone("none#pilot"),
				[`${item}/measurements.md`]: "# Measurements",
			}),
		).toEqual(["record-logs-missing"]);
		for (const method of ["none  # pre-pilot", "none\t#pre-pilot", "none  "])
			expect(
				codes({
					[`${item}/STATUS.md`]: methodDone(method),
					[`${item}/measurements.md`]: "# Measurements",
				}),
			).toEqual([]);
		expect(
			codes({
				[`${item}/STATUS.md`]:
					"---\nstate: done\nrecord:\n  method: none\n---\n# Item\n\n## Outcome\nMerged as #23.\n",
			}),
		).toEqual(["record-note-missing"]);
		expect(
			codes({
				[`${item}/STATUS.md`]: methodDone("pilot"),
				[`${item}/measurements.md`]: "# Measurements",
			}),
		).toEqual(["record-logs-missing"]);
		expect(
			codes({
				[`${item}/STATUS.md`]:
					"---\nstate: done\n---\n# Item\nmethod: none\n\n## Outcome\nMerged as #23.\n",
			}),
		).toEqual(["record-note-missing"]);
		expect(
			codes({
				[`${item}/STATUS.md`]: methodDone(
					"none",
					"Merged as #23 (2026-10-14).",
				),
				[`${item}/measurements.md`]: "# Note\nStatus: parked\n",
			}),
		).toEqual(["record-note-stale"]);
	});

	test("a Raw logs: none line with a reason satisfies the logs rule", () => {
		const logs = (note: string) =>
			codes({
				[`${item}/STATUS.md`]: done("Merged as #23."),
				[`${item}/measurements.md`]: note,
			});
		for (const line of [
			"Raw logs: none, the builder ran before the eval asked for them.",
			"- Raw logs: none, kept only in /private/tmp",
			"* Raw logs: none, see the report",
			"+ Raw logs: none, the gate ran in CI only",
			"- **Raw logs:** none, the gate output was not kept",
			"**Raw logs:** none, lost",
		])
			expect(
				logs(`# Note\nRepo: \`absync\`\nStatus: landed\n${line}\n`),
			).toEqual([]);
		expect(
			logs(
				`# Note\n\n## 1. Task\n${"Text.\n".repeat(50)}## 5. Evidence\nRaw logs: none, the run predates the eval.\n`,
			),
		).toEqual([]);
		expect(
			codes({
				[`${item}/STATUS.md`]: done("Merged as #23."),
				[`${item}/measurements.md`]: "# Note\nNo logs line here.\n",
				[`${item}/t2-measurements.md`]:
					"# Note\nRaw logs: none, the second try was not kept.\n",
			}),
		).toEqual([]);
		for (const line of [
			"Raw logs: none",
			"Raw logs: none.",
			"Raw logs: none, ",
			"Raw logs: kept in the report",
			"The note says Raw logs: none, somewhere mid-line.",
			"```\nRaw logs: none, inside a fence\n```",
		])
			expect(logs(`# Note\n${line}\n`)).toEqual(["record-logs-missing"]);
	});

	const verbatim =
		"- **Status:** landed: #23 merged 2026-10-14, live 2026-10-16 (see the second Status line below). When first written: built and checked (415a87f on refine/consulting-page, not pushed; b668de3 amended by copy-refresh round 2 with his D3 intro order and D5 nav, see copy-refresh/measurements.md). Reason: waiting on his yes to push and open the PR, and hosting. The open choices were settled by his D answers via ag0osPro (15:0x).";

	test("a status line has one judgment: landed first, merged as #n, #n merged or merged <sha>", () => {
		expect(stale(verbatim)).toEqual([]);
		for (const head of [
			"Status: landed: was not pushed at first",
			"Status: landed, after a week not pushed",
			"Status: landed. Not pushed until review.",
			"- **Status:** Landed; parked before that",
			"Status: not pushed at first; #23 merged 2026-10-14",
			"Status: not pushed at first; merged as #23",
			"Status: not pushed at first; merged 88a6e379",
		])
			expect(stale(head)).toEqual([]);
		for (const head of [
			"Status: built, not pushed; landed later",
			"Status: attempted, not landed",
			"Status: not pushed; PR #23 not merged",
		])
			expect(stale(head).map(({ code }) => code)).toEqual([
				"record-note-stale",
			]);
		expect(
			stale("Status: landed.\nThe branch is not pushed.").map(
				({ message }) => message,
			),
		).toEqual([
			'consulting/measurements.md says "not pushed"; STATUS says "Merged as #23"',
		]);
	});

	test("only the first Status line in the first 40 lines is judged", () => {
		expect(stale("Status: landed (PR #23).\n\nStatus: parked")).toEqual([]);
		expect(stale("Status: landed.\nStatus: not pushed")).toEqual([]);
		expect(
			stale("- **Status:** parked.\n- **Status:** landed as of review").map(
				({ message }) => message,
			),
		).toEqual([
			'consulting/measurements.md says "parked"; STATUS says "Merged as #23"',
		]);
	});

	test("record-note-stale quotes both phrases as the files write them", () => {
		expect(
			stale("Status: Not Pushed yet", "MERGED AS #23 on 2026-10-14.").map(
				({ message }) => message,
			),
		).toEqual([
			'consulting/measurements.md says "Not Pushed"; STATUS says "MERGED AS #23"',
		]);
		expect(
			stale("Status: parked", "Merged (88a6e379) on 2026-10-14.").map(
				({ message }) => message,
			),
		).toEqual([
			'consulting/measurements.md says "parked"; STATUS says "Merged (88a6e379)"',
		]);
	});
});
