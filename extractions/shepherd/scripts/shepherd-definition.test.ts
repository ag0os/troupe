import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startWatcher } from "troupe/compiler";
import {
	PACKAGE_ROOT,
	SHEPHERD_ID,
	shepherdDefinition,
} from "./shepherd-definition";

// R15: the package's watcher covers the compile and identity inputs and
// never its outputs, dependencies or eval evidence. The watcher is
// injected, so nothing is watched or built.

const EXPECTED = [
	"agents",
	"lib/shepherd",
	"packages",
	"scripts",
	"system-prompts",
];

describe("the package watcher's roots (R15)", () => {
	test("the definition watches the compile and identity inputs only", () => {
		const definition = shepherdDefinition(PACKAGE_ROOT);
		expect([...(definition.watchRoots ?? [])].sort()).toEqual(EXPECTED);
		for (const root of definition.watchRoots ?? []) {
			for (const never of ["bin", "node_modules", "evals"]) {
				expect([root, root === never || root.startsWith(`${never}/`)]).toEqual([
					root,
					false,
				]);
			}
		}
	});

	test("an injected watcher sees a lib/shepherd change schedule the roster once", async () => {
		const listeners = new Map<string, (event: string, name: string) => void>();
		const rebuilt: string[][] = [];
		const definition = shepherdDefinition(PACKAGE_ROOT);
		const watcher = startWatcher({
			definition,
			debounceMs: 5,
			watch: (dir, _options, listener) => {
				listeners.set(dir, listener);
				return { close() {} };
			},
			rebuild: async () => {
				rebuilt.push([...definition.roster]);
			},
		});
		try {
			expect([...listeners.keys()].sort()).toEqual(
				EXPECTED.map((root) => join(PACKAGE_ROOT, root)).sort(),
			);
			const lib = listeners.get(join(PACKAGE_ROOT, "lib/shepherd"));
			if (lib === undefined) throw new Error("lib/shepherd is not watched");
			lib("change", "text.ts");
			lib("change", "compose.ts");
			await Bun.sleep(50);
			await watcher.queue.idle();
			expect(rebuilt).toEqual([[SHEPHERD_ID]]);
		} finally {
			watcher.close();
		}
	});
});
