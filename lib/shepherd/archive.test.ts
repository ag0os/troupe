import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
	applyArchive,
	archiveExitCode,
	planArchive,
	renderArchive,
} from "./archive";
import {
	type Config,
	DEFAULT_HANDOFF_CEILINGS,
	DEFAULT_MARKS,
	DEFAULT_START,
	DEFAULT_WINDOWS,
} from "./config";
import { makeTree } from "./test-support";
import * as text from "./text";
import { journalChain } from "./text";
import { archiveJson } from "./tool";
import { discoverTree, selectWorkspaces } from "./tree";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function config(doneDays: number = DEFAULT_WINDOWS.doneDays): Config {
	return {
		marks: { ...DEFAULT_MARKS },
		windows: { ...DEFAULT_WINDOWS, doneDays },
		start: { ...DEFAULT_START },
		handoffCeilings: { ...DEFAULT_HANDOFF_CEILINGS },
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

function entriesUnder(
	root: string,
): Record<string, { type: "directory" | "file" | "symlink"; value: string }> {
	const entries: Record<
		string,
		{ type: "directory" | "file" | "symlink"; value: string }
	> = {};
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			const relativePath = relative(root, path);
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				entries[relativePath] = { type: "directory", value: "" };
				walk(path);
			} else if (stat.isSymbolicLink()) {
				entries[relativePath] = {
					type: "symlink",
					value: readlinkSync(path),
				};
			} else {
				entries[relativePath] = {
					type: "file",
					value: readFileSync(path, "utf8"),
				};
			}
		}
	};
	walk(root);
	return entries;
}

describe("planArchive", () => {
	test("a dry run plans both move kinds without changing any file", () => {
		const { workspace } = fixture({
			"root/.shepherd/journal.md":
				"Notes\n\n## 2026-09-30\n- Old\n\n## 2026-10-01\n- Current\n",
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-08-01\n---\n# release: Shipped safely\n",
		});
		const before = entriesUnder(workspace.dir);

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
		expect(entriesUnder(workspace.dir)).toEqual(before);
		expect(archiveExitCode(plan)).toBe(0);
	});

	test.each([
		[
			"orphans above the first section",
			"- Orphan\n\n## 2026-08-01\n- Old\n",
			"would move entries without a heading",
		],
		[
			"a misordered heading",
			"## 2026-10-01\n- Current\n\n## 2026-08-01\n- Old\n",
			"would reorder the journal chain",
		],
	])("refuses rotation with %s", (_name, journal, cause) => {
		const { tree, workspace } = fixture({
			"root/.shepherd/journal.md": journal,
		});
		const before = journalChain(workspace.state).entries;
		const plan = planArchive([workspace], config(), new Date(2026, 9, 5));
		expect(plan.workspaces[0]?.moves[0]).toMatchObject({ status: "skipped" });
		expect(plan.workspaces[0]?.moves[0]?.detail).toContain(cause);
		expect(plan.workspaces[0]?.moves[0]?.detail).toContain(
			"give orphans a heading, put sections in order, or leave the stray month in place (a heading fix changes no id)",
		);
		expect(archiveExitCode(plan)).toBe(1);
		applyArchive(plan, tree);
		expect(journalChain(workspace.state).entries).toEqual(before);
		expect(readFileSync(join(workspace.state, "journal.md"), "utf8")).toBe(
			journal,
		);
	});

	test("refuses August rotation behind an existing September archive", () => {
		const { tree, workspace } = fixture({
			"root/.shepherd/archive/journal/2026-08.md": "## 2026-08-01\n- A\n",
			"root/.shepherd/archive/journal/2026-09.md": "## 2026-09-01\n- B\n",
			"root/.shepherd/journal.md": "## 2026-08-02\n- C\n",
		});
		const plan = planArchive([workspace], config(), new Date(2026, 9, 5));
		expect(plan.workspaces[0]?.moves[0]?.detail).toContain(
			"rotating 2026-08 would place its entries after archive/journal/2026-09.md",
		);
		applyArchive(plan, tree);
		expect(
			journalChain(workspace.state).entries.map(({ text }) => text),
		).toEqual(["A", "B", "C"]);
		expect(archiveExitCode(plan)).toBe(1);
	});

	test("allows appending in chain order and preserves every id", () => {
		const { tree, workspace } = fixture({
			"root/.shepherd/archive/journal/2026-08.md": "## 2026-08-01\n- A\n",
			"root/.shepherd/journal.md":
				"## 2026-08-02\n- B\n\n## 2026-09-01\n- C\n\n## 2026-10-01\n- D\n",
		});
		const before = journalChain(workspace.state).entries.map(({ id }) => id);
		const applied = applyArchive(
			planArchive([workspace], config(), new Date(2026, 9, 5)),
			tree,
		);
		expect(applied.workspaces[0]?.moves.map(({ status }) => status)).toEqual([
			"moved",
			"moved",
		]);
		expect(journalChain(workspace.state).entries.map(({ id }) => id)).toEqual(
			before,
		);
	});

	test("moves an allowed month while leaving a refused month in place", () => {
		const { tree, workspace } = fixture({
			"root/.shepherd/archive/journal/2026-09.md": "## 2026-09-01\n- A\n",
			"root/.shepherd/journal.md": "## 2026-09-02\n- B\n\n## 2026-08-01\n- C\n",
		});
		const before = journalChain(workspace.state).entries.map(({ id }) => id);
		const applied = applyArchive(
			planArchive([workspace], config(), new Date(2026, 9, 5)),
			tree,
		);
		expect(
			applied.workspaces[0]?.moves.map(({ month, status }) => ({
				month,
				status,
			})),
		).toEqual([
			{ month: "2026-08", status: "skipped" },
			{ month: "2026-09", status: "moved" },
		]);
		expect(readFileSync(join(workspace.state, "journal.md"), "utf8")).toContain(
			"- C",
		);
		expect(
			readFileSync(join(workspace.state, "journal.md"), "utf8"),
		).not.toContain("- B");
		expect(journalChain(workspace.state).entries.map(({ id }) => id)).toEqual(
			before,
		);
		expect(archiveExitCode(applied)).toBe(1);
	});

	test("moves items even when journal rotation is skipped", () => {
		const { tree, workspace } = fixture({
			"root/.shepherd/journal.md": "- Orphan\n\n## 2026-08-01\n- Old\n",
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-08-01\n---\n# Release\n",
		});
		const applied = applyArchive(
			planArchive([workspace], config(), new Date(2026, 9, 5)),
			tree,
		);
		expect(applied.workspaces[0]?.moves.map(({ status }) => status)).toEqual([
			"skipped",
			"moved",
		]);
		expect(
			existsSync(join(workspace.state, "archive/2026-08/release/STATUS.md")),
		).toBeTrue();
		expect(archiveExitCode(applied)).toBe(1);
	});

	test("uses the local month before and after its boundary", () => {
		const child = spawnSync(
			process.execPath,
			[
				"-e",
				`
			import { strict as assert } from "node:assert";
			import { readFileSync } from "node:fs";
			import { join } from "node:path";
			import { planArchive, applyArchive } from "./lib/shepherd/archive.ts";
			import { makeTree } from "./lib/shepherd/test-support.ts";
			import { discoverTree } from "./lib/shepherd/tree.ts";
			const result = makeTree({
				"root/.shepherd/charter.md": "Charter",
				"root/.shepherd/journal.md": "Preface\\n\\n## 2026-10-30\\n- One\\n\\n## 2026-10-31\\n- Two\\n",
			});
			try {
				const tree = discoverTree(join(result.root, "root"));
				const workspace = tree.root;
				const config = ${JSON.stringify(config())};
				const lateOctober = new Date(2026, 9, 31, 22, 30);
				assert.notEqual(lateOctober.getUTCMonth(), lateOctober.getMonth());
				assert.deepEqual(planArchive([workspace], config, lateOctober).workspaces[0].moves, []);
				const applied = applyArchive(planArchive([workspace], config, new Date(2026, 10, 1, 0, 10)), tree);
				assert.equal(readFileSync(join(workspace.state, "archive/journal/2026-10.md"), "utf8"), "# Journal 2026-10\\n\\n## 2026-10-30\\n- One\\n\\n## 2026-10-31\\n- Two\\n");
				assert.equal(readFileSync(join(workspace.state, "journal.md"), "utf8"), "Preface\\n\\n");
				assert.equal(applied.workspaces[0].moves[0].status, "moved");
			} finally { result.cleanup(); }
		`,
			],
			{
				cwd: join(import.meta.dir, "../.."),
				env: { ...process.env, TZ: "America/Argentina/Buenos_Aires" },
				encoding: "utf8",
			},
		);
		expect(child.stderr).toBe("");
		expect(child.status).toBe(0);
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

	test.each(["journal.md", "archive/journal"])(
		"skips rotation through symlinked %s without losing entries",
		(path) => {
			const journal = "## 2026-08-02\n- B\n\n## 2026-10-01\n- Current\n";
			const archived = "## 2026-08-01\n- A\n";
			const result = makeTree(
				{
					"root/.shepherd/charter.md": "Charter",
					...(path === "journal.md"
						? { "journal-target.md": journal }
						: { "root/.shepherd/journal.md": journal }),
					...(path === "archive/journal"
						? { "archive-target/2026-08.md": archived }
						: { "root/.shepherd/archive/journal/2026-08.md": archived }),
				},
				{
					symlinks: {
						[`root/.shepherd/${path}`]:
							path === "journal.md" ? "journal-target.md" : "archive-target",
					},
				},
			);
			cleanups.push(result.cleanup);
			const tree = discoverTree(join(result.root, "root"));
			const before = entriesUnder(result.root);
			const plan = planArchive([tree.root], config(), new Date(2026, 9, 5));
			expect(plan.workspaces[0]?.moves).toHaveLength(1);
			expect(plan.workspaces[0]?.moves[0]).toMatchObject({
				status: "skipped",
				month: "2026-08",
				to: "archive/journal/2026-08.md",
			});
			expect(plan.workspaces[0]?.moves[0]?.detail).toContain(
				`${path} is a symlink`,
			);
			const applied = applyArchive(plan, tree);
			expect(archiveExitCode(applied)).toBe(1);
			expect(entriesUnder(result.root)).toEqual(before);
			expect(readFileSync(join(tree.root.state, "journal.md"), "utf8")).toBe(
				journal,
			);
			expect(
				readFileSync(
					join(tree.root.state, "archive/journal/2026-08.md"),
					"utf8",
				),
			).toBe(archived);
		},
	);

	test.each(["journal.md", "archive/journal", "archive/journal/2026-08.md"])(
		"rechecks %s when it becomes a symlink after planning",
		(path) => {
			const { root, tree, workspace } = fixture({
				"root/.shepherd/journal.md":
					"## 2026-08-02\n- B\n\n## 2026-10-01\n- Current\n",
				"root/.shepherd/archive/journal/2026-08.md": "## 2026-08-01\n- A\n",
				"target/2026-08.md": "## 2026-08-01\n- External\n",
				"target.md": "## 2026-08-01\n- External\n",
			});
			const plan = planArchive([workspace], config(), new Date(2026, 9, 5));
			expect(plan.workspaces[0]?.moves[0]?.status).toBe("planned");
			rmSync(join(workspace.state, path), { recursive: true });
			symlinkSync(
				join(root, path === "archive/journal" ? "target" : "target.md"),
				join(workspace.state, path),
			);
			const before = entriesUnder(root);
			const applied = applyArchive(plan, tree);
			expect(applied.workspaces[0]?.moves[0]?.status).toBe("skipped");
			expect(applied.workspaces[0]?.moves[0]?.detail).toContain(path);
			expect(entriesUnder(root)).toEqual(before);
		},
	);

	test.each(["journal.md", "archive/journal", "archive/journal/2026-07.md"])(
		"skips journal rotation for a nonregular %s path",
		(path) => {
			const { tree, workspace } = fixture({
				"root/.shepherd/journal.md": "## 2026-08-01\n- Old\n",
			});
			const target = join(workspace.state, path);
			if (path === "journal.md") rmSync(target);
			if (path === "archive/journal") {
				mkdirSync(join(workspace.state, "archive"));
				writeFileSync(target, "not a directory");
			} else {
				mkdirSync(target, { recursive: true });
			}
			const before = entriesUnder(workspace.dir);
			const plan = planArchive([workspace], config(), new Date(2026, 9, 5));
			expect(plan.workspaces[0]?.moves[0]?.status).toBe("skipped");
			expect(plan.workspaces[0]?.moves[0]?.detail).toContain(path);
			applyArchive(plan, tree);
			expect(entriesUnder(workspace.dir)).toEqual(before);
		},
	);

	test("skips a journal move when its destination is a symlink", () => {
		const result = makeTree(
			{
				"root/.shepherd/charter.md": "Charter",
				"root/.shepherd/journal.md": "## 2026-09-30\n- Old\n",
				"journal-target.md": "Do not change\n",
			},
			{
				symlinks: {
					"root/.shepherd/archive/journal/2026-09.md": "journal-target.md",
				},
			},
		);
		cleanups.push(result.cleanup);
		const tree = discoverTree(join(result.root, "root"));

		const applied = applyArchive(
			planArchive([tree.root], config(), new Date(2026, 9, 5)),
			tree,
		);

		expect(applied.workspaces[0]?.moves[0]).toMatchObject({
			status: "skipped",
			detail: "archive/journal/2026-09.md is a symlink",
		});
		expect(archiveExitCode(applied)).toBe(1);
		expect(readFileSync(join(tree.root.state, "journal.md"), "utf8")).toBe(
			"## 2026-09-30\n- Old\n",
		);
		expect(readFileSync(join(result.root, "journal-target.md"), "utf8")).toBe(
			"Do not change\n",
		);
	});

	test("skips item moves before changing anything when the index is not a file", () => {
		const { tree, workspace } = fixture({
			"root/.shepherd/archive/INDEX.md/keep": "directory marker",
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-08-01\n---\n# Release\n",
		});

		const applied = applyArchive(
			planArchive([workspace], config(), new Date(2026, 9, 5)),
			tree,
		);

		expect(applied.workspaces[0]?.moves[0]).toMatchObject({
			status: "skipped",
			detail: "archive/INDEX.md is not a regular file",
		});
		expect(archiveExitCode(applied)).toBe(1);
		expect(
			readFileSync(
				join(workspace.state, "work/done/release/STATUS.md"),
				"utf8",
			),
		).toContain("closed:");
		expect(
			existsSync(join(workspace.state, "archive/2026-08/release")),
		).toBeFalse();
	});

	test("skips dangling work item symlinks", () => {
		const result = makeTree(
			{ "root/.shepherd/charter.md": "Charter" },
			{
				symlinks: {
					"root/.shepherd/work/done/missing": "does-not-exist",
				},
			},
		);
		cleanups.push(result.cleanup);
		const tree = discoverTree(join(result.root, "root"));

		expect(() =>
			planArchive([tree.root], config(), new Date(2026, 9, 5)),
		).not.toThrow();
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

test("rotation separates an appended heading from the existing final bullet", () => {
	const { workspace, tree } = fixture({
		"root/.shepherd/archive/journal/2026-09.md":
			"## 2026-09-01\n- 09:00 first\n",
		"root/.shepherd/journal.md": "## 2026-09-30\n- 10:00 next\n",
	});
	const applied = applyArchive(
		planArchive([workspace], config(), new Date(2026, 9, 1)),
		tree,
	);
	expect(applied.workspaces[0]?.moves[0]?.status).toBe("moved");
	expect(
		readFileSync(join(workspace.state, "archive/journal/2026-09.md"), "utf8"),
	).toContain("- 09:00 first\n\n## 2026-09-30\n");
});

test("item archive refuses a symlinked parent destination", () => {
	const { workspace, tree, root } = fixture({
		"root/.shepherd/work/done/release/STATUS.md":
			"---\nclosed: 2026-08-01\n---\n# release: Shipped\n",
	});
	const outside = join(root, "outside");
	mkdirSync(outside);
	symlinkSync(outside, join(workspace.state, "archive"));
	const applied = applyArchive(
		planArchive([workspace], config(), new Date(2026, 9, 1)),
		tree,
	);
	expect(applied.workspaces[0]?.moves[0]).toMatchObject({
		status: "skipped",
		detail: "archive is a symlink",
	});
	expect(readdirSync(outside)).toEqual([]);
	expect(existsSync(join(workspace.state, "work/done/release/STATUS.md"))).toBe(
		true,
	);
});

test("rotation keeps a fenced dated heading with its enclosing section", () => {
	const journal =
		"## 2026-09-30\n- old\n```\n## 2026-10-01\nexample\n```\n## 2026-10-02\n- keep\n";
	const { workspace, tree } = fixture({ "root/.shepherd/journal.md": journal });
	const applied = applyArchive(
		planArchive([workspace], config(), new Date(2026, 9, 5)),
		tree,
	);
	expect(journalChain(workspace.state).unreadable).toEqual([]);
	expect(
		readFileSync(join(workspace.state, "archive/journal/2026-09.md"), "utf8"),
	).toContain("```\n## 2026-10-01\nexample\n```");
	expect(applied.workspaces[0]?.moves[0]?.status).toBe("moved");
});

test("rotation simulation refuses a proposed section with an unclosed fence", () => {
	const { workspace } = fixture({
		"root/.shepherd/journal.md": "## 2026-09-30\n- old\n",
	});
	const original = text.journalSections;
	const parser = spyOn(text, "journalSections").mockImplementationOnce(
		(input) => {
			const parsed = original(input);
			const day = parsed.days[0];
			if (!day) throw new Error("missing day section");
			day.body += "```\n";
			return parsed;
		},
	);
	try {
		const plan = planArchive([workspace], config(), new Date(2026, 9, 5));
		expect(plan.workspaces[0]?.moves[0]?.status).toBe("skipped");
		expect(plan.workspaces[0]?.moves[0]?.detail).toContain(
			"fence opened at line",
		);
	} finally {
		parser.mockRestore();
	}
});

test("apply refuses a simulated fence problem before either rotation write", () => {
	const journal = "## 2026-09-30\n- old\n";
	const { workspace, tree } = fixture({ "root/.shepherd/journal.md": journal });
	const plan = planArchive([workspace], config(), new Date(2026, 9, 5));
	const move = plan.workspaces[0]?.moves[0];
	if (move?.kind !== "journal") throw new Error("expected journal move");
	move.days[0] += "```\n";
	const applied = applyArchive(plan, tree);
	expect(applied.workspaces[0]?.moves[0]?.status).toBe("skipped");
	expect(applied.workspaces[0]?.moves[0]?.detail).toContain(
		"fence opened at line",
	);
	expect(readFileSync(join(workspace.state, "journal.md"), "utf8")).toBe(
		journal,
	);
	expect(existsSync(join(workspace.state, "archive"))).toBe(false);
});

test("cross-workspace reference rewrites skip a symlinked archive with the reason", () => {
	const { root, workspace, tree } = fixture({
		"root/child/.shepherd/charter.md": "Child",
		"root/child/.shepherd/work/done/release/STATUS.md":
			"---\nclosed: 2026-08-01\n---\n# release: Shipped\n",
		"outside/INDEX.md": "child/.shepherd/work/done/release\n",
	});
	symlinkSync(join(root, "outside"), join(workspace.state, "archive"));
	const child = tree.workspaces.find(({ name }) => name === "child");
	if (!child) throw new Error("missing child");
	const before = readFileSync(join(root, "outside/INDEX.md"), "utf8");
	const applied = applyArchive(
		planArchive([child], config(), new Date(2026, 9, 5)),
		tree,
	);
	expect(readFileSync(join(root, "outside/INDEX.md"), "utf8")).toBe(before);
	expect(applied.workspaces[0]?.moves[0]?.status).toBe("moved");
	expect(renderArchive(applied)).toContain("archive is a symlink");
	expect(archiveJson(applied).skippedRewrites).toEqual([
		expect.objectContaining({ reason: "archive is a symlink" }),
	]);
});

for (const phase of ["plan", "apply"] as const) {
	test(`archive ${phase} skips component inspection errors without throwing`, () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/work/done/release/STATUS.md":
				"---\nclosed: 2026-08-01\n---\n# release: Shipped\n",
		});
		mkdirSync(join(workspace.state, "archive"));
		const plan =
			phase === "apply"
				? planArchive([workspace], config(), new Date(2026, 9, 5))
				: undefined;
		const original = fs.lstatSync;
		const stat = spyOn(fs, "lstatSync").mockImplementation(((
			...args: Parameters<typeof fs.lstatSync>
		) => {
			const [path] = args;
			if (String(path) === join(workspace.state, "archive/2026-08"))
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			return Reflect.apply(original, fs, args);
		}) as typeof fs.lstatSync);
		try {
			const result = plan
				? applyArchive(plan, tree)
				: planArchive([workspace], config(), new Date(2026, 9, 5));
			expect(result.workspaces[0]?.moves[0]?.status).toBe("skipped");
			expect(result.workspaces[0]?.moves[0]?.detail).toContain(
				"cannot be inspected",
			);
			expect(existsSync(join(workspace.state, "work/done/release"))).toBe(true);
		} finally {
			stat.mockRestore();
		}
	});
}
