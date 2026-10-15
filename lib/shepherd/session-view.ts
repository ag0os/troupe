import type { AdapterResult, Running } from "./sessions";
import { ownsDirectory, type UncheckedSession } from "./status";
import type { ListedSession } from "./status-parse";

export type Drift = {
	code: "session-unrecorded" | "session-gone";
	name: string;
	line?: number;
	message: string;
};

type Source = Pick<AdapterResult, "available"> & { reason?: string };

export type SessionViewInput = {
	listed: readonly ListedSession[];
	running: readonly Running[];
	/** The sources read; a harness left out is unchecked. */
	sources: Partial<Record<Running["harness"], Source>>;
	workspace: { dir: string; hasChildren: boolean; prefix: string };
	writer: string | null;
	updatedName: string | null;
	/**
	 * Who counts as listed and which directories this workspace answers for
	 * when finding unlisted sessions; status passes the whole tree's view.
	 */
	unlistedScope?: {
		listedNames: ReadonlySet<string>;
		owner: (cwd: string) => boolean;
	};
};

export type SessionView = {
	shepherds: Running[];
	ok: string[];
	gone: ListedSession[];
	unchecked: UncheckedSession[];
	retiredButRunning: Running[];
	unlisted: Running[];
	drift: Drift[];
};

const NOT_READ = "source not read here";

/** Classify one workspace's listed and running sessions and name any drift. */
export function sessionView(input: SessionViewInput): SessionView {
	const { listed, running, sources, workspace, writer, updatedName } = input;
	const owns = (cwd: string) =>
		ownsDirectory(workspace.dir, workspace.hasChildren, cwd);
	const prefixed = (name: string) => name.startsWith(`${workspace.prefix}-`);
	const runningNames = new Set(running.map(({ name }) => name));
	const active = listed.filter(({ retired }) => !retired);
	const unavailable = (session: ListedSession): string | undefined => {
		if (session.subagent) return "subagent";
		const source = sources[session.codex ? "codex" : "claude"];
		if (!source) return NOT_READ;
		return source.available ? undefined : (source.reason ?? NOT_READ);
	};
	const checked = active.filter((session) => !unavailable(session));
	const shepherds = running.filter(
		(session) =>
			!session.derived && owns(session.cwd) && prefixed(session.name),
	);
	const listedNames = new Set(listed.map(({ name }) => name));
	const scope = input.unlistedScope ?? { listedNames, owner: owns };
	const listedLive = [...new Set(active.map(({ name }) => name))];
	const shepherdNames = shepherds.map(({ name }) => name).join(", ") || "none";
	const drift: Drift[] = [
		...shepherds
			.filter(
				({ name }) =>
					name !== writer && name !== updatedName && !listedNames.has(name),
			)
			.map(
				({ name }): Drift => ({
					code: "session-unrecorded",
					name,
					message: `${name} is running here but the record names ${writer ?? "no writer"} (checkpoint), ${updatedName ?? "no name"} (Updated:) and lists ${listedLive.join(", ") || "nobody"} (Live sessions)`,
				}),
			),
		...checked
			.filter(({ name }) => prefixed(name) && !runningNames.has(name))
			.map(
				({ name, line }): Drift => ({
					code: "session-gone",
					name,
					line,
					message: `${name} is listed live (CURRENT.md:${line}) but not running; running Shepherd: ${shepherdNames}`,
				}),
			),
	];
	return {
		shepherds,
		ok: checked
			.filter(({ name }) => runningNames.has(name))
			.map(({ name }) => name),
		gone: checked.filter(({ name }) => !runningNames.has(name)),
		unchecked: active.flatMap((session) => {
			const reason = unavailable(session);
			return reason ? [{ ...session, reason }] : [];
		}),
		retiredButRunning: listed.flatMap((session) => {
			if (
				!session.retired ||
				active.some((candidate) => candidate.name === session.name)
			)
				return [];
			const found = running.find(({ name }) => name === session.name);
			return found ? [found] : [];
		}),
		unlisted: running.filter(
			(session) =>
				!scope.listedNames.has(session.name) && scope.owner(session.cwd),
		),
		drift,
	};
}
