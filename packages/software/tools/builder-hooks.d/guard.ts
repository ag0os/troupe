// The guard: denies a Bash history write when the run has no history
// authority, and an edit to an excluded path or to the run's own directory.
// Every other call passes with no explicit grant. Whatever stops it from
// checking is the caller's to turn into a refusal.
import { logLine } from "./log";
import type { Manifest } from "./manifest";
import { excludedBy, shownPath } from "./paths";
import { historyWrite, Unclassifiable } from "./shell";

export const HISTORY_REASON =
	"Role guard: history writes are off for this run; the host holds commits, pushes and pull requests. Leave the change uncommitted; the host commits after recheck.";

export function excludedReason(path: string): string {
	return `Role guard: ${path} is excluded from automated change in this repo (auth, data, deploy, or the gate's own definition). Record what you would change there in your report; the host presents it.`;
}

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export class CannotCheck extends Error {}

export type Decision = {
	deny: string | null;
	tool: string;
	target: string;
	reason: string;
};

export function decide(
	m: Manifest,
	runDir: string,
	event: Record<string, unknown>,
): Decision {
	const tool = event.tool_name;
	const input = event.tool_input;
	if (typeof tool !== "string")
		throw new CannotCheck("the event has no tool_name");
	if (typeof input !== "object" || input === null)
		throw new CannotCheck("the event has no tool_input");
	const fields = input as Record<string, unknown>;
	if (tool === "Bash") {
		const command = fields.command;
		if (typeof command !== "string")
			throw new CannotCheck("the Bash call has no command");
		if (m.history_writes)
			return { deny: null, tool, target: "bash", reason: "history authority" };
		let found: string | null;
		try {
			found = historyWrite(command);
		} catch (error) {
			if (error instanceof Unclassifiable)
				throw new CannotCheck(`the command holds ${error.message}`);
			throw error;
		}
		return found
			? {
					deny: HISTORY_REASON,
					tool,
					target: "bash",
					reason: `history write ${found}`,
				}
			: { deny: null, tool, target: "bash", reason: "no history write" };
	}
	if (EDITS.has(tool)) {
		const path =
			tool === "NotebookEdit" ? fields.notebook_path : fields.file_path;
		if (typeof path !== "string" || path === "")
			throw new CannotCheck(`the ${tool} call has no path`);
		if (excludedBy(m.repo, path, [runDir]))
			return {
				deny: excludedReason(shownPath(m.repo, path)),
				tool,
				target: path,
				reason: "the run directory",
			};
		const hit = excludedBy(m.repo, path, m.excluded);
		return hit
			? {
					deny: excludedReason(shownPath(m.repo, path)),
					tool,
					target: path,
					reason: `excluded by ${hit}`,
				}
			: { deny: null, tool, target: path, reason: "not excluded" };
	}
	return { deny: null, tool, target: "-", reason: "not a guarded tool" };
}

/** Log the decision and return the hook's stdout. A log failure throws. */
export function answer(
	m: Manifest,
	d: Decision,
	session: string,
	ms: number,
): string {
	logLine(
		m.log,
		"guard",
		d.tool,
		d.target,
		ms,
		d.deny ? "DENY" : "ALLOW",
		`${d.reason} session=${session}`,
	);
	if (!d.deny) return "";
	return `${JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: d.deny,
		},
	})}\n`;
}
