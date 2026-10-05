/**
 * SHEPHERD: personal day-to-day assistant and agent coordinator.
 *
 * Runs in any directory and keeps its own state there (.shepherd/): memories,
 * an append-only journal, and living docs that make it better at that
 * workspace over time.
 *
 * The session prompt is composed from layers:
 *   1. core.md                - identity, workspace protocol, init, self-evolution
 *   2. integrations/*.md      - built-in modules. Herdr and inter-agent messaging
 *                               always load and check their own availability. The
 *                               launcher adds the rest only when they apply: nested
 *                               under an enclosing workspace that publishes modules,
 *                               root above child workspaces, software when the
 *                               charter declares it
 *   3. inherited modules      - the integrations/*.md of the nearest enclosing
 *                               workspace (a parent directory with its own
 *                               .shepherd/), shared by every workspace beneath it
 *   4. .shepherd/integrations/*.md - workspace-local modules appended at launch,
 *                               so a directory can extend Shepherd without a recompile
 *   5. .shepherd/charter.md   - the workspace's agreed mission and way of working,
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

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PrepareContext, PrepareResult } from "../lib/agent-format/types";
import { composeFragments } from "../lib/shepherd/compose";
import { loadConfig } from "../lib/shepherd/config";
import { sessionNameFor } from "../lib/shepherd/session-name";
import {
	claudeSessions,
	codexThreadNames,
	type ToolEnv,
} from "../lib/shepherd/sessions";
import {
	findChildWorkspaces,
	findEnclosingWorkspace,
	STATE_DIR,
} from "../lib/shepherd/workspace";

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

function workspaceChain(cwd: string): string[] {
	const chain: string[] = [];
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (existsSync(join(dir, STATE_DIR))) chain.push(dir);
		if (dir === dirname(dir)) break;
	}
	return chain.reverse();
}

function processToolEnv(ctx: PrepareContext): ToolEnv {
	return {
		cwd: ctx.cwd,
		home: homedir(),
		env: process.env,
		now: new Date(),
		runCommand: ctx.runCommand,
		pidAlive: (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		},
	};
}

export function prepare(
	ctx: PrepareContext,
	toolEnv: ToolEnv = processToolEnv(ctx),
): PrepareResult {
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
	const config = loadConfig({
		home: toolEnv.home,
		env: toolEnv.env,
		workspaceChain: workspaceChain(ctx.cwd),
	});
	const claude = ctx.backend === "claude" ? claudeSessions(toolEnv) : undefined;
	const takenNames =
		claude?.available === true
			? new Set(claude.sessions.map(({ name }) => name))
			: ctx.backend === "codex"
				? new Set(codexThreadNames(toolEnv, config).values())
				: new Set<string>();
	const naming = sessionNameFor({
		backend: ctx.backend,
		passthrough: ctx.passthrough ?? [],
		mode: ctx.mode,
		cwd: ctx.cwd,
		requestedName:
			typeof ctx.flags.name === "string" ? ctx.flags.name : undefined,
		sessionPrefix: config.sessionPrefix,
		now: toolEnv.now,
		hasChildren: findChildWorkspaces(ctx.cwd).length > 0,
		takenNames,
	});
	if (naming.error) {
		return {
			exit: { message: `${naming.error}\n`, code: 2, stream: "stderr" },
		};
	}
	const systemPromptFragments = composeFragments(
		ctx.cwd,
		BACKEND_LABELS[ctx.backend],
		enclosing,
		naming.headerLines,
	);

	if (ctx.backend !== "claude" || !enclosing) {
		return {
			systemPromptFragments,
			initialPrompt: prompt,
			...(naming.sessionName ? { sessionName: naming.sessionName } : {}),
		};
	}
	return {
		systemPromptFragments,
		initialPrompt: prompt,
		...(naming.sessionName ? { sessionName: naming.sessionName } : {}),
		extraAllowRules: enclosingAccess(enclosing),
	};
}
