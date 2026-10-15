import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { sessionPrefixFor } from "./session-name";
import { codexIndex, type ToolEnv } from "./sessions";
import { ownsDirectory } from "./status";
import type { Workspace } from "./tree";
import { findChildWorkspaces } from "./workspace";

/** The session that ran a tool command, as its harness reports it. */
export type Caller = {
	harness: "claude" | "codex" | null;
	id: string | null;
	name: string | null;
	role: "shepherd" | "other" | "none";
	reason?: string;
};

export const AMBIGUOUS_CALLER =
	"both CLAUDE_PID and CODEX_THREAD_ID are set; pass --session";

type ClaudeCaller = {
	id: string;
	name: string | null;
	cwd: string | null;
	reason?: string;
};

/** The registry entry of the Claude session whose shell ran this command. */
function claudeCaller(toolEnv: ToolEnv): ClaudeCaller | undefined {
	const pid = toolEnv.env.CLAUDE_PID;
	const id = toolEnv.env.CLAUDE_CODE_SESSION_ID;
	if (!pid || !/^\d+$/.test(pid) || !id) return undefined;
	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(
			readFileSync(
				join(toolEnv.home, ".claude", "sessions", `${pid}.json`),
				"utf8",
			),
		) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (entry.sessionId !== id || !toolEnv.pidAlive(Number(pid)))
		return undefined;
	const cwd = typeof entry.cwd === "string" ? entry.cwd : null;
	if (typeof entry.name !== "string" || !entry.name)
		return { id, name: null, cwd, reason: "Claude session has no name" };
	if (entry.nameSource === "derived")
		return {
			id,
			name: null,
			cwd,
			reason: "name derived by Claude Code; name the session",
		};
	return { id, name: entry.name, cwd };
}

/**
 * The calling session: Claude through its registry entry for CLAUDE_PID,
 * else Codex through CODEX_THREAD_ID and its index, else none. Its role is
 * "shepherd" when its name carries the workspace prefix and, for Claude, its
 * registry directory is the workspace's.
 */
export function callerSession(
	toolEnv: ToolEnv,
	workspace: Pick<Workspace, "dir">,
	config: Config,
	hasChildren = findChildWorkspaces(workspace.dir).length > 0,
): Caller {
	const claude = claudeCaller(toolEnv);
	const thread = toolEnv.env.CODEX_THREAD_ID || undefined;
	if (claude && thread)
		return {
			harness: null,
			id: null,
			name: null,
			role: "none",
			reason: AMBIGUOUS_CALLER,
		};
	const prefixed = (name: string | null) =>
		name?.startsWith(
			`${sessionPrefixFor(workspace.dir, config.sessionPrefix, hasChildren)}-`,
		) === true;
	if (claude) {
		const { id, name, cwd, reason } = claude;
		return {
			harness: "claude",
			id,
			name,
			role:
				prefixed(name) &&
				cwd !== null &&
				ownsDirectory(workspace.dir, hasChildren, cwd)
					? "shepherd"
					: "other",
			...(reason === undefined ? {} : { reason }),
		};
	}
	if (thread) {
		const name = codexIndex(toolEnv, config).names.get(thread) ?? null;
		return {
			harness: "codex",
			id: thread,
			name,
			role: prefixed(name) ? "shepherd" : "other",
			...(name === null
				? { reason: "Codex thread has no name; use the rename dialog" }
				: {}),
		};
	}
	return { harness: null, id: null, name: null, role: "none" };
}
