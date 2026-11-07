import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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
	WRAPPERS,
} from "./ownership";

// O19: the section 8 inventory, enforced over this repository's tracked
// files. It reads the checkout only.

const repo = resolve(import.meta.dir, "..");

function tracked(...pathspecs: string[]): string[] {
	const result = spawnSync("git", ["ls-files", "-z", "--", ...pathspecs], {
		cwd: repo,
		encoding: "utf8",
	});
	expect(result.status).toBe(0);
	return result.stdout.split("\0").filter((path) => path !== "");
}

/** Repository-relative files a module loads by relative path or file URL. */
function loads(path: string): string[] {
	const full = resolve(repo, path);
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
	return [...targets, ...edges.urls].map((target) => relative(repo, target));
}

const code = tracked("*.ts").filter((path) => existsSync(resolve(repo, path)));

describe("the ownership inventory (O19)", () => {
	test("every exact path exists and every owned tree is present", () => {
		for (const path of [
			...WRAPPERS,
			...POLICIES,
			...AGENT_FILES,
			...AGENT_FIXTURES,
			...DOCUMENTS,
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

	test("no file outside the inventory imports into it, except classified compatibility tests", () => {
		const crossings = code
			.filter((path) => !mayImportOwned(path))
			.flatMap((path) =>
				loads(path)
					.filter(isOwned)
					.map((target) => `${path} -> ${target}`),
			);
		expect(crossings).toEqual([]);
	});

	test("every classified compatibility test is a test that reaches the inventory", () => {
		for (const path of Object.keys(COMPATIBILITY_TESTS)) {
			expect(path).toEndWith(".test.ts");
			expect(isOwned(path)).toBe(false);
			expect(loads(path).some(isOwned)).toBe(true);
		}
	});

	test("generic distributable code reaches no Shepherd location", () => {
		const entries = [
			"lib/index.ts",
			...tracked("lib/entries").filter((path) => path.endsWith(".ts")),
		].map((path) => resolve(repo, path));
		const closure = importClosure(entries);
		const reached = closure.files.map((file) => relative(repo, file));
		expect(reached.filter(isOwned)).toEqual([]);
		expect(reached.filter((path) => /shepherd/i.test(path))).toEqual([]);
		expect(reached.filter((path) => path.startsWith("scripts/"))).toEqual([]);
	});

	test("framework library files and tests use generic APIs only", () => {
		const framework = code.filter(
			(path) =>
				(path.startsWith("lib/agent-format/") ||
					path.startsWith("lib/entries/")) &&
				!Object.hasOwn(COMPATIBILITY_TESTS, path),
		);
		expect(framework.length).toBeGreaterThan(20);
		const crossings = framework.flatMap((path) =>
			loads(path)
				.filter(isOwned)
				.map((target) => `${path} -> ${target}`),
		);
		expect(crossings).toEqual([]);
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
			expect(loads(path)).not.toContain("lib/agent-format/compiler.ts");
		}
	});
});
