import { proseLines } from "./text";

export const STATUS_WORDS = [
	"NEXT",
	"ASK",
	"WAITING",
	"SCHEDULED",
	"CANDIDATE",
] as const;

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
