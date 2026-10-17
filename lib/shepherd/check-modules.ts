import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Finding } from "./check";
import { charterFindings } from "./check-charter";
import type { Config } from "./config";
import {
	type ModuleCandidate,
	type ModuleCatalog,
	moduleCatalog,
	resolveModules,
} from "./module-resolution";
import { executable } from "./package-resolution";
import { words } from "./text";
import type { Workspace, WorkspaceTree } from "./tree";

/**
 * What `MODULE.md` declares against what the package directory holds: each
 * declared tool a file with the executable bit, each declared guide a file,
 * each `requires` entry on PATH. Undeclared files in `tools/` are noted,
 * since dispatch never runs them; dotfiles and directories are not tools.
 * No tool is run (docs/PACKAGES.md).
 */
export function packageFileFindings(module: ModuleCandidate): Finding[] {
	const record = module.package;
	if (!record || module.body === undefined) return [];
	const findings: Finding[] = [];
	const add = (
		level: Finding["level"],
		code: string,
		file: string,
		message: string,
	) => findings.push({ level, code, file, message });
	for (const [tool, declaration] of Object.entries(record.tools)) {
		const file = join(record.dir, "tools", tool);
		if (!existsSync(file))
			add(
				"error",
				"package-tool-missing",
				file,
				`declared tool "${tool}" has no file`,
			);
		else if (!executable(file))
			add(
				"error",
				"package-tool-not-executable",
				file,
				`declared tool "${tool}" is not executable`,
			);
		for (const name of declaration.requires)
			if (!Bun.which(name))
				add(
					"warn",
					"package-requires-missing",
					module.source,
					`tool "${tool}" requires "${name}", which is not on PATH`,
				);
	}
	const toolsDir = join(record.dir, "tools");
	if (existsSync(toolsDir))
		for (const file of readdirSync(toolsDir).sort())
			if (
				!file.startsWith(".") &&
				statSync(join(toolsDir, file), { throwIfNoEntry: false })?.isFile() &&
				!Object.hasOwn(record.tools, file)
			)
				add(
					"info",
					"package-tool-undeclared",
					join(toolsDir, file),
					`tools/${file} is not declared in MODULE.md; it is never run`,
				);
	for (const guide of Object.keys(record.guides)) {
		const file = join(record.dir, "guides", `${guide}.md`);
		if (!existsSync(file))
			add(
				"error",
				"package-guide-missing",
				file,
				`declared guide "${guide}" has no file`,
			);
	}
	return findings;
}

export function moduleFindings(
	catalog: ModuleCatalog,
	state: string,
): Finding[] {
	const findings: Finding[] = [];
	// A package's files display as absolute paths: they live outside the state dir (D17).
	const packageSources = new Set(
		catalog.candidates.filter((m) => m.package).map((m) => m.source),
	);
	const fileOf = (source: string) =>
		source.startsWith("builtin/") ||
		source === "charter.md" ||
		packageSources.has(source)
			? source
			: relative(state, source);
	const inheritedPaths = new Set(
		catalog.candidates
			.filter((m) => m.layer === "inherited")
			.map((m) => m.path),
	);
	for (const module of catalog.candidates) {
		if (module.layer === "local" && inheritedPaths.has(module.path)) continue;
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
		findings.push(...packageFileFindings(module));
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
		const resolved = resolveModules(catalog, fileOf);
		selected = resolved.selected;
		// Candidate problems were reported above; resolution adds its own.
		for (const problem of resolved.problems)
			if (problem.file === "charter.md")
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
	findings.push(...charterFindings(catalog, workspace.state));
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
