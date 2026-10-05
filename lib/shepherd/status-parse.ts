import { proseLines } from "./text";

export const STATUS_WORDS = [
	"NEXT",
	"ASK",
	"WAITING",
	"SCHEDULED",
	"CANDIDATE",
] as const;

const STATUS_WORD_SET = new Set<string>(STATUS_WORDS);
const STATUS_PATTERN = STATUS_WORDS.join("|");
const SESSION_NAME =
	/(?<![\w/.~:-])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?![\w/.-])/g;

export type StatusItem = {
	word: string;
	known: boolean;
	text: string;
	line: number;
};

export type ListedSession = {
	name: string;
	line: number;
	retired: boolean;
	subagent: boolean;
	codex: boolean;
};

function legendLines(lines: { n: number; line: string }[]): Set<number> {
	const legend = new Set<number>();
	const pattern = /^[-*]\s+\*\*([A-Z]{3,})\*\*:/;
	for (let index = 0; index < lines.length; ) {
		let end = index;
		const words = new Set<string>();
		let repeated = false;
		while (end < lines.length) {
			const word = lines[end]?.line.match(pattern)?.[1];
			if (!word) break;
			if (words.has(word)) repeated = true;
			words.add(word);
			end++;
		}
		if (end - index >= 3 && !repeated) {
			for (let entry = index; entry < end; entry++) {
				const line = lines[entry];
				if (line) legend.add(line.n);
			}
		}
		index = Math.max(index + 1, end);
	}
	return legend;
}

function itemText(line: string, word: string): string {
	const clean = line
		.replace(/^[-*]\s+/, "")
		.replace(/\*\*/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(new RegExp(`^${word}\\s*[:—-]?\\s*`), "");
	return clean.length > 150 ? `${clean.slice(0, 147)}...` : clean;
}

function itemsSectionLines(lines: { n: number; line: string }[]): Set<number> {
	const scoped = new Set<number>();
	let inItems = false;
	for (const { n, line } of lines) {
		if (/^##\s+Items\b/i.test(line)) {
			inItems = true;
			continue;
		}
		if (/^#{1,2}\s/.test(line)) inItems = false;
		else if (inItems) scoped.add(n);
	}
	return scoped;
}

/** Status-word items in CURRENT, excluding a status-word legend. */
export function statusItems(text: string): StatusItem[] {
	const lines = proseLines(text);
	const legend = legendLines(lines);
	const hasItemsSection = lines.some(({ line }) => /^##\s+Items\b/i.test(line));
	const scoped = hasItemsSection ? itemsSectionLines(lines) : undefined;
	const knownPattern = new RegExp(
		`^(?:[-*]\\s+)?\\*\\*(${STATUS_PATTERN})\\b[^*]*?(?:\\*\\*)?\\s*[:(—-]?\\s*(.*)$`,
	);
	const unknownPattern = /^[-*]\s+\*\*([A-Z]{3,})\*\*/;
	const items: StatusItem[] = [];

	for (const { n, line } of lines) {
		if (legend.has(n)) continue;
		const known = line.match(knownPattern);
		if (known?.[1]) {
			items.push({
				word: known[1],
				known: true,
				text: itemText(line, known[1]),
				line: n,
			});
			continue;
		}
		if (scoped && !scoped.has(n)) continue;
		const unknown = line.match(unknownPattern)?.[1];
		if (!unknown || STATUS_WORD_SET.has(unknown)) continue;
		items.push({
			word: unknown,
			known: false,
			text: itemText(line, unknown),
			line: n,
		});
	}
	return items;
}

/** Whether CURRENT explicitly says that no NEXT item is set. */
export function noNext(text: string): boolean {
	return /No NEXT is set/i.test(text);
}

/** Session names declared in CURRENT's Live sessions section. */
export function listedSessions(text: string): ListedSession[] {
	const sessions: ListedSession[] = [];
	let inSection = false;
	let retiredTail = false;
	for (const { n, line } of proseLines(text)) {
		if (/^#{1,6}\s/.test(line)) {
			inSection = /^#{1,6}\s*Live sessions/i.test(line);
			continue;
		}
		if (!inSection) continue;
		const bullet = /^\s*[-*]\s+/.test(line);
		const body = line.replace(/^\s*[-*]\s+/, "").replace(/`/g, "");
		if (!bullet) {
			if (retiredTail && /^\s+\S/.test(line)) {
				for (const name of body.match(SESSION_NAME) ?? []) {
					sessions.push({
						name,
						line: n,
						retired: true,
						subagent: false,
						codex: false,
					});
				}
			}
			continue;
		}
		const clauses = body.split(/;|\.(?=\s|$)/).map((clause) => ({
			retired: /\b(?:retired|ended)\b/i.test(clause),
			names: clause.match(SESSION_NAME) ?? [],
		}));
		retiredTail =
			clauses.findLast((clause) => clause.names.length > 0 || clause.retired)
				?.retired ?? false;
		const subagent = /\bsubagent\b/i.test(body);
		const codex = /\bcodex\b/i.test(body) && !/\bclaude\b/i.test(body);
		const active = clauses.find(
			(clause) => !clause.retired && clause.names.length > 0,
		)?.names[0];
		if (active) {
			sessions.push({ name: active, line: n, retired: false, subagent, codex });
		}
		for (const clause of clauses.filter((entry) => entry.retired)) {
			for (const name of clause.names) {
				sessions.push({
					name,
					line: n,
					retired: true,
					subagent: false,
					codex: false,
				});
			}
		}
	}
	return sessions;
}
