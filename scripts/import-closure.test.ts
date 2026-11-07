import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { relativeClosure } from "./import-closure";

const root = realpathSync(mkdtempSync(join(tmpdir(), "import-closure-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string>): string {
	const base = join(root, name);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(base, path)), { recursive: true });
		writeFileSync(join(base, path), text);
	}
	return base;
}

describe("import closure", () => {
	test("follows a namespace re-export", () => {
		const base = tree("namespace", {
			"index.ts": 'export * as helpers from "./helpers";\n',
			"helpers.ts": "export const h = 1;\n",
		});
		expect(relativeClosure(base, ["index.ts"]).files).toEqual([
			"helpers.ts",
			"index.ts",
		]);
	});

	test("follows runtime URLs in both quote styles and a template", () => {
		const base = tree("urls", {
			"index.ts": [
				'export const a = new URL("./a.ts", import.meta.url);',
				"export const b = new URL('./b.ts', import.meta.url);",
				"export const c = new URL(`./c.ts`, import.meta.url);",
				"",
			].join("\n"),
			"a.ts": "",
			"b.ts": "",
			"c.ts": "",
		});
		const result = relativeClosure(base, ["index.ts"]);
		expect(result.files).toEqual(["a.ts", "b.ts", "c.ts", "index.ts"]);
		expect(result.opaque).toEqual([]);
	});

	test("ignores a URL in a comment and in a string", () => {
		const base = tree("ignored", {
			"index.ts": [
				'// new URL("./comment.ts", import.meta.url)',
				'/* new URL("./block.ts", import.meta.url) */',
				`export const s = 'new URL("./string.ts", import.meta.url)';`,
				'export const t = `import("./template.ts")`;',
				"",
			].join("\n"),
		});
		const result = relativeClosure(base, ["index.ts"]);
		expect(result.files).toEqual(["index.ts"]);
		expect(result.unresolved).toEqual([]);
	});

	test("reports computed imports, URLs and import.meta directories as opaque", () => {
		const base = tree("opaque", {
			"index.ts": [
				"const name = process.argv[2] ?? 'x';",
				"export const m = import(`./${name}.ts`);",
				"export const u = new URL(name, import.meta.url);",
				"export const d = import.meta.dir;",
				"export const e = import.meta.dirname;",
				"",
			].join("\n"),
		});
		const result = relativeClosure(base, ["index.ts"]);
		const file = join(base, "index.ts");
		expect(result.opaque).toEqual([
			`${file}:2: computed import()`,
			`${file}:3: non-literal URL with import.meta.url`,
			`${file}:4: import.meta.dir`,
			`${file}:5: import.meta.dirname`,
		]);
	});

	test("a literal dynamic import is an edge", () => {
		const base = tree("dynamic", {
			"index.ts": 'export const m = await import("./later");\n',
			"later.ts": "export {};\n",
		});
		expect(relativeClosure(base, ["index.ts"]).files).toEqual([
			"index.ts",
			"later.ts",
		]);
	});

	test("a text import is a member and is not followed", () => {
		const base = tree("text", {
			"index.ts":
				'import prompt from "./prompt.md" with { type: "text" };\nexport { prompt };\n',
			"prompt.md": 'import x from "./never.ts";\n',
		});
		const result = relativeClosure(base, ["index.ts"]);
		expect(result.files).toEqual(["index.ts", "prompt.md"]);
		expect(result.unresolved).toEqual([]);
	});

	test("traverses a JavaScript member", () => {
		const base = tree("javascript", {
			"index.ts": 'export * from "./legacy.js";\n',
			"legacy.js": 'export * from "./deeper.mjs";\n',
			"deeper.mjs": 'import "./tail.cjs";\n',
			"tail.cjs": 'require("./end.ts");\n',
			"end.ts": "export {};\n",
		});
		expect(relativeClosure(base, ["index.ts"]).files).toEqual([
			"deeper.mjs",
			"end.ts",
			"index.ts",
			"legacy.js",
			"tail.cjs",
		]);
	});

	test("counts type-only edges", () => {
		const base = tree("types", {
			"index.ts":
				'import type { A } from "./a";\nexport type * from "./b";\nexport type C = import("./c").C;\nexport type { A };\n',
			"a.ts": "export type A = 1;\n",
			"b.ts": "export type B = 2;\n",
			"c.ts": "export type C = 3;\n",
		});
		expect(relativeClosure(base, ["index.ts"]).files).toEqual([
			"a.ts",
			"b.ts",
			"c.ts",
			"index.ts",
		]);
	});
});

describe("runtime URL forms (R2)", () => {
	test("a bare URL path names a local file, not a package", () => {
		const base = tree("bare-url", {
			"index.ts": [
				'export const a = new URL("helper.ts", import.meta.url);',
				'export const b = new URL("yaml/helper.ts", import.meta.url);',
				"",
			].join("\n"),
			"helper.ts": "",
			"yaml/helper.ts": "",
		});
		const result = relativeClosure(base, ["index.ts"]);
		expect(result.files).toEqual(["helper.ts", "index.ts", "yaml/helper.ts"]);
		expect(result.external).toEqual([]);
	});

	test("parenthesized, asserted and element-access forms are followed", () => {
		const base = tree("wrapped-url", {
			"index.ts": [
				'export const a = new URL("./a.ts", (import.meta.url));',
				'export const b = new URL("./b.ts", import.meta["url"]);',
				'export const c = new URL(("./c.ts"), import.meta.url as string);',
				'export const d = new globalThis.URL("./d.ts", import.meta.url);',
				'export const e = new (URL)("./e.ts", import.meta.url);',
				'export const f = await import(("./f.ts"));',
				"",
			].join("\n"),
			"a.ts": "",
			"b.ts": "",
			"c.ts": "",
			"d.ts": "",
			"e.ts": "",
			"f.ts": "",
		});
		const result = relativeClosure(base, ["index.ts"]);
		expect(result.files).toEqual([
			"a.ts",
			"b.ts",
			"c.ts",
			"d.ts",
			"e.ts",
			"f.ts",
			"index.ts",
		]);
		expect(result.opaque).toEqual([]);
	});

	test("a URL is resolved exactly, without an extension search", () => {
		const base = tree("exact-url", {
			"index.ts": 'export const a = new URL("./helper", import.meta.url);\n',
			"helper.ts": "",
		});
		const result = relativeClosure(base, ["index.ts"]);
		expect(result.files).toEqual(["index.ts"]);
		expect(result.unresolved).toEqual([
			`${join(base, "index.ts")} -> url ${join(base, "helper")}`,
		]);
	});

	test("element-access and computed import.meta reads are opaque", () => {
		const base = tree("meta-access", {
			"index.ts": [
				"const key = process.argv[2] as string;",
				'export const d = import.meta["dirname"];',
				'export const m = import.meta[key as "url"];',
				'export const u = new URL("./x.ts", import.meta[key as "url"]);',
				'export const n = new URL("https://x.test/a.ts", import.meta.url);',
				'export const r = new URL("./", import.meta.url);',
				"",
			].join("\n"),
		});
		const result = relativeClosure(base, ["index.ts"]);
		expect(
			result.opaqueRefs.map((ref) => `${ref.line} ${ref.kind} ${ref.what}`),
		).toEqual([
			"2 directory import.meta.dirname",
			"3 url computed import.meta access",
			"4 url non-literal URL with import.meta.url",
			"4 url computed import.meta access",
			"5 url non-file URL https:",
			`0 directory URL to the directory ${base}/`,
		]);
	});

	test("opaque references carry their kind", () => {
		const base = tree("kinds", {
			"index.ts": [
				"const name = process.argv[2] ?? 'x';",
				"export const m = import(name);",
				"export const r = require(name);",
				"export const d = import.meta.dir;",
				"",
			].join("\n"),
		});
		expect(
			relativeClosure(base, ["index.ts"]).opaqueRefs.map((ref) => ref.kind),
		).toEqual(["module", "module", "directory"]);
	});
});
