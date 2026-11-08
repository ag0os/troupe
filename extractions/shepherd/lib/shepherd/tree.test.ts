import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeTree } from "./test-support";
import {
	discoverTree,
	selectWorkspaces,
	type Workspace,
	WorkspaceTreeError,
} from "./tree";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
	const result = makeTree({
		"root/.shepherd/CURRENT.md": "root",
		"root/a/.shepherd/CURRENT.md": "a",
		"root/a/inner/.shepherd/CURRENT.md": "inner",
		"root/group/b/.shepherd/CURRENT.md": "b",
		"root/plain/file.txt": "plain",
	});
	cleanups.push(result.cleanup);
	return result.root;
}

function names(workspaces: Workspace[]): string[] {
	return workspaces.map(({ name }) => name);
}

describe("discoverTree", () => {
	test("finds the outer root and nested workspaces with stable names", () => {
		const base = fixture();
		const root = join(base, "root");
		const tree = discoverTree(join(root, "a", "inner"));

		expect(tree.home).toBe(join(root, "a", "inner"));
		expect(tree.root).toEqual({
			name: "root",
			dir: root,
			state: join(root, ".shepherd"),
		});
		expect(names(tree.workspaces)).toEqual(["root", "a", "a/inner", "group/b"]);
	});

	test("resets the search depth at each workspace boundary", () => {
		const { root: base, cleanup } = makeTree({
			"root/.shepherd/CURRENT.md": "root",
			"root/one/two/at-limit/.shepherd/CURRENT.md": "limit",
			"root/one/two/three/too-deep/.shepherd/CURRENT.md": "deep",
			"root/one/two/at-limit/one/two/nested/.shepherd/CURRENT.md": "nested",
		});
		cleanups.push(cleanup);

		expect(names(discoverTree(join(base, "root")).workspaces)).toEqual([
			"root",
			"one/two/at-limit",
			"one/two/at-limit/one/two/nested",
		]);
	});

	test("skips hidden, node_modules and symlinked directories", () => {
		const { root: base, cleanup } = makeTree(
			{
				"root/.shepherd/CURRENT.md": "root",
				"root/visible/.shepherd/CURRENT.md": "visible",
				"root/.hidden/child/.shepherd/CURRENT.md": "hidden",
				"root/node_modules/package/.shepherd/CURRENT.md": "package",
				"outside/.shepherd/CURRENT.md": "outside",
			},
			{ symlinks: { "root/linked": "outside" } },
		);
		cleanups.push(cleanup);

		expect(names(discoverTree(join(base, "root")).workspaces)).toEqual([
			"root",
			"visible",
		]);
	});

	test("rejects a non-workspace with or without an enclosing workspace", () => {
		const base = fixture();
		const inside = join(base, "root", "plain");
		const outside = join(base, "outside");
		mkdirSync(outside);

		for (const path of [inside, outside]) {
			try {
				discoverTree(path);
				throw new Error("expected discovery to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(WorkspaceTreeError);
				expect(error).toMatchObject({ exitCode: 2 });
				expect((error as Error).message).toBe(`not a workspace: ${path}`);
			}
		}
	});
});

describe("selectWorkspaces", () => {
	test("uses check and archive defaults from each workspace level", () => {
		const base = fixture();
		const root = join(base, "root");
		const cases = [
			{
				home: root,
				check: ["root", "a", "a/inner", "group/b"],
				archive: ["root"],
			},
			{ home: join(root, "a"), check: ["a", "a/inner"], archive: ["a"] },
			{
				home: join(root, "a", "inner"),
				check: ["a/inner"],
				archive: ["a/inner"],
			},
		];

		for (const expected of cases) {
			const tree = discoverTree(expected.home);
			expect(names(selectWorkspaces(tree, [], "check"))).toEqual(
				expected.check,
			);
			expect(names(selectWorkspaces(tree, [], "archive"))).toEqual(
				expected.archive,
			);
			expect(names(selectWorkspaces(tree, [], "archive-recursive"))).toEqual(
				expected.check,
			);
		}
	});

	test("selectors replace the default scope and preserve tree order", () => {
		const base = fixture();
		const tree = discoverTree(join(base, "root", "a"));

		expect(
			names(selectWorkspaces(tree, ["group/b", "root"], "archive")),
		).toEqual(["root", "group/b"]);
	});

	test("reports unknown selectors and all available names", () => {
		const base = fixture();
		const tree = discoverTree(join(base, "root"));

		expect(() => selectWorkspaces(tree, ["missing"], "check")).toThrow(
			"unknown workspace: missing (have: root, a, a/inner, group/b)",
		);
		try {
			selectWorkspaces(tree, ["missing"], "check");
		} catch (error) {
			expect(error).toMatchObject({ exitCode: 2 });
		}
	});
});

test("makeTree writes files, symlinks and modification times", () => {
	const modified = new Date("2026-09-30T12:00:00Z");
	const { root, cleanup } = makeTree(
		{ "target/file.md": "contents" },
		{
			symlinks: { linked: "target" },
			mtimes: { "target/file.md": modified },
		},
	);
	cleanups.push(cleanup);

	expect(readFileSync(join(root, "linked", "file.md"), "utf8")).toBe(
		"contents",
	);
	expect(statSync(join(root, "target", "file.md")).mtime).toEqual(modified);
});
