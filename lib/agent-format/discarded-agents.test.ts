import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { relativeClosure } from "../../scripts/import-closure";

const repo = resolve(import.meta.dir, "../..");

function frameworkTests(dir: string): string[] {
	return readdirSync(join(repo, dir), { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => join(dir, name))
		.sort();
}

/**
 * What keeps a test from loading with agent trees absent: a reached
 * `agents/` file, an unresolved local reference, or a module or URL the
 * walker cannot follow (it could load anything). `import.meta.dir` and
 * `import.meta.dirname` reads are classified as runtime fixture paths and
 * exempt: they locate files, they load no module. Runtime roster readers are
 * out of a static scan's reach (deferred to PR 2 and PR 3, C2).
 */
export function agentReach(root: string, file: string) {
	const closure = relativeClosure(root, [file]);
	return {
		agents: closure.files.filter((path) => path.startsWith("agents/")),
		unresolved: closure.unresolved,
		opaque: closure.opaqueRefs
			.filter((ref) => ref.kind !== "directory")
			.map((ref) => `${ref.kind}: ${ref.what}`),
	};
}

const clean = { agents: [], unresolved: [], opaque: [] };

// O22: framework tests (lib/agent-format and the compiler tests in scripts/)
// must load with discarded agent trees absent. A static scan of each test's
// import closure stands in for deleting `agents/`.
describe("framework tests reach no agent tree (O22)", () => {
	const tests = [
		...frameworkTests("lib/agent-format"),
		...readdirSync(join(repo, "scripts"))
			.filter((name) => name.endsWith(".test.ts"))
			.map((name) => `scripts/${name}`)
			.sort(),
	];

	test("the scan sees the framework and compiler tests", () => {
		expect(tests).toContain("lib/agent-format/execute.test.ts");
		expect(tests).toContain("scripts/agent-compiler.test.ts");
	});

	for (const file of tests) {
		test(file, () => {
			expect(agentReach(repo, file)).toEqual(clean);
		});
	}
});

describe("the O22 scan's own failures", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "o22-")));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const put = (path: string, text: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	put("agents/tools/webfetch.ts", "export const x = 1;\n");

	test("a computed agent import fails", () => {
		put(
			"lib/agent-format/computed.test.ts",
			'const modulePath = "../../agents/tools/webfetch.ts";\nawait import(modulePath);\n',
		);
		expect(agentReach(root, "lib/agent-format/computed.test.ts")).toEqual({
			...clean,
			opaque: ["module: computed import()"],
		});
	});

	test("a computed require and a computed URL fail", () => {
		put(
			"lib/agent-format/required.test.ts",
			'const p = "../../agents/tools/webfetch.ts";\nrequire(p);\nnew URL(p, import.meta.url);\n',
		);
		expect(agentReach(root, "lib/agent-format/required.test.ts")).toEqual({
			...clean,
			opaque: [
				"module: computed require()",
				"url: non-literal URL with import.meta.url",
			],
		});
	});

	test("a literal agent import fails and a fixture directory read does not", () => {
		put(
			"lib/agent-format/literal.test.ts",
			'import "../../agents/tools/webfetch";\nexport const here = import.meta.dir;\n',
		);
		expect(agentReach(root, "lib/agent-format/literal.test.ts")).toEqual({
			...clean,
			agents: ["agents/tools/webfetch.ts"],
		});
	});
});
