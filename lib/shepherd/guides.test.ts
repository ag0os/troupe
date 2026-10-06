import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GUIDES, renderTemplate, TEMPLATES } from "./guides";

const prompts = join(import.meta.dir, "../../system-prompts/shepherd");
const templateSources = [
	["CURRENT.md", false, "CURRENT.md"],
	["MEMORY.md", false, "MEMORY.md"],
	["journal.md", false, "journal.md"],
	["docs/INDEX.md", false, "docs-INDEX.md"],
	["docs/STATUS-template.md", false, "STATUS-template.md"],
	["archive/INDEX.md", false, "archive-INDEX.md"],
	["shared/user.md", true, "shared-user.md"],
	["shared/machine.md", true, "shared-machine.md"],
	["shared/roster.md", true, "shared-roster.md"],
	["shared/tools.md", true, "shared-tools.md"],
	["integrations/shared.md", true, "integrations-shared.md"],
] as const;

describe("shipped guides and templates", () => {
	test("resolves every guide in order with its purpose and exact source bytes", () => {
		expect(GUIDES.map(({ name, purpose }) => [name, purpose])).toEqual([
			["charter", "the init conversation's questions and the charter's shape"],
			["memory", "the memory file format and what each type holds"],
			[
				"tools",
				"generic traps in Claude Code delegates, the Codex CLI and the shell",
			],
		]);
		for (const guide of GUIDES) {
			expect(Buffer.from(guide.text)).toEqual(
				readFileSync(join(prompts, "guides", `${guide.name}.md`)),
			);
		}
	});

	test("resolves every template in workspace then master order with exact source bytes", () => {
		expect(TEMPLATES.map(({ path, master }) => [path, master])).toEqual(
			templateSources.map(([path, master]) => [path, master]),
		);
		for (const [path, , source] of templateSources) {
			const template = TEMPLATES.find((entry) => entry.path === path);
			expect(template).toBeDefined();
			expect(Buffer.from(template?.text ?? "")).toEqual(
				readFileSync(join(prompts, "templates", source)),
			);
		}
	});

	test("ships one trailing newline and only supported placeholders", () => {
		for (const { text } of [...GUIDES, ...TEMPLATES]) {
			expect(text.endsWith("\n")).toBe(true);
			expect(text.endsWith("\n\n")).toBe(false);
			for (const [placeholder] of text.matchAll(/\{\{[^}]*\}\}/g)) {
				expect(["{{updated}}", "{{date}}"]).toContain(placeholder);
			}
		}
	});

	test("renders both placeholders everywhere using local date and padded time", () => {
		const now = new Date(2026, 0, 2, 3, 4, 59);
		expect(
			renderTemplate("{{updated}} / {{date}} / {{updated}} / {{date}}", now),
		).toBe("2026-01-02 03:04 / 2026-01-02 / 2026-01-02 03:04 / 2026-01-02");
		for (const { text } of TEMPLATES) {
			expect(renderTemplate(text, now)).not.toMatch(/\{\{.*?\}\}/);
		}
		expect(renderTemplate(TEMPLATES[0].text, now)).toStartWith(
			"Updated: 2026-01-02 03:04, tool init\n",
		);
	});

	test("preserves text without placeholders", () => {
		const text = "# Heading\n\n    indented\n```\nexample\n```\n";
		expect(renderTemplate(text, new Date(2026, 9, 6))).toBe(text);
	});

	test("loader embeds text imports and has no fs import or runtime file read", () => {
		const source = readFileSync(join(import.meta.dir, "guides.ts"), "utf8");
		expect(source).not.toMatch(/["'](?:node:)?fs(?:\/promises)?["']/);
		expect(source).not.toMatch(/\b(?:readFile(?:Sync)?|Bun\s*\.\s*file)\s*\(/);
		expect([
			...source.matchAll(
				/import\s+\w+\s+from\s+"[^"\n]+\.md"\s+with\s*\{\s*type:\s*"text",?\s*\}/g,
			),
		]).toHaveLength(GUIDES.length + TEMPLATES.length);
	});
});
