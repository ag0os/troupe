import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { checkWorkspace } from "./check";
import { loadConfig } from "./config";
import { builtInModules } from "./module-resolution";
import { makeTree } from "./test-support";
import { words } from "./text";
import { discoverTree } from "./tree";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
const doc = (name: string, body: string, extra = "", budget = 2) =>
	`---\nname: ${name}\ntype: domain\ndescription: rules\nbudget: ${budget}\n${extra}---\n${body}`;
function findings(files: Record<string, string>, marks = {}) {
	const t = makeTree({
		"root/.shepherd/charter.md": "",
		"root/.shepherd/CURRENT.md": "Updated: 2026-10-05\n",
		...files,
	});
	cleanups.push(t.cleanup);
	const discovered = discoverTree(join(t.root, "root"));
	const workspace = discovered.workspaces.find(
		(w) => w.dir === join(t.root, "root"),
	);
	if (!workspace) throw new Error("workspace missing");
	const tree = {
		...discovered,
		root: workspace,
		workspaces: discovered.workspaces.filter(
			(w) => w.dir === workspace.dir || w.dir.startsWith(`${workspace.dir}/`),
		),
	};
	const config = loadConfig({
		workspaceChain: [tree.root.dir],
		home: t.root,
		env: {},
	});
	config.marks = { ...config.marks, ...marks };
	return checkWorkspace(
		tree.root,
		tree,
		config,
		new Date("2026-10-05"),
		t.root,
	).filter(
		(f) => f.code.startsWith("module-") || f.code === "shared-over-mark",
	);
}
test("cost equality, one word over and inactive candidates exclude metadata", () => {
	const result = findings({
		"root/.shepherd/integrations/equal.md": doc("equal", "one two"),
		"root/.shepherd/integrations/over.md": doc(
			"over",
			"one two three",
			"applies-when:\n  has-children: true\n",
		),
		"root/.shepherd/integrations/legacy.md": "legacy",
	});
	expect(result).toContainEqual(
		expect.objectContaining({
			code: "module-cost",
			level: "info",
			file: "integrations/equal.md",
			message: "equal: 2 prompt words / 2 budget; rules",
		}),
	);
	expect(result).toContainEqual(
		expect.objectContaining({
			code: "module-over-budget",
			level: "warn",
			message: "over: 3 prompt words, exceeds budget 2 by 1",
		}),
	);
	expect(result).toContainEqual(
		expect.objectContaining({
			code: "module-frontmatter-missing",
			level: "info",
		}),
	);
	expect(
		result.some(
			(f) => f.code === "module-cost" && f.file.startsWith("builtin/"),
		),
	).toBe(false);
});
test("shared publication totals include degraded bodies and mark unclosed costs incomplete", () => {
	const result = findings(
		{
			"root/child/.shepherd/charter.md": "",
			"root/.shepherd/integrations/invalid.md": doc(
				"invalid",
				"one two three",
				"unknown: true\n",
			),
			"root/.shepherd/integrations/unclosed.md": "---\nname: unclosed\n",
			"root/.shepherd/integrations/inactive.md": doc(
				"inactive",
				"four five",
				"applies-when:\n  has-children: false\n",
			),
		},
		{ shared: 4 },
	);
	expect(result.find((f) => f.code === "shared-over-mark")?.message).toBe(
		"5 published prompt words, past the 4-word mark; actual loading depends on selection; subtotal incomplete: integrations/unclosed.md cost unavailable",
	);
	expect(result.filter((f) => f.code === "module-schema")).toHaveLength(2);
});
test("checking sees enclosing schema and duplicates outside the checked tree", () => {
	const result = findings({
		".shepherd/charter.md": "",
		".shepherd/integrations/same.md": doc(
			"same",
			"inherited",
			"unknown: true\n",
		),
		"root/.shepherd/integrations/same.md": "local",
	});
	expect(result).toContainEqual(
		expect.objectContaining({
			code: "module-schema",
			file: "../../.shepherd/integrations/same.md",
			line: 6,
		}),
	);
	expect(result.find((f) => f.code === "module-duplicate")?.message).toContain(
		"both load at launch",
	);
});
test("built-in metadata and body costs are pinned against budgets", () => {
	const expected: Array<[string, number, number]> = [
		["herdr", 675, 700],
		["inter-agent", 364, 400],
		["nested", 399, 450],
		["root", 631, 650],
		["software", 2336, 2600],
	];
	const builtins = builtInModules();
	for (const [index, [name, cost, budget]] of expected.entries()) {
		const module = builtins[index];
		expect(module?.name).toBe(`${name}.md`);
		expect(module?.problems).toEqual([]);
		expect(words(module?.body ?? "")).toBe(cost);
		expect(module?.metadata?.budget).toBe(budget);
	}
});

test("built-in finding paths stay literal and defects throw in resolution", async () => {
	const { moduleFindings } = await import("./check-modules");
	const { resolveModules } = await import("./module-resolution");
	const candidates = builtInModules();
	const software = candidates.find((m) => m.name === "software.md");
	if (!software?.metadata) throw new Error("missing software metadata");
	software.metadata.budget = 1;
	const catalog = { candidates, children: [], published: false };
	expect(moduleFindings(catalog, "/workspace/.shepherd")).toContainEqual(
		expect.objectContaining({
			code: "module-over-budget",
			level: "warn",
			file: "builtin/software.md",
		}),
	);
	software.metadata = undefined;
	software.problems = [
		{ code: "module-schema", message: "budget: invalid", line: 6 },
	];
	expect(() => resolveModules(catalog)).toThrow(
		"builtin/software.md: invalid built-in metadata",
	);
	expect(moduleFindings(catalog, "/workspace/.shepherd")).toContainEqual(
		expect.objectContaining({
			code: "module-schema",
			level: "error",
			file: "builtin/software.md",
			line: 6,
		}),
	);
});

test("annotated duplicate wording follows actual loaded selection", () => {
	for (const [extra, tokens, message] of [
		[
			"",
			"",
			"both load; an explicit selection of this name would be ambiguous",
		],
		["applies-when:\n  has-children: true\n", "", "neither body loaded"],
		["provides: craft\ndefault: true\n", "craft", "no provider loaded"],
	]) {
		const result = findings({
			".shepherd/charter.md": "",
			".shepherd/integrations/same.md": doc("same", "inherited", extra),
			"root/.shepherd/charter.md": `Modules: ${tokens}\n`,
			"root/.shepherd/integrations/same.md": doc("same", "local", extra),
		});
		expect(
			result.find((f) => f.code === "module-duplicate")?.message,
		).toContain(message ?? "");
	}
});

test("unclosed published subtotal within the mark has no shared-over-mark warning", () => {
	const result = findings(
		{
			"root/child/.shepherd/charter.md": "",
			"root/.shepherd/integrations/unclosed.md": "---\nname: unclosed\n",
			"root/.shepherd/integrations/small.md": doc("small", "one two"),
		},
		{ shared: 2 },
	);
	expect(result.filter((f) => f.code === "module-schema")).toHaveLength(1);
	expect(result.some((f) => f.code === "shared-over-mark")).toBe(false);
});
