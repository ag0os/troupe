// The guard: denies a Bash history write when the run has no history
// authority, and an edit or a shell write to an excluded path or to the
// run's own directory.
// Every other call passes with no explicit grant. Whatever stops it from
// checking is the caller's to turn into a refusal.
import { lstatSync, opendirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { globRegex } from "../contract.d/lint";
import { logLine } from "./log";
import type { Manifest } from "./manifest";
import { excludedBy, holdsExclusion, shownPath } from "./paths";
import {
	historyWrite,
	pushWrite,
	shellWrites,
	type Target,
	Unclassifiable,
} from "./shell";

export const HISTORY_REASON =
	"Role guard: history writes are off for this run; the host holds commits, pushes and pull requests. Leave the change uncommitted; the host commits after recheck.";

export const PUSH_REASON =
	"Role guard: pushes and pull requests stay with the host in this run. Commit on your branch; the host pushes after recheck.";

/**
 * The most entries one glob's directory may hold, and the most it may match:
 * each match is checked like any target, so these bound the guard's time
 * (measured in the fix3 report). Past either the command is refused.
 */
export const GLOB_LISTED = 5000;
export const GLOB_MATCHED = 64;

/**
 * Each target whose last segment is a glob, replaced by the entries of its
 * directory it matches, as Bash expands it: no leading dot unless the glob
 * has one, and the word itself when nothing matches or the directory cannot
 * be listed. A matched entry that is not a directory is a file target.
 */
function expand(targets: Target[], cwd: string): Target[] {
	const tooMany = (what: string) =>
		new Unreadable(new Unclassifiable(`a glob over ${what}`));
	return targets.flatMap((t) => {
		if (!t.glob) return [t];
		const cut = t.path.lastIndexOf("/");
		const dir = cut < 0 ? "" : t.path.slice(0, cut + 1);
		const pattern = t.path.slice(cut + 1);
		const regex = globRegex(pattern);
		const matched: Target[] = [];
		let listed = 0;
		try {
			const handle = opendirSync(isAbsolute(dir) ? dir : `${cwd}/${dir}`);
			try {
				for (let e = handle.readSync(); e; e = handle.readSync()) {
					if (++listed > GLOB_LISTED)
						throw tooMany(`a directory of more than ${GLOB_LISTED} entries`);
					if (
						(pattern.startsWith(".") || !e.name.startsWith(".")) &&
						regex.test(e.name)
					) {
						if (matched.length >= GLOB_MATCHED)
							throw tooMany(`more than ${GLOB_MATCHED} entries`);
						matched.push({
							path: `${dir}${e.name}`,
							kind: e.isDirectory() || e.isSymbolicLink() ? t.kind : "file",
						});
					}
				}
			} finally {
				handle.closeSync();
			}
		} catch (error) {
			if (error instanceof Unreadable) throw error;
		}
		// Unmatched, Bash keeps the word: a path that does not exist, which
		// holds nothing.
		return matched.length ? matched : [{ path: t.path, kind: "file" }];
	});
}

function regularFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

export function excludedReason(path: string): string {
	return `Role guard: ${path} is excluded from automated change in this repo (auth, data, deploy, or the gate's own definition). Record what you would change there in your report; the host presents it.`;
}

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export class CannotCheck extends Error {}

/** A command the guard cannot read: the builder's to rewrite, not a fault. */
export class Unreadable extends CannotCheck {
	readonly text: string;
	constructor(error: Unclassifiable) {
		super(`the command holds ${error.message}`);
		this.text = error.what
			? `Role guard could not read this command: ${error.what} holds an expansion. Spell the command name and git options literally and run it again; this is not a hooks failure.`
			: `Role guard could not read this command: it holds ${error.message}. Write it plainly and run it again; this is not a hooks failure.`;
	}
}

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
		const history = m.history_writes ? "history authority" : "no history write";
		let unreadable: Unclassifiable | null = null;
		const attempt = (read: () => string | null): string | null => {
			try {
				return read();
			} catch (error) {
				if (!(error instanceof Unclassifiable)) throw error;
				unreadable ??= error;
				return null;
			}
		};
		if (!m.history_writes) {
			const found = attempt(() => historyWrite(command));
			if (found)
				return {
					deny: HISTORY_REASON,
					tool,
					target: "bash",
					reason: `history write ${found}`,
				};
		} else if (!m.push_writes) {
			const found = attempt(() => pushWrite(command));
			if (found)
				return {
					deny: PUSH_REASON,
					tool,
					target: "bash",
					reason: `push ${found}`,
				};
		}
		// What was read is checked before an unreadable remainder is decided.
		const writes = shellWrites(command);
		unreadable ??= writes.error;
		const cwd =
			typeof event.cwd === "string" && isAbsolute(event.cwd)
				? event.cwd
				: m.repo;
		for (const write of expand(writes.targets, cwd)) {
			// Unnormalized, so the path check resolves symlinks before `..`.
			const path = isAbsolute(write.path) ? write.path : `${cwd}/${write.path}`;
			const shown = shownPath(m.repo, path);
			const deny = (named: string, why: string): Decision => ({
				deny: excludedReason(named),
				tool,
				target: "bash",
				reason: `shell write ${shown} ${why}`,
			});
			if (excludedBy(m.repo, path, [runDir]))
				return deny(shown, "in the run directory");
			const hit = excludedBy(m.repo, path, m.excluded);
			if (hit) return deny(shown, `excluded by ${hit}`);
			// A regular file holds nothing, whatever a glob exclusion says.
			if (write.kind === "tree" && !regularFile(path)) {
				if (holdsExclusion(m.repo, path, [runDir]))
					return deny(runDir, "contains the run directory");
				const held = holdsExclusion(m.repo, path, m.excluded);
				if (held) {
					const entry = held.replace(/\/+$/, "");
					const named = /[*?[]/.test(entry) ? entry : shownPath(m.repo, entry);
					return deny(named, `contains ${named}`);
				}
			}
		}
		// With history and push authority and nothing excluded only the run
		// directory is at stake, and an unreadable command passes unread.
		if (unreadable) {
			if (!(m.history_writes && m.push_writes && m.excluded.length === 0))
				throw new Unreadable(unreadable);
			return {
				deny: null,
				tool,
				target: "bash",
				reason: `${history}; command not read`,
			};
		}
		const said = writes.unread
			? "shell writes not read, not health-checked"
			: writes.targets.length
				? "shell writes not excluded, not health-checked"
				: null;
		return {
			deny: null,
			tool,
			target: "bash",
			reason: said ? `${history}; ${said}` : history,
		};
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
