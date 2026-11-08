import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Assessment, assessCheckpoint } from "./checkpoint";
import type { Config } from "./config";
import { localTimestamp } from "./dates";
import { TEMPLATES } from "./guides";
import type { ToolEnv } from "./sessions";
import { type ChainEntry, proseLines, words } from "./text";
import type { Workspace } from "./tree";

export type StartWords = {
	current: number;
	pending: number;
	journal: number;
	memoryIndex: number;
	docsIndex: number;
	start: number;
};
export type StartData = {
	workspace: string;
	now: string;
	binary: string;
	assessment: Assessment;
	current: string;
	pending: string;
	memoryIndex: string;
	docsIndex: string;
	journal: {
		mode: "boundary" | "fallback";
		sections: string[];
		entries: ChainEntry[];
		orphans: ChainEntry[];
		uncertified: number;
		cut?: { entries: number; words: number; from: string; to: string };
		text: string;
	};
	words: StartWords;
};

function source(state: string, path: string): string | undefined {
	try {
		return readFileSync(join(state, path), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return `unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function entryLine(entry: ChainEntry): string {
	return `${entry.file}:${entry.line} ${entry.text}`;
}

function entryEnd(state: string, entry: ChainEntry): number {
	let end = entry.line;
	for (const { n, line } of proseLines(source(state, entry.file) ?? "")) {
		if (n <= entry.line) continue;
		if (n !== end + 1 || !/^[ \t]/.test(line) || !line.trim()) break;
		end = n;
	}
	return end;
}

/** Collect startup sources and their printed word counts, without checking or rendering. */
export function collectStart(
	workspace: Workspace,
	toolEnv: ToolEnv,
	config: Config,
	budget = config.start.journalWords,
): StartData {
	const assessment = assessCheckpoint(workspace, toolEnv);
	const current = source(workspace.state, "CURRENT.md");
	if (current === undefined) {
		assessment.verdict = "RECONCILE";
		if (!assessment.reasons.includes("CURRENT.md is missing"))
			assessment.reasons.push("CURRENT.md is missing");
	}
	const pending = source(workspace.state, "pending.md");
	const PENDING_TEMPLATE = TEMPLATES.find(
		(template) => String(template.path) === "pending.md",
	)?.text;
	const pendingText =
		pending === undefined ||
		(PENDING_TEMPLATE === undefined && !pending.trim()) ||
		(PENDING_TEMPLATE !== undefined && pending === PENDING_TEMPLATE)
			? "none"
			: pending.trim()
				? pending
				: "(empty file)";
	const all = assessment.unreviewed.entries;
	let first = all.length;
	let used = 0;
	let oversized = false;
	if (budget > 0) {
		for (let index = all.length - 1; index >= 0; index--) {
			const entry = all[index];
			if (!entry) continue;
			const count = words(entryLine(entry));
			if (used + count > budget) {
				if (index === all.length - 1) {
					first = index;
					oversized = true;
				}
				break;
			}
			used += count;
			first = index;
		}
	}
	const removed = all.slice(0, first);
	const entries = all.slice(first);
	const cutFrom = removed[0];
	const cutTo = removed.at(-1);
	const cutEnd = cutTo ? entryEnd(workspace.state, cutTo) : undefined;
	const cut =
		cutFrom && cutTo
			? {
					entries: removed.length,
					words: removed.reduce(
						(sum, entry) => sum + words(entryLine(entry)),
						0,
					),
					from: `${cutFrom.file}:${cutFrom.line}`,
					to: `${cutTo.file}:${cutEnd}`,
				}
			: undefined;
	const lines: string[] = [];
	if (cut && cutFrom && cutTo) {
		const range =
			cutFrom.file === cutTo.file
				? `${cutFrom.file} lines ${cutFrom.line} to ${cutEnd}`
				: `${cut.from} to ${cut.to}`;
		lines.push(
			`[cut: ${cut.entries} earlier entries, ${cut.words} words, ${range}: read them before any action they could concern and before you checkpoint]`,
		);
	}
	if (oversized)
		lines.push(
			`[newest entry exceeds the ${budget}-word budget; printed whole]`,
		);
	if (!all.length) lines.push("none");
	lines.push(...entries.map(entryLine));
	if (assessment.orphans.length) {
		lines.push(
			"entries without a heading (not certified: give them a heading)",
			...assessment.orphans.map(entryLine),
		);
	}
	lines.push(
		`${assessment.uncertified} uncertified entries before the reviewed range`,
	);
	const data: StartData = {
		workspace: workspace.name,
		now: localTimestamp(toolEnv.clock()),
		binary: toolEnv.execPath ?? process.execPath,
		assessment,
		current: current ?? "CURRENT.md is missing",
		pending: pendingText,
		memoryIndex: source(workspace.state, "MEMORY.md") ?? "missing",
		docsIndex: source(workspace.state, "docs/INDEX.md") ?? "missing",
		journal: {
			mode: assessment.unreviewed.mode,
			sections:
				assessment.unreviewed.sections?.map((section) => section.day) ?? [],
			entries,
			orphans: assessment.orphans,
			uncertified: assessment.uncertified,
			...(cut ? { cut } : {}),
			text: lines.join("\n"),
		},
		words: {
			current: 0,
			pending: 0,
			journal: 0,
			memoryIndex: 0,
			docsIndex: 0,
			start: 0,
		},
	};
	for (const part of [
		"current",
		"pending",
		"memoryIndex",
		"docsIndex",
	] as const)
		data.words[part] = words(data[part]);
	data.words.journal = words(data.journal.text);
	data.words.start = Object.values(data.words).reduce(
		(sum, count) => sum + count,
		0,
	);
	return data;
}
