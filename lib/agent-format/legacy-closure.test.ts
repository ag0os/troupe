import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
	generateEntry,
	loadAgentDefinition,
} from "../../scripts/agent-compiler";
import { importClosure } from "../../scripts/import-closure";
import { isSourcePath } from "../../scripts/shepherd-source";

// O31: the compiler and the entry it generates for Shepherd must import only
// files inside legacy source membership, or a move or a new helper silently
// leaves Shepherd's source identity (and the eval path policy built on it).
// This is a guard: it passes on the baseline and catches a bad move.

const repo = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "legacy-closure-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The builder entry points the legacy membership names. */
export const COMPILER_ENTRIES = [
	"scripts/compile.ts",
	"scripts/compile-all.ts",
	"scripts/agent-compiler.ts",
	"scripts/binary-name.ts",
] as const;

/** Repo-relative closure members outside legacy membership. */
function escapes(
	root: string,
	entries: readonly string[],
	generated: readonly string[] = [],
) {
	const closure = importClosure(entries);
	return {
		unresolved: closure.unresolved,
		outside: closure.files
			.filter((file) => !generated.includes(file))
			.map((file) => relative(root, file))
			.filter((path) => !isSourcePath(path))
			.sort(),
	};
}

describe("legacy import membership (O31)", () => {
	test("the compiler's closure stays inside legacy membership", () => {
		const result = escapes(
			repo,
			COMPILER_ENTRIES.map((entry) => join(repo, entry)),
		);
		expect(result).toEqual({ unresolved: [], outside: [] });
	});

	test("Shepherd's generated entry imports only legacy members", async () => {
		const agent = await loadAgentDefinition(repo, "agents/shepherd.md");
		const entry = join(scratch, "shepherd-entry.ts");
		writeFileSync(entry, generateEntry(agent));
		const closure = importClosure([entry]);
		expect(closure.files).toContain(join(repo, "lib/agent-format/run.ts"));
		expect(closure.files).toContain(join(repo, "agents/shepherd.ts"));
		expect(escapes(repo, [entry], [entry])).toEqual({
			unresolved: [],
			outside: [],
		});
	});

	test("a compiler helper outside membership is reported", () => {
		const root = join(scratch, "bad-move");
		const put = (path: string, text: string) => {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		};
		put(
			"scripts/agent-compiler.ts",
			'export * from "../lib/build/compiler";\n',
		);
		put(
			"lib/build/compiler.ts",
			'import { name } from "../agent-format/binary-name";\nexport { name };\n',
		);
		put("lib/agent-format/binary-name.ts", 'export const name = "x";\n');
		expect(escapes(root, [join(root, "scripts/agent-compiler.ts")])).toEqual({
			unresolved: [],
			outside: ["lib/build/compiler.ts"],
		});
	});
});
