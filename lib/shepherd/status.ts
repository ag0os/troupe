import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function mentionedPaths(workspace: Workspace, home: string): string[] {
	const paths = new Set<string>();
	for (const file of ["charter.md", "CURRENT.md"]) {
		const text = read(join(workspace.state, file));
		for (const match of text.matchAll(
			/(?:~|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g,
		)) {
			const value = match[0].replace(/[.,;:]+$/, "");
			const path =
				value === "~" ? home : resolve(value.replace(/^~\//, `${home}/`));
			if (path !== home) paths.add(path);
		}
	}
	return [...paths];
}

function currentSessions(workspace: Workspace): ListedSession[] {
	const path = join(workspace.state, "CURRENT.md");
	return existsSync(path) ? listedSessions(read(path)) : [];
}

function sessionKey(name: string, harness: Running["harness"]): string {
	return `${harness}\0${name}`;
}

function listedHarness(session: ListedSession): Running["harness"] {
	return session.codex ? "codex" : "claude";
}

/** Classify listed and running sessions for the selected workspaces. */
export function liveReports(
	workspaces: readonly Workspace[],
	tree: WorkspaceTree,
	running: RunningSessionsResult,
): LiveReports {
	const allListed = new Map(
		tree.workspaces.map((workspace) => [
			workspace.name,
			currentSessions(workspace),
		]),
	);
	const listedNames = new Set(
		[...allListed.values()].flat().map((session) => session.name),
	);
	const runningByKey = new Map(
		running.sessions.map((session) => [
			sessionKey(session.name, session.harness),
			session,
		]),
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
	const ownsDirectory = (workspace: Workspace, cwd: string) =>
		hasChildren.has(workspace.name)
			? cwd === workspace.dir
			: within(workspace.dir, cwd);
	const home = dirname(tree.root.dir);
	const references = tree.workspaces.map((workspace) => ({
		workspace,
		paths: mentionedPaths(workspace, home),
	}));
	const owner = (cwd: string): Workspace | undefined => {
		const direct = tree.workspaces
			.filter((workspace) => ownsDirectory(workspace, cwd))
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
	const unavailableReason = (session: ListedSession): string | undefined => {
		if (session.subagent) return "subagent";
		const adapter = session.codex ? running.codex : running.claude;
		return adapter.available ? undefined : adapter.reason;
	};

	const byWorkspace = new Map<string, LiveReport>();
	for (const workspace of workspaces) {
		const mine = allListed.get(workspace.name) ?? [];
		const active = mine.filter((session) => !session.retired);
		const checked = active.filter((session) => !unavailableReason(session));
		byWorkspace.set(workspace.name, {
			shepherd: running.sessions.filter((session) =>
				ownsDirectory(workspace, session.cwd),
			),
			ok: checked
				.filter((session) =>
					runningByKey.has(sessionKey(session.name, listedHarness(session))),
				)
				.map((session) => session.name),
			gone: checked.filter(
				(session) =>
					!runningByKey.has(sessionKey(session.name, listedHarness(session))),
			),
			unchecked: active.flatMap((session) => {
				const reason = unavailableReason(session);
				return reason ? [{ ...session, reason }] : [];
			}),
			retiredButRunning: mine.flatMap((session) => {
				if (
					!session.retired ||
					active.some((candidate) => candidate.name === session.name)
				) {
					return [];
				}
				const found = running.sessions.find(
					(candidate) => candidate.name === session.name,
				);
				return found ? [found] : [];
			}),
			unlisted: running.sessions.filter(
				(session) =>
					!listedNames.has(session.name) && owner(session.cwd) === workspace,
			),
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
): string | undefined {
	const lastActivity = latestClaudeTranscriptMtime(toolEnv, workspace.dir);
	if (lastActivity === undefined) return undefined;
	const lastRecord = Math.max(
		writtenMtime(workspace, "CURRENT.md"),
		writtenMtime(workspace, "journal.md"),
	);
	const gapMinutes = Math.round((lastActivity - lastRecord) / 60_000);
	const when = `last Shepherd activity ${timestamp(lastActivity)}, CURRENT/journal last written ${timestamp(lastRecord)}`;
	if (gapMinutes <= 10) return `record up to date (${when})`;
	const gap =
		gapMinutes >= 120 ? `${Math.round(gapMinutes / 60)}h` : `${gapMinutes} min`;
	return `STALE? ${gap} of Shepherd activity after the last record (${when}); resume that session to bring it up to date`;
}
