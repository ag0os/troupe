/**
 * COMMENT-REVIEW: Review and fix newly added comments in the current branch
 *
 * Analyzes git diff to find new comments, evaluates them for quality,
 * and removes or improves comments that don't add lasting value.
 */

import type {
	CommandRequest,
	PrepareContext,
	PrepareResult,
} from "../../lib/agent-format/types";

/**
 * A `git` request through the runner. Under `--show-prompt` it must stay
 * local and leave nothing running (D-012), so a partial clone may not fetch
 * missing blobs and an fsmonitor daemon may not start; `runCommand` merges
 * this `env` over the inherited environment.
 */
function gitRequest(ctx: PrepareContext, args: string[]): CommandRequest {
	if (!ctx.preview) return { argv: ["git", ...args] };
	return {
		argv: ["git", "-c", "core.fsmonitor=false", ...args],
		env: { GIT_NO_LAZY_FETCH: "1" },
	};
}

/** `git` through the runner; a failure stops preparation with its stderr. */
async function git(ctx: PrepareContext, args: string[]): Promise<string> {
	const result = await ctx.runCommand(gitRequest(ctx, args));
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`,
		);
	}
	return result.stdout;
}

async function verifies(ctx: PrepareContext, ref: string): Promise<boolean> {
	const result = await ctx.runCommand(
		gitRequest(ctx, ["rev-parse", "--verify", ref]),
	);
	return result.exitCode === 0;
}

async function getBaseBranch(ctx: PrepareContext): Promise<string | null> {
	for (const branch of ["main", "master"]) {
		if (await verifies(ctx, branch)) return branch;
		if (await verifies(ctx, `origin/${branch}`)) return `origin/${branch}`;
	}
	return null;
}

export function buildCommentReviewPrompt(diff: string): string {
	return `Review the following git diff for newly added comments. Focus only on lines starting with "+" that contain comment syntax (// or /* or # depending on language).

<diff>
${diff}
</diff>

Analyze these new comments. For any comments that should be removed or improved, edit the files directly to fix them.`;
}

/**
 * Embeds the committed and staged diff against main/master in the initial
 * prompt. The git commands are local and read-only, so they run under
 * `--show-prompt` too, hardened by `gitRequest`.
 */
export async function prepare(ctx: PrepareContext): Promise<PrepareResult> {
	const baseBranch = await getBaseBranch(ctx);
	if (!baseBranch) {
		return {
			exit: {
				message: "Could not find main or master branch\n",
				code: 1,
				stream: "stderr",
			},
		};
	}

	const committed = await git(ctx, ["diff", `${baseBranch}...HEAD`]);
	const staged = await git(ctx, ["diff", "--cached"]);
	const diff = `${committed}\n${staged}`;

	if (!diff.trim()) {
		return {
			exit: {
				message: "No changes found to review.\n",
				code: 0,
				stream: "stdout",
			},
		};
	}

	return { initialPrompt: buildCommentReviewPrompt(diff) };
}
