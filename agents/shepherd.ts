/**
 * SHEPHERD: personal day-to-day assistant and agent coordinator.
 *
 * Runs in any directory and keeps its own state there (.shepherd/): memories,
 * an append-only journal, and living docs that make it better at that
 * workspace over time.
 *
 * The session prompt is composed from layers:
 *   1. core.md                — identity, workspace protocol, init, self-evolution
 *   2. integrations/*.md      — built-in capability modules (Herdr, inter-agent
 *                               messaging), each self-gated by an availability check
 *   3. inherited modules      — the integrations/*.md of the nearest enclosing
 *                               workspace (a parent directory with its own
 *                               .shepherd/), shared by every workspace beneath it
 *   4. .shepherd/charter.md   — the workspace's agreed mission and way of working,
 *                               written during the init conversation
 *   5. .shepherd/integrations/*.md — workspace-local modules appended at launch,
 *                               so a directory can extend Shepherd without a recompile
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

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PrepareContext, PrepareResult } from "../lib/agent-format/types";
import coreDoc from "../system-prompts/shepherd/core.md" with { type: "text" };
import herdrDoc from "../system-prompts/shepherd/integrations/herdr.md" with {
	type: "text",
};
import interAgentDoc from "../system-prompts/shepherd/integrations/inter-agent.md" with {
	type: "text",
};

const STATE_DIR = ".shepherd";

function builtInIntegrations(): string[] {
	return [herdrDoc, interAgentDoc];
}

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

type Module = { name: string; body: string; path: string };

/**
 * Capability modules in a workspace's integrations dir: workspace-local ones
 * for the launch directory, inherited ones for an enclosing workspace.
 */
function loadIntegrations(root: string): Module[] {
	const dir = join(root, STATE_DIR, "integrations");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => ({
			name: file,
			body: readFileSync(join(dir, file), "utf8"),
			path: realpathSync(join(dir, file)),
		}));
}

/**
 * The nearest parent directory that is itself a Shepherd workspace. Its
 * modules apply to every workspace beneath it, which is how a group of
 * workspaces shares one layer of conventions without copying it.
 */
function findEnclosingWorkspace(cwd: string): string | undefined {
	for (let dir = dirname(cwd); dir !== dirname(dir); dir = dirname(dir)) {
		if (existsSync(join(dir, STATE_DIR))) return dir;
	}
	return undefined;
}

/**
 * The workspace charter is the agreed mission and way of working, written
 * during the init conversation. Absence means the workspace is uninitiated
 * and core.md tells Shepherd to run init before substantial work.
 */
function loadCharter(cwd: string): string | undefined {
	const path = join(cwd, STATE_DIR, "charter.md");
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function composeFragments(
	cwd: string,
	backend: string,
	enclosing: string | undefined,
): string[] {
	const charter = loadCharter(cwd);
	const inherited = enclosing ? loadIntegrations(enclosing) : [];
	// A local module that is the same file as an inherited one (a leftover
	// symlink, say) would load twice.
	const inheritedPaths = new Set(inherited.map((m) => m.path));
	const locals = loadIntegrations(cwd).filter(
		(m) => !inheritedPaths.has(m.path),
	);
	const header = [
		"# Shepherd session context",
		"",
		`- Launch directory: ${cwd}`,
		`- State directory: ${join(cwd, STATE_DIR)}`,
		`- Date: ${new Date().toISOString().slice(0, 10)}`,
		`- Backend: ${backend}`,
		enclosing
			? `- Enclosing workspace: ${enclosing} (inherited integrations: ${inherited.map((m) => m.name).join(", ") || "none"})`
			: "- Enclosing workspace: none",
		charter
			? "- Charter: loaded"
			: "- Charter: none, this workspace is uninitiated",
		locals.length
			? `- Workspace-local integrations loaded: ${locals.map((l) => l.name).join(", ")}`
			: "- Workspace-local integrations loaded: none",
	].join("\n");

	return [
		coreDoc,
		...builtInIntegrations(),
		...inherited.map((m) => m.body),
		...(charter ? [charter] : []),
		...locals.map((l) => l.body),
		header,
	];
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
