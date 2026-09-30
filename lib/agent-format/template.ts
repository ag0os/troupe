import type { FlagSpec } from "./types";

export const DEFAULT_INITIAL_PROMPT = "{{args}}";

export interface TemplateProblem {
	message: string;
	/** 0-based offset of the offending tag within the template. */
	offset: number;
}

export type TemplateCondition =
	| { kind: "args" }
	| { kind: "boolean"; flag: string }
	| { kind: "enum"; flag: string; value: string };

export type TemplateInline =
	| { kind: "text"; text: string }
	| { kind: "args" }
	| { kind: "cwd" }
	| { kind: "flag"; name: string };

export type TemplateNode =
	| TemplateInline
	| {
			kind: "if";
			branches: { condition: TemplateCondition; body: TemplateInline[] }[];
			otherwise?: TemplateInline[];
	  };

export interface TemplateValues {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly flags: Readonly<Record<string, string | boolean>>;
}

type Tag =
	| { kind: "if"; condition: string }
	| { kind: "else-if"; condition: string }
	| { kind: "else" }
	| { kind: "end" }
	| { kind: "reference"; reference: string };

/**
 * Parse an initial-prompt template (D-025). Supported tags are `{{args}}`,
 * `{{cwd}}`, `{{flag.<name>}}` and one unnested level of
 * `{{#if C}} ... {{else if C}} ... {{else}} ... {{/if}}`, where `C` is
 * `args` (true when the joined, trimmed positionals are non-empty), a boolean flag
 * `flag.<name>`, or an enum comparison `flag.<name> == "<value>"`.
 * A block tag alone on its line removes that whole line from the output.
 */
export function parseTemplate(
	template: string,
	flags: Readonly<Record<string, FlagSpec>>,
): { nodes: TemplateNode[]; problems: TemplateProblem[] } {
	const nodes: TemplateNode[] = [];
	const problems: TemplateProblem[] = [];
	let block:
		| {
				offset: number;
				branches: { condition: TemplateCondition; body: TemplateInline[] }[];
				otherwise?: TemplateInline[];
		  }
		| undefined;
	const emit = (node: TemplateInline) => {
		if (!block) {
			nodes.push(node);
			return;
		}
		const target = block.otherwise ?? block.branches.at(-1)?.body;
		target?.push(node);
	};
	const condition = (text: string, offset: number) => {
		const parsed = parseCondition(text, flags);
		if (typeof parsed === "string") {
			problems.push({ message: parsed, offset });
			return undefined;
		}
		return parsed;
	};

	let index = 0;
	while (index < template.length) {
		const open = template.indexOf("{{", index);
		if (open === -1) {
			emit({ kind: "text", text: template.slice(index) });
			break;
		}
		const close = template.indexOf("}}", open + 2);
		if (close === -1) {
			problems.push({ message: 'unterminated "{{" tag', offset: open });
			break;
		}
		const tag = classifyTag(template.slice(open + 2, close).trim());
		let textEnd = open;
		let next = close + 2;
		if (tag.kind !== "reference") {
			const standalone = standaloneLine(template, open, next);
			if (standalone && standalone.start >= index) {
				textEnd = standalone.start;
				next = standalone.end;
			}
		}
		if (textEnd > index) {
			emit({ kind: "text", text: template.slice(index, textEnd) });
		}
		index = next;

		switch (tag.kind) {
			case "reference": {
				const inline = parseReference(tag.reference, flags);
				if (typeof inline === "string") {
					problems.push({ message: inline, offset: open });
				} else {
					emit(inline);
				}
				break;
			}
			case "if": {
				if (block) {
					problems.push({
						message: "nested {{#if}} is not supported",
						offset: open,
					});
					break;
				}
				const parsed = condition(tag.condition, open);
				block = {
					offset: open,
					branches: [{ condition: parsed ?? { kind: "args" }, body: [] }],
				};
				break;
			}
			case "else-if": {
				if (!block) {
					problems.push({
						message: "{{else if}} outside an {{#if}} block",
						offset: open,
					});
					break;
				}
				if (block.otherwise) {
					problems.push({
						message: "{{else if}} after {{else}}",
						offset: open,
					});
					break;
				}
				const parsed = condition(tag.condition, open);
				block.branches.push({
					condition: parsed ?? { kind: "args" },
					body: [],
				});
				break;
			}
			case "else": {
				if (!block) {
					problems.push({
						message: "{{else}} outside an {{#if}} block",
						offset: open,
					});
				} else if (block.otherwise) {
					problems.push({ message: "duplicate {{else}}", offset: open });
				} else {
					block.otherwise = [];
				}
				break;
			}
			case "end": {
				if (!block) {
					problems.push({
						message: "{{/if}} without an open {{#if}}",
						offset: open,
					});
					break;
				}
				nodes.push({
					kind: "if",
					branches: block.branches,
					...(block.otherwise ? { otherwise: block.otherwise } : {}),
				});
				block = undefined;
				break;
			}
		}
	}
	if (block) {
		problems.push({
			message: "{{#if}} is never closed with {{/if}}",
			offset: block.offset,
		});
	}
	return { nodes, problems };
}

/** Check every tag in an initial-prompt template; see `parseTemplate`. */
export function validateTemplate(
	template: string,
	flags: Readonly<Record<string, FlagSpec>>,
): TemplateProblem[] {
	return parseTemplate(template, flags).problems;
}

/** Render a template that already passed validation. */
export function renderTemplate(
	template: string,
	flags: Readonly<Record<string, FlagSpec>>,
	values: TemplateValues,
): string {
	const { nodes, problems } = parseTemplate(template, flags);
	if (problems.length > 0) {
		throw new Error(
			`invalid template: ${problems.map((p) => p.message).join("; ")}`,
		);
	}
	const inline = (node: TemplateInline): string => {
		switch (node.kind) {
			case "text":
				return node.text;
			case "args":
				return values.args.join(" ").trim();
			case "cwd":
				return values.cwd;
			case "flag": {
				const value = values.flags[node.name];
				return value === undefined ? "" : String(value);
			}
		}
	};
	const holds = (condition: TemplateCondition): boolean => {
		switch (condition.kind) {
			case "args":
				return values.args.join(" ").trim() !== "";
			case "boolean":
				return values.flags[condition.flag] === true;
			case "enum":
				return values.flags[condition.flag] === condition.value;
		}
	};
	return nodes
		.map((node) => {
			if (node.kind !== "if") return inline(node);
			const branch = node.branches.find((b) => holds(b.condition));
			return (branch?.body ?? node.otherwise ?? []).map(inline).join("");
		})
		.join("");
}

function classifyTag(inner: string): Tag {
	const ifMatch = /^#if(?:\s+(.*))?$/s.exec(inner);
	if (ifMatch) return { kind: "if", condition: ifMatch[1] ?? "" };
	const elseIf = /^else\s+if(?:\s+(.*))?$/s.exec(inner);
	if (elseIf) return { kind: "else-if", condition: elseIf[1] ?? "" };
	if (inner === "else") return { kind: "else" };
	if (inner === "/if") return { kind: "end" };
	return { kind: "reference", reference: inner };
}

function parseReference(
	reference: string,
	flags: Readonly<Record<string, FlagSpec>>,
): TemplateInline | string {
	if (reference === "args") return { kind: "args" };
	if (reference === "cwd") return { kind: "cwd" };
	if (reference.startsWith("flag.")) {
		const name = reference.slice("flag.".length);
		if (Object.hasOwn(flags, name)) return { kind: "flag", name };
		return `{{${reference}}} references undeclared flag "${name}"`;
	}
	if (/^[#/]/.test(reference)) {
		return `unsupported block tag {{${reference}}}; only {{#if}}, {{else if}}, {{else}} and {{/if}} are allowed`;
	}
	return `unknown template reference {{${reference}}}`;
}

function parseCondition(
	text: string,
	flags: Readonly<Record<string, FlagSpec>>,
): TemplateCondition | string {
	const condition = text.trim();
	if (condition === "") return "missing condition";
	if (condition === "args") return { kind: "args" };
	const comparison = /^flag\.([^\s=]+)\s*==\s*(?:"([^"]*)"|'([^']*)')$/.exec(
		condition,
	);
	if (comparison) {
		const name = comparison[1] ?? "";
		const value = comparison[2] ?? comparison[3] ?? "";
		const spec = flags[name];
		if (!spec || !Object.hasOwn(flags, name)) {
			return `condition references undeclared flag "${name}"`;
		}
		if (spec.type !== "enum") {
			return `only enum flags can be compared with ==; "${name}" is a ${spec.type} flag`;
		}
		if (!spec.values.includes(value)) {
			return `"${value}" is not a declared value of enum flag "${name}" (${spec.values.join(", ")})`;
		}
		return { kind: "enum", flag: name, value };
	}
	const bare = /^flag\.(\S+)$/.exec(condition);
	if (bare) {
		const name = bare[1] ?? "";
		const spec = flags[name];
		if (!spec || !Object.hasOwn(flags, name)) {
			return `condition references undeclared flag "${name}"`;
		}
		if (spec.type === "boolean") return { kind: "boolean", flag: name };
		if (spec.type === "enum") {
			return `enum flag "${name}" must be compared with a value, e.g. flag.${name} == "${spec.values[0]}"`;
		}
		return `string flag "${name}" cannot be a condition; use a boolean or enum flag`;
	}
	return `unsupported condition "${condition}"; use args, flag.<boolean>, or flag.<enum> == "<value>"`;
}

/**
 * When the tag spanning `[open, end)` is the only non-whitespace text on its
 * line, return the span of that whole line including its newline.
 */
function standaloneLine(
	template: string,
	open: number,
	end: number,
): { start: number; end: number } | undefined {
	const start = template.lastIndexOf("\n", open - 1) + 1;
	if (!/^[ \t]*$/.test(template.slice(start, open))) return undefined;
	const newline = template.indexOf("\n", end);
	const lineEnd = newline === -1 ? template.length : newline;
	if (!/^[ \t\r]*$/.test(template.slice(end, lineEnd))) return undefined;
	return { start, end: newline === -1 ? lineEnd : newline + 1 };
}
