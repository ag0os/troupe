import {
	appendFileSync,
	lstatSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dayOf } from "./dates";
import { renderTemplate, TEMPLATES } from "./guides";
import { LockError, type LockOptions, withStateLock } from "./lock";
import type { ToolEnv } from "./sessions";
import { journalChain, proseLines } from "./text";

export type AppendedEntry = {
	line: number;
	id: string;
	day: string;
	time: string;
	text: string;
	headingAdded: boolean;
};

class JournalPathError extends Error {}

function readJournal(state: string, toolEnv: ToolEnv): string {
	const path = join(state, "journal.md");
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink())
			throw new JournalPathError("journal.md is a symlink");
		if (!stat.isFile())
			throw new JournalPathError("journal.md is not a regular file");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const template = TEMPLATES.find(({ path }) => path === "journal.md");
		if (!template) throw new Error("journal template not found");
		writeFileSync(path, renderTemplate(template.text, toolEnv.now), {
			flag: "wx",
		});
	}
	return readFileSync(path, "utf8");
}

/** Append clock-stamped entries under the state lock unless already held. */
export async function appendEntries(
	state: string,
	texts: string[],
	toolEnv: ToolEnv,
	options: { locked?: boolean; lock?: LockOptions } = {},
): Promise<AppendedEntry[]> {
	const append = () => {
		const appended: AppendedEntry[] = [];
		for (const text of texts) {
			const before = readJournal(state, toolEnv);
			const now = toolEnv.clock();
			const day = dayOf(now);
			const pad = (value: number) => String(value).padStart(2, "0");
			const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
			const lastDay = proseLines(before)
				.flatMap(({ line }) => line.match(/^## (\d{4}-\d{2}-\d{2})/)?.[1] ?? [])
				.at(-1);
			const headingAdded = lastDay !== day;
			const newline = before.endsWith("\n") ? "" : "\n";
			const heading = headingAdded ? `\n## ${day}\n\n` : "";
			const writtenText = `${time} ${text}`.replace(/\s+/g, " ").trim();
			const addition = `${newline}${heading}- ${writtenText}\n`;
			appendFileSync(join(state, "journal.md"), addition);
			const line = (before + addition).split("\n").length - 1;
			const entry = journalChain(state).entries.find(
				(entry) => entry.file === "journal.md" && entry.line === line,
			);
			if (!entry) throw new Error("appended journal entry not found in chain");
			appended.push({
				line,
				id: entry.id,
				day,
				time,
				text: writtenText,
				headingAdded,
			});
		}
		return appended;
	};
	return options.locked
		? append()
		: withStateLock(state, toolEnv, append, options.lock);
}

/** Normalize journal input, append it, and render human or JSON output. */
export async function runJournal(
	state: string,
	input: string,
	toolEnv: ToolEnv,
	json: boolean,
	options: { lock?: LockOptions } = {},
): Promise<{
	code: 0 | 1;
	text: string;
	stream: "stdout" | "stderr";
	notice?: string;
}> {
	let text = input.replace(/\s+/g, " ").trim();
	const stamp = /^\d{2}:\d{2}(?: UTC)?(?::|(?=\s|$))\s*/;
	const notice = stamp.test(text) ? "time comes from the clock" : undefined;
	if (notice) text = text.replace(stamp, "").trim();
	if (!text)
		return { code: 1, text: "nothing to append", stream: "stderr", notice };
	try {
		const [entry] = await appendEntries(state, [text], toolEnv, options);
		if (!entry) throw new Error("journal entry not appended");
		return {
			code: 0,
			text: json
				? JSON.stringify(entry)
				: `- ${entry.text}\n${entry.id} (line ${entry.line})`,
			stream: "stdout",
			notice,
		};
	} catch (error) {
		if (!(error instanceof LockError) && !(error instanceof JournalPathError))
			throw error;
		return { code: 1, text: error.message, stream: "stderr", notice };
	}
}
