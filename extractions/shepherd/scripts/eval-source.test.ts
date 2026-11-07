import { describe, expect, test } from "bun:test";
import { isGatedPath } from "../evals/shepherd/gated-paths";
import { ALWAYS_GATED } from "../evals/shepherd/verify";
import { GATED_MODULES, IDENTITY_MODULE } from "./eval-source";

// The eval seam is an evaluation input: v2's source membership does not
// select it, so the seam names it among the always gated modules.
describe("the package eval gate covers its build seam", () => {
	test("the identity module and the seam are gated under every policy", () => {
		expect([...GATED_MODULES].sort()).toEqual(
			[IDENTITY_MODULE, "scripts/eval-source.ts"].sort(),
		);
		for (const path of GATED_MODULES) {
			expect([path, isGatedPath(path)]).toEqual([path, true]);
			expect([path, ALWAYS_GATED.includes(path)]).toEqual([path, true]);
		}
	});
});
