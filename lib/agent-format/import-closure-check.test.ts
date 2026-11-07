import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AgentBuildDefinition,
	compileAgent,
	loadAgentDefinition,
	planBuild,
} from "../entries/compiler";
import { AgentSourceError } from "../entries/declaration";

// C11 (symlinked declarations) and C13 (the transitive relative import
// closure of accepted helpers), with fixtures only.

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "closure-check-")));
	mkdirSync(join(root, "defs"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string) {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

const declaration =
	"---\ndescription: Fixture\nbackends: [claude]\n---\nBody\n";

function definition(
	extra: Partial<AgentBuildDefinition> = {},
): AgentBuildDefinition {
	return {
		consumerRoot: root,
		declarationRoot: "defs",
		extensionCodeRoots: ["lib"],
		extensionTextRoots: ["prompts"],
		roster: ["a"],
		outDir: "out",
		...extra,
	};
}

/** An extension importing `../lib/h`, whose helper body is `helper`. */
function withHelper(helper: string) {
	write("defs/a.md", declaration);
	write(
		"defs/a.ts",
		'import { h } from "../lib/h";\nexport function prepare() {\n\treturn { h };\n}\n',
	);
	write("lib/h.ts", helper);
}

async function messages(promise: Promise<unknown>): Promise<string[]> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AgentSourceError) {
			return error.issues.map((issue) => issue.message);
		}
		throw error;
	}
	return [];
}

const load = () => loadAgentDefinition(definition(), "defs/a.md");

describe("C13: an accepted helper's own imports", () => {
	test("a deep chain inside the code roots is accepted", async () => {
		withHelper(
			'import { x } from "./deep/x";\nimport type { T } from "../outside/t";\nimport { z } from "zod";\nexport const h = [x, z] as unknown as T;\n',
		);
		write("lib/deep/x.ts", 'export * from "./y";\nexport const x = 1;\n');
		write("lib/deep/y.ts", "export const y = 2;\n");
		write("outside/t.ts", "export type T = unknown;\n");
		expect(await messages(load())).toEqual([]);
	});

	test("a transitive import outside the code roots is refused", async () => {
		withHelper('import { o } from "./mid";\nexport const h = o;\n');
		write("lib/mid.ts", 'export { o } from "../outside/o";\n');
		write("outside/o.ts", "export const o = 1;\n");
		expect(await messages(load())).toEqual([
			'lib/mid.ts: value import "../outside/o" resolves outside lib/',
		]);
	});

	test("a transitive import that cannot be established is refused", async () => {
		withHelper('import { p } from "./pkg";\nexport const h = p;\n');
		write("lib/pkg/package.json", '{"main":"main.ts"}');
		write("lib/pkg/index.ts", "export const p = 1;\n");
		expect(await messages(load())).toEqual([
			'lib/h.ts: value import "./pkg": its selected module cannot be established (the directory has a package.json); name the file explicitly',
		]);
	});

	test("absolute specifiers and non-literal dynamic loads are refused", async () => {
		withHelper(
			`import { a } from "${join(root, "lib/abs.ts")}";\nconst name = "./x";\nexport const h = () => import(name);\nexport { a };\n`,
		);
		write("lib/abs.ts", "export const a = 1;\n");
		const found = await messages(load());
		expect(found).toHaveLength(2);
		expect(found[0]).toBe(
			"lib/h.ts:3: a dynamic load whose module cannot be established",
		);
		expect(found[1]).toContain("names an absolute location");
	});

	test("a helper's text import follows the text-import rules", async () => {
		withHelper(
			'import t from "../elsewhere/t.md" with { type: "text" };\nexport const h = t;\n',
		);
		write("elsewhere/t.md", "text\n");
		expect(await messages(load())).toEqual([
			'lib/h.ts: text import "../elsewhere/t.md" resolves outside prompts/',
		]);
		write("prompts/t.md", "text\n");
		write(
			"lib/h.ts",
			'import t from "../prompts/t.md" with { type: "text" };\nexport const h = t;\n',
		);
		expect(await messages(load())).toEqual([]);
	});

	test("a cycle is walked once", async () => {
		withHelper(
			'import { b } from "./b";\nexport const h = 1;\nexport { b };\n',
		);
		write("lib/b.ts", 'import { h } from "./h";\nexport const b = h;\n');
		expect(await messages(load())).toEqual([]);
	});
});

describe("C11: a declaration that is itself a symlink is refused", () => {
	test("in discovery and when compiled by its link path", async () => {
		write("elsewhere/real.md", declaration);
		write("defs/real.md", declaration);
		symlinkSync(join(root, "defs/real.md"), join(root, "defs/a.md"));
		expect(
			await messages(
				planBuild({ definition: definition({ roster: ["real"] }) }),
			),
		).toEqual(["a declaration must not be a symlink"]);
		expect(
			await messages(
				compileAgent({
					definition: definition(),
					file: "defs/a.md",
					outFile: "out/a",
					build: async () => {},
				}),
			),
		).toEqual(["a declaration must not be a symlink"]);
	});

	test("a declaration inside a symlinked directory is unaffected", async () => {
		write("sources/a.md", declaration);
		rmSync(join(root, "defs"), { recursive: true });
		symlinkSync(join(root, "sources"), join(root, "defs"));
		const plan = await planBuild({ definition: definition() });
		expect(plan.entries.map((entry) => entry.id)).toEqual(["a"]);
	});
});

describe("C13 fix 1: every module load form is seen", () => {
	const outside = "resolves outside lib/";
	for (const [form, line] of [
		[
			"import x = require()",
			'import o = require("../outside/o");\nexport const h = o;\n',
		],
		["(require)()", 'export const h = (require)("../outside/o");\n'],
	] as const) {
		test(`${form} reaching outside the code roots is refused`, async () => {
			withHelper(line);
			write("outside/o.ts", "export const o = 1;\n");
			expect(await messages(load())).toEqual([
				`lib/h.ts: value import "../outside/o" ${outside}`,
			]);
		});

		test(`${form} inside a code root is accepted`, async () => {
			withHelper(line.replace("../outside/o", "./inside"));
			write("lib/inside.ts", "export const o = 1;\n");
			expect(await messages(load())).toEqual([]);
		});
	}

	test("(require)(name) is a dynamic load that cannot be established", async () => {
		withHelper('const name = "./x";\nexport const h = (require)(name);\n');
		expect(await messages(load())).toEqual([
			"lib/h.ts:2: a dynamic load whose module cannot be established",
		]);
	});
});

describe("C13 fix 2: a helper's attributed imports follow the text-import rules", () => {
	const cases: [string, string, string][] = [
		[
			".txt under a text root",
			'import t from "../prompts/t.txt" with { type: "text" };',
			'text import "../prompts/t.txt" must name a .md file under prompts/',
		],
		[
			"an extra attribute",
			'import t from "../prompts/t.md" with { type: "text", x: "y" };',
			'import attributes on "../prompts/t.md" must be exactly with { type: "text" }',
		],
		[
			"a named binding",
			'import { a as t } from "../prompts/t.md" with { type: "text" };',
			'text import "../prompts/t.md" must be a single default import',
		],
		[
			"a json attribute",
			'import t from "../prompts/t.md" with { type: "json" };',
			'import attributes on "../prompts/t.md" must be exactly with { type: "text" }',
		],
		[
			"a bare specifier",
			'import t from "pkg/body.md" with { type: "text" };',
			'text import "pkg/body.md" must be a relative path into prompts/',
		],
	];
	for (const [what, statement, message] of cases) {
		test(`${what} is refused`, async () => {
			write("prompts/t.md", "text\n");
			write("prompts/t.txt", "text\n");
			withHelper(`${statement}\nexport const h = t;\n`);
			expect(await messages(load())).toEqual([`lib/h.ts: ${message}`]);
		});
	}

	test("a valid .md default import is accepted", async () => {
		write("prompts/t.md", "text\n");
		withHelper(
			'import t from "../prompts/t.md" with { type: "text" };\nexport const h = t;\n',
		);
		expect(await messages(load())).toEqual([]);
	});
});
