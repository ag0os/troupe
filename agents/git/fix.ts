/**
 * FIX: Read PR review comments and fix the issues
 *
 * Fetches review comments from the current branch's PR and fixes any issues found.
 * Designed to run after review:pr.
 *
 * Usage:
 *   git:fix                                # Auto-detect PR for current branch
 *   git:fix 123                            # Fix issues from PR #123
 */

import type {
	PrepareContext,
	PrepareResult,
} from "../../lib/agent-format/types";

/** Stands in for the detected PR under `--show-prompt`, which never calls `gh` (D-012). */
export const PREVIEW_PR = "<detected:pr>";

const USAGE = `No PR found for current branch.
Usage: git:fix [PR_NUMBER]
Examples:
  git:fix           # Auto-detect PR for current branch
  git:fix 123
`;

/**
 * Get the PR number for the current branch using gh CLI
 */
async function getCurrentBranchPR(ctx: PrepareContext): Promise<string | null> {
	const result = await ctx.runCommand({
		argv: ["gh", "pr", "view", "--json", "number", "-q", ".number"],
	});
	if (result.exitCode !== 0) {
		return null;
	}
	return result.stdout.trim() || null;
}

export function buildFixPrompt(prRef: string): string {
	return `Fix issues from PR review comments on pull request #${prRef}.

## Instructions

1. First, fetch the review comments from the PR using:
   \`gh api repos/{owner}/{repo}/pulls/${prRef}/comments\`

   Also check for general PR comments:
   \`gh pr view ${prRef} --comments\`

2. If there are no review comments or issues to fix, output "No issues to fix" and stop.

3. For each issue found in the comments:
   - Read the relevant file
   - Understand the issue described
   - Apply the fix
   - If a suggestion block is provided, apply it exactly

4. After fixing all issues, summarize what was fixed.

Do NOT commit the changes - leave them staged for review.`;
}

export async function prepare(ctx: PrepareContext): Promise<PrepareResult> {
	const supplied = ctx.args[0];
	if (supplied) return { initialPrompt: buildFixPrompt(supplied) };
	if (ctx.preview) return { initialPrompt: buildFixPrompt(PREVIEW_PR) };

	// Auto-detect PR for current branch if no argument provided
	const detectedPR = await getCurrentBranchPR(ctx);
	if (!detectedPR) {
		return { exit: { message: USAGE, code: 1, stream: "stderr" } };
	}
	return {
		initialPrompt: buildFixPrompt(detectedPR),
		// Print mode keeps stdout for the payload, so the notice is dropped there.
		...(ctx.mode === "print"
			? {}
			: {
					beforeRunMessages: [`Detected PR #${detectedPR} for current branch`],
				}),
	};
}
