import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	contentHash,
	type DroppedInput,
	droppedDigest,
	droppedLines,
	readBaseline,
	readDroppedSources,
} from "./current-prev";
import { type MakeTreeOptions, makeTree } from "./test-support";
import type { Workspace } from "./tree";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(files: Record<string, string>, options: MakeTreeOptions = {}) {
	const tree = makeTree({ "root/.shepherd/CURRENT.md": "", ...files }, options);
	cleanups.push(tree.cleanup);
	const dir = join(tree.root, "root");
	const workspace: Workspace = {
		name: "root",
		dir,
		state: join(dir, ".shepherd"),
	};
	return { ...tree, workspace };
}
function assess(baseline: string, rest: Partial<DroppedInput> = {}) {
	return droppedLines({
		baseline,
		current: "",
		items: {},
		destinations: {},
		...rest,
	});
}

describe("droppedLines", () => {
	test("retains indented continuation lines across an indented blank", () => {
		const result = assess(
			"## Items\n- [task](work/todo/task/STATUS.md)\n  \n  Keep details.",
			{ items: { task: "live" } },
		);
		expect(result.candidates).toHaveLength(2);
		expect(result.candidates[1]?.disposition).toEqual({
			kind: "exempt",
			reason: "item live task",
		});
	});
	test("checks hash-prefixed content that is not a Markdown heading", () => {
		expect(assess("#launch agent").unaccounted).toEqual([
			{ line: 1, text: "#launch agent" },
		]);
	});
	test("accounts for exact text in a memory after normalization", () => {
		const result = assess("- **Keep**   the launch instructions.", {
			destinations: { "memories/tools.md": "1. keep the launch instructions." },
		});
		expect(result.accounted).toEqual([
			{
				line: 1,
				text: "- **Keep**   the launch instructions.",
				foundIn: "memories/tools.md",
			},
		]);
		expect(result.unaccounted).toEqual([]);
		expect(result.candidates[0]?.normalized).toBe(
			"keep the launch instructions.",
		);
	});
	test("does not account for a sentence preserved only in negated form", () => {
		const result = assess("send credentials", {
			destinations: { "memories/safety.md": "never send credentials" },
		});
		expect(result.accounted).toEqual([]);
		expect(result.unaccounted[0]?.nearest?.percent).toBe(100);
	});
	test("suggests 86 percent overlap without accounting for it", () => {
		const baseline =
			"alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar";
		const result = assess(baseline, {
			destinations: {
				"docs/guide.md": baseline.split(" ").slice(0, 13).join(" "),
			},
		});
		expect(result.accounted).toEqual([]);
		expect(result.unaccounted).toEqual([
			{
				line: 1,
				text: baseline,
				nearest: { path: "docs/guide.md", line: 1, percent: 86 },
			},
		]);
	});
	test("suggests an exact journal copy without accounting for it", () => {
		const result = assess("Keep launch instructions.", {
			destinations: { "journal.md": "Preamble\nKeep launch instructions." },
		});
		expect(result.accounted).toEqual([]);
		expect(result.unaccounted[0]?.nearest).toEqual({
			path: "journal.md",
			line: 2,
			percent: 100,
		});
	});
	test("checks Do not go despite its short words", () => {
		expect(assess("Do not go.").unaccounted).toEqual([
			{ line: 1, text: "Do not go." },
		]);
	});
	test("checks launch lines inside fences", () => {
		expect(assess("```\nbun run launch\n```").unaccounted).toEqual([
			{ line: 2, text: "bun run launch" },
		]);
	});
	test("checks fenced headings and following prose without changing sections", () => {
		for (const fence of ["```", "~~~"]) {
			for (const heading of ["## Live sessions", "## Items", "## Notes"]) {
				const baseline = `${fence}\n${heading}\nbun run launch\n${fence}\nKeep credentials private.`;
				const result = assess(baseline);
				expect(result.unaccounted).toEqual([
					{ line: 2, text: heading },
					{ line: 3, text: "bun run launch" },
					{ line: 5, text: "Keep credentials private." },
				]);
				expect(result.candidates).toHaveLength(3);
				expect(droppedDigest(result)).toBe(
					createHash("sha256")
						.update(
							`${heading.toLowerCase()}\tunaccounted\nbun run launch\tunaccounted\nkeep credentials private.\tunaccounted`,
						)
						.digest("hex"),
				);
			}
		}
	});
	test("ignores fenced Items examples and preserves real Items boundaries", () => {
		const baseline =
			"```\n## Items\n- [example](work/todo/example/STATUS.md)\n```\n## Items\n~~~\n## Notes\n- [example](work/todo/example/STATUS.md)\n~~~\n- [real](work/todo/real/STATUS.md)\n## This week\n- [weekly](work/todo/weekly/STATUS.md)";
		const result = assess(baseline, {
			items: { example: "live", real: "live", weekly: "live" },
		});
		expect(
			result.candidates
				.filter(({ disposition }) => disposition.kind === "exempt")
				.map(({ line }) => line),
		).toEqual([10]);
		expect(result.unaccounted.map(({ line }) => line)).toEqual([
			2, 3, 7, 8, 12,
		]);
	});
	test("requires matching fence characters and enough closing markers", () => {
		const result = assess(
			"````\n```\n~~~\n## Live sessions\nbun run launch\n````\nKeep credentials private.",
		);
		expect(result.unaccounted.map(({ line }) => line)).toEqual([4, 5, 7]);
	});
	test("checks This week success criteria unless copied exactly to a live file", () => {
		const text = "Keep credentials private.";
		const baseline = `## This week\n${text}`;
		expect(assess(baseline).unaccounted).toEqual([{ line: 2, text }]);
		const result = assess(baseline, {
			destinations: { "memories/safety.md": text },
		});
		expect(result.accounted).toEqual([
			{ line: 2, text, foundIn: "memories/safety.md" },
		]);
		expect(result.unaccounted).toEqual([]);
	});
	for (const state of ["live", "done", "archived"] as const) {
		test(`exempts ${state} Items entries including continuation links and lines`, () => {
			const baseline =
				"## Items\n- Important task\n  [status](work/todo/task/STATUS.md)\n  Keep launch instructions.\n## Notes\nOther content";
			const result = assess(baseline, { items: { task: state } });
			expect(
				result.candidates.slice(0, 3).map(({ disposition }) => disposition),
			).toEqual(
				Array(3).fill({ kind: "exempt", reason: `item ${state} task` }),
			);
			expect(result.unaccounted).toEqual([{ line: 6, text: "Other content" }]);
		});
	}
	test("checks linked Items entries whose directory is missing", () => {
		const baseline =
			"## Items\n- [task](work/todo/task/STATUS.md)\n  Keep details.";
		expect(
			assess(baseline, { items: { task: "missing" } }).unaccounted.map(
				({ line }) => line,
			),
		).toEqual([2, 3]);
	});
	test("checks done Items entries without an Outcome", () => {
		const text = "- [task](work/done/task/STATUS.md)";
		expect(
			assess(`## Items\n${text}`, { items: { task: "done-no-outcome" } })
				.unaccounted,
		).toEqual([{ line: 2, text }]);
	});
	test("checks unlinked Items entries", () => {
		expect(assess("## Items\n- Keep details.").unaccounted).toEqual([
			{ line: 2, text: "- Keep details." },
		]);
	});
	test("skips Live sessions until the next level two heading", () => {
		const result = assess(
			"## Live sessions\n- active session\n### More sessions\nlaunch agent\n## Notes\nKeep instructions.",
		);
		expect(result.unaccounted).toEqual([
			{ line: 6, text: "Keep instructions." },
		]);
	});
	test("skips headings, Updated, blanks, and lines without letters", () => {
		expect(
			assess("# Current\n## Notes\nUpdated: today\n\n123 +-!\nKeep details.")
				.unaccounted,
		).toEqual([{ line: 6, text: "Keep details." }]);
	});
	test("a line moved within CURRENT is not a candidate", () => {
		expect(
			assess("First line\n- **Second** line", {
				current: "second line\nFirst line",
			}).candidates,
		).toEqual([]);
	});
	test("sorts destination keys and breaks suggestion ties by line order", () => {
		const destinations = {
			"memories/z.md": "keep credentials\nlaunch safely",
			"docs/a.md": "keep credentials\nlaunch carefully\nlaunch again",
		};
		const result = assess("keep credentials\nlaunch elsewhere", {
			destinations,
		});
		expect(result.accounted[0]?.foundIn).toBe("docs/a.md");
		expect(result.unaccounted[0]?.nearest).toEqual({
			path: "docs/a.md",
			line: 2,
			percent: 50,
		});
	});
	test("omits suggestions with no shared content words and uses unique words", () => {
		expect(
			assess("Do not.", { destinations: { "docs/a.md": "not the" } })
				.unaccounted[0],
		).not.toHaveProperty("nearest");
		expect(
			assess("launch launch safely", {
				destinations: { "docs/a.md": "launch" },
			}).unaccounted[0]?.nearest?.percent,
		).toBe(50);
	});
});

describe("droppedDigest", () => {
	test("changes when a disposition changes and uses baseline order", () => {
		const result = assess("Keep details.\nLaunch safely.");
		const expected = createHash("sha256")
			.update("keep details.\tunaccounted\nlaunch safely.\tunaccounted")
			.digest("hex");
		expect(droppedDigest(result)).toBe(expected);
		expect(
			droppedDigest(
				assess("Keep details.\nLaunch safely.", {
					destinations: { "docs/a.md": "Keep details." },
				}),
			),
		).not.toBe(expected);
	});
	test("changes when an exempt item becomes missing", () => {
		const baseline = "## Items\n- [task](work/todo/task/STATUS.md)";
		expect(
			droppedDigest(assess(baseline, { items: { task: "live" } })),
		).not.toBe(droppedDigest(assess(baseline, { items: { task: "missing" } })));
	});
	test("includes destination and exemption reason but excludes suggestion changes", () => {
		const baseline = "Keep details.";
		expect(
			droppedDigest(
				assess(baseline, { destinations: { "docs/a.md": baseline } }),
			),
		).not.toBe(
			droppedDigest(
				assess(baseline, { destinations: { "docs/b.md": baseline } }),
			),
		);
		expect(droppedDigest(assess(baseline))).toBe(
			droppedDigest(
				assess(baseline, { destinations: { "journal.md": baseline } }),
			),
		);
		const entry = "## Items\n- [task](work/todo/task/STATUS.md)";
		expect(droppedDigest(assess(entry, { items: { task: "live" } }))).not.toBe(
			droppedDigest(assess(entry, { items: { task: "archived" } })),
		);
	});
});

describe("readDroppedSources", () => {
	test("strips leading frontmatter with a CRLF closing delimiter before checking Outcome", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/done/example/STATUS.md":
				"---\nstate: done\n## Outcome\n---\r\nNo outcome heading",
			"root/.shepherd/work/done/real/STATUS.md":
				"---\nstate: done\n---\r\n## Outcome\r\nFinished",
		});
		const baseline =
			"## Items\n- [example](work/done/example/STATUS.md)\n- [real](work/done/real/STATUS.md)";
		const sources = readDroppedSources(workspace, baseline);
		expect(sources.items).toEqual({ example: "done-no-outcome", real: "done" });
		expect(
			droppedLines({ current: "", baseline, ...sources }).unaccounted,
		).toEqual([{ line: 2, text: "- [example](work/done/example/STATUS.md)" }]);
	});
	test("does not qualify a done item with only a fenced Outcome", () => {
		for (const fence of ["```", "~~~"]) {
			const { workspace } = fixture({
				"root/.shepherd/work/done/task/STATUS.md": `---\nstate: done\n---\n${fence}\n## Outcome\nExample outcome\n${fence}`,
			});
			const baseline = "## Items\n- [task](work/done/task/STATUS.md)";
			const sources = readDroppedSources(workspace, baseline);
			expect(sources.items).toEqual({ task: "done-no-outcome" });
			expect(
				droppedLines({ current: "", baseline, ...sources }).unaccounted,
			).toEqual([{ line: 2, text: "- [task](work/done/task/STATUS.md)" }]);
		}
	});
	test("requires real leading frontmatter and accepts a real Outcome after a fence", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/done/example/STATUS.md":
				"```\n---\nstate: done\n---\n```\n## Outcome\nFinished",
			"root/.shepherd/work/done/real/STATUS.md":
				"---\nstate: done\n---\n```\n## Outcome\nExample\n```\n## Outcome\nFinished",
			"root/.shepherd/work/done/yaml/STATUS.md":
				"---\nstate: done\n## Outcome\n---\nNo outcome heading",
		});
		const baseline =
			"## Items\n- [example](work/done/example/STATUS.md)\n- [real](work/done/real/STATUS.md)\n- [yaml](work/done/yaml/STATUS.md)";
		expect(readDroppedSources(workspace, baseline).items).toEqual({
			example: "done-no-outcome",
			real: "done",
			yaml: "done-no-outcome",
		});
	});
	test("does not read item links from fenced Items examples", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/todo/example/STATUS.md": "Active",
		});
		expect(
			readDroppedSources(
				workspace,
				"```\n## Items\n- [example](work/todo/example/STATUS.md)\n```",
			).items,
		).toEqual({});
	});
	test("resolves live, done, incomplete, archived, and missing item directories", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/todo/todo/placeholder": "",
			"root/.shepherd/work/in-progress/active/STATUS.md": "Active",
			"root/.shepherd/work/done/done/STATUS.md":
				"---\nstate: done\n---\n## Outcome\nFinished",
			"root/.shepherd/work/done/no-outcome/STATUS.md":
				"---\nstate: done\n---\nFinished",
			"root/.shepherd/work/done/no-state/STATUS.md": "## Outcome\nFinished",
			"root/.shepherd/work/done/no-status/placeholder": "",
			"root/.shepherd/archive/2026-10/archived/placeholder": "",
		});
		const slugs = [
			"todo",
			"active",
			"done",
			"no-outcome",
			"no-state",
			"no-status",
			"archived",
			"missing",
		];
		const baseline = `## Items\n${slugs.map((slug) => `- [${slug}](work/todo/${slug}/STATUS.md)`).join("\n")}`;
		const sources = readDroppedSources(workspace, baseline);
		expect(sources.items).toEqual({
			todo: "live",
			active: "live",
			done: "done",
			"no-outcome": "done-no-outcome",
			"no-state": "done-no-outcome",
			"no-status": "done-no-outcome",
			archived: "archived",
			missing: "missing",
		});
		expect(
			droppedLines({ current: "", baseline, ...sources }).unaccounted,
		).toHaveLength(4);
	});
	test("reads exactly the live destination scopes and journal, skipping symlinks", () => {
		const included = [
			"docs/deep/guide.md",
			"memories/tools.md",
			"work/todo/task/deep/STATUS.md",
			"work/in-progress/task/STATUS.md",
			"pending.md",
			"charter.md",
			"integrations/tools.md",
			"outbox/message.md",
			"journal.md",
		];
		const excluded = [
			"memories/deep/hidden.md",
			"integrations/deep/hidden.md",
			"outbox/deep/hidden.md",
			"work/done/task/STATUS.md",
			"work/todo/task/notes.md",
			"archive/2026-10/old.md",
			"CURRENT.md",
			"HANDOFF.md",
			"shared/tools.md",
		];
		const files = Object.fromEntries(
			[...included, ...excluded].map((path) => [
				`root/.shepherd/${path}`,
				path,
			]),
		);
		const { workspace } = fixture(files, {
			symlinks: {
				"root/.shepherd/docs/link.md": "root/.shepherd/charter.md",
				"root/.shepherd/docs/linked-dir": "root/.shepherd/memories",
				"root/.shepherd/integrations/link.md": "missing.md",
			},
		});
		expect(
			Object.keys(readDroppedSources(workspace, "").destinations).sort(),
		).toEqual(included.sort());
	});
	test("accounts for a nested workspace line in enclosing shared/tools.md", () => {
		const { root } = fixture({
			"root/.shepherd/shared/tools.md": "Keep launch instructions.",
			"root/child/.shepherd/CURRENT.md": "",
		});
		const dir = join(root, "root/child");
		const workspace = { name: "child", dir, state: join(dir, ".shepherd") };
		const sources = readDroppedSources(workspace, "Keep launch instructions.");
		expect(
			droppedLines({
				current: "",
				baseline: "Keep launch instructions.",
				...sources,
			}).accounted[0]?.foundIn,
		).toBe("enclosing:shared/tools.md");
	});
	test("uses the first STATUS link, including links in continuation lines", () => {
		const { workspace } = fixture({
			"root/.shepherd/work/todo/task/STATUS.md": "Active",
		});
		const baseline =
			"## Items\n- [docs](docs/tools.md) details\n  [status](work/todo/task/STATUS.md) [other](work/todo/other/STATUS.md)\n## Notes\n- [ignored](work/todo/ignored/STATUS.md)";
		expect(readDroppedSources(workspace, baseline).items).toEqual({
			task: "live",
		});
	});
});

describe("readBaseline", () => {
	test("no certified hash means no baseline", () => {
		expect(
			readBaseline("/nonexistent", "checkpoints/CURRENT.r1", null),
		).toEqual({ status: "none" });
	});
	test("reads a matching snapshot and hashes its bytes", () => {
		const text = "Keep café details.\r\n";
		const { workspace } = fixture({
			"root/.shepherd/checkpoints/CURRENT.r1": text,
		});
		const hash = contentHash(new TextEncoder().encode(text));
		expect(hash).toBe(contentHash(text));
		expect(
			readBaseline(workspace.state, "checkpoints/CURRENT.r1", hash),
		).toEqual({ status: "ok", text, hash });
	});
	test("rejects hash mismatch and missing snapshots", () => {
		const { workspace } = fixture({
			"root/.shepherd/checkpoints/CURRENT.r1": "Keep details.",
		});
		for (const snapshot of ["checkpoints/CURRENT.r1", "checkpoints/CURRENT.r2"])
			expect(
				readBaseline(workspace.state, snapshot, contentHash("different")),
			).toEqual({
				status: "lost",
				reason: "snapshot missing or does not match",
			});
	});
	test("rejects symlink snapshots and symlink parent directories", () => {
		const { workspace } = fixture(
			{ "root/.shepherd/elsewhere/CURRENT.r1": "Keep details." },
			{
				symlinks: {
					"root/.shepherd/checkpoints/CURRENT.r1":
						"root/.shepherd/elsewhere/CURRENT.r1",
					"root/.shepherd/checkpoints/linked": "root/.shepherd/elsewhere",
				},
			},
		);
		for (const snapshot of [
			"checkpoints/CURRENT.r1",
			"checkpoints/linked/CURRENT.r1",
		])
			expect(
				readBaseline(workspace.state, snapshot, contentHash("Keep details."))
					.status,
			).toBe("lost");
	});
	test("rejects paths outside checkpoints and directories", () => {
		const { workspace } = fixture({
			"root/.shepherd/checkpoints/CURRENT.r1": "Keep details.",
			"root/.shepherd/other": "Keep details.",
		});
		for (const snapshot of [
			"other",
			"checkpoints/../other",
			"../other",
			join(workspace.state, "checkpoints/CURRENT.r1"),
			"checkpoints",
			"checkpoints/.",
		])
			expect(
				readBaseline(workspace.state, snapshot, contentHash("Keep details."))
					.status,
			).toBe("lost");
	});
});
