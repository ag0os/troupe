// The restricted YAML subset for a Contract's front matter: top-level keys
// with plain or quoted string values, or block or flow lists of them, blank
// lines and comments. Everything else YAML allows (anchors, aliases, tags,
// merge keys, multiline scalars, nesting, directives, more documents) is
// refused rather than guessed. This is not a general YAML parser.

export type Field = { value: string | string[]; line: number; lines: number[] };
export type Fields = Map<string, Field>;
export type YamlError = { line: number; message: string };

class Refused extends Error {
	constructor(
		readonly line: number,
		message: string,
	) {
		super(message);
	}
}

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;

/** Split a quoted or plain scalar from the front of `text`. */
function scalar(
	text: string,
	line: number,
	flow: boolean,
): { value: string; rest: string } {
	const quote = text[0];
	if (quote === '"') {
		let i = 1;
		while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
		if (i >= text.length)
			throw new Refused(line, "an unterminated quoted value");
		try {
			return {
				value: JSON.parse(text.slice(0, i + 1)) as string,
				rest: text.slice(i + 1),
			};
		} catch {
			throw new Refused(line, "an escape JSON does not accept");
		}
	}
	if (quote === "'") {
		let value = "";
		let i = 1;
		for (;;) {
			if (i >= text.length)
				throw new Refused(line, "an unterminated quoted value");
			if (text[i] === "'") {
				if (text[i + 1] !== "'") break;
				value += "'";
				i += 2;
			} else value += text[i++];
		}
		return { value, rest: text.slice(i + 1) };
	}
	if (/^[&*]/.test(text)) throw new Refused(line, "an anchor or alias");
	if (text[0] === "!") throw new Refused(line, "a tag");
	if (/^[|>]/.test(text)) throw new Refused(line, "a multiline scalar");
	if (/^[[{]/.test(text)) throw new Refused(line, "a nested collection");
	if (/^([,\]}#%@`]|[-?:](\s|$))/.test(text))
		throw new Refused(line, `a value starting with ${text[0]}`);
	const end = text.search(flow ? /\s#|[,\]]/ : /\s#/);
	const value = (end < 0 ? text : text.slice(0, end)).trimEnd();
	if (/:(\s|$)/.test(value)) throw new Refused(line, "a nested mapping");
	if (flow && /[[{}]/.test(value))
		throw new Refused(line, "a nested collection");
	return { value, rest: end < 0 ? "" : text.slice(end) };
}

function noTrailing(rest: string, line: number) {
	const trimmed = rest.trim();
	if (trimmed !== "" && !(trimmed.startsWith("#") && /^\s/.test(rest)))
		throw new Refused(line, `unexpected text: ${trimmed}`);
}

function flowList(text: string, line: number): string[] {
	let rest = text.slice(1).trimStart();
	const items: string[] = [];
	if (rest.startsWith("]")) {
		noTrailing(rest.slice(1), line);
		return items;
	}
	for (;;) {
		const item = scalar(rest, line, true);
		items.push(item.value);
		rest = item.rest.trimStart();
		if (rest.startsWith(",")) rest = rest.slice(1).trimStart();
		else if (rest.startsWith("]")) {
			noTrailing(rest.slice(1), line);
			return items;
		} else
			throw new Refused(line, "a flow list that does not close on its line");
	}
}

/** Parse the lines between the front matter fences; `first` is the first line's number. */
export function parseFields(
	lines: string[],
	first: number,
): { fields: Fields } | { error: YamlError } {
	const fields: Fields = new Map();
	try {
		let i = 0;
		while (i < lines.length) {
			const text = lines[i] as string;
			const line = first + i;
			i++;
			if (/^\s*(#|$)/.test(text)) continue;
			if (text.startsWith("%")) throw new Refused(line, "a directive");
			if (/^(---|\.\.\.)(\s|$)/.test(text))
				throw new Refused(line, "another document");
			if (/^\s/.test(text))
				throw new Refused(line, "an indented line outside a list");
			if (text.startsWith("<<")) throw new Refused(line, "a merge key");
			const match = KEY.exec(text);
			if (!match) throw new Refused(line, `unsupported syntax: ${text}`);
			const [, key, raw = ""] = match as unknown as [string, string, string?];
			if (fields.has(key as string))
				throw new Refused(line, `a duplicate key: ${key}`);
			const value = raw.trim();
			if (value === "" || value.startsWith("#")) {
				const items: string[] = [];
				const itemLines: number[] = [];
				while (i < lines.length) {
					const next = lines[i] as string;
					if (/^\s*(#|$)/.test(next)) {
						i++;
						continue;
					}
					const item = /^\s*-(?:[ \t]+(.*)|$)/.exec(next);
					if (!item) break;
					const itemText = (item[1] ?? "").trim();
					if (itemText === "" || /^-(\s|$)/.test(itemText))
						throw new Refused(first + i, "a nested list");
					const parsed = scalar(itemText, first + i, false);
					noTrailing(parsed.rest, first + i);
					items.push(parsed.value);
					itemLines.push(first + i);
					i++;
				}
				fields.set(key as string, {
					value: itemLines.length ? items : "",
					line,
					lines: itemLines,
				});
			} else if (value.startsWith("[")) {
				fields.set(key as string, {
					value: flowList(value, line),
					line,
					lines: [],
				});
			} else {
				const parsed = scalar(value, line, false);
				noTrailing(parsed.rest, line);
				fields.set(key as string, { value: parsed.value, line, lines: [] });
			}
		}
	} catch (error) {
		if (error instanceof Refused)
			return { error: { line: error.line, message: error.message } };
		throw error;
	}
	return { fields };
}
