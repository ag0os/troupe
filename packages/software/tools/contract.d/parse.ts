// Contract text to a model with source lines. Parsing reads text only, so
// lint (worktree) and diff (git blobs) share it; filesystem checks are in
// lint.ts.
import { type Fields, parseFields, type YamlError } from "./frontmatter";

const EM = String.fromCodePoint(0x2014);

export type ProofClause = {
	type: "test" | "pr-evidence" | "none" | null;
	text: string;
	paths: string[];
	names: string[];
	ids: string[];
	prs: number[];
};

export type Reference = { text: string; line: number; clauses: ProofClause[] };

export type Obligation = {
	id: string;
	prefix: string;
	number: number;
	line: number;
	title: string;
	statement: string;
	reason: string | null;
	reasonLine: number | null;
	kind: string | null;
	kindLine: number | null;
	proof: (Reference & { bold: boolean }) | null;
	test: Reference | null;
	retired: { date: string; reason: string } | null;
	retiredProblem: string | null;
	reworded: string[];
};

export type Claimed = {
	obligations: number;
	test: number;
	prEvidence: number;
	mixed: number;
	unproved: number;
	target: string;
};

export type Coverage =
	| { problem: "missing" }
	| {
			problem: "format" | "position" | null;
			line: number;
			text: string;
			claimed: Claimed | null;
	  };

export type DecisionEntry = {
	id: string;
	path: string;
	title: string;
	line: number;
};

export type Decisions = {
	line: number;
	entries: DecisionEntry[];
	invalid: { line: number; text: string }[];
	closing: boolean;
};

export type Problem = {
	code: string;
	line: number;
	message: string;
	obligationId?: string;
};

export type ContractDoc = {
	format: "canonical" | "legacy-file";
	/** "attempted" when the file opens a front matter block. */
	frontMatter: "absent" | "attempted";
	fields: Fields | null;
	yamlError: YamlError | null;
	coverage: Coverage;
	obligations: Obligation[];
	decisions: Decisions | null;
	problems: Problem[];
	/** False when an unclosed front matter block leaves no body to read. */
	bodyParsed: boolean;
};

export type ProductSection = {
	name: string;
	line: number;
	ids: { id: string; line: number }[];
};

/** Lines inside fenced code, indented code and HTML comments. */
function ignoredLines(lines: string[]): boolean[] {
	const ignored = lines.map(() => false);
	let fence: string | null = null;
	let comment = false;
	let previousBlank = true;
	let indented = false;
	lines.forEach((text, i) => {
		if (fence !== null) {
			ignored[i] = true;
			if (
				text.trimStart().startsWith(fence) &&
				text.trim().replace(/[`~]/g, "") === ""
			)
				fence = null;
			return;
		}
		if (comment) {
			ignored[i] = true;
			if (text.includes("-->")) comment = false;
			return;
		}
		const open = /^ {0,3}(`{3,}|~{3,})/.exec(text);
		if (open) {
			fence = open[1] as string;
			ignored[i] = true;
			return;
		}
		if (text.includes("<!--")) {
			ignored[i] = true;
			comment = !text.slice(text.indexOf("<!--")).includes("-->");
			return;
		}
		const blank = text.trim() === "";
		if (!blank && /^( {4}|\t)/.test(text) && (previousBlank || indented)) {
			ignored[i] = true;
			indented = true;
		} else if (!blank) indented = false;
		previousBlank = blank;
	});
	return ignored;
}

const COVERAGE =
	/^Coverage: (\d+) obligations?; (\d+) proved by test, (\d+) by PR evidence, (?:(\d+) mixed, )?(\d+) unproved\. Suite runs against (this implementation|any implementation behind (\S.*?))\.$/;

function parseCoverage(text: string): Claimed | null {
	const m = COVERAGE.exec(text.trim());
	if (!m) return null;
	return {
		obligations: Number(m[1]),
		test: Number(m[2]),
		prEvidence: Number(m[3]),
		mixed: Number(m[4] ?? 0),
		unproved: Number(m[5]),
		target: m[6] as string,
	};
}

/** Paragraphs of non-ignored lines, each with its first line number. */
function paragraphs(
	lines: { text: string; line: number }[],
): { text: string; line: number; lines: { text: string; line: number }[] }[] {
	const out: {
		text: string;
		line: number;
		lines: { text: string; line: number }[];
	}[] = [];
	let current: { text: string; line: number }[] = [];
	const flush = () => {
		if (current.length)
			out.push({
				text: current.map((l) => l.text.trim()).join("\n"),
				line: (current[0] as { line: number }).line,
				lines: current,
			});
		current = [];
	};
	for (const l of lines) {
		if (l.text.trim() === "") flush();
		else current.push(l);
	}
	flush();
	return out;
}

/** Split proof text into clauses at semicolons outside backticks and quotes. */
function clauses(text: string): ProofClause[] {
	const parts: string[] = [];
	let part = "";
	let quote: string | null = null;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === "`" || ch === '"') quote = ch;
		else if (ch === ";") {
			parts.push(part);
			part = "";
			continue;
		}
		part += ch;
	}
	parts.push(part);
	return parts
		.map((p) => p.trim().replace(/\.$/, "").trim())
		.filter((p) => p !== "")
		.map((p) => {
			const m = /^(test|pr-evidence|none)\b,?\s*(.*)$/s.exec(p);
			return {
				...references(m ? (m[2] as string) : p),
				type: m ? (m[1] as ProofClause["type"]) : null,
				text: p,
			};
		});
}

/** Backtick paths and names, quoted names, obligation IDs and PR numbers. */
function references(text: string): Omit<ProofClause, "type" | "text"> {
	const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
	const outside = text.replace(/`[^`]*`/g, " ");
	return {
		paths: spans.filter((s) => s.includes("/")),
		names: [
			...spans.filter((s) => !s.includes("/")),
			...[...outside.matchAll(/"([^"]+)"|“([^”]+)”/g)].map(
				(m) => (m[1] ?? m[2]) as string,
			),
		],
		ids: [...outside.matchAll(/\b[A-Z]+-\d+\b/g)].map((m) => m[0]),
		prs: [...outside.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])),
	};
}

const REASON =
	/^(?:\*\*Reason[.:]\*\*|\*Reason[.:]\*|_Reason[.:]_|\*\*Because\*\*|\*Because\*|_Because_|(?=Because\b))\s*/;
const KIND = /^Kind:\s*([^\s.]+)\.?\s*(.*)$/;
const PROOF = /^(\*\*Proof[.:]\*\*|Proof:)\s*(.*)$/;
const TEST = /^(?:\*\*Test[.:]\*\*|Test:)\s*(.*)$/;

function validDate(date: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.toISOString().slice(0, 10) === date;
}

function obligation(
	head: {
		id: string;
		prefix: string;
		number: number;
		title: string;
		line: number;
	},
	body: { text: string; line: number }[],
): Obligation {
	const o: Obligation = {
		...head,
		statement: "",
		reason: null,
		reasonLine: null,
		kind: null,
		kindLine: null,
		proof: null,
		test: null,
		retired: null,
		retiredProblem: null,
		reworded: [],
	};
	const statement: string[] = [];
	for (const p of paragraphs(body)) {
		if (/^Retired\b/.test(p.text)) {
			const m = /^Retired (\S+), (.*\S)$/s.exec(p.text);
			if (!m) o.retiredProblem = "a retirement needs Retired YYYY-MM-DD, <why>";
			else if (!validDate(m[1] as string))
				o.retiredProblem = `${m[1]} is not a valid ISO date`;
			else
				o.retired = {
					date: m[1] as string,
					reason: (m[2] as string).replace(/\.$/, ""),
				};
			continue;
		}
		if (/^Reworded \d{4}-\d{2}-\d{2}\b/.test(p.text)) {
			const date = p.text.slice(9, 19);
			if (validDate(date)) o.reworded.push(p.text.replace(/[ \t]+$/gm, ""));
			continue;
		}
		const first = p.text.split("\n")[0] as string;
		if (KIND.test(first) || PROOF.test(first) || TEST.test(first)) {
			let proof: { text: string; line: number; bold: boolean } | null = null;
			for (const l of p.lines) {
				const text = l.text.trim();
				const test = TEST.exec(text);
				const kind = KIND.exec(text);
				const rest = kind ? (kind[2] as string) : text;
				if (kind) {
					o.kind = kind[1] as string;
					o.kindLine = l.line;
				}
				const proofLine = PROOF.exec(rest);
				if (test) {
					o.test = { text: test[1] as string, line: l.line, clauses: [] };
					proof = null;
				} else if (proofLine) {
					proof = {
						text: proofLine[2] as string,
						line: l.line,
						bold: proofLine[1] !== "Proof:",
					};
				} else if (proof && !kind) proof.text += ` ${text}`;
			}
			if (proof) o.proof = { ...proof, clauses: clauses(proof.text) };
			continue;
		}
		const reason = REASON.exec(p.text);
		if (reason && o.reason === null) {
			o.reason = p.text.slice(reason[0].length);
			o.reasonLine = p.line;
		} else if (o.reason !== null) o.reason += `\n\n${p.text}`;
		else statement.push(p.text);
	}
	o.statement = statement.join("\n\n");
	if (o.test)
		o.test.clauses = [
			{ type: "test", text: o.test.text, ...references(o.test.text) },
		];
	return o;
}

const ATTEMPT = /^([A-Za-z]+)-(\d+)\b/;

/** Parse a Contract file's text. */
export function parseContract(text: string): ContractDoc {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const doc: ContractDoc = {
		format: "canonical",
		frontMatter: "absent",
		fields: null,
		yamlError: null,
		coverage: { problem: "missing" },
		obligations: [],
		decisions: null,
		problems: [],
		bodyParsed: true,
	};
	let bodyStart = 0;
	if (lines[0]?.trimEnd() === "---") {
		doc.frontMatter = "attempted";
		const close = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
		if (close < 0) {
			doc.yamlError = {
				line: 1,
				message: "the front matter block is not closed",
			};
			doc.bodyParsed = false;
			return doc;
		}
		const parsed = parseFields(lines.slice(1, close), 2);
		if ("error" in parsed) doc.yamlError = parsed.error;
		else doc.fields = parsed.fields;
		bodyStart = close + 1;
	}
	const ignored = ignoredLines(lines);
	const body = lines
		.map((t, i) => ({ text: t, line: i + 1, ignored: ignored[i] ?? false }))
		.slice(bodyStart)
		.filter((l) => !l.ignored);
	if (doc.frontMatter === "absent") {
		const marker = body.some(
			(l) =>
				/^\*\*Code it covers\.\*\*/.test(l.text) ||
				new RegExp(`^###\\s+[A-Z]+-\\d+\\s+${EM}\\s`).test(l.text),
		);
		if (marker) doc.format = "legacy-file";
	}
	const legacy = doc.format === "legacy-file";

	const firstText = body.find((l) => l.text.trim() !== "");
	const coverageLines = body.filter((l) => /^Coverage:/.test(l.text));
	const found = coverageLines[0];
	if (found) {
		const claimed = parseCoverage(found.text);
		doc.coverage = {
			problem: found !== firstText ? "position" : claimed ? null : "format",
			line: found.line,
			text: found.text.trim(),
			claimed,
		};
	}

	let head: Parameters<typeof obligation>[0] | null = null;
	let bodyLines: { text: string; line: number }[] = [];
	let decisions: Decisions | null = null;
	const finish = () => {
		if (head) doc.obligations.push(obligation(head, bodyLines));
		head = null;
		bodyLines = [];
	};
	for (const l of body) {
		const heading = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/.exec(l.text);
		const level = heading ? (heading[1] as string).length : 0;
		if (heading && level <= 3) {
			finish();
			const title = heading[2] as string;
			if (decisions) decisions.closing = false;
			if (level === 2 && title === "Decisions") {
				decisions = { line: l.line, entries: [], invalid: [], closing: true };
				doc.decisions = decisions;
				continue;
			}
			if (level <= 2) decisions = null;
			if (level === 3 && ATTEMPT.test(title)) {
				const separator = legacy ? `(?:${EM}\\s+)?` : "";
				const m = new RegExp(`^([A-Z]+)-(\\d+)\\s+${separator}(\\S.*)$`).exec(
					title,
				);
				const number = m ? Number(m[2]) : 0;
				const id = (ATTEMPT.exec(title) as RegExpExecArray)[0];
				if (!m || number === 0 || (m[3] as string).startsWith(EM))
					doc.problems.push({
						code: "obligation-heading",
						line: l.line,
						obligationId: id,
						message: `${id}: an obligation heading is ### <PREFIX>-<n> <title>, with an uppercase prefix and a positive number`,
					});
				else
					head = {
						id: `${m[1]}-${m[2]}`,
						prefix: m[1] as string,
						number,
						title: m[3] as string,
						line: l.line,
					};
			}
			continue;
		}
		if (head) bodyLines.push(l);
		else if (decisions && /^\s*[-*]\s/.test(l.text)) {
			const m = /^- ([A-Za-z]+-?\d+), `([^`]+)`[^:]*: (\S.*)$/.exec(
				l.text.trim(),
			);
			if (m)
				decisions.entries.push({
					id: m[1] as string,
					path: m[2] as string,
					title: m[3] as string,
					line: l.line,
				});
			else decisions.invalid.push({ line: l.line, text: l.text.trim() });
		}
	}
	finish();
	return doc;
}

/** Decision pointers in a reason: parenthesized uppercase-prefix tokens. */
export function pointers(reason: string): string[] {
	const out: string[] = [];
	for (const group of reason.matchAll(/\(([^()]*)\)/g))
		for (const token of (group[1] as string).split(/[,;]/)) {
			const t = token.trim();
			if (/^[A-Z]+-?\d+$/.test(t)) out.push(t);
		}
	return out;
}

export function pointerPrefix(token: string): string {
	return (/^[A-Z]+/.exec(token) as RegExpExecArray)[0];
}

/** PRODUCT.md's `## Contract:` sections that hold obligation bullets. */
export function parseProduct(text: string): ProductSection[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const ignored = ignoredLines(lines);
	const sections: ProductSection[] = [];
	let current: ProductSection | null = null;
	lines.forEach((t, i) => {
		if (ignored[i]) return;
		if (/^#{1,2}\s/.test(t)) {
			if (current?.ids.length) sections.push(current);
			const m = /^## Contract:\s*(.*?)\s*$/.exec(t);
			current = m ? { name: m[1] as string, line: i + 1, ids: [] } : null;
			return;
		}
		const bullet = /^\s*[-*]\s+\*\*([A-Z]+-\d+)\*\*/.exec(t);
		if (current && bullet)
			current.ids.push({ id: bullet[1] as string, line: i + 1 });
	});
	if ((current as ProductSection | null)?.ids.length)
		sections.push(current as unknown as ProductSection);
	return sections;
}
