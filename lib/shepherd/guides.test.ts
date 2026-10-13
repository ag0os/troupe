import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_SLOTS, parseCharter } from "./charter-slots";
import { GUIDES, renderTemplate, TEMPLATES } from "./guides";
import { parseModule } from "./module-format";
import { words } from "./text";

const prompts = join(import.meta.dir, "../../system-prompts/shepherd");
const templateSources = [
	["CURRENT.md", false, "CURRENT.md"],
	["MEMORY.md", false, "MEMORY.md"],
	["journal.md", false, "journal.md"],
	["pending.md", false, "pending.md"],
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

describe("charter boundary text", () => {
	const charter = GUIDES.find(({ name }) => name === "charter")?.text ?? "";
	const software = parseModule(
		readFileSync(join(prompts, "integrations/software.md"), "utf8"),
		"software.md",
	);

	test("guide supplies a synthetic slot example and the eight core headings", () => {
		expect(charter).toContain("## Slots and the boundary");
		for (const [heading, key] of Object.entries(CORE_SLOTS)) {
			expect(charter.toLowerCase()).toContain(`| ${heading} |`);
			expect(charter).toContain(`\`${key}\``);
		}
		const example = charter.match(/```markdown\n([\s\S]*?)```/)?.[1];
		expect(example).toBeDefined();
		const parsed = parseCharter(example ?? "", ["software"]);
		expect(
			parsed.slots
				.filter(({ kind }) => kind === "module")
				.map(({ key }) => key),
		).toEqual([
			"software.grants",
			"software.merge-grant",
			"software.plans",
			"software.attribution",
		]);
		expect(
			parsed.slots.find(({ key }) => key === "core.done")?.value,
		).toContain("Tests, typecheck and lint.");
	});

	test("guide narrows software grants to the cycle's outward actions", () => {
		expect(charter).toContain(
			"Standing permissions for pushing branches, opening pull requests, and writing on the code host.",
		);
		expect(charter).toContain(
			"Grants for anything else stay in Way of working prose",
		);
	});

	test("guide preserves ordinary prose agreements during migration", () => {
		expect(charter).toContain(
			"Existing prose remains authoritative until renegotiated",
		);
		expect(charter).toContain("There is no `Grants:` alias");
		expect(software.body).toContain(
			"Until the charter is renegotiated, use its existing agreed prose for these values.",
		);
	});

	test("None is a value and missing slots or metadata grant no permissions", () => {
		expect(charter).toContain("`None` is a value, including `None.` in prose");
		expect(charter).toContain(
			"Neither missing slots nor module metadata grant permissions.",
		);
		expect(software.body).toContain("An absent or empty slot grants nothing");
		expect(software.body).toContain(
			"`None` is an agreed value, not an absent slot.",
		);
	});

	test("core contains exactly 3,398 words", () => {
		expect(words(readFileSync(join(prompts, "core.md"), "utf8"))).toBe(3398);
	});

	test("software references exactly its five declared named slots", () => {
		expect(software.problems).toEqual([]);
		const referenced = [
			...new Set(
				[
					...(software.body ?? "").matchAll(
						/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/g,
					),
				].map(([key]) => key),
			),
		].sort();
		const declared = Object.keys(
			software.metadata?.["charter-keys"] ?? {},
		).sort();
		expect(declared).toEqual([
			"core.done",
			"software.attribution",
			"software.grants",
			"software.merge-grant",
			"software.plans",
		]);
		expect(referenced).toEqual(declared);
	});
});

describe("charter guide recognition and duplicate headings", () => {
	const charter = GUIDES.find(({ name }) => name === "charter")?.text ?? "";

	test("repeated core headings produce a warning", () => {
		expect(charter).toContain("Repeated core headings produce a warning.");
	});

	test("recognizes dotted slots only in core or known module namespaces", () => {
		expect(charter).toContain(
			"A dotted bullet is a slot only when its namespace is `core` or a known module's name or slot; any other dotted bullet is ordinary prose.",
		);
	});
});
