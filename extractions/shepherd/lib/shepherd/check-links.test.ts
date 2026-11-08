import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./check";
import { checkLinks } from "./check-links";
import { makeTree } from "./test-support";
import { discoverTree } from "./tree";

const cleanFiles = {
	"root/.shepherd/charter.md": "A charter",
	"root/.shepherd/CURRENT.md": "Updated: 2026-10-05\nCurrent work",
};
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(files: Record<string, string> = {}) {
	const result = makeTree({ ...cleanFiles, ...files });
	cleanups.push(result.cleanup);
	const tree = discoverTree(join(result.root, "root"));
	return { home: result.root, tree, workspace: tree.root };
}

function findingsWithCode(findings: Finding[], code: string): Finding[] {
	return findings.filter((finding) => finding.code === code);
}

describe("checkLinks", () => {
	test("reports broken links with anchors, URI decoding and malformed escapes", () => {
		const { home, tree, workspace } = fixture({
			"root/.shepherd/docs/with space.md": "Present",
			"root/.shepherd/CURRENT.md": [
				"Updated: 2026-10-05",
				"[Present](docs/with%20space.md#heading)",
				"[Missing](docs/missing.md#heading)",
				"[Malformed](docs/bad%ZZ.md)",
				"[Web](https://example.com/missing)",
				"[Outside](/not-under-the-root)",
				"```",
				"[Fenced](docs/fenced.md)",
				"```",
			].join("\n"),
		});

		expect(
			findingsWithCode(checkLinks(workspace, tree, home), "link-broken"),
		).toEqual([
			{
				level: "error",
				code: "link-broken",
				file: "CURRENT.md",
				line: 3,
				message: "link to docs/missing.md#heading does not resolve",
			},
			{
				level: "error",
				code: "link-broken",
				file: "CURRENT.md",
				line: 4,
				message: "link to docs/bad%ZZ.md does not resolve",
			},
		]);
	});

	test("reports broken backticked paths and skips patterns", () => {
		const { home, tree, workspace } = fixture({
			"root/.shepherd/docs/present.md": "Present",
			"root/.shepherd/CURRENT.md": [
				"Updated: 2026-10-05",
				"`./docs/present.md`",
				"`./docs/missing.md`",
				"`./docs/<name>.md`",
				"~~~text",
				"`./docs/fenced.md`",
				"~~~",
			].join("\n"),
		});

		expect(
			findingsWithCode(checkLinks(workspace, tree, home), "path-broken"),
		).toEqual([
			{
				level: "error",
				code: "path-broken",
				file: "CURRENT.md",
				line: 3,
				message: "path ./docs/missing.md does not resolve",
			},
		]);
	});

	test("reports wikilinks that match no memory or Markdown base name", () => {
		const { home, tree, workspace } = fixture({
			"root/.shepherd/memories/note.md": "A memory",
			"root/.shepherd/docs/guide.md": "A guide",
			"root/.shepherd/MEMORY.md": [
				"[[note]] [[guide]] [[missing]] `[[inline]]`",
				"```",
				"[[fenced]]",
				"```",
			].join("\n"),
		});

		expect(
			findingsWithCode(checkLinks(workspace, tree, home), "wikilink-broken"),
		).toEqual([
			{
				level: "error",
				code: "wikilink-broken",
				file: "MEMORY.md",
				line: 1,
				message: "[[missing]] matches no memory or doc",
			},
		]);
	});

	test("reports moved item references with state and archive hints", () => {
		const { home, tree, workspace } = fixture({
			"root/.shepherd/CURRENT.md": [
				"Updated: 2026-10-05",
				"work/todo/active",
				"work/todo/old",
				"work/todo/missing",
			].join("\n"),
			"root/.shepherd/work/in-progress/active/STATUS.md": "Active",
			"root/.shepherd/archive/2026-09/old/STATUS.md": "Old",
		});

		expect(
			findingsWithCode(checkLinks(workspace, tree, home), "item-ref-broken"),
		).toEqual([
			{
				level: "error",
				code: "item-ref-broken",
				file: "CURRENT.md",
				line: 2,
				message: "work/todo/active does not exist (now in work/in-progress/)",
			},
			{
				level: "error",
				code: "item-ref-broken",
				file: "CURRENT.md",
				line: 3,
				message: "work/todo/old does not exist (now in archive/2026-09/)",
			},
			{
				level: "error",
				code: "item-ref-broken",
				file: "CURRENT.md",
				line: 4,
				message: "work/todo/missing does not exist",
			},
		]);
	});

	test("resolves nested and root cross-workspace references", () => {
		const { home, tree, workspace } = fixture({
			"root/a/.shepherd/charter.md": "A",
			"root/a/.shepherd/CURRENT.md": "Updated: 2026-10-05",
			"root/a/.shepherd/work/todo/first/STATUS.md": "First",
			"root/a/inner/.shepherd/charter.md": "Inner",
			"root/a/inner/.shepherd/CURRENT.md": "Updated: 2026-10-05",
			"root/a/inner/.shepherd/work/todo/second/STATUS.md": "Second",
			"root/.shepherd/work/todo/root-item/STATUS.md": "Root",
		});
		writeFileSync(
			join(workspace.state, "CURRENT.md"),
			[
				"Updated: 2026-10-05",
				"a/.shepherd/work/todo/first",
				"a/inner/.shepherd/work/todo/second",
				`${join(workspace.dir, ".shepherd")}/work/todo/root-item`,
				"~/root/.shepherd/work/todo/root-item",
				"a/.shepherd/work/todo/missing-first",
				"a/inner/.shepherd/work/todo/missing-second",
				`${join(workspace.dir, ".shepherd")}/work/todo/absolute-root`,
				"~/root/.shepherd/work/todo/home-root",
			].join("\n"),
		);

		expect(
			findingsWithCode(
				checkLinks(workspace, tree, home),
				"item-ref-broken",
			).map(({ line, message }) => ({ line, message })),
		).toEqual([
			{
				line: 6,
				message: "work/todo/missing-first does not exist",
			},
			{
				line: 7,
				message: "work/todo/missing-second does not exist",
			},
			{
				line: 8,
				message: "work/todo/absolute-root does not exist",
			},
			{
				line: 9,
				message: "work/todo/home-root does not exist",
			},
		]);
	});

	test("downgrades findings in done item status files", () => {
		const { home, tree, workspace } = fixture({
			"root/.shepherd/work/done/closed/STATUS.md": [
				"[Missing](missing.md)",
				"`./missing.md`",
				"[[missing]]",
				"work/todo/missing",
			].join("\n"),
		});

		expect(checkLinks(workspace, tree, home)).toEqual([
			expect.objectContaining({ level: "info", code: "link-broken" }),
			expect.objectContaining({ level: "info", code: "path-broken" }),
			expect.objectContaining({ level: "info", code: "wikilink-broken" }),
			expect.objectContaining({ level: "info", code: "item-ref-broken" }),
		]);
	});

	test("scans integrations recursively but not historical files", () => {
		const { home, tree, workspace } = fixture({
			"root/.shepherd/integrations/group/rules.md": "[Missing](missing.md)",
			"root/.shepherd/journal.md": "[Historical](missing.md)",
			"root/.shepherd/archive/2026-09/old/STATUS.md":
				"[Historical](missing.md)",
		});

		expect(
			findingsWithCode(checkLinks(workspace, tree, home), "link-broken"),
		).toEqual([
			{
				level: "error",
				code: "link-broken",
				file: "integrations/group/rules.md",
				line: 1,
				message: "link to missing.md does not resolve",
			},
		]);
	});

	test("returns no findings for a clean workspace", () => {
		const { home, tree, workspace } = fixture();

		expect(checkLinks(workspace, tree, home)).toEqual([]);
	});
});
