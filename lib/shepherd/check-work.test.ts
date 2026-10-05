import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkWorkspace, type Finding } from "./check";
import { checkWork } from "./check-work";
import { type Config, DEFAULT_MARKS, DEFAULT_WINDOWS } from "./config";
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
