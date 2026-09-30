import { describe, expect, test } from "bun:test";
import { renderTemplate, validateTemplate } from "./template";
import type { FlagSpec } from "./types";

const flags: Record<string, FlagSpec> = {
	quick: { type: "boolean", description: "Quick overview" },
	focus: {
		type: "enum",
		description: "Focus area",
		values: ["structure", "commands", "tech", "changes"],
	},
	task: { type: "string", description: "Task" },
};

const orient = `{{#if flag.quick}}
Provide a quick overview.
{{else if flag.focus == "structure"}}
Analyze the structure.
{{else if flag.focus == 'tech'}}
Analyze the tech stack.
{{else}}
Full orientation.
{{/if}}
{{#if args}}
Additional context: {{args}}
{{/if}}`;

const messages = (template: string) =>
	validateTemplate(template, flags).map((p) => p.message);

describe("template validation (D-025)", () => {
	test("accepts references and one level of if / else if / else", () => {
		expect(messages("{{args}} in {{cwd}} for {{flag.task}}")).toEqual([]);
		expect(messages(orient)).toEqual([]);
		expect(messages("{{#if args}}x{{/if}}")).toEqual([]);
		expect(messages("{{ #if flag.quick }}q{{ else }}n{{ /if }}")).toEqual([]);
	});

	test("rejects nesting", () => {
		expect(
			messages("{{#if flag.quick}}{{#if args}}x{{/if}}{{/if}}").join("\n"),
		).toContain("nested {{#if}} is not supported");
	});

	test("rejects malformed blocks", () => {
		expect(messages("{{#if args}}x")).toEqual([
			"{{#if}} is never closed with {{/if}}",
		]);
		expect(messages("x{{/if}}")).toEqual(["{{/if}} without an open {{#if}}"]);
		expect(messages("{{else}}")).toEqual(["{{else}} outside an {{#if}} block"]);
		expect(messages('{{else if flag.focus == "tech"}}')).toEqual([
			"{{else if}} outside an {{#if}} block",
		]);
		expect(messages("{{#if args}}a{{else}}b{{else}}c{{/if}}")).toEqual([
			"duplicate {{else}}",
		]);
		expect(messages("{{#if args}}a{{else}}b{{else if args}}c{{/if}}")).toEqual([
			"{{else if}} after {{else}}",
		]);
		expect(messages("{{#if}}x{{/if}}")).toEqual(["missing condition"]);
		expect(messages("{{args")).toEqual(['unterminated "{{" tag']);
		expect(messages("{{#each args}}{{/each}}").join("\n")).toContain(
			"unsupported block tag",
		);
	});

	test("rejects unknown and impossible references", () => {
		expect(messages("{{flag.nope}}")).toEqual([
			'{{flag.nope}} references undeclared flag "nope"',
		]);
		expect(messages("{{user}}")).toEqual([
			"unknown template reference {{user}}",
		]);
		expect(messages("{{#if flag.nope}}x{{/if}}")).toEqual([
			'condition references undeclared flag "nope"',
		]);
		expect(messages('{{#if flag.focus == "design"}}x{{/if}}')).toEqual([
			'"design" is not a declared value of enum flag "focus" (structure, commands, tech, changes)',
		]);
		expect(messages("{{#if flag.focus}}x{{/if}}").join("")).toContain(
			'must be compared with a value, e.g. flag.focus == "structure"',
		);
		expect(messages("{{#if flag.task}}x{{/if}}").join("")).toContain(
			'string flag "task" cannot be a condition',
		);
		expect(messages('{{#if flag.quick == "true"}}x{{/if}}').join("")).toContain(
			'only enum flags can be compared with ==; "quick" is a boolean flag',
		);
		expect(messages("{{#if cwd}}x{{/if}}").join("")).toContain(
			'unsupported condition "cwd"',
		);
		expect(messages("{{#if flag.quick && args}}x{{/if}}").join("")).toContain(
			"unsupported condition",
		);
	});
});

describe("template rendering", () => {
	const render = (
		values: Partial<{
			args: string[];
			flags: Record<string, string | boolean>;
		}>,
	) =>
		renderTemplate(orient, flags, {
			args: values.args ?? [],
			cwd: "/w",
			flags: values.flags ?? { quick: false },
		});

	test("quick overrides focus, focus picks its branch, else full", () => {
		expect(render({ flags: { quick: true, focus: "tech" } })).toBe(
			"Provide a quick overview.\n",
		);
		expect(render({ flags: { quick: false, focus: "tech" } })).toBe(
			"Analyze the tech stack.\n",
		);
		expect(render({})).toBe("Full orientation.\n");
	});

	test("the args block appears only with positionals", () => {
		expect(render({ args: ["foo", "bar"] })).toBe(
			"Full orientation.\nAdditional context: foo bar\n",
		);
	});

	test('blank positionals count as absent (orient "" has no suffix)', () => {
		expect(render({ args: [""] })).toBe("Full orientation.\n");
		expect(render({ args: ["  "] })).toBe("Full orientation.\n");
		expect(render({ args: ["", " "] })).toBe("Full orientation.\n");
		expect(render({ args: [" foo "] })).toBe(
			"Full orientation.\nAdditional context: foo\n",
		);
	});

	test("references render args, cwd and flag values", () => {
		expect(
			renderTemplate("{{args}}|{{cwd}}|{{flag.task}}|{{flag.focus}}", flags, {
				args: ["a", "b c"],
				cwd: "/repo",
				flags: { task: "t" },
			}),
		).toBe("a b c|/repo|t|");
	});

	test("inline blocks keep surrounding text", () => {
		expect(
			renderTemplate("A {{#if args}}[{{args}}]{{else}}none{{/if}} Z", flags, {
				args: [],
				cwd: "/",
				flags: {},
			}),
		).toBe("A none Z");
	});
});
