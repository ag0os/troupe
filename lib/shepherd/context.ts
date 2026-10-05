import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { promptWords } from "./compose";
import type { Config } from "./config";
import { journalSections, mdFiles, read, words, wordsIn } from "./text";
import type { Workspace } from "./tree";

const WORDS_TO_TOKENS = 1.35;

export type ContextTiers = {
	name: string;
	loaded: number;
	start: number;
	opens: number;
	onDemand: number;
	cold: number;
	over: string[];
};

function readableWords(paths: readonly string[]): number {
	let count = 0;
	for (const path of paths) {
		try {
			if (existsSync(path)) count += words(read(path));
		} catch {
			// A readable fragment still contributes when another one is broken.
		}
	}
	return count;
}

function localIntegrationFiles(state: string): string[] {
	const dir = join(state, "integrations");
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".md"))
			.sort()
			.map((file) => join(dir, file));
	} catch {
		return [];
	}
}

function linkedIntegrationTargets(state: string): string[] {
	const targets: string[] = [];
	for (const path of localIntegrationFiles(state)) {
		try {
			if (lstatSync(path).isSymbolicLink()) targets.push(realpathSync(path));
		} catch {
			// Broken links are diagnosed by the workspace check.
		}
	}
	return targets;
}

/** Count the four context tiers for one workspace. */
export function contextTiers(
	workspace: Workspace,
	config: Config,
	onPromptError?: (message: string) => void,
): ContextTiers {
	const state = workspace.state;
	const journal = join(state, "journal.md");
	const journalText = existsSync(journal) ? read(journal) : "";
	const lastTwoDays = journalSections(journalText)
		.days.slice(-2)
		.reduce((count, day) => count + words(day.body), 0);
	const startFiles = [
		"CURRENT.md",
		"HANDOFF.md",
		"MEMORY.md",
		"docs/INDEX.md",
	].map((file) => join(state, file));
	const start = wordsIn(startFiles) + lastTwoDays;

	const journalRest = words(journalText) - lastTwoDays;
	const linkedTargets = new Set(linkedIntegrationTargets(state));
	const skip = [
		join(state, "archive"),
		join(state, "integrations"),
		join(state, "charter.md"),
		journal,
		...startFiles,
	];
	const onDemandFiles = mdFiles(state, skip).filter((path) => {
		try {
			return !linkedTargets.has(realpathSync(path));
		} catch {
			return true;
		}
	});
	const onDemand = wordsIn(onDemandFiles) + journalRest;
	const cold = wordsIn(mdFiles(join(state, "archive")));

	let loaded: number;
	try {
		loaded = promptWords(workspace.dir);
	} catch (error) {
		loaded = readableWords([
			join(state, "charter.md"),
			...localIntegrationFiles(state),
		]);
		onPromptError?.(
			error instanceof Error ? error.message : "could not compose prompt",
		);
	}

	const opens = loaded + start;
	const over: string[] = [];
	if (opens > config.marks.opening) {
		over.push(`opening > ${config.marks.opening}`);
	}
	if (readableWords([join(state, "charter.md")]) > config.marks.charter) {
		over.push(`charter > ${config.marks.charter}`);
	}
	if (readableWords([join(state, "CURRENT.md")]) > config.marks.current) {
		over.push(`CURRENT > ${config.marks.current}`);
	}

	return {
		name: workspace.name,
		loaded,
		start,
		opens,
		onDemand,
		cold,
		over,
	};
}

function compact(count: number): string {
	return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : `${count}`;
}

function tokens(words: number): string {
	return `~${compact(Math.round(words * WORDS_TO_TOKENS))} tok`;
}

/** Render the human context table. */
export function renderContextTable(rows: readonly ContextTiers[]): string {
	const lines = [
		"Words per context tier (tokens are about words x 1.35):",
		"",
		`${"workspace".padEnd(14)}${"1 loaded".padStart(10)}${"2 at start".padStart(12)}${"= a session opens with".padStart(26)}${"3 on demand".padStart(13)}${"4 cold".padStart(9)}   past a review mark`,
	];
	for (const row of rows) {
		lines.push(
			`${row.name.padEnd(14)}${compact(row.loaded).padStart(10)}${compact(row.start).padStart(12)}${`${compact(row.opens)} (${tokens(row.opens)})`.padStart(26)}${compact(row.onDemand).padStart(13)}${compact(row.cold).padStart(9)}   ${row.over.join(", ") || "-"}`,
		);
	}
	const sum = (field: "onDemand" | "cold") =>
		rows.reduce((count, row) => count + row[field], 0);
	lines.push(
		`${"all".padEnd(14)}${"".padStart(10)}${"".padStart(12)}${"".padStart(26)}${compact(sum("onDemand")).padStart(13)}${compact(sum("cold")).padStart(9)}`,
		"",
		"1 loaded: the composed prompt (core, modules, charter). 2 at start: CURRENT, HANDOFF, MEMORY, docs/INDEX and the last two journal days.",
		"3 on demand: memories, docs, work items, older journal, other files. 4 cold: archive/.",
	);
	return lines.join("\n");
}
