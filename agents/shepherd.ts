/**
 * SHEPHERD: personal day-to-day assistant and agent coordinator.
 *
 * Runs in any directory and keeps its own state there (.shepherd/): memories,
 * an append-only journal, and living docs that make it better at that
 * workspace over time.
 *
 * The session prompt is composed from layers:
 *   1. core.md                — identity, workspace protocol, init, self-evolution
 *   2. integrations/*.md      — built-in modules. Herdr and inter-agent messaging
 *                               always load and check their own availability. The
 *                               launcher adds the rest only when they apply: nested
 *                               under an enclosing workspace that publishes modules,
 *                               root above child workspaces, software when the
 *                               charter declares it
 *   3. inherited modules      — the integrations/*.md of the nearest enclosing
 *                               workspace (a parent directory with its own
 *                               .shepherd/), shared by every workspace beneath it
 *   4. .shepherd/integrations/*.md — workspace-local modules appended at launch,
 *                               so a directory can extend Shepherd without a recompile
 *   5. .shepherd/charter.md   — the workspace's agreed mission and way of working,
 *                               written during the init conversation. It comes last
 *                               because it wins over every module on how the
 *                               workspace works
 *
 * The declaration is `shepherd.md`; this extension's `prepare` does the
 * composition at launch (D-016). The built-in layers are text imports rather
 * than declared includes so the prompt stays byte-identical to the legacy
 * launcher's: includes are trimmed before joining, these are not. The launch
 * directory is the framework's working directory, so `--cwd`, `--show-prompt`,
 * `--print`, `--model` and `--backend` are framework flags, and backend flags
 * such as `--resume` follow `--` (D-028). Capability modules degrade
 * gracefully on harnesses that lack a feature.
 *
 * Usage:
 *   shepherd                          # interactive session here
 *   shepherd "triage my morning"      # with an initial message
 *   shepherd --cwd ~/work             # run against another root
 *   shepherd --backend codex          # different harness
 *   shepherd --print "status report"  # one-shot, non-interactive
 *   shepherd --show-prompt            # print composed prompt, don't spawn
 *   shepherd -- --resume <id>         # backend flags follow `--`
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { PrepareContext, PrepareResult } from "../lib/agent-format/types";
import { composeFragments } from "../lib/shepherd/compose";
import { findEnclosingWorkspace, STATE_DIR } from "../lib/shepherd/workspace";

/**
 * The header's backend names, as the legacy launcher printed them, so an
 * existing workspace's prompt does not change with the migration.
 */
const BACKEND_LABELS = { claude: "claude-cli", codex: "codex-cli" } as const;

/**
 * An enclosing workspace's state dir is added as a readable directory, since
 * its modules point at files there. Claude Code checks permissions against
 * resolved paths, so this can't ride on the relative `.shepherd/**` rules in
 * the declaration, and the path is the enclosing workspace's realpath. The
 * rule's leading `/` before an absolute path is Claude's syntax for one: it
 * renders as `Read(//abs/...)`. Claude rules only: Codex does not emulate
 * them, so none are returned there.
 */
function enclosingAccess(enclosing: string): {
	rules: string[];
	additionalDirectories: string[];
} {
	const shared = join(realpathSync(enclosing), STATE_DIR);
	return { rules: [`Read(/${shared}/**)`], additionalDirectories: [shared] };
}

export function prepare(ctx: PrepareContext): PrepareResult {
	const prompt = ctx.args.join(" ").trim();

	// Preview only prints what would launch, so it keeps the legacy
	// `--show-prompt --print` behavior of showing the prompt.
	if (ctx.mode === "print" && !prompt && !ctx.preview) {
		return {
			exit: {
				message: 'Print mode requires a prompt: shepherd --print "..."\n',
				code: 1,
				stream: "stderr",
			},
		};
	}

	const enclosing = findEnclosingWorkspace(ctx.cwd);
	const systemPromptFragments = composeFragments(
		ctx.cwd,
		BACKEND_LABELS[ctx.backend],
		enclosing,
	);

	if (ctx.backend !== "claude" || !enclosing) {
		return { systemPromptFragments, initialPrompt: prompt };
	}
	return {
		systemPromptFragments,
		initialPrompt: prompt,
		extraAllowRules: enclosingAccess(enclosing),
	};
}
