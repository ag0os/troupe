import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { AgentSourceError, type SourceIssue } from "../lib/agent-format/errors";
import {
	installFakeClis,
	isAlive,
	readRecords,
	waitForFile,
} from "../lib/agent-format/fake-cli";
import { PROMPT_SEPARATOR } from "../lib/agent-format/schema";
import {
	compileAgent,
	inspectExtension,
	loadAgentDefinition,
} from "./agent-compiler";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "agent-compiler-"));
	mkdirSync(join(root, "agents"));
	mkdirSync(join(root, "system-prompts"));
	mkdirSync(join(root, "bin"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * Fake backends on PATH and a private TMPDIR, so a compiled binary launches
 * the fake CLIs and its runner resources land where the test can see them.
 */
function fakeBackendEnv(scenario = "ok") {
	const bin = join(root, "fake-backends");
	const tmp = join(root, "binary-tmp");
	mkdirSync(bin, { recursive: true });
	mkdirSync(tmp, { recursive: true });
	installFakeClis(bin);
	const record = join(root, "records.jsonl");
	const pid = join(root, "backend.pid");
	return {
		record,
		pid,
		tmp,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			TMPDIR: tmp,
			FAKE_RECORD: record,
			FAKE_PID_FILE: pid,
			FAKE_SCENARIO: scenario,
		},
	};
}

function write(path: string, text: string) {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

async function issuesOf(file: string): Promise<SourceIssue[]> {
	try {
		await loadAgentDefinition(root, file);
	} catch (error) {
		if (error instanceof AgentSourceError) return [...error.issues];
		throw error;
	}
	throw new Error("expected loadAgentDefinition to fail");
}

const header = "---\ndescription: Fixture\nbackends: [claude, codex]\n";

describe("loadAgentDefinition", () => {
	test("derives the id from the path and appends includes after the body", async () => {
		write("system-prompts/shared.md", "Shared fragment\n");
		write("agents/design/diagram/local.md", "Local fragment\n");
		write(
			"agents/design/diagram/all.md",
			`${header}includes:\n  - ../../../system-prompts/shared.md\n  - local.md\n---\nBody\n`,
		);
		const agent = await loadAgentDefinition(
			root,
			"agents/design/diagram/all.md",
		);
		expect(agent.id).toBe("design:diagram:all");
		expect(agent.spec.systemPrompt).toBe(
			["Body", "Shared fragment", "Local fragment"].join(PROMPT_SEPARATOR),
		);
		expect(agent.spec.promptMode).toBe("append");
		expect(agent.spec.mode).toBe("interactive");
		expect(agent.spec.initialPrompt).toBe("{{args}}");
		expect(agent.extension).toBeUndefined();
	});

	test("an include outside agents/ and system-prompts/ fails with file, line and field", async () => {
		write("docs/outside.md", "nope");
		write("agents/a.md", `${header}includes:\n  - ../docs/outside.md\n---\n`);
		const [issue] = await issuesOf("agents/a.md");
		expect(issue).toEqual({
			file: "agents/a.md",
			line: 5,
			field: "includes[0]",
			message:
				'"../docs/outside.md" resolves outside agents/ and system-prompts/',
		});
	});

	test("an include symlinked out of the roots is judged by its realpath", async () => {
		write("secrets.md", "nope");
		symlinkSync(join(root, "secrets.md"), join(root, "system-prompts/link.md"));
		write(
			"agents/a.md",
			`${header}includes: [../system-prompts/link.md]\n---\n`,
		);
		const [issue] = await issuesOf("agents/a.md");
		expect(issue?.field).toBe("includes[0]");
		expect(issue?.message).toMatch(/resolves outside/);
	});

	test("a missing include fails with file and field", async () => {
		write("agents/a.md", `${header}includes: [nope.md]\n---\n`);
		const [issue] = await issuesOf("agents/a.md");
		expect(issue).toMatchObject({
			file: "agents/a.md",
			line: 4,
			field: "includes[0]",
		});
		expect(issue?.message).toMatch(/does not exist/);
	});

	test("schema errors surface with the repository-relative file", async () => {
		write("agents/a.md", `${header}colour: blue\n---\n`);
		const [issue] = await issuesOf("agents/a.md");
		expect(issue).toEqual({
			file: "agents/a.md",
			line: 4,
			field: "colour",
			message: "unknown key",
		});
	});

	test("a declaration outside agents/ is rejected", async () => {
		write("system-prompts/a.md", `${header}---\n`);
		const [issue] = await issuesOf("system-prompts/a.md");
		expect(issue?.field).toBe("path");
	});

	test("picks up a side-effect-free extension without importing it", async () => {
		const marker = join(root, "imported");
		write("agents/a.md", `${header}---\nBody\n`);
		write(
			"agents/a.ts",
			`import { writeFileSync } from "node:fs";\nexport function prepare() { writeFileSync(${JSON.stringify(marker)}, "x"); return {}; }\n`,
		);
		const agent = await loadAgentDefinition(root, "agents/a.md");
		expect(agent.extension).toEqual({
			file: join(realpathSync(root), "agents/a.ts"),
			exports: ["prepare"],
		});
		expect(existsSync(marker)).toBe(false);
	});

	test("a paired extension with top-level side effects fails with file and line", async () => {
		const marker = join(root, "imported");
		write("agents/a.md", `${header}---\nBody\n`);
		write(
			"agents/a.ts",
			`import { writeFileSync } from "node:fs";\n\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport function finish() { return { exitCode: 0 }; }\n`,
		);
		const [issue] = await issuesOf("agents/a.md");
		expect(issue).toMatchObject({
			file: "agents/a.ts",
			line: 3,
			field: "top-level",
		});
		expect(existsSync(marker)).toBe(false);
	});

	test("a sibling without prepare/finish is not an extension", async () => {
		write("agents/a.md", `${header}---\nBody\n`);
		write("agents/a.ts", 'console.log("legacy launcher");\n');
		const agent = await loadAgentDefinition(root, "agents/a.md");
		expect(agent.extension).toBeUndefined();
	});
});

describe("extension imports", () => {
	test("accepts import type, a package import and a framework import", async () => {
		write("lib/agent-format/helper.ts", "export const HELP = 1;\n");
		write("agents/a.md", `${header}---\nBody\n`);
		write(
			"agents/a.ts",
			[
				'import type { PrepareContext } from "../lib/agent-format/types";',
				'import { parse } from "yaml";',
				'import { join } from "node:path";',
				'import { HELP } from "../lib/agent-format/helper";',
				"export function prepare(ctx: PrepareContext) { return { initialPrompt: join(String(parse(String(HELP))), ctx.cwd) }; }",
				"",
			].join("\n"),
		);
		const agent = await loadAgentDefinition(root, "agents/a.md");
		expect(agent.extension?.exports).toEqual(["prepare"]);
	});

	test("accepts a value import from lib/shepherd/", async () => {
		write("lib/shepherd/helper.ts", "export const HELP = 1;\n");
		write("agents/a.md", `${header}---\nBody\n`);
		write(
			"agents/a.ts",
			'import { HELP } from "../lib/shepherd/helper";\nexport function prepare() { return { initialPrompt: String(HELP) }; }\n',
		);
		const agent = await loadAgentDefinition(root, "agents/a.md");
		expect(agent.extension?.exports).toEqual(["prepare"]);
	});

	test("a framework-looking path that resolves elsewhere is rejected", async () => {
		write("lib/other/helper.ts", "export const HELP = 1;\n");
		write("agents/a.md", `${header}---\n`);
		write(
			"agents/a.ts",
			'import { HELP } from "../lib/other/helper";\nexport function prepare() { return { initialPrompt: String(HELP) }; }\n',
		);
		const [issue] = await issuesOf("agents/a.md");
		expect(issue).toMatchObject({
			file: "agents/a.ts",
			line: 1,
			field: "top-level",
		});
		expect(issue?.message).toContain('"../lib/other/helper"');
		expect(issue?.message).toContain(
			"only packages, builtins, lib/agent-format and lib/shepherd may be imported",
		);
	});

	test.each([
		[
			"a re-export from an executable module",
			'export { prepare } from "./legacy";\n',
		],
		[
			"a bare side-effect import",
			'import "./legacy";\nexport function prepare() { return {}; }\n',
		],
		[
			"a relative value import",
			'import { helper } from "./legacy";\nexport function prepare() { helper(); return {}; }\n',
		],
	])(
		"%s fails compile naming the specifier and never runs it",
		async (_, text) => {
			const marker = join(root, "imported");
			write(
				"agents/legacy.ts",
				`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport function prepare() { return {}; }\nexport function helper() {}\n`,
			);
			write("agents/a.md", `${header}---\n`);
			write("agents/a.ts", text);
			const [issue] = await issuesOf("agents/a.md");
			expect(issue).toMatchObject({
				file: "agents/a.ts",
				line: 1,
				field: "top-level",
			});
			expect(issue?.message).toContain('"./legacy"');
			expect(existsSync(marker)).toBe(false);
		},
	);

	test("export * in a paired sibling fails even without named hooks", async () => {
		write("agents/impl.ts", "export function prepare() { return {}; }\n");
		write("agents/a.md", `${header}---\n`);
		write("agents/a.ts", 'export * from "./impl";\n');
		const [issue] = await issuesOf("agents/a.md");
		expect(issue).toMatchObject({
			file: "agents/a.ts",
			line: 1,
			field: "exports",
		});
	});

	test("a declare-only prepare is a compile error, not a build failure", async () => {
		write("agents/a.md", `${header}---\n`);
		write("agents/a.ts", "export declare function prepare(): void;\n");
		const [issue] = await issuesOf("agents/a.md");
		expect(issue).toMatchObject({
			file: "agents/a.ts",
			line: 1,
			field: "exports",
		});
	});
});

describe("extension text imports", () => {
	const textHook = (specifier: string, attributes = '{ type: "text" }') =>
		`import type { PrepareContext } from "../lib/agent-format/types";\nimport doc from ${JSON.stringify(specifier)} with ${attributes};\nexport function prepare(_ctx: PrepareContext) { return { systemPromptFragments: [doc] }; }\n`;

	async function rejection(text: string) {
		write("agents/a.md", `${header}---\nBody\n`);
		write("agents/a.ts", text);
		const issues = await issuesOf("agents/a.md");
		expect(issues[0]).toMatchObject({ file: "agents/a.ts", field: "top-level" });
		return issues[0];
	}

	test("accepts a default text import of a file under system-prompts/", async () => {
		write("system-prompts/coach/doc.md", "Doc text");
		write("agents/a.md", `${header}---\nBody\n`);
		write("agents/a.ts", textHook("../system-prompts/coach/doc.md"));
		const agent = await loadAgentDefinition(root, "agents/a.md");
		expect(agent.extension?.exports).toEqual(["prepare"]);
	});

	test.each([
		["under agents/", "agents/doc.md", "../agents/doc.md"],
		["under lib/", "lib/doc.md", "../lib/doc.md"],
		["at the repository root", "doc.md", "../doc.md"],
		[
			"in a sibling directory that shares the prefix",
			"system-prompts-evil/x.md",
			"../system-prompts-evil/x.md",
		],
	])("rejects a text import %s", async (_, path, specifier) => {
		write(path, "Doc text");
		const issue = await rejection(textHook(specifier));
		expect(issue?.line).toBe(2);
		expect(issue?.message).toContain("resolves outside system-prompts/");
	});

	test("rejects a text import outside the repository", async () => {
		const outside = mkdtempSync(join(tmpdir(), "text-outside-"));
		try {
			writeFileSync(join(outside, "doc.md"), "Doc text");
			const specifier = relative(join(root, "agents"), join(outside, "doc.md"));
			const issue = await rejection(textHook(specifier));
			expect(issue?.message).toContain("resolves outside system-prompts/");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("judges a symlink under system-prompts/ by its realpath", async () => {
		write("lib/doc.md", "Doc text");
		symlinkSync(join(root, "lib/doc.md"), join(root, "system-prompts/doc.md"));
		const issue = await rejection(textHook("../system-prompts/doc.md"));
		expect(issue?.message).toContain("resolves outside system-prompts/");
	});

	test.each([
		"helper.ts",
		"helper.js",
		"notes.txt",
		"addon.node",
		"noext",
	])("rejects a non-.md specifier (%s) carrying type: text", async (name) => {
		write(`system-prompts/${name}`, "export const x = 1;\n");
		const issue = await rejection(textHook(`../system-prompts/${name}`));
		expect(issue?.line).toBe(2);
		expect(issue?.message).toBe(
			`text import "../system-prompts/${name}" must name a .md file under system-prompts/; extensions must not run code on import`,
		);
	});

	test.each([
		["holding an index module", "index.ts", 'console.log("INDEX");\n'],
		[
			"holding a package.json that redirects outside",
			"package.json",
			'{"main":"../../outside.md"}\n',
		],
	])("rejects a directory %s, with file and line", async (_, name, content) => {
		write("outside.md", "Outside text");
		write(`system-prompts/dir.md/${name}`, content);
		const issue = await rejection(textHook("../system-prompts/dir.md"));
		expect(issue?.line).toBe(2);
		expect(issue?.message).toContain(
			'text import "../system-prompts/dir.md" is not a file',
		);
	});

	test("a symlinked extension is judged from its real location for text imports", async () => {
		// From the link (agents/), the specifier names system-prompts/doc.md;
		// from the real file (x1/x2/x3/), Bun would load x1/x2/system-prompts/doc.md.
		write("system-prompts/doc.md", "Checked text");
		write("x1/x2/system-prompts/doc.md", "Divergent text");
		write("x1/x2/x3/a.ts", textHook("../system-prompts/doc.md"));
		write("agents/a.md", `${header}---\nBody\n`);
		symlinkSync(join(root, "x1/x2/x3/a.ts"), join(root, "agents/a.ts"));
		const [issue] = await issuesOf("agents/a.md");
		expect(issue).toMatchObject({ file: "agents/a.ts", line: 2 });
		expect(issue?.message).toContain("resolves outside system-prompts/");
	});

	test("a symlinked extension is judged from its real location for framework imports", async () => {
		// From the link the import names the real framework; from the real file
		// it names x1/x2/lib/agent-format/cli.ts, which would run on import.
		const marker = join(root, "ran-on-import");
		write("lib/agent-format/cli.ts", "export const v = 1;\n");
		write(
			"x1/x2/lib/agent-format/cli.ts",
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport const v = 1;\n`,
		);
		write(
			"x1/x2/x3/a.ts",
			'import { v } from "../lib/agent-format/cli.ts";\nexport function prepare() { return { initialPrompt: String(v) }; }\n',
		);
		write("agents/a.md", `${header}---\nBody\n`);
		symlinkSync(join(root, "x1/x2/x3/a.ts"), join(root, "agents/a.ts"));
		const [issue] = await issuesOf("agents/a.md");
		expect(issue).toMatchObject({
			file: "agents/a.ts",
			line: 1,
			field: "top-level",
		});
		expect(issue?.message).toContain(
			'value import from "../lib/agent-format/cli.ts"',
		);
		expect(existsSync(marker)).toBe(false);
	});

	test.each([
		[
			"a side-effect-only text import",
			'import "../system-prompts/doc.md" with { type: "text" };\nexport function prepare() { return {}; }\n',
			"side-effect import",
		],
		[
			"a namespace text import",
			'import * as doc from "../system-prompts/doc.md" with { type: "text" };\nexport function prepare() { return { initialPrompt: String(doc) }; }\n',
			"single default import",
		],
		[
			"a named text import",
			'import { default as doc } from "../system-prompts/doc.md" with { type: "text" };\nexport function prepare() { return { initialPrompt: doc }; }\n',
			"single default import",
		],
		[
			"a default plus named text import",
			'import doc, { x } from "../system-prompts/doc.md" with { type: "text" };\nexport function prepare() { return { initialPrompt: doc + x }; }\n',
			"single default import",
		],
		[
			"another attribute value",
			'import doc from "../system-prompts/doc.md" with { type: "json" };\nexport function prepare() { return { initialPrompt: String(doc) }; }\n',
			'exactly with { type: "text" }',
		],
		[
			"an extra attribute",
			'import doc from "../system-prompts/doc.md" with { type: "text", mode: "raw" };\nexport function prepare() { return { initialPrompt: doc }; }\n',
			'exactly with { type: "text" }',
		],
		[
			"the legacy assert keyword",
			'import doc from "../system-prompts/doc.md" assert { type: "text" };\nexport function prepare() { return { initialPrompt: doc }; }\n',
			'exactly with { type: "text" }',
		],
		[
			"a re-export of a text module",
			'export { default as prepare } from "../system-prompts/doc.md" with { type: "text" };\n',
			"re-export",
		],
		[
			"a package specifier carrying type: text",
			'import doc from "troupe/system-prompts/doc.md" with { type: "text" };\nexport function prepare() { return { initialPrompt: doc }; }\n',
			"must be a relative path into system-prompts/",
		],
	])("rejects %s", async (_, text, message) => {
		write("system-prompts/doc.md", "Doc text");
		const issue = await rejection(text);
		expect(issue?.line).toBe(1);
		expect(issue?.message).toContain(message);
	});

	test("a missing text file fails with file and line", async () => {
		const issue = await rejection(textHook("../system-prompts/missing.md"));
		expect(issue).toMatchObject({ file: "agents/a.ts", line: 2 });
		expect(issue?.message).toContain(
			'text import "../system-prompts/missing.md" does not exist',
		);
	});

	test("without a repository, inspectExtension rejects every text import", () => {
		const inspection = inspectExtension(
			"agents/a.ts",
			textHook("../system-prompts/doc.md"),
		);
		expect(inspection.sideEffects[0]?.message).toContain(
			"cannot be resolved without a repository",
		);
	});

	test("the compiled binary embeds the imported text", async () => {
		write("system-prompts/coach/doc.md", "Embedded coach text");
		write("agents/fixture/hello.md", `${header}---\nHello body\n`);
		write(
			"agents/fixture/hello.ts",
			'import doc from "../../system-prompts/coach/doc.md" with { type: "text" };\nexport function prepare() { return { systemPromptFragments: [doc] }; }\n',
		);
		const outFile = join(root, "bin/fixture:hello");
		await compileAgent({ root, file: "agents/fixture/hello.md", outFile });

		// Neither the source tree nor the repository is reachable at run time.
		rmSync(join(root, "agents"), { recursive: true });
		rmSync(join(root, "system-prompts"), { recursive: true });
		const child = Bun.spawnSync([outFile, "--show-prompt"], {
			cwd: realpathSync(tmpdir()),
		});
		expect(child.exitCode).toBe(0);
		expect(child.stdout.toString()).toContain(
			`Hello body${PROMPT_SEPARATOR}Embedded coach text\n--- Initial prompt ---`,
		);
	}, 60_000);
});

describe("inspectExtension", () => {
	const inspect = (text: string) => inspectExtension("agents/x.ts", text);

	test("finds reserved exports in every static form", () => {
		expect(inspect("export async function prepare() {}").exports).toEqual([
			"prepare",
		]);
		expect(
			inspect("export const finish = () => ({ exitCode: 0 });").exports,
		).toEqual(["finish"]);
		expect(
			inspect("function a() {}\nexport { a as prepare, a as finish };").exports,
		).toEqual(["prepare", "finish"]);
		expect(inspect('export { prepare } from "./shared";').exports).toEqual([
			"prepare",
		]);
		expect(inspect("export function helper() {}").exports).toEqual([]);
	});

	test.each([
		["a destructured export", "export const { prepare } = make();"],
		["a nested destructured export", "export const [{ finish }] = list;"],
		["export default function", "export default function prepare() {}"],
		["export default expression", "export default { prepare };"],
		["export =", "export = prepare;"],
		["a declare export", "export declare function prepare(): void;"],
		["a type alias export", "export type prepare = () => void;"],
		["a type-only clause", "type prepare = number;\nexport type { prepare };"],
		[
			"a type-only specifier",
			"type prepare = number;\nexport { type prepare };",
		],
		[
			"an import-type re-export",
			'import type { prepare } from "pkg";\nexport { prepare };',
		],
		["an undeclared local", "export { prepare };"],
		["export *", 'export * from "./impl";'],
		["export * as", 'export * as prepare from "./impl";'],
	])("reports %s as an unresolvable export shape", (_, text) => {
		const { exportProblems } = inspect(text);
		expect(exportProblems.length).toBeGreaterThan(0);
		expect(exportProblems[0]).toMatchObject({
			file: "agents/x.ts",
			field: "exports",
		});
		expect(exportProblems[0]?.line).toBeGreaterThan(0);
	});

	test("a local import can be exported by name", () => {
		const result = inspect(
			'import { prepare } from "pkg";\nexport { prepare };',
		);
		expect(result.exports).toEqual(["prepare"]);
		expect(result.exportProblems).toEqual([]);
		expect(result.sideEffects).toEqual([]);
	});

	test("accepts the allowed top level", () => {
		const { sideEffects } = inspect(`
import { join } from "node:path";
import type { Prepare } from "../lib/agent-format/types";
export type Mode = "a" | "b";
export interface Options { quick: boolean }
const LIMIT = -3;
const NAMES = ["a", "b"] as const;
const TABLE = { a: 1, b: [true, null], c() { return 1; }, get d() { return 2; } };
const render = (x: string) => join(x, "y");
const legacy = function () {};
enum Kind { A, B = 2, C = "c", D = -1 }
declare const injected: string;
class Base {}
class Child extends Base {}
class Helper { static readonly max = 3; run() { return join("a"); } }
export function prepare() { return { initialPrompt: render("x") }; }
`);
		expect(sideEffects).toEqual([]);
	});

	test.each([
		["an expression statement", 'console.log("hi");'],
		["a call initializer", 'const dir = join("a", "b");'],
		["a let declaration", "let count = 0;"],
		["a var declaration", "var count = 0;"],
		["top-level await", "await Promise.resolve();"],
		["an await initializer", "const x = await load();"],
		["an if block", "if (process.env.X) {}"],
		["a try block", "try {} catch {}"],
		["a template with substitutions", "const t = `${process.pid}`;"],
		["an identifier initializer", "const env = process.env;"],
		["a new expression", "const m = new Map();"],
		["a spread", "const a = [...list];"],
		["a computed key", "const o = { [key()]: 1 };"],
		["a destructuring declaration", "const { a } = { a: 1 };"],
		["a const enum", "const enum Kind { A }"],
		["an enum with a computed initializer", "enum Kind { A = run() }"],
		["a class decorator", "@dec class A {}"],
		["a method decorator", "class A { @dec m() {} }"],
		["a parameter decorator", "class A { m(@dec x: number) {} }"],
		[
			"a constructor parameter decorator",
			"class A { constructor(@dec x: number) {} }",
		],
		["a property access extends", "class A extends o.B {}"],
		["import-equals of an entity", "import x = o.B;"],
		["import-equals of require", 'import x = require("node:fs");'],
		["a relative side-effect import", 'import "./boot";'],
		["a package side-effect import", 'import "some-package";'],
		["a relative value import", 'import { helper } from "./legacy";'],
		["a parent value import", 'import helper from "../shared/helper";'],
		["an absolute value import", 'import { x } from "/tmp/x";'],
		["a named re-export", 'export { helper } from "./legacy";'],
		["a type re-export", 'export type { T } from "./types";'],
		["a declare naming prepare", "declare function prepare(): void;"],
		["a class static block", "class A { static { run(); } }"],
		["a class static call initializer", "class A { static x = run(); }"],
		["a computed extends", "class A extends mixin(B) {}"],
		["a namespace", "namespace N { run(); }"],
		["a default export call", "export default run();"],
	])("rejects %s with its line", (_, statement) => {
		const { sideEffects } = inspect(
			`export function prepare() {}\n\n${statement}\n`,
		);
		expect(sideEffects.length).toBeGreaterThan(0);
		expect(sideEffects[0]).toMatchObject({ file: "agents/x.ts", line: 3 });
	});

	test("reports syntax errors", () => {
		const { sideEffects } = inspect("export function prepare( {\n");
		expect(sideEffects.some((i) => i.field === "syntax")).toBe(true);
	});
});

describe("compileAgent", () => {
	test("builds one fixture with its extension into a working binary", async () => {
		write("system-prompts/shared.md", "Shared fragment");
		write(
			"agents/fixture/hello.md",
			`${header}includes: [../../system-prompts/shared.md]\n---\nHello body\n`,
		);
		write(
			"agents/fixture/hello.ts",
			'export function prepare() { return { systemPromptFragments: ["From prepare"] }; }\nexport function helper() {}\n',
		);
		const outFile = join(root, "bin/fixture:hello");
		const agent = await compileAgent({
			root,
			file: "agents/fixture/hello.md",
			outFile,
		});
		expect(agent.id).toBe("fixture:hello");
		expect(agent.extension?.exports).toEqual(["prepare"]);

		// The binary needs no checkout assets.
		rmSync(join(root, "agents"), { recursive: true });
		rmSync(join(root, "system-prompts"), { recursive: true });
		const fake = fakeBackendEnv();
		const cwd = realpathSync(tmpdir());
		const child = Bun.spawnSync([outFile, "--print", "go"], {
			cwd,
			env: fake.env,
		});
		expect(child.exitCode).toBe(0);
		expect(child.stdout.toString()).toBe("claude result\n");
		const [record] = readRecords(fake.record);
		expect(record?.cwd).toBe(cwd);
		expect(record?.argv).toEqual([
			"--print",
			"--append-system-prompt",
			`Hello body${PROMPT_SEPARATOR}Shared fragment${PROMPT_SEPARATOR}From prepare`,
			"--",
			"go",
		]);
		expect(readdirSync(fake.tmp)).toEqual([]);
		expect(existsSync(join(root, "bin"))).toBe(true);
	}, 60_000);

	test("the binary parses its CLI: help, strict errors, flags and passthrough (B-002)", async () => {
		write(
			"agents/fixture/flags.md",
			`${header}model: { claude: sonnet }
flags:
  quick: { type: boolean, short: q, description: Quick }
  focus: { type: enum, description: Focus, values: [tech, changes], default: changes }
---
Body
`,
		);
		const outFile = join(root, "bin/fixture:flags");
		await compileAgent({ root, file: "agents/fixture/flags.md", outFile });
		const cwd = realpathSync(tmpdir());
		const fake = fakeBackendEnv();
		const runBinary = (...argv: string[]) => {
			const child = Bun.spawnSync([outFile, ...argv], {
				cwd,
				env: { ...fake.env, FORGE_BACKEND: "codex" },
				stdout: "pipe",
				stderr: "pipe",
			});
			return {
				code: child.exitCode,
				stdout: child.stdout.toString(),
				stderr: child.stderr.toString(),
			};
		};

		const help = runBinary("--help");
		expect(help.code).toBe(0);
		expect(help.stderr).toBe("");
		expect(help.stdout).toContain("fixture:flags: Fixture");
		expect(help.stdout).toContain("-q, --quick");
		expect(help.stdout).toContain("--focus <tech|changes>");

		for (const argv of [
			["--resume", "x"],
			["--backend", "gemini"],
			["--cwd", "/definitely/missing"],
		]) {
			const bad = runBinary(...argv);
			expect(bad.code).toBe(2);
			expect(bad.stdout).toBe("");
			expect(bad.stderr).toStartWith("fixture:flags: ");
		}
		expect(readRecords(fake.record)).toEqual([]);

		const ok = runBinary(
			"a",
			"-q",
			"--focus=tech",
			"b",
			"--model",
			"opus",
			"--print",
			"--",
			"--resume",
			"x",
		);
		expect(ok.code).toBe(0);
		expect(ok.stdout).toBe("claude result\n");
		// FORGE_BACKEND is ignored; declared flags are consumed, the tail is verbatim.
		const [record] = readRecords(fake.record);
		expect(record?.name).toBe("claude");
		expect(record?.argv).toEqual([
			"--print",
			"--append-system-prompt",
			"Body",
			"--model",
			"opus",
			"--resume",
			"x",
			"--",
			"a b",
		]);
	}, 60_000);

	test("the binary runs signals and cleanup end to end (B-006, D-018)", async () => {
		write("agents/fixture/stream.md", `${header}mode: stream\n---\nBody\n`);
		const outFile = join(root, "bin/fixture:stream");
		await compileAgent({ root, file: "agents/fixture/stream.md", outFile });
		const cwd = realpathSync(tmpdir());

		const ok = fakeBackendEnv();
		const decoded = Bun.spawnSync([outFile, "hi"], { cwd, env: ok.env });
		expect(decoded.exitCode).toBe(0);
		expect(decoded.stdout.toString()).toBe("hello from claude\n");
		expect(readRecords(ok.record)[0]?.argv.slice(0, 4)).toEqual([
			"--print",
			"--output-format",
			"stream-json",
			"--verbose",
		]);
		expect(readdirSync(ok.tmp)).toEqual([]);

		const hang = fakeBackendEnv("hang");
		rmSync(hang.record, { force: true });
		rmSync(hang.pid, { force: true });
		const child = Bun.spawn([outFile, "hi"], {
			cwd,
			env: hang.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const pid = await waitForFile(hang.pid, {
			diagnose: async () =>
				child.exitCode === null
					? "the binary is still running"
					: `the binary exited ${child.exitCode}: ${await new Response(child.stderr).text()}`,
		});
		expect(readdirSync(hang.tmp)).toHaveLength(1);
		child.kill("SIGTERM");
		expect(await child.exited).toBe(143);
		expect(isAlive(pid)).toBe(false);
		expect(readdirSync(hang.tmp)).toEqual([]);
	}, 60_000);

	test("an invalid declaration produces no binary and leaves no temp files", async () => {
		write("agents/bad.md", `${header}unknown: 1\n---\n`);
		const outFile = join(root, "bin/bad");
		await expect(
			compileAgent({ root, file: "agents/bad.md", outFile }),
		).rejects.toBeInstanceOf(AgentSourceError);
		expect(existsSync(outFile)).toBe(false);
		expect(
			Bun.spawnSync(["ls", "-A", join(root, "bin")]).stdout.toString(),
		).toBe("");
	});
});

describe("compiled --show-prompt (B-003, D-012)", () => {
	test("prints exactly the envelope on both backends and nothing executes", async () => {
		// A secret command that leaves a marker if anything ever runs it.
		const marker = join(root, "secret-ran");
		write(
			"fake-bin/secret-cmd",
			`#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho leaked-secret\n`,
		);
		Bun.spawnSync(["chmod", "+x", join(root, "fake-bin/secret-cmd")]);
		write(
			"agents/fixture/audit.md",
			`---
description: Fixture
backends: [claude, codex]
promptMode: replace
initialPrompt: "Audit {{args}}"
flags:
  fail: { type: boolean, description: Make prepare throw }
mcp:
  api:
    url: https://api.example.test/mcp
    headers:
      Authorization: "Bearer \${cmd:secret-cmd --reveal}"
  local:
    command: local-mcp
    env:
      TOKEN: "\${env:SECRET_TOKEN}"
---
Audit body
`,
		);
		// Prepare creates a directory and runs a child only outside preview,
		// and prints carelessly: the runner must absorb it.
		write(
			"agents/fixture/audit.ts",
			`import { mkdirSync } from "node:fs";
export async function prepare(ctx) {
	const dir = ctx.cwd + "/.audit";
	if (!ctx.preview) {
		mkdirSync(dir);
		await ctx.runCommand({ argv: ["secret-cmd"] });
	}
	if (ctx.flags.fail) throw new Error("prepare exploded");
	for (const name of ["log", "info", "debug", "write", "dir", "dirxml", "table", "count", "countReset", "group", "groupCollapsed", "groupEnd", "trace", "timeLog", "timeEnd"]) {
		console[name]("LEAK " + name);
	}
	process.stdout.write("LEAK write\\n");
	// Output scheduled to land after prepare returns.
	queueMicrotask(() => console.log("LEAK microtask"));
	Promise.resolve().then(() => process.stdout.write("LEAK promise\\n"));
	setTimeout(() => console.log("LEAK timer"), 0);
	setTimeout(() => process.stdout.write("LEAK late timer\\n"), 50);
	setImmediate(() => console.log("LEAK immediate"));
	return {
		systemPromptFragments: ["Report dir: " + dir],
		beforeRunMessages: ["BANNER before"],
		afterRunMessages: ["BANNER after"],
	};
}
`,
		);
		const outFile = join(root, "bin/fixture:audit");
		await compileAgent({ root, file: "agents/fixture/audit.md", outFile });

		const workspace = realpathSync(mkdtempSync(join(tmpdir(), "preview-ws-")));
		const tmp = realpathSync(mkdtempSync(join(tmpdir(), "preview-tmp-")));
		try {
			const runBinary = (...argv: string[]) => {
				const child = Bun.spawnSync([outFile, ...argv], {
					cwd: workspace,
					env: {
						...process.env,
						PATH: `${join(root, "fake-bin")}:${process.env.PATH}`,
						SECRET_TOKEN: "super-secret-value",
						TMPDIR: tmp,
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				return {
					code: child.exitCode,
					stdout: child.stdout.toString(),
					stderr: child.stderr.toString(),
				};
			};
			const system = `Audit body${PROMPT_SEPARATOR}Report dir: ${workspace}/.audit`;
			const envelope = (backend: string, argv: string[]) =>
				[
					`Backend: ${backend}`,
					"--- System prompt ---",
					system,
					"--- Initial prompt ---",
					"Audit src",
					"--- Argv ---",
					JSON.stringify(argv),
					"",
				].join("\n");
			const mcpJson = JSON.stringify({
				mcpServers: {
					api: {
						type: "http",
						url: "https://api.example.test/mcp",
						headers: { Authorization: "${TROUPE_MCP_API_AUTHORIZATION}" },
					},
					local: {
						type: "stdio",
						command: "local-mcp",
						env: { TOKEN: "<redacted:env:SECRET_TOKEN>" },
					},
				},
			});

			expect(runBinary("src", "--show-prompt")).toEqual({
				code: 0,
				stderr: "",
				stdout: envelope("claude", [
					"claude",
					"--system-prompt",
					system,
					"--mcp-config",
					mcpJson,
					"--",
					"Audit src",
				]),
			});
			expect(runBinary("src", "--show-prompt", "--backend", "codex")).toEqual({
				code: 0,
				stderr: "",
				stdout: envelope("codex", [
					"codex",
					"-c",
					'model_instructions_file="<temp:prompt-file>"',
					"-c",
					'mcp_servers.api={url = "https://api.example.test/mcp", env_http_headers = {Authorization = "TROUPE_MCP_API_AUTHORIZATION"}}',
					"-c",
					'mcp_servers.local={command = "local-mcp", env = {TOKEN = "<redacted:env:SECRET_TOKEN>"}}',
					"--",
					"Audit src",
				]),
			});

			// Negative checks: no secret command ran, nothing was written, no temp
			// resource was created, no secret or banner reached stdout.
			expect(existsSync(marker)).toBe(false);
			expect(readdirSync(workspace)).toEqual([]);
			expect(readdirSync(tmp)).toEqual([]);

			// A prepare failure exits 1 with stderr only, and nothing deferred leaks.
			expect(runBinary("src", "--fail", "--show-prompt")).toEqual({
				code: 1,
				stdout: "",
				stderr: "fixture:audit: prepare failed: prepare exploded\n",
			});

			// A failing request exits nonzero with stderr only, no partial envelope.
			for (const argv of [
				["--show-prompt", "--backend", "gemini"],
				["--show-prompt", "--cwd", "/definitely/missing"],
			]) {
				const bad = runBinary(...argv);
				expect(bad.code).not.toBe(0);
				expect(bad.stdout).toBe("");
				expect(bad.stderr).toStartWith("fixture:audit: ");
			}
		} finally {
			rmSync(workspace, { recursive: true, force: true });
			rmSync(tmp, { recursive: true, force: true });
		}
	}, 60_000);
});
