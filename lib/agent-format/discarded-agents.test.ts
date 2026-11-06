import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { relativeClosure } from "../../scripts/import-closure";

const repo = resolve(import.meta.dir, "../..");

function frameworkTests(dir: string): string[] {
	return readdirSync(join(repo, dir), { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => join(dir, name))
		.sort();
}

// O22: framework tests (lib/agent-format and the compiler tests in scripts/)
// must load with discarded agent trees absent. A static scan of each test's
// import closure stands in for deleting `agents/`. Runtime reads of the real
// roster are outside a static scan (deferred to PR 2 and PR 3, C2).
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
			const closure = relativeClosure(repo, [file]);
			expect(closure.unresolved).toEqual([]);
			expect(
				closure.files.filter((path) => path.startsWith("agents/")),
			).toEqual([]);
		});
	}
});
