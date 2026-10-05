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

import {
	type Dirent,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { PrepareContext, PrepareResult } from "../lib/agent-format/types";
import coreDoc from "../system-prompts/shepherd/core.md" with { type: "text" };
import herdrDoc from "../system-prompts/shepherd/integrations/herdr.md" with {
	type: "text",
};
import interAgentDoc from "../system-prompts/shepherd/integrations/inter-agent.md" with {
	type: "text",
};
import nestedDoc from "../system-prompts/shepherd/integrations/nested.md" with {
	type: "text",
};
import rootDoc from "../system-prompts/shepherd/integrations/root.md" with {
	type: "text",
};
import softwareDoc from "../system-prompts/shepherd/integrations/software.md" with {
	type: "text",
};

const STATE_DIR = ".shepherd";

/**
 * Child workspaces are looked for this many levels below the launch
 * directory. The walk runs on every launch, and a launch in a home directory
 * or a large repository must stay fast.
 */
const CHILD_DEPTH = 3;

/**
 * Herdr and inter-agent messaging check their own availability at run time.
 * The others depend on facts the launcher already has, so it leaves out the
 * ones that cannot apply instead of spending prompt on a module that would
 * only say to skip it.
 */
function builtInIntegrations(applies: {
	nested: boolean;
	root: boolean;
	software: boolean;
}): string[] {
	return [
		herdrDoc,
		interAgentDoc,
		...(applies.nested ? [nestedDoc] : []),
		...(applies.root ? [rootDoc] : []),
		...(applies.software ? [softwareDoc] : []),
	];
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

/**
 * The optional built-in modules a charter asks for on a line of its own,
 * `Modules: software`. Declared, not inferred: nothing on disk says what a
 * workspace's work is.
 */
function declaredModules(charter: string | undefined): Set<string> {
	const line = charter?.match(/^[ \t]*(?:[-*][ \t]+)?\**Modules:\**(.*)$/im);
	return new Set(line?.[1]?.toLowerCase().match(/[a-z][a-z-]*/g) ?? []);
}

/**
 * Workspaces beneath the launch directory, as paths relative to it. A
 * directory with its own .shepherd/ is one, and the walk does not look
 * inside it: what sits below belongs to that workspace. Hidden directories,
 * node_modules and symlinks are not entered.
 */
function findChildWorkspaces(cwd: string): string[] {
	const found: string[] = [];
	const walk = (dir: string, prefix: string, depth: number) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const path = join(dir, entry.name);
			const name = `${prefix}${entry.name}`;
			if (existsSync(join(path, STATE_DIR))) found.push(name);
			else if (depth < CHILD_DEPTH) walk(path, `${name}/`, depth + 1);
		}
	};
	walk(cwd, "", 1);
	return found.sort();
}

/** The date where the user is; `toISOString` would give the UTC day. */
function localDate(now: Date): string {
	const pad = (part: number) => String(part).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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
	const children = findChildWorkspaces(cwd);
	const header = [
		"# Shepherd session context",
		"",
		`- Launch directory: ${cwd}`,
		`- State directory: ${join(cwd, STATE_DIR)}`,
		`- Date: ${localDate(new Date())}`,
		`- Backend: ${backend}`,
		enclosing
			? `- Enclosing workspace: ${enclosing} (inherited integrations: ${inherited.map((m) => m.name).join(", ") || "none"})`
			: "- Enclosing workspace: none",
		`- Workspaces beneath: ${children.join(", ") || "none"}`,
		charter
			? "- Charter: loaded"
			: "- Charter: none, this workspace is uninitiated",
		locals.length
			? `- Workspace-local integrations loaded: ${locals.map((l) => l.name).join(", ")}`
			: "- Workspace-local integrations loaded: none",
	].join("\n");

	return [
		coreDoc,
		...builtInIntegrations({
			// An ancestor that publishes no module shares no layer to live under.
			nested: inherited.length > 0,
			root: children.length > 0,
			software: declaredModules(charter).has("software"),
		}),
		...inherited.map((m) => m.body),
		...locals.map((l) => l.body),
		...(charter ? [charter] : []),
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
