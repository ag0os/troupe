import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { localDate } from "./dates";

export function read(path: string): string {
	return readFileSync(path, "utf8");
}

export function words(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

export function wordsIn(paths: string[]): number {
	return paths.reduce(
		(count, path) => count + (existsSync(path) ? words(read(path)) : 0),
		0,
	);
}

/** Regular files under dir matching filter; symlinks are not followed. */
export function walk(
	dir: string,
	filter: (path: string) => boolean,
	skip: string[] = [],
): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (skip.includes(path)) continue;
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) out.push(...walk(path, filter, skip));
		else if (filter(path)) out.push(path);
	}
	return out.sort();
}

export function mdFiles(dir: string, skip: string[] = []): string[] {
	return walk(dir, (path) => path.endsWith(".md"), skip);
}

export function frontmatter(text: string): Record<string, string> | undefined {
	const match = text.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return undefined;
	const fields: Record<string, string> = {};
	for (const line of match[1]?.split("\n") ?? []) {
		const keyValue = line.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*(#.*)?$/);
		if (keyValue?.[1] !== undefined && keyValue[2] !== undefined) {
			fields[keyValue[1]] = keyValue[2];
		}
	}
	return fields;
}

/** Lines outside fenced code blocks, with 1-based line numbers. */
export function proseLines(text: string): { n: number; line: string }[] {
	const out: { n: number; line: string }[] = [];
	let fenced = false;
	text.split("\n").forEach((line, index) => {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			return;
		}
		if (!fenced) out.push({ n: index + 1, line });
	});
	return out;
}

/**
 * When a done item closed: its `closed:` frontmatter, else the STATUS.md
 * modification time, which is an approximation.
 */
export function closedDate(itemDir: string): {
	date: Date;
	approximate: boolean;
} {
	const status = join(itemDir, "STATUS.md");
	const closed = existsSync(status)
		? frontmatter(read(status))?.closed
		: undefined;
	if (closed) {
		const date = localDate(closed);
		if (!Number.isNaN(date.getTime())) return { date, approximate: false };
	}
	const stamp = existsSync(status)
		? statSync(status).mtime
		: statSync(itemDir).mtime;
	return { date: stamp, approximate: true };
}

/** Split a journal into its preamble and one section per dated heading. */
export function journalSections(text: string): {
	preamble: string;
	days: { date: string; body: string }[];
} {
	const parts = text.split(/^(?=## \d{4}-\d{2}-\d{2})/m);
	const preamble = /^## \d{4}-\d{2}-\d{2}/.test(parts[0] ?? "")
		? ""
		: (parts.shift() ?? "");
	const days = parts.map((body) => ({
		date: body.match(/^## (\d{4}-\d{2}-\d{2})/)?.[1] ?? "",
		body,
	}));
	return { preamble, days };
}

export type JournalEntry = {
	line: number;
	heading?: number;
	day?: string;
	time?: string;
	text: string;
	id: string;
};

export type ChainEntry = JournalEntry & { file: string };

/** Entries in file order, with ids chained from previousId. */
export function journalEntries(
	text: string,
	previousId: string = "root",
): JournalEntry[] {
	const entries: JournalEntry[] = [];
	let day: string | undefined;
	let headingLine: number | undefined;
	let current: JournalEntry | undefined;
	let previousLine = 0;
	for (const { n, line } of proseLines(text)) {
		if (n !== previousLine + 1) current = undefined;
		previousLine = n;
		const heading = line.match(/^## (\d{4}-\d{2}-\d{2})/);
		if (heading) {
			day = heading[1];
			headingLine = n;
		}
		if (line.startsWith("- ")) {
			current = {
				line: n,
				heading: headingLine,
				day,
				text: line.slice(2),
				id: "",
			};
			entries.push(current);
		} else if (current && /^[ \t]/.test(line) && line.trim()) {
			current.text += ` ${line}`;
		} else {
			current = undefined;
		}
	}
	for (const entry of entries) {
		entry.text = entry.text.replace(/\s+/g, " ").trim();
		entry.time = entry.text.match(/^(\d{2}:\d{2})(?=\s|:)/)?.[1];
		entry.id = createHash("sha256")
			.update(`${previousId}\n${entry.text}`)
			.digest("hex")
			.slice(0, 10);
		previousId = entry.id;
	}
	return entries;
}

/** Archived journals in filename order, followed by the current journal. */
export function journalChain(state: string): {
	entries: ChainEntry[];
	files: string[];
	unreadable: { file: string; reason: string }[];
} {
	const entries: ChainEntry[] = [];
	const files: string[] = [];
	const unreadable: { file: string; reason: string }[] = [];
	const candidates: string[] = [];
	const archive = "archive/journal";
	try {
		const path = join(state, archive);
		if (lstatSync(path).isSymbolicLink()) {
			unreadable.push({ file: archive, reason: "is a symlink" });
		} else {
			candidates.push(
				...readdirSync(path)
					.filter((file) => file.endsWith(".md"))
					.sort()
					.map((file) => `${archive}/${file}`),
			);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			unreadable.push({
				file: archive,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	candidates.push("journal.md");
	let previousId = "root";
	for (const file of candidates) {
		let inspected = false;
		try {
			const path = join(state, file);
			const stat = lstatSync(path);
			inspected = true;
			if (stat.isSymbolicLink() || !stat.isFile()) {
				unreadable.push({
					file,
					reason: stat.isSymbolicLink()
						? "is a symlink"
						: "is not a regular file",
				});
				continue;
			}
			const parsed = journalEntries(read(path), previousId);
			files.push(file);
			entries.push(...parsed.map((entry) => ({ ...entry, file })));
			previousId = parsed.at(-1)?.id ?? previousId;
		} catch (error) {
			if (
				!inspected &&
				file === "journal.md" &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			) {
				continue;
			}
			unreadable.push({
				file,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { entries, files, unreadable };
}

function journalHeadings(text: string): { day: string; line: number }[] {
	return proseLines(text).flatMap(({ n, line }) => {
		const day = line.match(/^## (\d{4}-\d{2}-\d{2})/)?.[1];
		return day ? [{ day, line: n }] : [];
	});
}

/** Timed entries more than five minutes behind the previous time per heading. */
export function journalTimeSlips(text: string): {
	day: string;
	headingLine: number;
	count: number;
	firstLine: number;
}[] {
	const headings = journalHeadings(text);
	const slips: ReturnType<typeof journalTimeSlips> = [];
	let headingIndex = -1;
	let previous: number | undefined;
	let slip: (typeof slips)[number] | undefined;
	for (const entry of journalEntries(text)) {
		while (
			headings[headingIndex + 1] &&
			(headings[headingIndex + 1]?.line ?? Infinity) < entry.line
		) {
			headingIndex++;
			previous = undefined;
			slip = undefined;
		}
		const heading = headings[headingIndex];
		if (!heading || !entry.time) continue;
		const [hour, minute] = entry.time.split(":").map(Number);
		const time = (hour ?? 0) * 60 + (minute ?? 0);
		if (previous !== undefined && previous - time > 5) {
			if (!slip) {
				slip = {
					day: heading.day,
					headingLine: heading.line,
					count: 0,
					firstLine: entry.line,
				};
				slips.push(slip);
			}
			slip.count++;
		}
		previous = time;
	}
	return slips;
}

/** Repeated dates with every heading line, in first appearance order. */
export function journalDuplicateHeadings(
	text: string,
): { day: string; lines: number[] }[] {
	const dates = new Map<string, number[]>();
	for (const { day, line } of journalHeadings(text)) {
		const lines = dates.get(day) ?? [];
		lines.push(line);
		dates.set(day, lines);
	}
	return [...dates].flatMap(([day, lines]) =>
		lines.length > 1 ? [{ day, lines }] : [],
	);
}

/** Headings earlier than the immediately preceding dated heading. */
export function journalMisorderedHeadings(
	text: string,
): { day: string; line: number; previous: string }[] {
	const out: ReturnType<typeof journalMisorderedHeadings> = [];
	let previous: string | undefined;
	for (const { day, line } of journalHeadings(text)) {
		if (previous && day < previous) out.push({ day, line, previous });
		previous = day;
	}
	return out;
}

/** Entries before the first dated heading, retaining their chain ids. */
export function journalOrphans(text: string): JournalEntry[] {
	return journalEntries(text).filter(({ day }) => day === undefined);
}

/** One line from STATUS.md for an index. */
export function summaryLine(itemDir: string): string {
	const status = join(itemDir, "STATUS.md");
	if (!existsSync(status)) return "(no STATUS.md)";
	const text = read(status).replace(/^---\n[\s\S]*?\n---\n/, "");
	const title = text.match(/^# [^:\n]+:\s*(.+)$/m)?.[1];
	if (title) return title.trim();
	const outcome = text.match(/^## Outcome\s*\n+([^\n]+)/m)?.[1];
	if (outcome) {
		return (
			outcome
				.replace(/\*\*/g, "")
				.split(/(?<=\.)\s/)[0]
				?.trim() ?? ""
		);
	}
	return text.match(/^# (.+)$/m)?.[1]?.trim() ?? "(untitled)";
}
