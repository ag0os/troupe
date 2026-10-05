import { join } from "node:path";
import coreDoc from "../../system-prompts/shepherd/core.md" with {
	type: "text",
};
import herdrDoc from "../../system-prompts/shepherd/integrations/herdr.md" with {
	type: "text",
};
import interAgentDoc from "../../system-prompts/shepherd/integrations/inter-agent.md" with {
	type: "text",
};
import nestedDoc from "../../system-prompts/shepherd/integrations/nested.md" with {
	type: "text",
};
import rootDoc from "../../system-prompts/shepherd/integrations/root.md" with {
	type: "text",
};
import softwareDoc from "../../system-prompts/shepherd/integrations/software.md" with {
	type: "text",
};
import { PROMPT_SEPARATOR } from "../agent-format/schema";
import { dayOf } from "./dates";
import { words } from "./text";
import {
	CHILD_DEPTH,
	declaredModules,
	findChildWorkspaces,
	findEnclosingWorkspace,
	loadCharter,
	loadIntegrations,
	STATE_DIR,
} from "./workspace";

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

export function composeFragments(
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
	const gates = {
		// An ancestor that publishes no module shares no layer to live under.
		nested: inherited.length > 0,
		root: children.length > 0,
		software: declaredModules(charter).has("software"),
	};
	const gated = Object.entries(gates)
		.filter(([, on]) => on)
		.map(([name]) => name);
	const header = [
		"# Shepherd session context",
		"",
		`- Launch directory: ${cwd}`,
		`- State directory: ${join(cwd, STATE_DIR)}`,
		`- Date: ${dayOf(new Date())}`,
		`- Backend: ${backend}`,
		enclosing
			? `- Enclosing workspace: ${enclosing} (inherited integrations: ${inherited.map((m) => m.name).join(", ") || "none"})`
			: "- Enclosing workspace: none",
		`- Workspaces beneath: ${children.join(", ") || `none within ${CHILD_DEPTH} levels`}`,
		`- Gated modules loaded: ${gated.join(", ") || "none"}`,
		charter
			? "- Charter: loaded"
			: "- Charter: none, this workspace is uninitiated",
		locals.length
			? `- Workspace-local integrations loaded: ${locals.map((l) => l.name).join(", ")}`
			: "- Workspace-local integrations loaded: none",
	].join("\n");

	return [
		coreDoc,
		...builtInIntegrations(gates),
		...inherited.map((m) => m.body),
		...locals.map((l) => l.body),
		...(charter ? [charter] : []),
		header,
	];
}

/** The composed Claude system prompt's word count for a workspace. */
export function promptWords(dir: string): number {
	return words(
		composeFragments(dir, "claude-cli", findEnclosingWorkspace(dir))
			.filter((fragment) => fragment.length > 0)
			.join(PROMPT_SEPARATOR),
	);
}
