import type { FlagSpec } from "./types";

export const DEFAULT_INITIAL_PROMPT = "{{args}}";

export interface TemplateProblem {
	message: string;
	/** 0-based offset of the offending tag within the template. */
	offset: number;
}

/**
 * Check every `{{...}}` tag in an initial-prompt template. Supported
 * references are `{{args}}`, `{{cwd}}` and `{{flag.<declared name>}}`.
 */
export function validateTemplate(
	template: string,
	flags: Readonly<Record<string, FlagSpec>>,
): TemplateProblem[] {
	const problems: TemplateProblem[] = [];
	let index = 0;
	while (true) {
		const open = template.indexOf("{{", index);
		if (open === -1) break;
		const close = template.indexOf("}}", open + 2);
		if (close === -1) {
			problems.push({ message: 'unterminated "{{" tag', offset: open });
			break;
		}
		const reference = template.slice(open + 2, close).trim();
		const problem = checkReference(reference, flags);
		if (problem) problems.push({ message: problem, offset: open });
		index = close + 2;
	}
	return problems;
}

function checkReference(
	reference: string,
	flags: Readonly<Record<string, FlagSpec>>,
): string | undefined {
	if (reference === "args" || reference === "cwd") return undefined;
	if (reference.startsWith("flag.")) {
		const name = reference.slice("flag.".length);
		if (Object.hasOwn(flags, name)) return undefined;
		return `{{${reference}}} references undeclared flag "${name}"`;
	}
	return `unknown template reference {{${reference}}}`;
}
