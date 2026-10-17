import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { moduleCatalog, resolveModules } from "./module-resolution";
import { makeTree } from "./test-support";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
export function moduleText(name: string, extra = "", body = `${name} body\n`) {
	return `---\nname: ${name}\ntype: domain\ndescription: ${name} rules\nbudget: 10\n${extra}---\n${body}`;
}
function launch(
	files: Record<string, string>,
	tokens: string,
	symlinks: Record<string, string> = {},
) {
	const tree = makeTree(
		{
			"parent/.shepherd/charter.md": "",
			"parent/child/.shepherd/charter.md": `Modules: ${tokens}\n`,
			...files,
		},
		{ symlinks },
	);
	cleanups.push(tree.cleanup);
	const catalog = moduleCatalog(join(tree.root, "parent/child"));
	return { catalog, ...resolveModules(catalog) };
}
const provider = (name: string, extra = "") =>
	moduleText(name, `provides: craft\n${extra}`);
test("defaults, explicit alternatives and slot-plus-name preserve layer order", () => {
	for (const [token, expected] of [
		["craft", "base.md"],
		["alt", "alt.md"],
		["craft, alt", "alt.md"],
	]) {
		const r = launch(
			{
				"parent/.shepherd/integrations/base.md": provider(
					"base",
					"default: true\n",
				),
				"parent/child/.shepherd/integrations/alt.md": provider("alt"),
			},
			token ?? "",
		);
		expect(r.problems).toEqual([]);
		expect(r.selected.map((m) => m.name)).toEqual([
			"herdr.md",
			"inter-agent.md",
			"nested.md",
			expected ?? "",
		]);
	}
});
test("conflicts suppress only affected slot; unknown tokens keep software", () => {
	for (const token of ["craft", "base, alt"]) {
		const r = launch(
			{
				"parent/.shepherd/integrations/base.md": provider(
					"base",
					"default: true\n",
				),
				"parent/child/.shepherd/integrations/alt.md": provider(
					"alt",
					"default: true\n",
				),
			},
			`${token}, software, docs`,
		);
		expect(r.problems.map((p) => p.code)).toEqual([
			"module-slot-conflict",
			"module-token-unknown",
		]);
		expect(r.selected.map((m) => m.package?.name)).toContain("software");
		expect(r.selected.some((m) => m.metadata?.provides === "craft")).toBe(
			false,
		);
	}
});
test("ineligible explicit providers and missing defaults are unresolved", () => {
	for (const token of ["craft", "alt"]) {
		const r = launch(
			{
				"parent/child/.shepherd/integrations/alt.md": provider(
					"alt",
					"applies-when:\n  has-children: true\n",
				),
			},
			token,
		);
		expect(r.problems[0]?.code).toBe("module-slot-unresolved");
		expect(r.selected.some((m) => m.name === "alt.md")).toBe(false);
	}
});
test("publication precedes filtering and providers satisfy charter predicate", () => {
	const r = launch(
		{
			"parent/.shepherd/integrations/inactive.md": moduleText(
				"inactive",
				"applies-when:\n  has-children: true\n",
			),
			"parent/child/.shepherd/integrations/alt.md": moduleText(
				"alt",
				"provides: software\napplies-when:\n  charter-declares: software\n",
			),
		},
		"alt",
	);
	expect(r.selected.map((m) => m.name)).toEqual([
		"herdr.md",
		"inter-agent.md",
		"nested.md",
		"alt.md",
	]);
});
test("duplicate nonproviders load; ambiguous explicit providers fail; realpath dedupe first", () => {
	const files = {
		"parent/.shepherd/integrations/base.md": moduleText("base"),
		"parent/child/.shepherd/integrations/base.md": moduleText("base"),
	};
	expect(
		launch(files, "base").selected.filter((m) => m.name === "base.md"),
	).toHaveLength(2);
	const providers = Object.fromEntries(
		Object.keys(files).map((path) => [
			path,
			provider("base", "default: true\n"),
		]),
	);
	expect(launch(providers, "base").problems[0]?.code).toBe(
		"module-slot-conflict",
	);
	delete providers["parent/child/.shepherd/integrations/base.md"];
	const r = launch(providers, "craft", {
		"parent/child/.shepherd/integrations/base.md":
			"parent/.shepherd/integrations/base.md",
	});
	expect(r.problems).toEqual([]);
	expect(r.selected.filter((m) => m.name === "base.md")).toHaveLength(1);
});
test("slot name wins over same-name provider and unrequested providers remain out", () => {
	const files = {
		"parent/child/.shepherd/integrations/craft.md": provider("craft"),
		"parent/child/.shepherd/integrations/alt.md": provider(
			"alt",
			"default: true\n",
		),
	};
	expect(launch(files, "craft").selected.at(-1)?.name).toBe("alt.md");
	expect(launch(files, "").selected.some((m) => m.metadata?.provides)).toBe(
		false,
	);
});

test("deduped local copies do not duplicate inherited degradation problems", async () => {
	const r = launch(
		{
			"parent/.shepherd/integrations/bad.md": moduleText("bad").replace(
				"budget: 10",
				"budget: x",
			),
		},
		"",
		{
			"parent/child/.shepherd/integrations/bad.md":
				"parent/.shepherd/integrations/bad.md",
		},
	);
	expect(r.problems).toHaveLength(1);
	expect(r.problems[0]?.file).toBe(
		r.catalog.candidates.find((m) => m.layer === "inherited")?.source ?? "",
	);
	expect(r.problems[0]?.message).toContain("stripped body loaded ungated");
	expect(r.selected.filter((m) => m.name === "bad.md")).toHaveLength(1);
	const { moduleFindings } = await import("./check-modules");
	expect(
		moduleFindings(
			r.catalog,
			join(r.catalog.enclosing ?? "", "child/.shepherd"),
		),
	).toContainEqual(
		expect.objectContaining({
			code: "module-duplicate",
			message:
				"local bad.md is the same file as the inherited module; it is skipped at launch",
		}),
	);
});

test("ambiguous provider name lists the same-named nonprovider too", () => {
	const r = launch(
		{
			"parent/.shepherd/integrations/alt.md": moduleText("alt"),
			"parent/child/.shepherd/integrations/alt.md": provider("alt"),
		},
		"alt",
	);
	const conflict = r.problems.find((p) => p.code === "module-slot-conflict");
	expect(conflict?.message).toContain("explicit provider name is ambiguous");
	for (const m of r.catalog.candidates.filter((m) => m.name === "alt.md"))
		expect(conflict?.message).toContain(m.source);
	expect(r.selected.some((m) => m.metadata?.provides === "craft")).toBe(false);
});
