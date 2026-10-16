import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
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
import {
	type ModuleProblem,
	type ParsedModule,
	parseModule,
} from "./module-format";
import {
	type PackageLocation,
	type PackageRecord,
	packageLocations,
	packageModules,
} from "./package-resolution";
import {
	declaredModules,
	findChildWorkspaces,
	findEnclosingWorkspace,
	loadCharter,
	STATE_DIR,
} from "./workspace";

export type ModuleCandidate = ParsedModule & {
	name: string;
	source: string;
	path: string;
	layer: "builtin" | "inherited" | "local";
	raw: string;
	/** Present for a package's MODULE.md (docs/PACKAGES.md). */
	package?: PackageRecord;
};
export type ResolutionProblem = ModuleProblem & { file: string };
export type ModuleCatalog = {
	candidates: ModuleCandidate[];
	children: string[];
	charter?: string;
	enclosing?: string;
	published: boolean;
};
export function builtInModules(): ModuleCandidate[] {
	return [
		["herdr", herdrDoc],
		["inter-agent", interAgentDoc],
		["nested", nestedDoc],
		["root", rootDoc],
	].map(([name, raw]) => {
		const file = `${name}.md`;
		const source = `builtin/${file}`;
		return {
			...parseModule(raw ?? "", file),
			name: file,
			source,
			path: source,
			layer: "builtin",
			raw: raw ?? "",
		};
	});
}
export function workspaceModules(
	root: string,
	layer: "inherited" | "local",
	tolerateUnreadable = false,
): ModuleCandidate[] {
	const dir = join(root, STATE_DIR, "integrations");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.flatMap((name) => {
			const source = join(dir, name);
			let raw: string;
			try {
				raw = readFileSync(source, "utf8");
			} catch (error) {
				if (tolerateUnreadable) return [];
				throw error;
			}
			return {
				...parseModule(raw, name),
				name,
				source,
				path: realpathSync(source),
				layer,
				raw,
			};
		});
}
/**
 * Every module a launch in `cwd` could load: the embedded built-ins, then
 * base packages, the enclosing workspace's integrations and packages, and
 * the workspace's own integrations. `published` counts enclosing packages
 * as well as enclosing integrations.
 */
export function moduleCatalog(
	cwd: string,
	enclosing: string | undefined = findEnclosingWorkspace(cwd),
	tolerateUnreadable = false,
	locations: readonly PackageLocation[] = packageLocations(enclosing),
): ModuleCatalog {
	const packages = packageModules(locations, tolerateUnreadable);
	const inherited = [
		...(enclosing
			? workspaceModules(enclosing, "inherited", tolerateUnreadable)
			: []),
		...packages.filter((m) => m.layer === "inherited"),
	];
	return {
		candidates: [
			...builtInModules(),
			...packages.filter((m) => m.layer === "builtin"),
			...inherited,
			...workspaceModules(cwd, "local", tolerateUnreadable),
		],
		children: findChildWorkspaces(cwd),
		charter: loadCharter(cwd),
		enclosing,
		published: inherited.length > 0,
	};
}
export function moduleProblemDetails(
	problems: readonly ResolutionProblem[],
): string {
	return problems.map((p) => `${p.file}: ${p.code}: ${p.message}`).join("; ");
}
export function resolveModules(
	catalog: ModuleCatalog,
	displaySource: (source: string) => string = (source) => source,
): {
	selected: ModuleCandidate[];
	problems: ResolutionProblem[];
} {
	const inheritedPaths = new Set(
		catalog.candidates
			.filter((m) => m.layer === "inherited")
			.map((m) => m.path),
	);
	const surviving = catalog.candidates.filter(
		(m) => !(m.layer === "local" && inheritedPaths.has(m.path)),
	);
	const problems: ResolutionProblem[] = [];
	const tokens = declaredModules(catalog.charter);
	// A package no charter names stays out of the header, broken or not:
	// `tool check` reports every package it can see.
	const named = (module: ModuleCandidate) =>
		!module.package ||
		tokens.has(module.package.name) ||
		(!!module.metadata?.provides && tokens.has(module.metadata.provides));
	for (const module of surviving) {
		// Embedded built-ins are tested before a build; a package on disk
		// may be edited after it, so its problems are reported (D12).
		if (
			module.layer === "builtin" &&
			!module.package &&
			(!module.metadata || module.problems.length)
		)
			throw new Error(
				`${module.source}: invalid built-in metadata: ${module.problems.map((p) => p.message).join("; ")}`,
			);
		if (named(module))
			for (const problem of module.problems)
				problems.push({
					...problem,
					file: module.source,
					message: `${problem.message}${module.body === undefined ? "" : "; stripped body loaded ungated"}`,
				});
	}
	const candidates = surviving.filter((m) => m.body !== undefined);
	const annotated = candidates.filter((m) => m.metadata);
	const slots = new Set(
		annotated.flatMap((m) =>
			m.metadata?.provides ? [m.metadata.provides] : [],
		),
	);
	const names = new Set(annotated.map((m) => m.metadata?.name));
	// `direct` leaves out what a named provider contributes to its slot.
	const declares = (value: string, direct = false) =>
		tokens.has(value) ||
		(!direct &&
			annotated.some(
				(m) => m.metadata?.provides === value && tokens.has(m.metadata.name),
			));
	const eligible = (module: ModuleCandidate, direct = false) => {
		const predicates = module.metadata?.["applies-when"];
		return (
			!predicates ||
			((predicates["enclosing-modules"] === undefined ||
				predicates["enclosing-modules"] === catalog.published) &&
				(predicates["has-children"] === undefined ||
					predicates["has-children"] === catalog.children.length > 0) &&
				(predicates["charter-declares"] === undefined ||
					declares(predicates["charter-declares"], direct)))
		);
	};
	const chosen = new Set(
		candidates.filter((m) => !m.metadata?.provides && eligible(m)),
	);
	const providers = annotated.filter((m) => m.metadata?.provides);
	for (const slot of slots) {
		const members = providers.filter((m) => m.metadata?.provides === slot);
		const explicitTokens = [...tokens].filter(
			(token) =>
				!slots.has(token) && members.some((m) => m.metadata?.name === token),
		);
		if (!tokens.has(slot) && !explicitTokens.length) continue;
		const conflict = (reason: string, conflicting = members) =>
			problems.push({
				file: "charter.md",
				code: "module-slot-conflict",
				message: `slot "${slot}": ${reason}; candidates: ${conflicting.map((m) => displaySource(m.source)).join(", ")}; no provider loaded`,
			});
		const unresolved = (token: string, reason: string) =>
			problems.push({
				file: "charter.md",
				code: "module-slot-unresolved",
				message: `"${token}": ${reason}; no provider loaded for slot "${slot}"`,
			});
		// A slot may not take the name of a module that loads, or its
		// provider would ride in on that module's token. The module stays
		// only when it is eligible without the provider's name.
		const namesake = [...chosen].filter(
			(m) => !m.metadata?.provides && m.metadata?.name === slot,
		);
		if (namesake.length) {
			for (const module of namesake)
				if (!eligible(module, true)) chosen.delete(module);
			conflict(`takes the name of module ${slot}`);
			continue;
		}
		if (
			explicitTokens.some(
				(token) =>
					annotated.filter((m) => m.metadata?.name === token).length > 1,
			)
		) {
			conflict(
				"explicit provider name is ambiguous",
				annotated.filter(
					(m) =>
						members.includes(m) ||
						explicitTokens.includes(m.metadata?.name ?? ""),
				),
			);
			continue;
		}
		if (explicitTokens.length > 1) {
			conflict("multiple explicit providers");
			continue;
		}
		const token = explicitTokens[0];
		if (token) {
			const provider = members.find((m) => m.metadata?.name === token);
			if (provider && eligible(provider)) chosen.add(provider);
			else unresolved(token, "requested provider is ineligible");
		} else {
			const defaults = members.filter(
				(m) => m.metadata?.default && eligible(m),
			);
			if (defaults.length > 1) conflict("multiple eligible defaults");
			else if (!defaults.length) unresolved(slot, "no eligible default");
			else if (defaults[0]) chosen.add(defaults[0]);
		}
	}
	for (const token of tokens)
		if (!slots.has(token) && !names.has(token))
			problems.push({
				file: "charter.md",
				code: "module-token-unknown",
				message: `Modules token "${token}" has no known module or slot`,
			});
	const line = catalog.charter
		?.split(/\r?\n/)
		.findIndex((text) => /^[ \t]*(?:[-*][ \t]+)?\**Modules:\**/i.test(text));
	for (const problem of problems)
		if (problem.file === "charter.md" && line !== undefined && line >= 0)
			problem.line = line + 1;
	return { selected: candidates.filter((m) => chosen.has(m)), problems };
}
