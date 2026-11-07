import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { edgesOf, importClosure } from "./import-closure";
import {
	AGENT_FILES,
	AGENT_FIXTURES,
	COMPATIBILITY_TESTS,
	DOCUMENTS,
	isOwned,
	mayImportOwned,
	OWNED_TREES,
	POLICIES,
	TRANSITIONAL,
	WRAPPERS,
} from "./ownership";

// O19: the section 8 inventory, enforced over this repository's tracked
// files. It reads the checkout only.

const repo = resolve(import.meta.dir, "..");

/** Every extension `scripts/import-closure.ts` parses. */
const CODE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;

function tracked(...pathspecs: string[]): string[] {
	const result = spawnSync("git", ["ls-files", "-z", "--", ...pathspecs], {
		cwd: repo,
		encoding: "utf8",
	});
	expect(result.status).toBe(0);
	return result.stdout.split("\0").filter((path) => path !== "");
}

/** Root-relative files a module loads by relative path or file URL. */
function loads(root: string, path: string): string[] {
	const full = resolve(root, path);
	const edges = edgesOf(full);
	const targets = edges.specifiers
		.filter((specifier) => specifier.startsWith("."))
		.map((specifier) => {
			const base = resolve(dirname(full), specifier);
			return (
				[base, `${base}.ts`, `${base}/index.ts`].find(
					(candidate) => existsSync(candidate) && statSync(candidate).isFile(),
				) ?? base
			);
		});
	return [...targets, ...edges.urls].map((target) => relative(root, target));
}

/**
 * Crossings into the inventory by files outside it, and what such a file
 * loads that cannot be judged: an absolute specifier, or a module or URL
 * reference the walker cannot follow. Directory-kind references (a
 * computed path handed to a directory reader) load no code and stay out
 * of scope.
 */
function crossings(
	root: string,
	files: readonly string[],
	owned: (path: string) => boolean,
	exempt: (path: string) => boolean,
): string[] {
	return files
		.filter((path) => !exempt(path))
		.flatMap((path) => {
			const edges = edgesOf(resolve(root, path));
			return [
				...loads(root, path)
					.filter(owned)
					.map((target) => `${path} -> ${target}`),
				...edges.specifiers
					.filter((specifier) => specifier.startsWith("/"))
					.map((specifier) => `${path} -> absolute ${specifier}`),
				...edges.opaque
					.filter((ref) => ref.kind !== "directory")
					.map((ref) => `${path}:${ref.line} -> opaque ${ref.kind}`),
			];
		});
}

const code = tracked()
	.filter((path) => CODE.test(path))
	.filter((path) => existsSync(resolve(repo, path)));

describe("the ownership inventory (O19)", () => {
	test("every exact path exists and every owned tree is present", () => {
		for (const path of [
			...WRAPPERS,
			...POLICIES,
			...AGENT_FILES,
			...AGENT_FIXTURES,
			...DOCUMENTS,
			...TRANSITIONAL,
			...Object.keys(COMPATIBILITY_TESTS),
		]) {
			expect(existsSync(resolve(repo, path))).toBe(true);
		}
		for (const tree of OWNED_TREES) {
			expect(tracked(tree).length).toBeGreaterThan(0);
		}
	});

	test("Shepherd agent files and their fixtures are all enumerated", () => {
		const shepherdAgentFiles = tracked("agents").filter((path) =>
			/shepherd/i.test(path),
		);
		expect(shepherdAgentFiles.filter((path) => !isOwned(path))).toEqual([]);
	});

	test("extraction scripts are all listed by exact path as transitional verification code", () => {
		const extraction = tracked("scripts").filter((path) =>
			/extraction|shepherd-copy/.test(path),
		);
		expect(extraction.length).toBeGreaterThan(0);
		expect(extraction.filter((path) => !isOwned(path))).toEqual([]);
		expect([...extraction].sort()).toEqual([...TRANSITIONAL].sort());
	});

	test("each root Shepherd document carries one transitional line naming its package copy", () => {
		for (const path of DOCUMENTS) {
			const name = path.slice("docs/".length);
			const target = `extractions/shepherd/docs/${name}`;
			expect(existsSync(resolve(repo, target))).toBe(true);
			const text = readFileSync(resolve(repo, path), "utf8");
			const lines = text
				.split("\n")
				.filter((line) => line.startsWith("> Transitional copy:"));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(`[${target}](../${target})`);
			expect(readFileSync(resolve(repo, target), "utf8")).not.toContain(
				"Transitional copy:",
			);
		}
	});

	test("no file outside the inventory imports into it, except classified compatibility tests", () => {
		expect(code.length).toBeGreaterThan(100);
		expect(crossings(repo, code, isOwned, mayImportOwned)).toEqual([]);
	});

	test("every classified compatibility test is a test that reaches the inventory", () => {
		for (const path of Object.keys(COMPATIBILITY_TESTS)) {
			expect(path).toEndWith(".test.ts");
			expect(isOwned(path)).toBe(false);
			expect(loads(repo, path).some(isOwned)).toBe(true);
		}
	});

	test("generic distributable code reaches no Shepherd location and nothing unjudged", () => {
		const entries = [
			"lib/index.ts",
			...tracked("lib/entries").filter((path) => path.endsWith(".ts")),
		].map((path) => resolve(repo, path));
		const closure = importClosure(entries);
		const reached = closure.files.map((file) => relative(repo, file));
		expect(reached.filter(isOwned)).toEqual([]);
		expect(reached.filter((path) => /shepherd/i.test(path))).toEqual([]);
		expect(reached.filter((path) => path.startsWith("scripts/"))).toEqual([]);
		expect(closure.unresolved).toEqual([]);
		expect(
			closure.opaqueRefs.filter((ref) => ref.kind !== "directory"),
		).toEqual([]);
	});

	test("framework library files and tests use generic APIs only", () => {
		const framework = code.filter(
			(path) =>
				(path.startsWith("lib/agent-format/") ||
					path.startsWith("lib/entries/")) &&
				!Object.hasOwn(COMPATIBILITY_TESTS, path),
		);
		expect(framework.length).toBeGreaterThan(20);
		const crossed = framework.flatMap((path) =>
			loads(repo, path)
				.filter(isOwned)
				.map((target) => `${path} -> ${target}`),
		);
		expect(crossed).toEqual([]);
	});

	test("the wrappers hand Shepherd policy to the compiler only through stamps", () => {
		const compiler = readFileSync(
			resolve(repo, "lib/agent-format/compiler.ts"),
			"utf8",
		);
		expect(compiler).not.toMatch(/shepherd-source|SHEPHERD_ID|gitStamp/);
		const wrapper = readFileSync(
			resolve(repo, "scripts/agent-compiler.ts"),
			"utf8",
		);
		expect(wrapper).toMatch(
			/stamps: \{\s*\[SHEPHERD_ID\]: legacyStampPolicy\(/,
		);
		// No other compiler option or global carries the v1 stamp.
		expect(wrapper.match(/legacyStampPolicy\(/g)?.length).toBe(2);
		for (const path of [
			"scripts/compile.ts",
			"scripts/compile-all.ts",
			"scripts/watch-agents.ts",
		]) {
			expect(loads(repo, path)).not.toContain("lib/agent-format/compiler.ts");
		}
	});
});

describe("the crossing scan on a miniature tree (O19)", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ownership-")));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const put = (path: string, text: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	put("owned/policy.ts", "export const p = 1;\n");
	put("owned/body.md", "body\n");
	put("owned/data.txt", "data\n");
	const sources: Record<string, string> = {
		"src/static.ts": 'import { p } from "../owned/policy";\nexport { p };\n',
		"src/text.ts":
			'import b from "../owned/body.md" with { type: "text" };\nexport { b };\n',
		"src/url.ts":
			'export const u = new URL("../owned/data.txt", import.meta.url);\n',
		"src/computed.ts":
			'const name = "../owned/policy";\nexport const m = () => import(name);\n',
		"src/plain.js": 'import { p } from "../owned/policy.ts";\nexport { p };\n',
		"src/clean.ts": 'import { z } from "zod";\nexport { z };\n',
	};
	for (const [path, text] of Object.entries(sources)) put(path, text);

	test("each crossing form is reported", () => {
		const found = crossings(
			root,
			Object.keys(sources),
			(path) => path.startsWith("owned/"),
			() => false,
		);
		expect(found).toEqual([
			"src/static.ts -> owned/policy.ts",
			"src/text.ts -> owned/body.md",
			"src/url.ts -> owned/data.txt",
			"src/computed.ts:2 -> opaque module",
			"src/plain.js -> owned/policy.ts",
		]);
	});
});
