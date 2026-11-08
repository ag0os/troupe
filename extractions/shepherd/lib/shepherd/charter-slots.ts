export const CORE_SLOTS: Readonly<Record<string, string>> = {
	mission: "core.mission",
	role: "core.role",
	"what lives where": "core.what-lives-where",
	"way of working": "core.way-of-working",
	cadence: "core.cadence",
	done: "core.done",
	toolset: "core.toolset",
	structure: "core.structure",
};

export type CharterBlock = { source: string; line: number };
export type CharterSlot = CharterBlock & {
	key: string;
	value: string;
	kind: "core" | "module";
};

const moduleBullet =
	/^[ \t]*[-*][ \t]+(?:\*\*([a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*):\*\*|\*\*([a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)\*\*:|([a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*):)/;
const listItem = /^[ \t]*(?:[-*+]|[0-9]+[.)])[ \t]+/;
const headingLine = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const indentation = (line: string) => {
	let columns = 0;
	for (const character of line.match(/^[ \t]*/)?.[0] ?? "")
		columns += character === "\t" ? 4 - (columns % 4) : 1;
	return columns;
};

export function parseCharter(
	raw: string,
	declaredKeys: Iterable<string> = [],
): {
	slots: CharterSlot[];
	blocks: CharterBlock[];
	unknownBullets: { key: string; line: number }[];
} {
	const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const recognized = new Set(declaredKeys);
	const text = lines.map((line) => line.replace(/\r?\n$/, ""));
	const excluded = new Set<number>();
	let fence: { marker: string; length: number } | undefined;
	for (const [index, line] of text.entries()) {
		if (fence) {
			excluded.add(index);
			const close = line.match(/^[ \t]*(`+|~+)[ \t]*$/)?.[1];
			if (close?.[0] === fence.marker && close.length >= fence.length)
				fence = undefined;
			continue;
		}
		if (/^[ \t]*>/.test(line)) {
			excluded.add(index);
			continue;
		}
		const open = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
		if (open?.[1] && !(open[1][0] === "`" && open[2]?.includes("`"))) {
			fence = { marker: open[1][0] ?? "", length: open[1].length };
			excluded.add(index);
		}
	}
	const unknownBullets: { key: string; line: number }[] = [];
	for (const [index, line] of text.entries()) {
		if (excluded.has(index)) continue;
		const match = line.match(moduleBullet);
		if (!match) continue;
		const key = match[1] ?? match[2] ?? match[3] ?? "";
		if (!key.startsWith("core.") && !recognized.has(key))
			unknownBullets.push({ key, line: index + 1 });
	}
	const slots: CharterSlot[] = [];
	const slotLines = new Set<number>();
	for (let index = 0; index < lines.length; index++) {
		if (excluded.has(index)) continue;
		const line = text[index] ?? "";
		const match = line.match(moduleBullet);
		if (!match) continue;
		const key = match[1] ?? match[2] ?? match[3] ?? "";
		if (!key.startsWith("core.") && !recognized.has(key)) continue;
		let end = index + 1;
		while (end < lines.length) {
			const next = text[end] ?? "";
			if (next.trim() && indentation(next) <= indentation(line)) break;
			end++;
		}
		for (let i = index; i < end; i++) slotLines.add(i);
		slots.push({
			key,
			kind: "module",
			line: index + 1,
			source: lines.slice(index, end).join(""),
			value:
				(lines[index] ?? "").slice(match[0].length) +
				lines.slice(index + 1, end).join(""),
		});
		index = end - 1;
	}
	const headingAt = (index: number) => {
		if (excluded.has(index) || slotLines.has(index)) return undefined;
		const match = text[index]?.match(/^ {0,3}##(?:[ \t]+(.*))?$/);
		return match
			? (match[1] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim()
			: undefined;
	};
	for (let index = 0; index < lines.length; index++) {
		const heading = headingAt(index);
		const key =
			heading && Object.hasOwn(CORE_SLOTS, heading.toLowerCase())
				? CORE_SLOTS[heading.toLowerCase()]
				: undefined;
		if (!key) continue;
		let end = index + 1;
		while (end < lines.length && headingAt(end) === undefined) end++;
		slots.push({
			key,
			kind: "core",
			line: index + 1,
			source: lines.slice(index, end).join(""),
			value: lines
				.slice(index + 1, end)
				.filter((_, offset) => !slotLines.has(index + 1 + offset))
				.join(""),
		});
	}
	const blocks: CharterBlock[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = text[index] ?? "";
		if (
			excluded.has(index) ||
			slotLines.has(index) ||
			!line.trim() ||
			headingLine.test(line)
		)
			continue;
		const item = listItem.test(line);
		let end = index + 1;
		while (end < lines.length) {
			const next = text[end] ?? "";
			if (
				excluded.has(end) ||
				slotLines.has(end) ||
				headingLine.test(next) ||
				(listItem.test(next) &&
					(!item || indentation(next) <= indentation(line)))
			)
				break;
			if (!next.trim()) {
				let following = end + 1;
				while (following < lines.length && !text[following]?.trim())
					following++;
				if (
					!item ||
					following >= lines.length ||
					indentation(text[following] ?? "") <= indentation(line)
				)
					break;
			}
			end++;
		}
		blocks.push({ source: lines.slice(index, end).join(""), line: index + 1 });
		index = end - 1;
	}
	return {
		slots: slots.sort((a, b) => a.line - b.line),
		blocks,
		unknownBullets,
	};
}

export function normalizedText(
	raw: string,
	firstLine = 1,
): {
	text: string;
	lines: number[];
} {
	const tokens: string[] = [];
	const sourceLines: number[] = [];
	for (const [offset, line] of raw.split(/\r?\n/).entries()) {
		const prose = line.replace(listItem, "");
		for (const token of prose.match(/\S+/g) ?? []) {
			if (tokens.length) sourceLines.push(firstLine + offset);
			tokens.push(token);
			for (let i = 0; i < token.length; i++)
				sourceLines.push(firstLine + offset);
		}
	}
	return { text: tokens.join(" "), lines: sourceLines };
}
