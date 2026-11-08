import { checkWorkspace, type Finding } from "./check";
import { CLEAN_WORDS, RECONCILE_WORDS } from "./checkpoint";
import type { Config } from "./config";
import type { ToolEnv } from "./sessions";
import { collectStart, type StartData } from "./start-collect";
import { words } from "./text";
import type { Workspace, WorkspaceTree } from "./tree";

function shownFindings(findings: Finding[]): Finding[] {
	return findings
		.filter(({ level }) => level !== "info")
		.sort(
			(left, right) =>
				Number(left.level === "warn") - Number(right.level === "warn") ||
				left.file.localeCompare(right.file),
		);
}
function checkText(findings: Finding[]): string {
	const shown = shownFindings(findings);
	if (!shown.length) return "clean";
	return [
		`${shown.filter(({ level }) => level === "error").length} errors, ${shown.filter(({ level }) => level === "warn").length} warnings`,
		...shown.map(
			(finding) =>
				`  ${finding.level.toUpperCase().padEnd(5)} ${finding.file}${finding.line ? `:${finding.line}` : ""}  ${finding.message}`,
		),
	].join("\n");
}

/** Render the complete human startup view. */
export function renderStart(data: StartData, findings: Finding[]): string {
	const a = data.assessment;
	const checkpoint =
		a.status === "none"
			? "no checkpoint"
			: a.status === "invalid"
				? `invalid checkpoint: ${a.reason}`
				: `revision ${a.checkpoint?.revision} by ${a.checkpoint?.session ?? "unknown"} at ${a.checkpoint?.written}`;
	let journalHeading =
		data.journal.mode === "boundary"
			? "Journal since the boundary"
			: `Journal, fallback: last two sections (${data.journal.sections.join(", ") || "none"})`;
	if (
		data.journal.mode === "fallback" &&
		findings.some(({ code }) =>
			[
				"journal-misfiled",
				"journal-heading-duplicate",
				"journal-heading-order",
				"journal-time-backwards",
			].includes(code),
		)
	)
		journalHeading += "; headings may be misfiled; see check findings";
	return [
		`# Shepherd start: ${data.workspace}\n${data.now}\nbinary: ${data.binary}\n${checkpoint}`,
		`## Verdict\n${a.verdict}\n${[...a.reasons, `freshness: ${a.freshness}`, `lock: ${a.lock}`, a.verdict === "CLEAN" ? CLEAN_WORDS : RECONCILE_WORDS].join("\n")}`,
		`## CURRENT.md\n${data.current}`,
		`## Pending\n${data.pending}`,
		`## ${journalHeading}\n${data.journal.text}`,
		`## MEMORY.md\n${data.memoryIndex}`,
		`## docs/INDEX.md\n${data.docsIndex}`,
		`## Check\n${checkText(findings)}`,
		"## Next\nRun `shepherd tool checkpoint` after you reconcile and at handoff.\nAppend to the journal with `shepherd tool journal`.\nCURRENT is the live briefing; STATUS is the work item's state; pending holds unresolved warnings.",
	].join("\n\n");
}

/** Return the schema 1 startup object with printed source word counts. */
export function startJson(data: StartData, findings: Finding[]) {
	const a = data.assessment;
	return {
		schema: 1,
		command: "start",
		workspace: data.workspace,
		now: data.now,
		binary: data.binary,
		checkpoint: {
			status: a.status,
			revision: a.checkpoint?.revision,
			session: a.checkpoint?.session,
			written: a.checkpoint?.written,
			...(a.reason ? { reason: a.reason } : {}),
		},
		verdict: a.verdict,
		reasons: a.reasons,
		freshness: a.freshness,
		lock: a.lock,
		current: data.current,
		pending: data.pending,
		journal: {
			mode: data.journal.mode,
			entries: data.journal.entries,
			orphans: data.journal.orphans,
			uncertified: data.journal.uncertified,
			...(data.journal.cut ? { cut: data.journal.cut } : {}),
		},
		memoryIndex: data.memoryIndex,
		docsIndex: data.docsIndex,
		findings: shownFindings(findings),
		words: { ...data.words, findings: words(checkText(findings)) },
	};
}

/** Collect, check once, then render the requested startup form. */
export function runStart(
	workspace: Workspace,
	tree: WorkspaceTree,
	toolEnv: ToolEnv,
	config: Config,
	options: { budget?: number; json: boolean; today: Date },
): { code: 0; text: string } {
	const data = collectStart(workspace, toolEnv, config, options.budget);
	const findings = checkWorkspace(
		workspace,
		tree,
		config,
		options.today,
		toolEnv.home,
		toolEnv,
	);
	return {
		code: 0,
		text: options.json
			? JSON.stringify(startJson(data, findings), null, 2)
			: renderStart(data, findings),
	};
}
