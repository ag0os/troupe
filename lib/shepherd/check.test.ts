import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkWorkspace, type Finding } from "./check";
import { type Config, DEFAULT_MARKS, DEFAULT_WINDOWS } from "./config";
import { type MakeTreeOptions, makeTree } from "./test-support";
import { discoverTree } from "./tree";

const TODAY = new Date(2026, 9, 5);
const MEMORY = `---
name: note
description: A note
type: reference
---
Text
`;
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
	const root = join(result.root, "root");
	const tree = discoverTree(root);
	return { root, tree, workspace: tree.root };
}

function finding(findings: Finding[], code: string): Finding {
	const match = findings.find((candidate) => candidate.code === code);
	if (!match) throw new Error(`missing ${code}: ${JSON.stringify(findings)}`);
	return match;
}

describe("checkWorkspace", () => {
	test("reports config-invalid for a problem in this workspace", () => {
		const { workspace, tree } = fixture();
		const file = join(workspace.state, "config.json");
		const findings = checkWorkspace(
			workspace,
			tree,
			config({
				problems: [
					{ file, key: "marks.extra", problem: "unknown key" },
					{ file: "/elsewhere/config.json", key: "x", problem: "unknown key" },
				],
			}),
			TODAY,
		);

		expect(finding(findings, "config-invalid")).toEqual({
			level: "error",
			code: "config-invalid",
			file: "config.json",
			message: "marks.extra: unknown key",
		});
		expect(
			findings.filter(({ code }) => code === "config-invalid"),
		).toHaveLength(1);
	});

	test("reports charter-missing", () => {
		const files = { ...cleanFiles };
		delete (files as Partial<typeof cleanFiles>)["root/.shepherd/charter.md"];
		const { root, cleanup } = makeTree(files);
		cleanups.push(cleanup);
		const tree = discoverTree(join(root, "root"));

		expect(
			finding(
				checkWorkspace(tree.root, tree, config(), TODAY),
				"charter-missing",
			),
		).toMatchObject({
			level: "info",
			file: "charter.md",
		});
	});

	test("reports charter-over-mark", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/charter.md": "one two three",
		});
		const settings = config({ marks: { ...DEFAULT_MARKS, charter: 2 } });

		expect(
			finding(
				checkWorkspace(workspace, tree, settings, TODAY),
				"charter-over-mark",
			).message,
		).toContain("3 words, past the 2-word review mark");
	});

	test("reports current-missing", () => {
		const { root, cleanup } = makeTree({
			"root/.shepherd/charter.md": "A charter",
		});
		cleanups.push(cleanup);
		const tree = discoverTree(join(root, "root"));

		expect(
			finding(
				checkWorkspace(tree.root, tree, config(), TODAY),
				"current-missing",
			),
		).toMatchObject({
			level: "error",
			file: "CURRENT.md",
			message: "CURRENT.md is missing",
		});
	});

	test("reports current-over-mark", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/CURRENT.md": "Updated: 2026-10-05\nLots of words",
		});
		const settings = config({ marks: { ...DEFAULT_MARKS, current: 2 } });

		expect(
			finding(
				checkWorkspace(workspace, tree, settings, TODAY),
				"current-over-mark",
			).message,
		).toContain("5 words, past the 2-word review mark");
	});

	test("reports current-no-updated", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/CURRENT.md": "Current work",
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"current-no-updated",
			),
		).toMatchObject({
			level: "info",
			file: "CURRENT.md",
		});
	});

	test("reports current-stale only after the configured window", () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = "America/Argentina/Buenos_Aires";
		const { workspace, tree } = fixture({
			"root/.shepherd/CURRENT.md": "Updated: 2026-09-27",
		});
		try {
			expect(
				checkWorkspace(workspace, tree, config(), new Date(2026, 9, 4)).some(
					({ code }) => code === "current-stale",
				),
			).toBeFalse();
			expect(
				finding(
					checkWorkspace(workspace, tree, config(), new Date(2026, 9, 5)),
					"current-stale",
				),
			).toMatchObject({
				level: "warn",
				message: "last updated 2026-09-27, 8 days ago",
			});
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	test("reports handoff-file", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/HANDOFF.md": "Old handoff",
		});

		expect(
			finding(checkWorkspace(workspace, tree, config(), TODAY), "handoff-file"),
		).toMatchObject({
			level: "info",
			file: "HANDOFF.md",
		});
	});

	test("reports shared-over-mark for a workspace with a descendant", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/integrations/one.md": "one two",
			"root/.shepherd/integrations/two.md": "three four",
			"root/child/.shepherd/charter.md": "Child",
			"root/child/.shepherd/CURRENT.md": "Updated: 2026-10-05",
		});
		const settings = config({ marks: { ...DEFAULT_MARKS, shared: 3 } });

		expect(
			finding(
				checkWorkspace(workspace, tree, settings, TODAY),
				"shared-over-mark",
			),
		).toMatchObject({
			level: "warn",
			file: "integrations",
		});
	});

	test("reports both kinds of module-duplicate", () => {
		const { root, cleanup } = makeTree(
			{
				...cleanFiles,
				"root/.shepherd/integrations/rules.md": "Inherited",
				"root/same/.shepherd/charter.md": "Same",
				"root/same/.shepherd/CURRENT.md": "Updated: 2026-10-05",
				"root/copy/.shepherd/charter.md": "Copy",
				"root/copy/.shepherd/CURRENT.md": "Updated: 2026-10-05",
				"root/copy/.shepherd/integrations/rules.md": "A copy",
			},
			{
				symlinks: {
					"root/same/.shepherd/integrations/rules.md":
						"root/.shepherd/integrations/rules.md",
				},
			},
		);
		cleanups.push(cleanup);
		const tree = discoverTree(join(root, "root"));
		const same = tree.workspaces.find(({ name }) => name === "same");
		const copy = tree.workspaces.find(({ name }) => name === "copy");
		if (!same || !copy) throw new Error("missing child fixtures");

		expect(
			finding(checkWorkspace(same, tree, config(), TODAY), "module-duplicate")
				.message,
		).toContain("same file");
		expect(
			finding(checkWorkspace(copy, tree, config(), TODAY), "module-duplicate")
				.message,
		).toContain("both load");
	});

	test("reports broken-symlink anywhere under state", () => {
		const { workspace, tree } = fixture(
			{},
			{
				symlinks: { "root/.shepherd/docs/missing.md": "does-not-exist" },
			},
		);

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"broken-symlink",
			),
		).toMatchObject({
			level: "error",
			file: "docs/missing.md",
		});
	});

	test("reports memory-index-missing", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/memories/note.md": MEMORY,
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"memory-index-missing",
			),
		).toMatchObject({
			level: "error",
			file: "MEMORY.md",
		});
	});

	test("reports memory-index-dangling with its line", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "# Index\n\n[Missing](memories/missing.md)\n",
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"memory-index-dangling",
			),
		).toEqual({
			level: "error",
			code: "memory-index-dangling",
			file: "MEMORY.md",
			line: 3,
			message: "index points at missing memories/missing.md",
		});
	});

	test("reports memory-unlisted", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "# Index\n",
			"root/.shepherd/memories/note.md": MEMORY,
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"memory-unlisted",
			),
		).toMatchObject({
			level: "error",
			file: "memories/note.md",
		});
	});

	test("reports memory-no-frontmatter", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "[Note](memories/note.md)",
			"root/.shepherd/memories/note.md": "No metadata",
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"memory-no-frontmatter",
			),
		).toMatchObject({
			level: "warn",
			file: "memories/note.md",
		});
	});

	test("reports one memory-frontmatter-key finding per missing key", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "[Note](memories/note.md)",
			"root/.shepherd/memories/note.md": "---\nname: note\n---\nText",
		});
		const findings = checkWorkspace(workspace, tree, config(), TODAY).filter(
			({ code }) => code === "memory-frontmatter-key",
		);

		expect(findings.map(({ message }) => message)).toEqual([
			"frontmatter lacks `description`",
			"frontmatter lacks `type`",
		]);
	});

	test("reports memory-type", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "[Note](memories/note.md)",
			"root/.shepherd/memories/note.md": MEMORY.replace("reference", "other"),
		});

		expect(
			finding(checkWorkspace(workspace, tree, config(), TODAY), "memory-type")
				.message,
		).toContain("type `other`");
	});

	test("reports memory-name", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "[Note](memories/note.md)",
			"root/.shepherd/memories/note.md": MEMORY.replace(
				"name: note",
				"name: other",
			),
		});

		expect(
			finding(checkWorkspace(workspace, tree, config(), TODAY), "memory-name")
				.message,
		).toContain("doesn't match the filename");
	});

	test("reports docs-index-missing", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/docs/guide.md": "Guide",
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"docs-index-missing",
			),
		).toEqual({
			level: "warn",
			code: "docs-index-missing",
			file: "docs/INDEX.md",
			message: "1 docs but no docs/INDEX.md",
		});
	});

	test("reports doc-unlisted unless a parent README is indexed", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/docs/INDEX.md": "[Area](area/README.md)",
			"root/.shepherd/docs/area/README.md": "Area",
			"root/.shepherd/docs/area/listed-by-folder.md": "Covered",
			"root/.shepherd/docs/loose.md": "Loose",
		});
		const findings = checkWorkspace(workspace, tree, config(), TODAY).filter(
			({ code }) => code === "doc-unlisted",
		);

		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			level: "warn",
			file: "docs/loose.md",
			message: "not listed in docs/INDEX.md",
		});
	});

	test("returns no findings for a clean workspace", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "[Note](memories/note.md)",
			"root/.shepherd/memories/note.md": MEMORY,
			"root/.shepherd/docs/INDEX.md": "[Guide](guide.md)",
			"root/.shepherd/docs/guide.md": "Guide",
		});

		expect(checkWorkspace(workspace, tree, config(), TODAY)).toEqual([]);
	});
});
