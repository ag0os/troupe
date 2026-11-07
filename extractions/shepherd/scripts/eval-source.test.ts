import { describe, expect, test } from "bun:test";
import { isGatedPath } from "../evals/shepherd/gated-paths";
import { EVALUATION_MODULES } from "../evals/shepherd/identity";
import { ALWAYS_GATED } from "../evals/shepherd/verify";
import { GATED_MODULES, IDENTITY_MODULE, isSourcePath } from "./eval-source";
import { PACKAGE_ROOT } from "./shepherd-definition";
import { EVAL_SEAM, evaluationInputs } from "./shepherd-source-v2";

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

	test("the evaluation identity hashes the seam, as v2's evaluation inputs select it", () => {
		expect(isSourcePath(EVAL_SEAM)).toBe(false);
		expect(EVALUATION_MODULES).toEqual([EVAL_SEAM]);
		expect(evaluationInputs(PACKAGE_ROOT).files).toEqual([
			...EVALUATION_MODULES,
		]);
	});
});
