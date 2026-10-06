import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterResult, Running, RunningSessionsResult } from "./sessions";
import { type LiveReport, liveReports, recordFreshness } from "./status";
import {
	noNext,
	STATUS_WORDS,
	type StatusItem,
	statusItems,
} from "./status-parse";
import type { Workspace, WorkspaceTree } from "./tree";

export type StatusLiveReport = LiveReport & { record: string | null };

export type StatusWorkspaceReport = {
	name: string;
	updated: string | undefined;
	noNext: boolean;
	items: StatusItem[];
	live: StatusLiveReport;
};

export type StatusSources = {
	claude: AdapterResult;
	herdr: AdapterResult;
	codex: AdapterResult;
};

export type StatusReport = {
	workspaces: StatusWorkspaceReport[];
	unattributed: Running[];
	sources: StatusSources;
};

function currentText(workspace: Workspace): string {
	const path = join(workspace.state, "CURRENT.md");
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function sourceResult(source: AdapterResult): AdapterResult {
	return source.available
		? { available: true, sessions: source.sessions }
		: { available: false, reason: source.reason };
}

/** Build the status data shared by the human and JSON renderers. */
export function statusReport(
	workspaces: readonly Workspace[],
	tree: WorkspaceTree,
	running: RunningSessionsResult,
	home: string,
): StatusReport {
	const reports = liveReports(workspaces, tree, running, home);
	return {
		workspaces: workspaces.map((workspace) => {
			const text = currentText(workspace);
			const live = reports.byWorkspace.get(workspace.name) ?? {
				shepherd: [],
				ok: [],
				gone: [],
				unchecked: [],
				retiredButRunning: [],
				unlisted: [],
			};
			return {
				name: workspace.name,
				updated: text.match(/^Updated:\s*(.+)$/m)?.[1],
				noNext: noNext(text),
				items: statusItems(text),
				live: {
					...live,
					record:
						live.shepherd.length === 0
							? (recordFreshness(workspace, { home }) ?? null)
							: null,
				},
			};
		}),
		unattributed: reports.unattributed,
		sources: {
			claude: sourceResult(running.claude),
			herdr: sourceResult(running.herdr),
			codex: sourceResult(running.codex),
		},
	};
}

function homePath(path: string, home: string): string {
	return path === home
		? "~"
		: path.startsWith(`${home}/`)
			? `~/${path.slice(home.length + 1)}`
			: path;
}

function liveLines(live: StatusLiveReport, home: string): string[] {
	const lines: string[] = [];
	if (live.ok.length) lines.push(`  live      ${live.ok.join(", ")}`);
	if (!live.shepherd.length) {
		const delegates = [
			...live.ok,
			...live.retiredButRunning.map((session) => session.name),
		];
		if (delegates.length) {
			lines.push(
				`  ORPHANED  ${delegates.join(", ")} running, but no Shepherd session runs in this workspace`,
			);
		} else {
			lines.push("  (no Shepherd running)");
		}
	}
	for (const session of live.gone) {
		lines.push(
			`  GONE      ${session.name} is listed (CURRENT.md:${session.line}) but not running`,
		);
	}
	for (const session of live.retiredButRunning) {
		lines.push(
			`  RETIRED?  ${session.name} is listed as retired but still running (${session.status})`,
		);
	}
	for (const session of live.unlisted) {
		lines.push(
			`  UNLISTED  ${session.name} is running (${session.status}, ${homePath(session.cwd, home)}) but no CURRENT lists it`,
		);
	}
	if (live.unchecked.length) {
		lines.push(
			`  unchecked ${live.unchecked.map((session) => session.name).join(", ")} (subagent, or unavailable session adapter: can't be checked)`,
		);
	}
	if (live.record) {
		lines.push(
			live.record.startsWith("record up to date")
				? `  record    ${live.record.slice("record ".length)}`
				: `  STALE?    ${live.record.slice("STALE? ".length)}`,
		);
	}
	return lines;
}

function sourceDescription(report: StatusReport): string {
	const unavailable = (source: AdapterResult): string | undefined =>
		source.available ? undefined : source.reason;
	const claude = unavailable(report.sources.claude);
	const codex = unavailable(report.sources.codex);
	return [
		claude ? `Claude registry: unchecked (${claude})` : "Claude registry",
		codex ? `Codex through Herdr: unchecked (${codex})` : "Codex through Herdr",
		"subagents unchecked",
	].join("; ");
}

/** Render the complete human status report. */
export function renderStatus(
	report: StatusReport,
	home: string,
	includeUnattributed = true,
): string {
	const lines: string[] = [];
	for (const workspace of report.workspaces) {
		lines.push(
			"",
			`${workspace.name}  ${workspace.updated ? `(updated ${workspace.updated.split(",")[0]})` : "(CURRENT has no Updated line)"}`,
		);
		if (!workspace.items.length) {
			lines.push("  not on the status words yet; read its CURRENT.md");
		}
		for (const word of STATUS_WORDS) {
			for (const item of workspace.items.filter(
				(candidate) => candidate.known && candidate.word === word,
			)) {
				lines.push(`  ${word.padEnd(9)} ${item.text}`);
			}
		}
		for (const item of workspace.items.filter(
			(candidate) => !candidate.known,
		)) {
			lines.push(`  ${`${item.word}?`.padEnd(9)} ${item.text}`);
		}
		if (
			workspace.items.length &&
			workspace.noNext &&
			!workspace.items.some((item) => item.word === "NEXT")
		) {
			lines.push("  (no NEXT is set)");
		}
		lines.push(...liveLines(workspace.live, home));
	}
	if (includeUnattributed && report.unattributed.length) {
		lines.push("", "Running sessions no workspace lists or contains:");
		for (const session of report.unattributed) {
			lines.push(
				`  ${session.name} (${session.status}, ${homePath(session.cwd, home)})`,
			);
		}
	}

	const ask = report.workspaces.reduce(
		(count, workspace) =>
			count + workspace.items.filter((item) => item.word === "ASK").length,
		0,
	);
	const unknown = report.workspaces.reduce(
		(count, workspace) =>
			count + workspace.items.filter((item) => !item.known).length,
		0,
	);
	const live = report.workspaces.map((workspace) => workspace.live);
	const gone = live.reduce((count, item) => count + item.gone.length, 0);
	const unlisted = live.reduce(
		(count, item) => count + item.unlisted.length,
		0,
	);
	const orphaned = live.filter(
		(item) =>
			!item.shepherd.length &&
			(item.ok.length || item.retiredButRunning.length),
	).length;
	lines.push("", `${ask} item(s) waiting on the user's decision (ASK).`);
	if (unknown) lines.push(`${unknown} item(s) use an unknown status word.`);
	lines.push(
		`Live sessions: ${orphaned} workspace(s) with delegates but no Shepherd, ${gone} listed but not running, ${unlisted} running but unlisted.`,
		`source: ${sourceDescription(report)}.`,
	);
	return lines.join("\n");
}

/** Return the mode-specific fields for the status JSON envelope. */
export function statusJson(report: StatusReport): {
	workspaces: StatusWorkspaceReport[];
	unattributed: Running[];
	sources: StatusSources;
} {
	return {
		workspaces: report.workspaces,
		unattributed: report.unattributed,
		sources: report.sources,
	};
}
