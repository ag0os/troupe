import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { checkWorkspace } from "./check";
import { loadConfig } from "./config";
import { builtInModules } from "./module-resolution";
import { packageLocations, packageModules } from "./package-resolution";
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
		(f) =>
			f.code.startsWith("module-") ||
			f.code.startsWith("charter-") ||
			f.code === "shared-over-mark",
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
		["nested", 392, 450],
		["root", 631, 650],
		["software", 2536, 2600],
	];
	const builtins = [
		...builtInModules(),
		...packageModules(packageLocations(undefined)),
	];
	for (const [index, [name, cost, budget]] of expected.entries()) {
		const module = builtins[index];
		expect(module?.metadata?.name).toBe(name);
		expect(module?.problems).toEqual([]);
		expect(words(module?.body ?? "")).toBe(cost);
		expect(module?.metadata?.budget).toBe(budget);
		expect(words(module?.body ?? "")).toBeLessThanOrEqual(budget);
	}
});

test("built-in finding paths stay literal and defects throw in resolution", async () => {
	const { moduleFindings } = await import("./check-modules");
	const { resolveModules } = await import("./module-resolution");
	const candidates = builtInModules();
	const software = candidates.find((m) => m.name === "root.md");
	if (!software?.metadata) throw new Error("missing root metadata");
	software.metadata.budget = 1;
	const catalog = { candidates, children: [], published: false };
	expect(moduleFindings(catalog, "/workspace/.shepherd")).toContainEqual(
		expect.objectContaining({
			code: "module-over-budget",
			level: "warn",
			file: "builtin/root.md",
		}),
	);
	software.metadata = undefined;
	software.problems = [
		{ code: "module-schema", message: "budget: invalid", line: 6 },
	];
	expect(() => resolveModules(catalog)).toThrow(
		"builtin/root.md: invalid built-in metadata",
	);
	expect(moduleFindings(catalog, "/workspace/.shepherd")).toContainEqual(
		expect.objectContaining({
			code: "module-schema",
			level: "error",
			file: "builtin/root.md",
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

test("charter declarations use selected modules, required wins and None is a value", () => {
	const result = findings({
		"root/.shepherd/charter.md":
			"Modules: craft\n## Done\n\n- craft.value: None\n- craft.blank:   \n- inactive.value: unused\n- core.done: None\n",
		"root/.shepherd/integrations/reader.md": doc(
			"reader",
			"rules",
			"provides: craft\ndefault: true\ncharter-keys:\n  craft.value: required\n  craft.blank: required\n  core.done: required\n",
		),
		"root/.shepherd/integrations/other.md": doc(
			"other",
			"rules",
			"charter-keys:\n  core.done: optional\n",
		),
		"root/.shepherd/integrations/inactive.md": doc(
			"inactive",
			"rules",
			"applies-when:\n  has-children: true\ncharter-keys:\n  inactive.value: required\n",
		),
	});
	expect(
		result
			.filter((f) => f.code === "charter-key-required")
			.map((f) => f.message),
	).toEqual([
		'slot "core.done" required by reader is missing or empty',
		'slot "craft.blank" required by reader is missing or empty',
	]);
	expect(result).toContainEqual(
		expect.objectContaining({
			code: "charter-key-required",
			level: "warn",
			line: 5,
		}),
	);
	expect(result).toContainEqual(
		expect.objectContaining({
			code: "charter-key-undeclared",
			line: 6,
			message: 'slot "inactive.value" is not declared by the loaded modules',
		}),
	);
	expect(result).toContainEqual(
		expect.objectContaining({
			code: "charter-key-undeclared",
			line: 7,
			message:
				'slot "core.done" uses the heading form, not a module-key bullet',
		}),
	);
});

test("duplicate module slots error while repeated core headings warn", () => {
	const result = findings({
		"root/.shepherd/charter.md":
			"## Done\nNone\n## DONE\nNone\n- software.grants: one\n* **software.grants:** two\n",
	});
	expect(result.filter((f) => f.code === "charter-slot-duplicate")).toEqual([
		{
			code: "charter-slot-duplicate",
			level: "warn",
			file: "charter.md",
			line: 3,
			message: 'slot "core.done" repeats line 1',
		},
		{
			code: "charter-slot-duplicate",
			level: "error",
			file: "charter.md",
			line: 6,
			message: 'slot "software.grants" repeats line 5',
		},
	]);
});

test("incomplete declaration resolution suppresses undeclared and required only", () => {
	for (const extra of ["unknown: true\n", "provides: craft\ndefault: true\n"]) {
		const result = findings({
			"root/.shepherd/charter.md":
				"Modules: craft\n- software.grants: one\n- software.grants: two\n",
			"root/.shepherd/integrations/a.md": doc("a", "rules", extra),
			"root/.shepherd/integrations/b.md": doc(
				"b",
				"rules",
				"provides: craft\ndefault: true\ncharter-keys:\n  craft.value: required\n",
			),
		});
		expect(
			result.filter((f) =>
				["charter-key-required", "charter-key-undeclared"].includes(f.code),
			),
		).toEqual([]);
		expect(result.some((f) => f.code === "charter-slot-duplicate")).toBe(true);
	}
	const unresolved = findings({
		"root/.shepherd/charter.md": "Modules: a\n- software.grants: one\n",
		"root/.shepherd/integrations/a.md": doc(
			"a",
			"rules",
			"provides: craft\napplies-when:\n  has-children: true\n",
		),
	});
	expect(unresolved.some((f) => f.code === "module-slot-unresolved")).toBe(
		true,
	);
	expect(unresolved.some((f) => f.code === "charter-key-undeclared")).toBe(
		false,
	);
});

const repeated =
	"Keep every synthetic project decision visible to the team and record the exact reason for each change before proceeding with the next task.";
test("restatements normalize whole blocks and report first body with original source line", () => {
	const result = findings({
		"root/.shepherd/charter.md": `## Notes\n- ${repeated}\n\n${repeated}\n`,
		"root/.shepherd/integrations/a.md": doc(
			"a",
			`# Rules\n\n* ${repeated}\n\n${repeated}\n`,
		),
		"root/.shepherd/integrations/b.md": doc("b", repeated),
	});
	expect(result.filter((f) => f.code === "charter-module-restatement")).toEqual(
		[2, 4].map((line) => ({
			code: "charter-module-restatement",
			level: "info",
			file: "charter.md",
			line,
			message:
				"possible repeated rule: integrations/a.md:9; review ownership before removing text",
		})),
	);
});

test("restatement excludes short, fenced, quoted, slot, paraphrase and unmatched longer blocks", () => {
	const result = findings({
		"root/.shepherd/charter.md": `Short text.\n\n\`\`\`\n${repeated}\n\`\`\`\n\n> ${repeated}\n\n- a.value: ${repeated}\n  ${repeated}\n\nDifferent words express a similar idea about documenting all project decisions before continuing to work on the next item in the queue.\n\n${repeated} Additional unmatched text.\n`,
		"root/.shepherd/integrations/a.md": doc(
			"a",
			`Short text.\n${repeated}\n`,
			"charter-keys:\n  a.value: optional\n",
		),
	});
	expect(result.filter((f) => f.code === "charter-module-restatement")).toEqual(
		[],
	);
});

test("restatement order includes core and selected built-ins before inherited and local bodies", async () => {
	const { readFileSync } = await import("node:fs");
	const core = readFileSync(
		join(import.meta.dir, "../../system-prompts/shepherd/core.md"),
		"utf8",
	);
	const block = core
		.split(/\r?\n\s*\r?\n/)
		.find((p) => !p.startsWith("#") && words(p) >= 20);
	if (!block) throw new Error("no core prose block");
	const coreResult = findings({
		"root/.shepherd/charter.md": block,
		"root/.shepherd/integrations/a.md": doc("a", block),
	});
	expect(
		coreResult.find((f) => f.code === "charter-module-restatement")?.message,
	).toContain(
		`possible repeated rule: core:${core.slice(0, core.indexOf(block)).split("\n").length};`,
	);
	const software = packageModules(packageLocations(undefined)).find(
		(m) => m.package?.name === "software",
	);
	const softwareBlock = software?.body
		?.split(/\r?\n\s*\r?\n/)
		.find((p) => !p.startsWith("#") && words(p) >= 20);
	if (!softwareBlock || !software?.body)
		throw new Error("no software prose block");
	const files = {
		"root/.shepherd/charter.md": `Modules: software\n\n${softwareBlock}\n`,
		".shepherd/integrations/a.md": doc("a", softwareBlock),
		"root/.shepherd/integrations/b.md": doc("b", softwareBlock),
	};
	expect(
		findings(files).find((f) => f.code === "charter-module-restatement")
			?.message,
	).toContain(
		`possible repeated rule: ${software.source}:${software.bodyLine + software.body.slice(0, software.body.indexOf(softwareBlock)).split("\n").length - 1};`,
	);
	const inactive = findings({
		...files,
		"root/.shepherd/charter.md": softwareBlock,
	});
	expect(
		inactive.find((f) => f.code === "charter-module-restatement")?.message,
	).toContain("../../.shepherd/integrations/a.md:");
});

test("unknown tokens keep known declarations and absent required values have no invented line", () => {
	const result = findings({
		"root/.shepherd/charter.md": "Modules: unknown\n- inactive.value: unused\n",
		"root/.shepherd/integrations/inactive.md": doc(
			"inactive",
			"rules",
			"applies-when:\n  has-children: true\ncharter-keys:\n  inactive.value: optional\n",
		),
		"root/.shepherd/integrations/reader.md": doc(
			"reader",
			"rules",
			"charter-keys:\n  reader.value: required\n  reader.optional: optional\n",
		),
	});
	expect(result.find((f) => f.code === "charter-key-required")).toEqual({
		code: "charter-key-required",
		level: "warn",
		file: "charter.md",
		message: 'slot "reader.value" required by reader is missing or empty',
	});
	expect(
		result.filter((f) => f.code === "charter-key-undeclared"),
	).toHaveLength(1);
});

test("restatement normalization preserves case and punctuation with a twenty-word threshold", () => {
	const twenty =
		"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
	const body = `# Rules\r\n\r\n1. one two three four five\r\n   six seven eight nine ten\r\n* eleven twelve thirteen fourteen fifteen\r\n   sixteen seventeen eighteen nineteen twenty\r\n`;
	const result = findings({
		"root/.shepherd/charter.md": `${twenty}\n\n${twenty.toUpperCase()}\n\n${twenty}.\n\n${twenty.split(" ").slice(0, 19).join(" ")}\n`,
		"root/.shepherd/integrations/a.md": doc("a", body),
	});
	expect(result.filter((f) => f.code === "charter-module-restatement")).toEqual(
		[
			{
				code: "charter-module-restatement",
				level: "info",
				file: "charter.md",
				line: 1,
				message:
					"possible repeated rule: integrations/a.md:9; review ownership before removing text",
			},
		],
	);
});

test("metadata failures still allow independent duplicates and degraded body restatements", () => {
	const result = findings({
		"root/.shepherd/charter.md": `- software.grants: one\n- software.grants: two\n\n${repeated}\n`,
		"root/.shepherd/integrations/bad.md": doc(
			"bad",
			repeated,
			"unknown: true\n",
		),
	});
	expect(
		result.filter((f) => f.code === "charter-slot-duplicate"),
	).toHaveLength(1);
	expect(
		result.filter((f) => f.code === "charter-module-restatement"),
	).toHaveLength(1);
	expect(result.filter((f) => f.code === "charter-key-undeclared")).toEqual([]);
});

test("a list item's unindented continuation belongs to the entire match", () => {
	const result = findings({
		"root/.shepherd/charter.md": `- ${repeated}\nAdditional unmatched continuation.\n`,
		"root/.shepherd/integrations/a.md": doc("a", repeated),
	});
	expect(result.filter((f) => f.code === "charter-module-restatement")).toEqual(
		[],
	);
});

test("file bullets cause no charter findings even when a filename repeats", () => {
	const result = findings({
		"root/.shepherd/charter.md":
			"## Structure\n- package.json: scripts\n- biome.json: formatting\n- package.json: more scripts\n- index.ts: entry\n",
	});
	expect(result.filter((f) => f.code.startsWith("charter-"))).toEqual([]);
});

test("recognition uses exact valid candidate keys even when inactive", () => {
	const result = findings({
		"root/.shepherd/charter.md":
			"- inactive.value: unused\n- craft.value: unused\n- invalid.value: prose\n- invalid.value: prose again\n- legacy.value: prose\n",
		"root/.shepherd/integrations/inactive.md": doc(
			"inactive",
			"rules",
			"provides: craft\napplies-when:\n  has-children: true\ncharter-keys:\n  craft.value: optional\n",
		),
		"root/.shepherd/integrations/invalid.md": doc(
			"invalid",
			"rules",
			"unknown: true\n",
		),
		"root/.shepherd/integrations/legacy.md": "rules",
	});
	expect(result.some((f) => f.code === "charter-slot-duplicate")).toBe(false);
	const valid = findings({
		"root/.shepherd/charter.md":
			"- inactive.value: unused\n- craft.value: unused\n",
		"root/.shepherd/integrations/inactive.md": doc(
			"inactive",
			"rules",
			"provides: craft\napplies-when:\n  has-children: true\ncharter-keys:\n  craft.value: optional\n",
		),
	});
	expect(
		valid.filter((f) => f.code === "charter-key-undeclared").map((f) => f.line),
	).toEqual([2]);
});

test("core bullets warn without duplicates and unknown core keys use the ordinary message", () => {
	const result = findings({
		"root/.shepherd/charter.md":
			"- core.done: None\n- core.done: None\n- core.unknown: None\n- core.unknown: None\n",
	});
	expect(result.filter((f) => f.code.startsWith("charter-"))).toEqual(
		[1, 2, 3, 4].map((line) => ({
			code: "charter-key-undeclared",
			level: "warn",
			file: "charter.md",
			line,
			message:
				line <= 2
					? 'slot "core.done" uses the heading form, not a module-key bullet'
					: 'slot "core.unknown" is not declared by the loaded modules',
		})),
	);
});

test("restatements match entire words and preserve the earliest valid source line", () => {
	const phrase =
		"open the issue and keep every synthetic project decision visible to the team while recording the exact reason for each change";
	const result = findings({
		"root/.shepherd/charter.md": phrase,
		"root/.shepherd/integrations/a.md": doc(
			"a",
			`Re${phrase}\n\n${phrase}d\n\n${phrase}\n`,
		),
	});
	expect(
		result.find((f) => f.code === "charter-module-restatement")?.message,
	).toBe(
		"possible repeated rule: integrations/a.md:11; review ownership before removing text",
	);
	const unmatched = findings({
		"root/.shepherd/charter.md": phrase,
		"root/.shepherd/integrations/a.md": doc("a", `Re${phrase}\n\n${phrase}d\n`),
	});
	expect(unmatched.some((f) => f.code === "charter-module-restatement")).toBe(
		false,
	);
});

test("no charter does not warn about required keys but an empty charter does", async () => {
	const { charterFindings } = await import("./check-charter");
	const { parseModule } = await import("./module-format");
	const raw = doc(
		"reader",
		"rules",
		"charter-keys:\n  reader.value: required\n",
	);
	const candidate = {
		...parseModule(raw, "reader.md"),
		raw,
		name: "reader.md",
		source: "/workspace/.shepherd/integrations/reader.md",
		path: "/workspace/.shepherd/integrations/reader.md",
		layer: "local" as const,
	};
	const catalog = { candidates: [candidate], children: [], published: false };
	expect(charterFindings(catalog, "/workspace/.shepherd")).toEqual([]);
	expect(
		charterFindings({ ...catalog, charter: "" }, "/workspace/.shepherd").filter(
			(f) => f.code === "charter-key-required",
		),
	).toHaveLength(1);
});

test("file and undeclared key bullets stay prose even in candidate namespaces", () => {
	const prose = `- software.md: ${repeated}\n`;
	const result = findings({
		"root/.shepherd/charter.md": `## Structure\n${prose}${prose}- notes.md: file\n- notes.md: file\n- software.grant: typo\n`,
		"root/.shepherd/integrations/notes.md": doc("notes", prose),
	});
	expect(
		result.filter((f) =>
			["charter-slot-duplicate", "charter-key-undeclared"].includes(f.code),
		),
	).toEqual([]);
	expect(
		result.filter((f) => f.code === "charter-module-restatement"),
	).toHaveLength(2);
});
test("check conflict candidate paths are workspace relative", () => {
	const result = findings({
		".shepherd/charter.md": "",
		".shepherd/integrations/alt.md": doc("alt", "rules"),
		"root/.shepherd/charter.md": "Modules: alt\n",
		"root/.shepherd/integrations/alt.md": doc(
			"alt",
			"rules",
			"provides: craft\n",
		),
	});
	expect(result.find((f) => f.code === "module-slot-conflict")?.message).toBe(
		'slot "craft": explicit provider name is ambiguous; candidates: ../../.shepherd/integrations/alt.md, integrations/alt.md; no provider loaded',
	);
});
test("same-realpath local candidates report no repeated schema or cost findings", async () => {
	const { moduleFindings } = await import("./check-modules");
	const { moduleCatalog } = await import("./module-resolution");
	for (const extra of ["unknown: true\n", ""]) {
		const t = makeTree(
			{
				"parent/.shepherd/charter.md": "",
				"parent/.shepherd/integrations/bad.md": doc("bad", "rules", extra),
				"parent/child/.shepherd/charter.md": "",
			},
			{
				symlinks: {
					"parent/child/.shepherd/integrations/bad.md":
						"parent/.shepherd/integrations/bad.md",
				},
			},
		);
		cleanups.push(t.cleanup);
		const state = join(t.root, "parent/child/.shepherd");
		const result = moduleFindings(
			moduleCatalog(join(t.root, "parent/child")),
			state,
		);
		expect(
			result.filter((f) => ["module-schema", "module-cost"].includes(f.code)),
		).toHaveLength(1);
		expect(
			result.find((f) => f.code === "module-duplicate")?.message,
		).toContain("same file");
	}
});
