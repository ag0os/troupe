import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readCheckpoint } from "./checkpoint";
import type { Config } from "./config";
import { updatedName } from "./query-items";
import { sessionPrefixFor } from "./session-name";
import { type Drift, sessionView } from "./session-view";
import {
	latestClaudeTranscriptMtime,
	type Running,
	type RunningSessionsResult,
	type ToolEnv,
} from "./sessions";
import { type ListedSession, listedSessions } from "./status-parse";
import type { Workspace, WorkspaceTree } from "./tree";

export type UncheckedSession = ListedSession & { reason: string };

export type LiveReport = {
	shepherd: Running[];
	ok: string[];
	gone: ListedSession[];
	unchecked: UncheckedSession[];
	retiredButRunning: Running[];
	unlisted: Running[];
	drift: Drift[];
};

export type LiveReports = {
	byWorkspace: Map<string, LiveReport>;
	unattributed: Running[];
};

function read(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function within(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
	);
}

/**
 * Whether a workspace owns a session's directory: exactly its own directory
 * when child workspaces sit beneath it, anything within it otherwise.
 */
export function ownsDirectory(
	dir: string,
	hasChildren: boolean,
	cwd: string,
): boolean {
	return hasChildren ? cwd === dir : within(dir, cwd);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionedPaths(
	workspace: Workspace,
	home: string,
	root: string,
): string[] {
	const paths = new Set<string>();
	const pattern = new RegExp(
		`(?:~|${escapeRegExp(home)})/[A-Za-z0-9._/-]+`,
		"g",
	);
	for (const file of ["charter.md", "CURRENT.md"]) {
		const text = read(join(workspace.state, file));
		for (const match of text.matchAll(pattern)) {
			const value = match[0].replace(/[./]+$/, "");
			const path = resolve(value.replace(/^~/, home));
			if (path !== home && !within(root, path)) paths.add(path);
		}
	}
	return [...paths];
}

function currentText(workspace: Workspace): string {
	const path = join(workspace.state, "CURRENT.md");
	return existsSync(path) ? read(path) : "";
}

function checkpointWriter(workspace: Workspace): string | null {
	const read = readCheckpoint(workspace.state);
	return read.status === "ok" ? (read.checkpoint.session ?? null) : null;
}

/** Classify listed and running sessions for the selected workspaces. */
export function liveReports(
	workspaces: readonly Workspace[],
	tree: WorkspaceTree,
	running: RunningSessionsResult,
	home: string,
	configs: ReadonlyMap<string, Pick<Config, "sessionPrefix">>,
): LiveReports {
	const texts = new Map(
		tree.workspaces.map((workspace) => [
			workspace.name,
			currentText(workspace),
		]),
	);
	const allListed = new Map(
		tree.workspaces.map((workspace) => [
			workspace.name,
			listedSessions(texts.get(workspace.name) ?? ""),
		]),
	);
	const listedNames = new Set(
		[...allListed.values()].flat().map((session) => session.name),
	);
	const hasChildren = new Set(
		tree.workspaces
			.filter((workspace) =>
				tree.workspaces.some(
					(candidate) =>
						candidate !== workspace && within(workspace.dir, candidate.dir),
				),
			)
			.map((workspace) => workspace.name),
	);
	const owns = (workspace: Workspace, cwd: string) =>
		ownsDirectory(workspace.dir, hasChildren.has(workspace.name), cwd);
	const references = tree.workspaces
		.filter(
			(workspace) =>
				workspace !== tree.root || !hasChildren.has(workspace.name),
		)
		.map((workspace) => ({
			workspace,
			paths: mentionedPaths(workspace, home, tree.root.dir),
		}));
	const owner = (cwd: string): Workspace | undefined => {
		const direct = tree.workspaces
			.filter((workspace) => owns(workspace, cwd))
			.sort((left, right) => right.dir.length - left.dir.length)[0];
		if (direct) return direct;
		let best: { workspace: Workspace; length: number } | undefined;
		for (const entry of references) {
			for (const path of entry.paths) {
				if (within(path, cwd) && (!best || path.length > best.length)) {
					best = { workspace: entry.workspace, length: path.length };
				}
			}
		}
		return best?.workspace;
	};
	const byWorkspace = new Map<string, LiveReport>();
	for (const workspace of workspaces) {
		const text = texts.get(workspace.name) ?? "";
		const children = hasChildren.has(workspace.name);
		const { ok, gone, unchecked, retiredButRunning, unlisted, drift } =
			sessionView({
				listed: allListed.get(workspace.name) ?? [],
				running: running.sessions,
				sources: { claude: running.claude, codex: running.codex },
				workspace: {
					dir: workspace.dir,
					hasChildren: children,
					prefix: sessionPrefixFor(
						workspace.dir,
						configs.get(workspace.dir)?.sessionPrefix,
						children,
					),
				},
				writer: checkpointWriter(workspace),
				updatedName: updatedName(text),
				unlistedScope: {
					listedNames,
					owner: (cwd) => owner(cwd) === workspace,
				},
			});
		byWorkspace.set(workspace.name, {
			shepherd: running.sessions.filter((session) =>
				owns(workspace, session.cwd),
			),
			ok,
			gone,
			unchecked,
			retiredButRunning,
			unlisted,
			drift,
		});
	}
	const unattributed = running.sessions.filter(
		(session) => !listedNames.has(session.name) && !owner(session.cwd),
	);
	return { byWorkspace, unattributed };
}

function writtenMtime(workspace: Workspace, file: string): number {
	try {
		return statSync(join(workspace.state, file)).mtimeMs;
	} catch {
		return 0;
	}
}

function timestamp(ms: number): string {
	const date = new Date(ms);
	const part = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}

/** Describe whether CURRENT and the journal cover the last Claude activity. */
export function recordFreshness(
	workspace: Workspace,
	toolEnv: Pick<ToolEnv, "home">,
	options: { excludeRunningSession?: Date } = {},
): string | undefined {
	const lastRecord = Math.max(
		writtenMtime(workspace, "CURRENT.md"),
		writtenMtime(workspace, "journal.md"),
	);
	const lastActivity = latestClaudeTranscriptMtime(
		toolEnv,
		workspace.dir,
		options.excludeRunningSession
			? { lastRecord, now: options.excludeRunningSession }
			: undefined,
	);
	if (lastActivity === undefined) return undefined;
	const gapMinutes = Math.round((lastActivity - lastRecord) / 60_000);
	const when = `last Shepherd activity ${timestamp(lastActivity)}, CURRENT/journal last written ${timestamp(lastRecord)}`;
	if (gapMinutes <= 10) return `record up to date (${when})`;
	const gap =
		gapMinutes >= 120 ? `${Math.round(gapMinutes / 60)}h` : `${gapMinutes} min`;
	return `STALE? ${gap} of Shepherd activity after the last record (${when}); resume that session to bring it up to date`;
}
