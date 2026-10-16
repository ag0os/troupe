import { join } from "node:path";
import coreDoc from "../../system-prompts/shepherd/core.md" with {
	type: "text",
};
import { PROMPT_SEPARATOR } from "../agent-format/schema";
import {
	type Config,
	DEFAULT_HANDOFF_CEILINGS,
	handoffCeiling,
} from "./config";
import { dayOf } from "./dates";
import {
	moduleCatalog,
	moduleProblemDetails,
	resolveModules,
} from "./module-resolution";
import {
	type PackageLocation,
	type PackageRecord,
	packageLocations,
	selectedPackages,
} from "./package-resolution";
import { defaultSessionName } from "./session-name";
import { words } from "./text";
import { CHILD_DEPTH, findEnclosingWorkspace, STATE_DIR } from "./workspace";

export function modelHeaderLine(
	config: Pick<Config, "handoffCeilings">,
	backend: "claude" | "codex",
	model?: string,
	keepsConversation = false,
): string {
	model ||= undefined;
	const overrides = Object.entries(config.handoffCeilings)
		.filter(([key]) => !["claude", "codex", "default"].includes(key))
		.map(([key, value]) => `${key} ${value}%`)
		.join(", ");
	const label =
		model ??
		(keepsConversation
			? "saved conversation (unknown)"
			: "backend default (unknown)");
	return `- Model: ${label}; handoff ceiling: ${handoffCeiling(config, backend, model)}% of context window; delegates: Claude ${handoffCeiling(config, "claude")}%, Codex ${handoffCeiling(config, "codex")}%, other backends ${handoffCeiling(config, "other")}%${overrides ? `; model overrides: ${overrides}` : ""}`;
}

/** The header lines that tell a session what its packages offer (D14). */
export function packageHeaderLines(
	packages: readonly PackageRecord[],
): string[] {
	const tools = packages.flatMap((p) =>
		Object.entries(p.tools).map(
			([tool, { access }]) => `${p.name} ${tool} (${access})`,
		),
	);
	const guides = packages.flatMap((p) =>
		Object.entries(p.guides).map(
			([guide, { description }]) => `${p.name} ${guide} (${description})`,
		),
	);
	return [
		...(tools.length
			? [
					`- Package tools: ${tools.join(", ")}; run as shepherd tool <package> <tool> [args], --help for usage; read tools need no permission prompt on Claude`,
				]
			: []),
		...(guides.length
			? [
					`- Package guides: ${guides.join(", ")}; read with shepherd tool guide <package> <guide>`,
				]
			: []),
	];
}

export function composeFragments(
	cwd: string,
	backend: string,
	enclosing: string | undefined,
	headerLines: readonly string[] = [],
	now: Date = new Date(),
	onProblems?: (details: string) => void,
	locations?: readonly PackageLocation[],
): string[] {
	return composeSession(
		cwd,
		backend,
		enclosing,
		headerLines,
		now,
		onProblems,
		locations,
	).fragments;
}

/** The prompt fragments, plus the packages they select. */
export function composeSession(
	cwd: string,
	backend: string,
	enclosing: string | undefined,
	headerLines: readonly string[] = [],
	now: Date = new Date(),
	onProblems?: (details: string) => void,
	locations: readonly PackageLocation[] = packageLocations(enclosing),
): { fragments: string[]; packages: PackageRecord[] } {
	const catalog = moduleCatalog(cwd, enclosing, false, locations);
	const { selected, problems } = resolveModules(catalog);
	const { charter, children } = catalog;
	const inherited = selected.filter((m) => m.layer === "inherited");
	const locals = selected.filter((m) => m.layer === "local");
	const builtins = selected.filter((m) => m.layer === "builtin");
	const packages = selectedPackages(selected);
	const gated = selected
		.filter(
			(m) =>
				m.package ||
				(m.layer === "builtin" &&
					["nested.md", "root.md", "software.md"].includes(m.name)),
		)
		.map((m) => m.metadata?.name);
	const details = moduleProblemDetails(problems);
	if (details) onProblems?.(details);
	const header = [
		"# Shepherd session context",
		"",
		`- Launch directory: ${cwd}`,
		`- State directory: ${join(cwd, STATE_DIR)}`,
		`- Date: ${dayOf(now)}`,
		`- Backend: ${backend}`,
		...headerLines,
		enclosing
			? `- Enclosing workspace: ${enclosing} (inherited integrations: ${
					inherited
						.filter((m) => !m.package)
						.map((m) => m.name)
						.join(", ") || "none"
				})`
			: "- Enclosing workspace: none",
		`- Workspaces beneath: ${children.join(", ") || `none within ${CHILD_DEPTH} levels`}`,
		`- Gated modules loaded: ${gated.join(", ") || "none"}`,
		...packageHeaderLines(packages),
		charter
			? "- Charter: loaded"
			: "- Charter: none, this workspace is uninitiated",
		locals.length
			? `- Workspace-local integrations loaded: ${locals.map((l) => l.name).join(", ")}`
			: "- Workspace-local integrations loaded: none",
		...(details ? [`- Module problems: ${details}`] : []),
	].join("\n");

	return {
		fragments: [
			coreDoc,
			...builtins.map((m) => m.body ?? ""),
			...inherited.map((m) => m.body ?? ""),
			...locals.map((l) => l.body ?? ""),
			...(charter ? [charter] : []),
			header,
		],
		packages,
	};
}

/** Estimate the default Claude system prompt for a workspace. */
export function promptWords(dir: string, now: Date = new Date()): number {
	// Model flags and configured delegate overrides can change this default estimate.
	const config = { handoffCeilings: DEFAULT_HANDOFF_CEILINGS };
	const name = defaultSessionName(dir, now, undefined, false);
	return words(
		composeFragments(
			dir,
			"claude-cli",
			findEnclosingWorkspace(dir),
			[
				modelHeaderLine(config, "claude"),
				`- Session name: ${name} (set by the launcher: use it as it stands in CURRENT.md and in messages, do not rename yourself)`,
			],
			now,
		)
			.filter((fragment) => fragment.length > 0)
			.join(PROMPT_SEPARATOR),
	);
}
