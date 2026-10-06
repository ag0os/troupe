import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { AdapterResult, Running, RunningSessionsResult } from "./sessions";
import { renderStatus, statusJson, statusReport } from "./status-render";
import { makeTree } from "./test-support";
import { discoverTree } from "./tree";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function available(sessions: Running[] = []): AdapterResult {
	return { available: true, sessions };
}

test("renders complete workspace blocks and the footer", () => {
	const fixture = makeTree({
		"home/root/.shepherd/charter.md": "Owns ~/projects/app",
		"home/root/.shepherd/CURRENT.md": `Updated: 2026-10-05, 09:00
## Items
- **ASK**: choose an approach
- **CHECK**: verify the result
No NEXT is set
## Live sessions
- delegate-one
- gone-one`,
	});
	cleanups.push(fixture.cleanup);
	const home = join(fixture.root, "home");
	const tree = discoverTree(join(home, "root"));
	const delegate: Running = {
		name: "delegate-one",
		cwd: join(home, "elsewhere"),
		status: "working",
		harness: "claude",
	};
	const loose: Running = {
		name: "loose-one",
		cwd: join(home, "projects/app/repo"),
		status: "idle",
		harness: "claude",
	};
	const running: RunningSessionsResult = {
		sessions: [delegate, loose],
		claude: available([delegate, loose]),
		herdr: { available: false, reason: "not inside Herdr" },
		codex: { available: false, reason: "not inside Herdr" },
	};

	const text = renderStatus(
		statusReport(tree.workspaces, tree, running, home),
		home,
	);

	expect(text).toBe(`
root  (updated 2026-10-05)
  ASK       choose an approach
  CHECK?    verify the result
  (no NEXT is set)
  live      delegate-one
  ORPHANED  delegate-one running, but no Shepherd session runs in this workspace
  GONE      gone-one is listed (CURRENT.md:8) but not running
  UNLISTED  loose-one is running (idle, ~/projects/app/repo) but no CURRENT lists it

1 item(s) waiting on the user's decision (ASK).
1 item(s) use an unknown status word.
Live sessions: 1 workspace(s) with delegates but no Shepherd, 1 listed but not running, 1 running but unlisted.
source: Claude registry; Codex through Herdr: unchecked (not inside Herdr); subagents unchecked.`);
});

test("returns the status JSON shape", () => {
	const fixture = makeTree({
		"home/root/.shepherd/CURRENT.md":
			"Updated: today\n- **NEXT**: ship it\n## Live sessions\n- missing-one",
	});
	cleanups.push(fixture.cleanup);
	const home = join(fixture.root, "home");
	const tree = discoverTree(join(home, "root"));
	const unavailable: AdapterResult = {
		available: false,
		reason: "not available",
	};
	const running: RunningSessionsResult = {
		sessions: [],
		claude: unavailable,
		herdr: unavailable,
		codex: unavailable,
	};

	const json = statusJson(statusReport(tree.workspaces, tree, running, home));

	expect(json).toEqual({
		workspaces: [
			{
				name: "root",
				updated: "today",
				noNext: false,
				items: [
					{
						word: "NEXT",
						known: true,
						text: "ship it",
						line: 2,
					},
				],
				live: {
					shepherd: [],
					ok: [],
					gone: [],
					unchecked: [
						{
							name: "missing-one",
							line: 4,
							retired: false,
							subagent: false,
							codex: false,
							reason: "not available",
						},
					],
					retiredButRunning: [],
					unlisted: [],
					record: null,
				},
			},
		],
		unattributed: [],
		sources: {
			claude: unavailable,
			herdr: unavailable,
			codex: unavailable,
		},
	});
});

test("aligns record freshness labels without changing the stored value", () => {
	const fixture = makeTree({
		"home/root/.shepherd/CURRENT.md": "Updated: today",
	});
	cleanups.push(fixture.cleanup);
	const home = join(fixture.root, "home");
	const tree = discoverTree(join(home, "root"));
	const unavailable: AdapterResult = {
		available: false,
		reason: "not available",
	};
	const base = statusReport(
		tree.workspaces,
		tree,
		{
			sessions: [],
			claude: unavailable,
			herdr: unavailable,
			codex: unavailable,
		},
		home,
	);
	const live = base.workspaces[0]?.live;
	if (!live) throw new Error("workspace report missing");

	for (const [record, line] of [
		["record up to date (timestamps)", "  record    up to date (timestamps)"],
		["STALE? 45 min behind", "  STALE?    45 min behind"],
	] as const) {
		live.record = record;
		expect(renderStatus(base, home)).toContain(`\n${line}\n`);
		expect(live.record).toBe(record);
	}
});
