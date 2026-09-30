import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentSourceError, type SourceIssue } from "../lib/agent-format/errors";
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
			"export function prepare() { return {}; }\nexport function helper() {}\n",
		);
		const outFile = join(root, "bin/fixture:hello");
		const agent = await compileAgent({
			root,
			file: "agents/fixture/hello.md",
			outFile,
		});
		expect(agent.id).toBe("fixture:hello");

		// The binary needs no checkout assets.
		rmSync(join(root, "agents"), { recursive: true });
		rmSync(join(root, "system-prompts"), { recursive: true });
		const child = Bun.spawnSync([outFile], { cwd: tmpdir() });
		expect(child.exitCode).toBe(0);
		const output = JSON.parse(child.stdout.toString());
		expect(output.extension).toEqual(["prepare"]);
		expect(output.spec).toMatchObject({
			id: "fixture:hello",
			promptMode: "append",
			mode: "interactive",
			initialPrompt: "{{args}}",
			systemPrompt: `Hello body${PROMPT_SEPARATOR}Shared fragment`,
		});
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
		const runBinary = (...argv: string[]) => {
			const child = Bun.spawnSync([outFile, ...argv], {
				cwd,
				env: { ...process.env, FORGE_BACKEND: "codex" },
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
		expect(JSON.parse(ok.stdout).invocation).toEqual({
			backend: "claude",
			mode: "print",
			model: "opus",
			cwd,
			flags: { quick: true, focus: "tech" },
			args: ["a", "b"],
			passthrough: ["--resume", "x"],
			showPrompt: false,
		});
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
