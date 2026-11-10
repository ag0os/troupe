import { statSync } from "node:fs";
import { join } from "node:path";
import { latestClaudeTranscriptMtime, type ToolEnv } from "./sessions";
import type { Workspace } from "./tree";

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
