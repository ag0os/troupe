import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyArchive, planArchive, renderArchive } from "./archive";
import { type Config, DEFAULT_MARKS, DEFAULT_WINDOWS } from "./config";
import { makeTree } from "./test-support";
import { discoverTree } from "./tree";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function config(): Config {
	return {
		marks: { ...DEFAULT_MARKS },
		windows: { ...DEFAULT_WINDOWS },
		codex: {},
		problems: [],
	};
}

test("rewrites all four reference forms throughout the tree", () => {
	const result = makeTree({
		"root/.shepherd/charter.md": "Root",
		"root/.shepherd/CURRENT.md":
			"a/.shepherd/work/done/release and a/.shepherd/work/done/release-notes\n",
		"root/.shepherd/journal.md": "a/.shepherd/work/done/release\n",
		"root/.shepherd/work/done/core/STATUS.md":
			"---\nclosed: 2026-08-01\n---\n# Core\n",
		"root/a/.shepherd/charter.md": "A",
		"root/a/.shepherd/CURRENT.md": [
			".shepherd/work/done/release",
			"work/done/release",
			"work/done/release-notes",
		].join("\n"),
		"root/a/.shepherd/docs/guide.md": "../work/done/release\n",
		"root/a/.shepherd/journal.md": "work/done/release\n",
		"root/a/.shepherd/work/in-progress/active/STATUS.md":
			"../../done/release\n",
		"root/a/.shepherd/work/done/release/STATUS.md":
			"---\nclosed: 2026-08-01\n---\n# Release\n",
		"root/group/b/.shepherd/charter.md": "B",
		"root/group/b/.shepherd/CURRENT.md": [
			"a/.shepherd/work/done/release",
			"root/.shepherd/work/done/core",
		].join("\n"),
		"root/group/b/.shepherd/archive/journal/2026-07.md":
			"root/.shepherd/work/done/core\n",
	});
	cleanups.push(result.cleanup);
	const tree = discoverTree(join(result.root, "root"));
	const root = tree.root;
	const child = tree.workspaces.find(({ name }) => name === "a");
	if (!child) throw new Error("missing child fixture");

	const applied = applyArchive(
		planArchive([root, child], config(), new Date(2026, 9, 5)),
		tree,
	);

	expect(readFileSync(join(root.state, "CURRENT.md"), "utf8")).toBe(
		"a/.shepherd/archive/2026-08/release and a/.shepherd/work/done/release-notes\n",
	);
	expect(readFileSync(join(child.state, "CURRENT.md"), "utf8")).toBe(
		[
			".shepherd/archive/2026-08/release",
			"archive/2026-08/release",
			"work/done/release-notes",
		].join("\n"),
	);
	expect(readFileSync(join(child.state, "docs/guide.md"), "utf8")).toBe(
		"../archive/2026-08/release\n",
	);
	expect(
		readFileSync(
			join(child.state, "work/in-progress/active/STATUS.md"),
			"utf8",
		),
	).toBe("../../../archive/2026-08/release\n");
	const nested = tree.workspaces.find(({ name }) => name === "group/b");
	if (!nested) throw new Error("missing nested fixture");
	expect(readFileSync(join(nested.state, "CURRENT.md"), "utf8")).toBe(
		[
			"a/.shepherd/archive/2026-08/release",
			"root/.shepherd/archive/2026-08/core",
		].join("\n"),
	);
	expect(readFileSync(join(root.state, "journal.md"), "utf8")).toBe(
		"a/.shepherd/work/done/release\n",
	);
	expect(readFileSync(join(child.state, "journal.md"), "utf8")).toBe(
		"work/done/release\n",
	);
	expect(
		readFileSync(join(nested.state, "archive/journal/2026-07.md"), "utf8"),
	).toBe("root/.shepherd/work/done/core\n");
	expect(applied.rewrittenFiles).toEqual([
		join(root.state, "CURRENT.md"),
		join(child.state, "CURRENT.md"),
		join(child.state, "docs/guide.md"),
		join(child.state, "work/in-progress/active/STATUS.md"),
		join(nested.state, "CURRENT.md"),
	]);
	expect(renderArchive(applied)).toContain(
		"\nRewrote references in 5 file(s):\n",
	);
	for (const file of applied.rewrittenFiles) {
		expect(renderArchive(applied)).toContain(`  ${file}`);
	}
});
