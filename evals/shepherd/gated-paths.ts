/**
 * Which changed paths require a passing Shepherd eval result (spec 7.3).
 * This is the one place the gate's path policy is stored; CI and the tests
 * read it from here. Section 11.1 leaves the choice open: the expanded
 * recommendation is adopted, and the narrower candidate agreed first is
 * kept beside it as the documented alternative.
 */

import { isSourcePath } from "../../scripts/shepherd-source";
import { isEvaluationPath } from "./identity";

export type GatedPathPolicy = "expanded" | "narrower";

/** The policy CI enforces. */
export const ADOPTED_GATED_PATHS: GatedPathPolicy = "expanded";

/**
 * The agreed narrower candidate. It leaves the declaration, the shared
 * runner (`lib/agent-format/`), the compiler, `package.json` and the rubric,
 * policy and checkers ungated, so changes there could evade evaluation.
 */
export const NARROWER_GATED_PATHS = {
	files: ["agents/shepherd.ts"],
	trees: ["system-prompts/shepherd", "lib/shepherd"],
} as const;

/**
 * Whether a change to `path` requires evaluation. Expanded: every section
 * 1 source path (exactly the source manifest's membership) plus the
 * evaluation implementation and policy of section 6.2 (exactly the
 * evaluation identity's membership), so results, evidence and validation
 * output stay outside and result-only commits need no evaluation.
 */
export function isGatedPath(
	path: string,
	policy: GatedPathPolicy = ADOPTED_GATED_PATHS,
): boolean {
	if (policy === "expanded") {
		return isSourcePath(path) || isEvaluationPath(path);
	}
	return (
		(NARROWER_GATED_PATHS.files as readonly string[]).includes(path) ||
		NARROWER_GATED_PATHS.trees.some((dir) => path.startsWith(`${dir}/`))
	);
}
