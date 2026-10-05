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
