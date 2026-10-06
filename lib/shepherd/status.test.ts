import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterResult, Running, RunningSessionsResult } from "./sessions";
import { liveReports, recordFreshness } from "./status";
import { makeTree } from "./test-support";
import { discoverTree } from "./tree";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function available(sessions: Running[] = []): AdapterResult {
	return { available: true, sessions };
}

function running(
	sessions: Running[],
	claude: AdapterResult = available(),
	codex: AdapterResult = available(),
): RunningSessionsResult {
	return { sessions, claude, codex, herdr: available() };
}

function session(
	name: string,
	cwd: string,
	harness: Running["harness"] = "claude",
): Running {
	return { name, cwd, harness, status: "working" };
}

function fixture(files: Record<string, string>) {
	const result = makeTree(files);
	cleanups.push(result.cleanup);
	const tree = discoverTree(join(result.root, "root"));
	return { result, tree };
}

describe("liveReports", () => {
	test("classifies every listed and running state", () => {
		const { result, tree } = fixture({
			"root/.shepherd/CURRENT.md": `## Live sessions
- ok-one
- gone-one
- retired-one retired
- duplicate-one; duplicate-one retired
- helper-one subagent
- codex-one codex`,
		});
		const report = liveReports(
			tree.workspaces,
			tree,
			running([
				session("ok-one", tree.root.dir),
				session("retired-one", tree.root.dir),
				session("duplicate-one", tree.root.dir),
				session("loose-one", join(tree.root.dir, "repo")),
				session("codex-one", tree.root.dir, "codex"),
			]),
			result.root,
		).byWorkspace.get(tree.root.name);

		expect(report?.ok).toEqual(["ok-one", "duplicate-one", "codex-one"]);
		expect(report?.gone.map(({ name }) => name)).toEqual(["gone-one"]);
		expect(
			report?.unchecked.map(({ name, reason }) => ({ name, reason })),
		).toEqual([{ name: "helper-one", reason: "subagent" }]);
		expect(report?.retiredButRunning.map(({ name }) => name)).toEqual([
			"retired-one",
		]);
		expect(report?.unlisted.map(({ name }) => name)).toEqual(["loose-one"]);
		expect(report?.shepherd).toHaveLength(5);
	});

	test("uses exact ownership for parents and containment for leaves", () => {
		const { result, tree } = fixture({
			"root/.shepherd/CURRENT.md": "",
			"root/a/.shepherd/CURRENT.md": "",
		});
		const child = tree.workspaces[1];
		if (!child) throw new Error("child workspace missing");
		const reports = liveReports(
			tree.workspaces,
			tree,
			running([
				session("root-one", tree.root.dir),
				session("child-one", join(child.dir, "repo")),
				session("between-one", join(tree.root.dir, "other")),
			]),
			result.root,
		);

		expect(
			reports.byWorkspace.get(tree.root.name)?.shepherd.map(({ name }) => name),
		).toEqual(["root-one"]);
		expect(
			reports.byWorkspace.get(child.name)?.shepherd.map(({ name }) => name),
		).toEqual(["child-one"]);
		expect(reports.unattributed.map(({ name }) => name)).toEqual([
			"between-one",
		]);
	});

	test("attributes only complete mentioned paths under the injected home", () => {
		const result = makeTree({
			"root/.shepherd/CURRENT.md":
				"Owns ~/Projects/app and ~/Projects/root-only.",
			"root/a/.shepherd/CURRENT.md": "",
		});
		cleanups.push(result.cleanup);
		const tree = discoverTree(join(result.root, "root"));
		const child = tree.workspaces[1];
		if (!child) throw new Error("child workspace missing");
		const home = join(result.root, "home");
		const projects = join(home, "Projects");
		const app = join(projects, "app");
		const rootOnly = join(projects, "root-only");
		const arbitrary = join(result.root, "outside-home");
		const insideRoot = join(tree.root.dir, "other");
		writeFileSync(
			join(tree.root.state, "charter.md"),
			`Also ${arbitrary} and ${insideRoot}.`,
		);
		writeFileSync(join(child.state, "charter.md"), `Owns ${app}.`);

		const reports = liveReports(
			tree.workspaces,
			tree,
			running([
				session("tilde-one", join(app, "src")),
				session("root-only-reference", join(rootOnly, "src")),
				session("absolute-outside-home", join(arbitrary, "repo")),
				session("inside-root-reference", join(insideRoot, "repo")),
			]),
			home,
		);

		expect(
			reports.byWorkspace.get(child.name)?.unlisted.map(({ name }) => name),
		).toEqual(["tilde-one"]);
		expect(reports.unattributed.map(({ name }) => name)).toEqual([
			"root-only-reference",
			"absolute-outside-home",
			"inside-root-reference",
		]);
	});

	test("matches a running session by name regardless of its harness", () => {
		const { result, tree } = fixture({
			"root/.shepherd/CURRENT.md":
				"## Live sessions\n- delegate-one codex, coordinated elsewhere",
		});
		const report = liveReports(
			tree.workspaces,
			tree,
			running([session("delegate-one", tree.root.dir, "claude")]),
			result.root,
		).byWorkspace.get(tree.root.name);

		expect(report?.ok).toEqual(["delegate-one"]);
		expect(report?.gone).toEqual([]);
	});

	test("marks sessions unchecked when their adapter is unavailable", () => {
		const { result, tree } = fixture({
			"root/.shepherd/CURRENT.md":
				"## Live sessions\n- claude-one\n- codex-one codex",
		});
		const report = liveReports(
			tree.workspaces,
			tree,
			running(
				[],
				{ available: false, reason: "Claude session registry not found" },
				{ available: false, reason: "not inside Herdr" },
			),
			result.root,
		).byWorkspace.get(tree.root.name);

		expect(report?.gone).toEqual([]);
		expect(
			report?.unchecked.map(({ name, reason }) => ({ name, reason })),
		).toEqual([
			{ name: "claude-one", reason: "Claude session registry not found" },
			{ name: "codex-one", reason: "not inside Herdr" },
		]);
	});

	test("exposes the empty Shepherd state used to report an orphan", () => {
		const { result, tree } = fixture({
			"root/.shepherd/CURRENT.md": "## Live sessions\n- delegate-one",
		});
		const report = liveReports(
			tree.workspaces,
			tree,
			running([session("delegate-one", join(result.root, "external", "repo"))]),
			result.root,
		).byWorkspace.get(tree.root.name);

		expect(report?.ok).toEqual(["delegate-one"]);
		expect(report?.shepherd).toEqual([]);
	});
});

describe("recordFreshness", () => {
	test("reports current, stale minutes and stale hours", () => {
		const now = new Date("2026-10-05T12:00:00Z");
		for (const [minutes, expected] of [
			[10, "record up to date"],
			[45, "STALE? 45 min"],
			[150, "STALE? 3h"],
		] as const) {
			const fixture = makeTree(
				{
					"home/work/.shepherd/CURRENT.md": "current",
					"home/work/.shepherd/journal.md": "journal",
					"home/.claude/projects/-work/session.jsonl": "activity",
				},
				{
					mtimes: {
						"home/work/.shepherd/CURRENT.md": now,
						"home/work/.shepherd/journal.md": new Date(now.getTime() - 60_000),
						"home/.claude/projects/-work/session.jsonl": new Date(
							now.getTime() + minutes * 60_000,
						),
					},
				},
			);
			cleanups.push(fixture.cleanup);
			const home = join(fixture.root, "home");
			const workspace = {
				name: "work",
				dir: "/work",
				state: join(home, "work", ".shepherd"),
			};
			expect(recordFreshness(workspace, { home })).toStartWith(expected);
		}
	});

	test("uses the newer record and omits workspaces without transcripts", () => {
		const fixture = makeTree(
			{
				"home/work/.shepherd/CURRENT.md": "current",
				"home/work/.shepherd/journal.md": "journal",
				"home/.claude/projects/-work/session.jsonl": "activity",
			},
			{
				mtimes: {
					"home/work/.shepherd/CURRENT.md": "2026-10-05T10:00:00Z",
					"home/work/.shepherd/journal.md": "2026-10-05T11:55:00Z",
					"home/.claude/projects/-work/session.jsonl": "2026-10-05T12:00:00Z",
				},
			},
		);
		cleanups.push(fixture.cleanup);
		const home = join(fixture.root, "home");
		const workspace = {
			name: "work",
			dir: "/work",
			state: join(home, "work", ".shepherd"),
		};

		expect(recordFreshness(workspace, { home })).toStartWith(
			"record up to date",
		);
		expect(
			recordFreshness({ ...workspace, dir: "/missing" }, { home }),
		).toBeUndefined();
	});

	test("returns no line when the transcript directory is empty", () => {
		const { result, tree } = fixture({
			"root/.shepherd/CURRENT.md": "current",
		});
		mkdirSync(
			join(result.root, ".claude", "projects", "-missing-transcripts"),
			{ recursive: true },
		);
		expect(recordFreshness(tree.root, { home: result.root })).toBeUndefined();
	});
});
