import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readCheckpoint } from "./checkpoint";
import type { Config } from "./config";
import { updatedName } from "./query-items";
import { sessionPrefixFor } from "./session-name";
import { type Drift, sessionView } from "./session-view";
import type { Running, RunningSessionsResult } from "./sessions";
import {
	type ListedSession,
	listedSessions,
	type UncheckedSession,
} from "./status-parse";
import {
	hasChildWorkspace,
	ownsDirectory,
	type Workspace,
	type WorkspaceTree,
} from "./tree";

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
			.filter((workspace) => hasChildWorkspace(tree, workspace))
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
