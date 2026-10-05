import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkWorkspace } from "./check";
import { promptWords } from "./compose";
import { type Config, DEFAULT_MARKS, DEFAULT_WINDOWS } from "./config";
import { contextTiers, renderContextTable } from "./context";
import { type MakeTreeOptions, makeTree } from "./test-support";
import { discoverTree } from "./tree";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function config(opening: number = DEFAULT_MARKS.opening): Config {
	return {
		marks: { ...DEFAULT_MARKS, opening },
		windows: { ...DEFAULT_WINDOWS },
		codex: {},
		problems: [],
	};
}

function fixture(files: Record<string, string>, options: MakeTreeOptions = {}) {
	const result = makeTree(files, options);
	cleanups.push(result.cleanup);
	const root = join(result.root, "root");
	const tree = discoverTree(root);
	return { tree, workspace: tree.root };
}

describe("contextTiers", () => {
	test("counts the composed prompt and each filesystem tier", () => {
		const { workspace } = fixture(
			{
				"root/.shepherd/charter.md": "charter words",
				"root/.shepherd/CURRENT.md": "current words",
				"root/.shepherd/HANDOFF.md": "handoff words",
				"root/.shepherd/MEMORY.md": "memory index",
				"root/.shepherd/docs/INDEX.md": "docs index",
				"root/.shepherd/docs/guide.md": "guide words",
				"root/.shepherd/journal.md":
					"preamble\n## 2026-10-01\nold\n## 2026-10-02\nnewer\n## 2026-10-03\nnewest\n",
				"root/.shepherd/notes.md": "other words",
				"root/.shepherd/shared/rules.md": "linked shared words",
				"root/.shepherd/archive/2026-09/old.md": "cold words",
			},
			{
				symlinks: {
					"root/.shepherd/integrations/rules.md":
						"root/.shepherd/shared/rules.md",
				},
			},
		);

		const tiers = contextTiers(workspace, config());

		expect(tiers.loaded).toBe(promptWords(workspace.dir));
		expect(tiers.start).toBe(14);
		expect(tiers.opens).toBe(tiers.loaded + 14);
		expect(tiers.onDemand).toBe(8);
		expect(tiers.cold).toBe(2);
		expect(tiers.over).toEqual([]);
	});

	test("uses readable local prompt files when composition fails", () => {
		const { tree, workspace } = fixture(
			{
				"root/.shepherd/charter.md": "fallback charter words",
				"root/.shepherd/CURRENT.md": "Updated: 2026-10-05",
			},
			{
				symlinks: {
					"root/.shepherd/integrations/broken.md": "missing.md",
				},
			},
		);
		let problem: string | undefined;

		const tiers = contextTiers(workspace, config(1), (message) => {
			problem = message;
		});
		const findings = checkWorkspace(
			workspace,
			tree,
			config(1),
			new Date(2026, 9, 5),
		);

		expect(problem).toBeString();
		expect(tiers.loaded).toBe(3);
		expect(tiers.over).toContain("opening > 1");
		expect(findings.map(({ code }) => code)).toContain("prompt-uncountable");
		expect(findings.map(({ code }) => code)).toContain("opening-over-mark");
	});
});

test("renderContextTable renders rows, totals, tokens and the legend", () => {
	const text = renderContextTable([
		{
			name: "root",
			loaded: 1000,
			start: 100,
			opens: 1100,
			onDemand: 20,
			cold: 3,
			over: ["opening > 1000"],
		},
		{
			name: "child",
			loaded: 10,
			start: 5,
			opens: 15,
			onDemand: 4,
			cold: 2,
			over: [],
		},
	]);

	expect(text).toContain("1.1k (~1.5k tok)");
	expect(text).toContain("opening > 1000");
	expect(text).toContain("all");
	expect(text).toContain("24");
	expect(text).toContain(
		"1 loaded: the composed prompt (core, modules, charter).",
	);
});
