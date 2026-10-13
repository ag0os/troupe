import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkWorkspace } from "./check";
import {
	captureState,
	commitCheckpoint,
	nextCheckpoint,
} from "./checkpoint-write";
import { promptWords } from "./compose";
import {
	type Config,
	DEFAULT_MARKS,
	DEFAULT_START,
	DEFAULT_WINDOWS,
} from "./config";
import { contextTiers, renderContextTable } from "./context";
import { runStart, startJson } from "./start";
import { collectStart } from "./start-collect";
import { fakeToolEnv, type MakeTreeOptions, makeTree } from "./test-support";
import { discoverTree } from "./tree";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function config(opening: number = DEFAULT_MARKS.opening): Config {
	return {
		marks: { ...DEFAULT_MARKS, opening },
		windows: { ...DEFAULT_WINDOWS },
		start: { ...DEFAULT_START },
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
		expect(tiers.start).toBe(
			startJson(
				collectStart(workspace, fakeToolEnv({ home: workspace.dir }), config()),
				[],
			).words.start,
		);
		expect(tiers.opens).toBe(tiers.loaded + tiers.start);
		expect(tiers.onDemand).toBe(16);
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
			startBreakdown: {
				current: 100,
				pending: 0,
				journal: 0,
				memoryIndex: 0,
				docsIndex: 0,
				start: 100,
			},
			journalMode: "boundary",
			opens: 1100,
			onDemand: 20,
			cold: 3,
			over: ["opening > 1000"],
		},
		{
			name: "child",
			loaded: 10,
			start: 5,
			startBreakdown: {
				current: 5,
				pending: 0,
				journal: 0,
				memoryIndex: 0,
				docsIndex: 0,
				start: 5,
			},
			journalMode: "fallback",
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

test("full startup and context collection terminate and agree after budget cuts", () => {
	const { workspace, tree } = fixture({
		"root/.shepherd/CURRENT.md": "current words",
		"root/.shepherd/charter.md": "charter words",
		"root/.shepherd/pending.md": "Warning beyond bullets",
		"root/.shepherd/MEMORY.md": "memory index",
		"root/.shepherd/docs/INDEX.md": "docs index",
		"root/.shepherd/journal.md":
			"## 2026-10-05\n- first entry\n- newest entry\n",
	});
	const env = fakeToolEnv({ home: workspace.dir });
	const cfg = config();
	cfg.start.journalWords = 3;
	const held = captureState(workspace, env);
	commitCheckpoint(
		workspace.state,
		held,
		nextCheckpoint(held, { written: env.now.toISOString() }),
	);
	writeFileSync(
		join(workspace.state, "journal.md"),
		"## 2026-10-05\n- first entry\n- newest entry\n- new unreviewed entry\n- final entry\n",
	);
	const data = collectStart(workspace, env, cfg);
	expect(data.assessment.status).toBe("ok");
	expect(data.assessment.boundary.state).toBe("found");
	expect(data.assessment.dropped).toBeDefined();
	expect(data.journal.cut?.entries).toBe(1);
	const result = runStart(workspace, tree, env, cfg, {
		json: true,
		today: env.now,
	});
	const json = JSON.parse(result.text);
	const tiers = contextTiers(workspace, cfg, undefined, env);
	expect(result.code).toBe(0);
	expect(tiers.start).toBe(json.words.start);
	const { findings: _findings, ...breakdown } = json.words;
	expect(tiers.startBreakdown).toEqual(breakdown);
	expect(tiers.journalMode).toBe("boundary");
	expect(tiers.journalMode).toBe(json.journal.mode);
	expect(renderContextTable([tiers])).toContain(
		"2 at start: the sources `shepherd tool start` prints, findings excluded",
	);
});

test("source collection and context imports exclude check and renderer", () => {
	for (const file of ["context.ts", "start-collect.ts"]) {
		const text = readFileSync(join(import.meta.dir, file), "utf8");
		const imports = text.match(/import[\s\S]*?from\s+["'][^"']+["']/g) ?? [];
		for (const statement of imports)
			expect(statement).not.toMatch(/from\s+["']\.\/(?:check|start)["']/);
	}
});
