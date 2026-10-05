import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
	applyArchive,
	archiveExitCode,
	planArchive,
	renderArchive,
} from "./archive";
import { type Config, DEFAULT_MARKS, DEFAULT_WINDOWS } from "./config";
import { makeTree } from "./test-support";
import { discoverTree, selectWorkspaces } from "./tree";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function config(doneDays: number = DEFAULT_WINDOWS.doneDays): Config {
	return {
		marks: { ...DEFAULT_MARKS },
		windows: { ...DEFAULT_WINDOWS, doneDays },
		codex: {},
		problems: [],
	};
}

function fixture(
	files: Record<string, string>,
	mtimes: Record<string, Date | string | number> = {},
) {
	const result = makeTree(
		{ "root/.shepherd/charter.md": "Charter", ...files },
		{ mtimes },
	);
	cleanups.push(result.cleanup);
	const tree = discoverTree(join(result.root, "root"));
	return { root: result.root, tree, workspace: tree.root };
}

function filesUnder(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else files[relative(root, path)] = readFileSync(path, "utf8");
		}
	};
	walk(root);
	return files;
}

function inTimezone(zone: string, run: () => void): void {
	const previous = process.env.TZ;
	try {
		process.env.TZ = zone;
		run();
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
}

describe("planArchive", () => {
	test("a dry run plans both move kinds without changing any file", () => {
		const { workspace } = fixture({
			"root/.shepherd/journal.md":
				"Notes\n\n## 2026-09-30\n- Old\n\n## 2026-10-01\n- Current\n",
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-08-01\n---\n# release: Shipped safely\n",
		});
		const before = filesUnder(workspace.dir);

		const plan = planArchive([workspace], config(), new Date(2026, 9, 5));

		expect(plan.workspaces[0]?.moves).toMatchObject([
			{
				kind: "journal",
				from: "journal.md",
				to: "archive/journal/2026-09.md",
				status: "planned",
			},
			{
				kind: "item",
				from: "work/done/release",
				to: "archive/2026-08/release",
				status: "planned",
			},
		]);
		expect(filesUnder(workspace.dir)).toEqual(before);
		expect(archiveExitCode(plan)).toBe(0);
	});

	test("uses the local month before and after its boundary", () => {
		inTimezone("America/Argentina/Buenos_Aires", () => {
			const { tree, workspace } = fixture({
				"root/.shepherd/journal.md":
					"Preface\n\n## 2026-10-30\n- One\n\n## 2026-10-31\n- Two\n",
			});
			const lateOctober = new Date(2026, 9, 31, 22, 30);
			expect(lateOctober.getUTCMonth()).not.toBe(lateOctober.getMonth());

			const october = planArchive([workspace], config(), lateOctober);
			expect(october.workspaces[0]?.moves).toEqual([]);

			const november = planArchive(
				[workspace],
				config(),
				new Date(2026, 10, 1, 0, 10),
			);
			const applied = applyArchive(november, tree);
			expect(
				readFileSync(
					join(workspace.state, "archive/journal/2026-10.md"),
					"utf8",
				),
			).toBe(
				"# Journal 2026-10\n\n## 2026-10-30\n- One\n\n## 2026-10-31\n- Two\n",
			);
			expect(readFileSync(join(workspace.state, "journal.md"), "utf8")).toBe(
				"Preface\n\n",
			);
			expect(applied.workspaces[0]?.moves[0]?.status).toBe("moved");
		});
	});

	test("plans a bare close date in its calendar month", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-09-30\n---\n# Release\n",
		});
		const plan = planArchive([workspace], config(), new Date(2026, 10, 1));
		expect(plan.workspaces[0]?.moves[0]?.to).toBe("archive/2026-09/release");
	});

	test("honors the configured done window", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-09-25\n---\n# Release\n",
		});

		expect(
			planArchive([workspace], config(10), new Date(2026, 9, 5)).workspaces[0]
				?.moves,
		).toEqual([]);
		expect(
			planArchive([workspace], config(9), new Date(2026, 9, 5)).workspaces[0]
				?.moves[0]?.status,
		).toBe("planned");
	});

	test("marks an existing item target skipped and excludes it from the count", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-08-01\n---\n# Release\n",
			"root/.shepherd/archive/2026-08/release/STATUS.md": "Already here\n",
		});
		const plan = planArchive([workspace], config(), new Date(2026, 9, 5));

		expect(plan.workspaces[0]?.moves[0]?.status).toBe("skipped");
		expect(archiveExitCode(plan)).toBe(1);
		expect(renderArchive(plan)).toContain(
			"root: 0 move(s) (dry run)\n  skip release: archive/2026-08/release already exists",
		);
		expect(renderArchive(plan)).not.toContain("Dry run. Add --apply");
	});

	test("the default archive scope selects only the home workspace", () => {
		const { tree } = fixture({
			"root/.shepherd/journal.md": "## 2026-09-01\n- Root\n",
			"root/child/.shepherd/journal.md": "## 2026-09-01\n- Child\n",
		});
		const selected = selectWorkspaces(tree, [], "archive");
		const plan = planArchive(selected, config(), new Date(2026, 9, 5));

		expect(plan.workspaces.map(({ name }) => name)).toEqual(["root"]);
		expect(plan.applied).toBeFalse();
	});
});

describe("applyArchive", () => {
	test("moves both kinds, preserves current journal entries and creates the index", () => {
		const { tree, workspace } = fixture({
			"root/.shepherd/journal.md":
				"# Notes\n\n## 2026-09-30\n- Old\n\n## 2026-10-01\n- Current\n",
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-08-01\n---\n# release: Shipped safely\n",
		});

		const applied = applyArchive(
			planArchive([workspace], config(45), new Date(2026, 9, 5)),
			tree,
		);

		expect(applied.workspaces[0]?.moves.map(({ status }) => status)).toEqual([
			"moved",
			"moved",
		]);
		expect(readFileSync(join(workspace.state, "journal.md"), "utf8")).toBe(
			"# Notes\n\n## 2026-10-01\n- Current\n",
		);
		expect(
			readFileSync(join(workspace.state, "archive/INDEX.md"), "utf8"),
		).toBe(
			"# Archive index\n\nClosed work moved out of `work/done/` after 45 days, one line per item in the order archived: date closed (`~` when taken from the file date), item, outcome.\n\n- 2026-08-01 [release](2026-08/release/STATUS.md): Shipped safely\n",
		);
		expect(
			readFileSync(
				join(workspace.state, "archive/2026-08/release/STATUS.md"),
				"utf8",
			),
		).toContain("Shipped safely");
		expect(archiveExitCode(applied)).toBe(0);
	});

	test("appends to existing journal and index files", () => {
		const { tree, workspace } = fixture({
			"root/.shepherd/journal.md": "## 2026-09-30\n- New day\n",
			"root/.shepherd/archive/journal/2026-09.md":
				"# Journal 2026-09\n\n## 2026-09-01\n- Existing day\n",
			"root/.shepherd/archive/INDEX.md":
				"# Archive index\n\n- 2026-07-01 [old](2026-07/old/): Old\n",
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-08-01\n---\n# release: New\n",
		});

		applyArchive(
			planArchive([workspace], config(), new Date(2026, 9, 5)),
			tree,
		);

		const journal = readFileSync(
			join(workspace.state, "archive/journal/2026-09.md"),
			"utf8",
		);
		expect(journal.match(/# Journal 2026-09/g)).toHaveLength(1);
		expect(journal).toContain("Existing day");
		expect(journal).toContain("New day");
		const index = readFileSync(
			join(workspace.state, "archive/INDEX.md"),
			"utf8",
		);
		expect(index).toContain("[old]");
		expect(index).toContain("[release](2026-08/release/STATUS.md): New");
	});

	test("uses an approximate file date and links an item without STATUS to its directory", () => {
		const { tree, workspace } = fixture(
			{
				"root/.shepherd/work/done/legacy/note.md": "Legacy\n",
			},
			{
				"root/.shepherd/work/done/legacy": new Date(2026, 7, 1, 12),
			},
		);

		applyArchive(
			planArchive([workspace], config(), new Date(2026, 9, 5)),
			tree,
		);

		expect(
			readFileSync(join(workspace.state, "archive/INDEX.md"), "utf8"),
		).toContain("- 2026-08-01~ [legacy](2026-08/legacy/): (no STATUS.md)");
	});

	test("a second apply has no moves", () => {
		const { tree, workspace } = fixture({
			"root/.shepherd/journal.md": "## 2026-09-30\n- Old\n",
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-08-01\n---\n# Release\n",
		});
		applyArchive(
			planArchive([workspace], config(), new Date(2026, 9, 5)),
			tree,
		);

		const second = planArchive([workspace], config(), new Date(2026, 9, 5));
		expect(second.workspaces[0]?.moves).toEqual([]);
		expect(renderArchive(applyArchive(second, tree))).toBe(
			"\nroot: nothing to archive",
		);
	});

	test("rechecks a target before moving", () => {
		const { tree, workspace } = fixture({
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-08-01\n---\n# Release\n",
		});
		const plan = planArchive([workspace], config(), new Date(2026, 9, 5));
		const target = join(workspace.state, "archive/2026-08/release");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "STATUS.md"), "Appeared later\n");

		const applied = applyArchive(plan, tree);

		expect(applied.workspaces[0]?.moves[0]?.status).toBe("skipped");
		expect(archiveExitCode(applied)).toBe(1);
		expect(
			readFileSync(
				join(workspace.state, "work/done/release/STATUS.md"),
				"utf8",
			),
		).toContain("closed:");
	});
});

test("renderArchive shows dry-run and applied output", () => {
	const { tree, workspace } = fixture({
		"root/.shepherd/journal.md": "## 2026-09-30\n- Old\n",
	});
	const plan = planArchive([workspace], config(), new Date(2026, 9, 5));

	expect(renderArchive(plan)).toBe(
		"\nroot: 1 move(s) (dry run)\n  journal: 1 day(s) of 2026-09 -> archive/journal/2026-09.md\n\nDry run. Add --apply to move.",
	);
	expect(renderArchive(applyArchive(plan, tree))).toBe(
		"\nroot: 1 move(s)\n  journal: 1 day(s) of 2026-09 -> archive/journal/2026-09.md",
	);
});
