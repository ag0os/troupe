import { join, relative, sep } from "node:path";
import type { Finding } from "./check";
import type { Config } from "./config";
import {
	type ModuleCatalog,
	moduleCatalog,
	resolveModules,
} from "./module-resolution";
import { words } from "./text";
import type { Workspace, WorkspaceTree } from "./tree";

export function moduleFindings(
	catalog: ModuleCatalog,
	state: string,
): Finding[] {
	const findings: Finding[] = [];
	const fileOf = (source: string) =>
		source.startsWith("builtin/") || source === "charter.md"
			? source
			: relative(state, source);
	for (const module of catalog.candidates) {
		const file = fileOf(module.source);
		for (const problem of module.problems)
			findings.push({ ...problem, level: "error", file });
		if (module.kind === "legacy")
			findings.push({
				level: "info",
				code: "module-frontmatter-missing",
				file,
				message:
					"legacy module: loaded unchanged; metadata and budget unavailable",
			});
		if (!module.metadata || module.body === undefined) continue;
		const { name, budget, description } = module.metadata;
		const count = words(module.body);
		if (count > budget)
			findings.push({
				level: "warn",
				code: "module-over-budget",
				file,
				message: `${name}: ${count} prompt words, exceeds budget ${budget} by ${count - budget}`,
			});
		else if (module.layer !== "builtin")
			findings.push({
				level: "info",
				code: "module-cost",
				file,
				message: `${name}: ${count} prompt words / ${budget} budget; ${description}`,
			});
	}
	let selected: ReturnType<typeof resolveModules>["selected"] = [];
	try {
		const resolved = resolveModules(catalog);
		selected = resolved.selected;
		for (const problem of resolved.problems)
			if (!["module-schema", "module-name"].includes(problem.code))
				findings.push({
					...problem,
					level: problem.code === "module-token-unknown" ? "warn" : "error",
					file: fileOf(problem.file),
				});
	} catch {
		// Built-in defects already have schema findings; prompt counting reports failure.
	}
	const inherited = catalog.candidates.filter((m) => m.layer === "inherited");
	for (const local of catalog.candidates.filter((m) => m.layer === "local")) {
		const parent = inherited.find((m) => m.name === local.name);
		if (!parent) continue;
		let message: string;
		if (local.path === parent.path)
			message = `local ${local.name} is the same file as the inherited module; it is skipped at launch`;
		else if (selected.includes(local) && selected.includes(parent))
			message =
				local.metadata &&
				parent.metadata &&
				!local.metadata.provides &&
				!parent.metadata.provides
					? `local ${local.name} has the same name as the inherited module; both load; an explicit selection of this name would be ambiguous`
					: `local ${local.name} has the same name as the inherited module; both load at launch`;
		else {
			const bodies = [
				selected.includes(parent) ? "inherited" : "",
				selected.includes(local) ? "local" : "",
			].filter(Boolean);
			message = `local ${local.name} has the same name as the inherited module; ${bodies.length ? `${bodies.join(" and ")} body loaded` : local.metadata?.provides || parent.metadata?.provides ? "no provider loaded" : "neither body loaded"}`;
		}
		findings.push({
			level: "info",
			code: "module-duplicate",
			file: fileOf(local.source),
			message,
		});
	}
	return findings;
}

export function checkModules(
	workspace: Workspace,
	tree: WorkspaceTree,
	config: Config,
): Finding[] {
	const catalog = moduleCatalog(workspace.dir, undefined, true);
	const findings = moduleFindings(catalog, workspace.state);
	const locals = catalog.candidates.filter((m) => m.layer === "local");
	const count = locals.reduce(
		(total, m) => total + (m.body === undefined ? 0 : words(m.body)),
		0,
	);
	const incomplete = locals
		.filter((m) => m.body === undefined)
		.map((m) => relative(workspace.state, m.source));
	const hasDescendant = tree.workspaces.some((w) => {
		const path = relative(workspace.dir, w.dir);
		return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
	});
	if (hasDescendant && count > config.marks.shared)
		findings.push({
			level: "warn",
			code: "shared-over-mark",
			file: relative(workspace.state, join(workspace.state, "integrations")),
			message: `${count} published prompt words, past the ${config.marks.shared}-word mark; actual loading depends on selection${incomplete.length ? `; subtotal incomplete: ${incomplete.join(", ")} cost unavailable` : ""}`,
		});
	return findings;
}
