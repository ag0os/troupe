import { posix } from "node:path";
import { noNext, STATUS_WORDS, type StatusItem } from "./status-parse";
import { journalFenceProblem, proseLines } from "./text";

export type ParseProblem = {
	code: string;
	line?: number;
	message: string;
};

export type CurrentItem = {
	word: string;
	known: boolean;
	slug: string | null;
	link: string | null;
	text: string;
	raw: string;
	line: number;
	endLine: number;
};

export type CurrentItems = {
	updated: string | null;
	noNext: boolean;
	section: { line: number; endLine: number } | null;
	items: CurrentItem[];
	problems: ParseProblem[];
};

export type StatusSection = {
	heading: string;
	level: number;
	line: number;
	endLine: number;
	text: string;
};

export type StatusProjection = {
	raw: string;
	lines: number;
	frontmatter: { raw: string; fields: Record<string, string> } | null;
	title: string | null;
	preamble: { line: number; endLine: number; text: string } | null;
	sections: StatusSection[];
	problems: ParseProblem[];
};

const KNOWN = new Set<string>(STATUS_WORDS);
const ENTRY = /^[-*][ \t]+\*\*([A-Z]{3,}):?\*\*/;
const BOLD_START = /^[-*][ \t]+(\*\*([A-Z]+)\b[^*]*\*\*)/;
const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const WORK_STATUS = /^work\/[^/]+\/([^/]+)\/STATUS\.md$/;

function sourceLines(text: string): string[] {
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function fenceProblem(text: string): ParseProblem | undefined {
	const fence = journalFenceProblem(text);
	return (
		fence && { code: "fence-unclosed", line: fence.line, message: fence.reason }
	);
}

function entryText(joined: string): string {
	return collapse(
		joined
			.replace(/^[-*][ \t]+\*\*[A-Z]{3,}:?\*\*/, "")
			.replace(/^\s*[:—–-]?\s*/, "")
			.replace(LINK, "$1"),
	);
}

function statusLink(raw: string): { slug: string; link: string } | undefined {
	for (const [, label, target] of raw.matchAll(LINK)) {
		if (!target?.endsWith("/STATUS.md")) continue;
		return {
			link: target,
			slug: posix.normalize(target).match(WORK_STATUS)?.[1] ?? label ?? "",
		};
	}
	return undefined;
}

const UPDATED_SHAPE =
	/^Updated:\s*(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)(?:,[ \t]*(.*?))?[ \t]*(\r?)$/;

/** CURRENT's first `Updated:` line outside a fence and above `## Items`. */
function updatedLine(text: string): { line: number; text: string } | null {
	for (const { n, line } of proseLines(text)) {
		if (/^##\s+Items\b/i.test(line)) return null;
		if (/^Updated:/.test(line)) return { line: n, text: line };
	}
	return null;
}

/** The session name on CURRENT's `Updated:` line, when the line has the standard shape. */
export function updatedName(text: string): string | null {
	const found = updatedLine(text);
	return found?.text.match(UPDATED_SHAPE)?.[2] || null;
}

/**
 * CURRENT with the `Updated:` line's session name set to writer, nothing else
 * changed, or why the line was left alone.
 */
export function withUpdatedName(
	text: string,
	writer: string,
):
	| { status: "rewritten"; text: string; before: string | null }
	| { status: "same" }
	| { status: "skipped"; reason: "missing" | "not in the standard shape" } {
	const found = updatedLine(text);
	if (!found) return { status: "skipped", reason: "missing" };
	const match = found.text.match(UPDATED_SHAPE);
	if (!match?.[1])
		return { status: "skipped", reason: "not in the standard shape" };
	const before = match[2] || null;
	if (before === writer) return { status: "same" };
	const lines = text.split("\n");
	lines[found.line - 1] = `Updated: ${match[1]}, ${writer}${match[3]}`;
	return { status: "rewritten", text: lines.join("\n"), before };
}

/** CURRENT's Items entries, scoped to the Items section and lossless. */
export function currentItems(text: string): CurrentItems {
	const all = sourceLines(text);
	const prose = proseLines(text);
	const start = prose.findIndex(({ line }) => /^##\s+Items\b/i.test(line));
	const updated =
		updatedLine(text)?.text.slice("Updated:".length).trim() || null;
	const result: CurrentItems = {
		updated,
		noNext: noNext(text),
		section: null,
		items: [],
		problems: [],
	};
	const fence = fenceProblem(text);
	if (fence) {
		result.problems.push(fence);
		return result;
	}

	const heading = prose[start];
	if (!heading) {
		result.problems.push({
			code: "items-section-missing",
			message: "CURRENT.md has no `## Items` section",
		});
		return result;
	}
	const next = prose
		.slice(start + 1)
		.find(({ line }) => /^#{1,2}\s/.test(line));
	result.section = {
		line: heading.n,
		endLine: next ? next.n - 1 : all.length,
	};
	const inSection = prose.filter(
		({ n }) => n > heading.n && n <= (result.section?.endLine ?? 0),
	);

	let current: { item: CurrentItem; joined: string } | undefined;
	let previous = 0;
	const finish = () => {
		if (!current) return;
		const { item, joined } = current;
		item.raw = all.slice(item.line - 1, item.endLine).join("\n");
		item.text = entryText(joined);
		const link = statusLink(item.raw);
		item.slug = link?.slug ?? null;
		item.link = link?.link ?? null;
		result.items.push(item);
		current = undefined;
	};
	for (const { n, line } of inSection) {
		const contiguous = n === previous + 1;
		previous = n;
		if (current && contiguous && /^[ \t]/.test(line) && line.trim()) {
			current.item.endLine = n;
			current.joined += ` ${line}`;
			continue;
		}
		finish();
		const word = line.match(ENTRY)?.[1];
		if (!word) {
			const bold = line.match(BOLD_START);
			if (bold?.[1] && bold[2] && KNOWN.has(bold[2]))
				result.problems.push({
					code: "entry-off-shape",
					line: n,
					message: `entry starts with ${bold[1]}; core's shape is "- **WORD** text"; query items skips it`,
				});
			continue;
		}
		current = {
			item: {
				word,
				known: KNOWN.has(word),
				slug: null,
				link: null,
				text: "",
				raw: "",
				line: n,
				endLine: n,
			},
			joined: line,
		};
	}
	finish();
	return result;
}

/** CURRENT's entries as status shows them: the word, its text cut to 150 characters, and its line. */
export function statusItems(text: string): StatusItem[] {
	return currentItems(text).items.map(({ word, known, text, line }) => {
		const clean = text.replace(/\*\*/g, "");
		return {
			word,
			known,
			text: clean.length > 150 ? `${clean.slice(0, 147)}...` : clean,
			line,
		};
	});
}

function frontmatterValue(rest: string): string {
	const value = rest.trim();
	const quote = value[0];
	if (quote === '"' || quote === "'") {
		const close = value.indexOf(quote, 1);
		if (close > 0 && /^(\s+#.*)?\s*$/.test(value.slice(close + 1))) {
			return value.slice(1, close);
		}
	}
	return value.replace(/(^|\s)#.*$/, "").trim();
}

/** A STATUS file's raw text beside its frontmatter, title and sections. */
export function statusProjection(text: string): StatusProjection {
	const all = sourceLines(text);
	const projection: StatusProjection = {
		raw: text,
		lines: all.length,
		frontmatter: null,
		title: null,
		preamble: null,
		sections: [],
		problems: [],
	};

	let bodyStart = 1;
	const close =
		all[0] === "---"
			? all.findIndex((line, index) => index > 0 && line.trimEnd() === "---")
			: -1;
	if (close > 0) {
		const fields: Record<string, string> = {};
		for (let index = 1; index < close; index++) {
			const line = all[index] ?? "";
			const n = index + 1;
			if (!line.trim()) continue;
			const match = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
			if (!match?.[1]) {
				projection.problems.push({
					code: "frontmatter-unsupported",
					line: n,
					message: `frontmatter line ${n} is not \`key: value\``,
				});
				continue;
			}
			if (Object.hasOwn(fields, match[1])) {
				projection.problems.push({
					code: "frontmatter-duplicate-key",
					line: n,
					message: `frontmatter key \`${match[1]}\` repeats at line ${n}; the first value is kept`,
				});
				continue;
			}
			fields[match[1]] = frontmatterValue(match[2] ?? "");
		}
		projection.frontmatter = {
			raw: all.slice(1, close).join("\n"),
			fields,
		};
		bodyStart = close + 2;
	} else {
		projection.problems.push({
			code: "status-no-frontmatter",
			message:
				all[0] === "---"
					? "frontmatter opened at line 1 is never closed"
					: "STATUS.md has no frontmatter block",
		});
	}

	const fence = fenceProblem(text);
	if (fence) projection.problems.push(fence);

	const headings = proseLines(text)
		.filter(({ n }) => n >= bodyStart)
		.map(({ n, line }) => ({ n, match: line.match(/^(#{1,6})\s+(.*\S)\s*$/) }))
		.filter(({ match }) => match)
		.map(({ n, match }) => ({
			n,
			level: match?.[1]?.length ?? 0,
			heading: match?.[2] ?? "",
		}));
	const titleIndex = headings.findIndex(({ level }) => level === 1);
	const title = headings[titleIndex];
	if (title) projection.title = title.heading;
	const span = (from: number, to: number) =>
		collapse(all.slice(from - 1, to).join("\n"));
	const nextHeading = (index: number) =>
		(headings[index + 1]?.n ?? all.length + 1) - 1;

	const preambleStart = title ? title.n + 1 : bodyStart;
	const preambleEnd = title
		? nextHeading(titleIndex)
		: (headings[0]?.n ?? all.length + 1) - 1;
	if (preambleEnd >= preambleStart) {
		projection.preamble = {
			line: preambleStart,
			endLine: preambleEnd,
			text: span(preambleStart, preambleEnd),
		};
	}
	projection.sections = headings.flatMap((section, index) => {
		if (index === titleIndex) return [];
		const endLine = nextHeading(index);
		return [
			{
				heading: section.heading,
				level: section.level,
				line: section.n,
				endLine,
				text: span(section.n + 1, endLine),
			},
		];
	});
	return projection;
}
