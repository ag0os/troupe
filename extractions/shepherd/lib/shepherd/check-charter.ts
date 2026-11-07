import { relative } from "node:path";
import coreDoc from "../../system-prompts/shepherd/core.md" with {
	type: "text",
};
import { CORE_SLOTS, normalizedText, parseCharter } from "./charter-slots";
import type { Finding } from "./check";
import { type ModuleCatalog, resolveModules } from "./module-resolution";
import { words } from "./text";

export function charterFindings(
	catalog: ModuleCatalog,
	state: string,
): Finding[] {
	if (catalog.charter === undefined) return [];
	const findings: Finding[] = [];
	const validModules = catalog.candidates.filter(
		(module) => module.metadata && !module.problems.length,
	);
	const declaredKeys = validModules.flatMap((module) =>
		Object.keys(module.metadata?.["charter-keys"] ?? {}),
	);
	const namespaces = new Set(
		validModules.flatMap((module) =>
			[module.metadata?.name, module.metadata?.provides].filter(
				(name): name is string => name !== undefined,
			),
		),
	);
	const { slots, blocks, unknownBullets } = parseCharter(
		catalog.charter,
		declaredKeys,
	);
	const add = (
		level: Finding["level"],
		code: string,
		message: string,
		line?: number,
	) =>
		findings.push({
			level,
			code,
			file: "charter.md",
			message,
			...(line === undefined ? {} : { line }),
		});
	for (const bullet of unknownBullets) {
		const namespace = bullet.key.split(".")[0] ?? "";
		if (!namespaces.has(namespace)) continue;
		const keys = [...new Set(declaredKeys)]
			.filter((key) => key.startsWith(`${namespace}.`))
			.sort();
		add(
			"warn",
			"charter-key-unknown",
			`"${bullet.key}" is not a slot any module declares (read as prose); declared ${namespace} keys: ${keys.join(", ") || "none"}`,
			bullet.line,
		);
	}
	const seen = new Map<string, number>();
	for (const slot of slots) {
		if (slot.kind === "module" && slot.key.startsWith("core.")) continue;
		const identity = `${slot.kind}:${slot.key}`;
		const first = seen.get(identity);
		if (first !== undefined)
			add(
				slot.kind === "core" ? "warn" : "error",
				"charter-slot-duplicate",
				`slot "${slot.key}" repeats line ${first}`,
				slot.line,
			);
		else seen.set(identity, slot.line);
	}
	let resolved: ReturnType<typeof resolveModules>;
	try {
		resolved = resolveModules(catalog);
	} catch {
		return findings;
	}
	const declarations = new Map<string, { required: string[] }>(
		Object.values(CORE_SLOTS).map((key) => [key, { required: [] }]),
	);
	for (const module of resolved.selected) {
		for (const [key, requirement] of Object.entries(
			module.metadata?.["charter-keys"] ?? {},
		)) {
			const declaration = declarations.get(key) ?? { required: [] };
			if (requirement === "required" && module.metadata)
				declaration.required.push(module.metadata.name);
			declarations.set(key, declaration);
		}
	}
	const incomplete =
		catalog.candidates.some((m) => m.problems.length > 0) ||
		resolved.problems.some((p) => p.code !== "module-token-unknown");
	if (!incomplete) {
		for (const slot of slots.filter((s) => s.kind === "module")) {
			if (Object.values(CORE_SLOTS).includes(slot.key))
				add(
					"warn",
					"charter-key-undeclared",
					`slot "${slot.key}" uses the heading form, not a module-key bullet`,
					slot.line,
				);
			else if (!declarations.has(slot.key))
				add(
					"warn",
					"charter-key-undeclared",
					`slot "${slot.key}" is not declared by the loaded modules`,
					slot.line,
				);
		}
		for (const [key, { required }] of declarations) {
			if (!required.length) continue;
			const values = slots.filter(
				(s) =>
					s.key === key &&
					s.kind === (key.startsWith("core.") ? "core" : "module"),
			);
			if (!values.length || values.every((s) => !s.value.trim()))
				add(
					"warn",
					"charter-key-required",
					`slot "${key}" required by ${[...new Set(required)].join(", ")} is missing or empty`,
					values[0]?.line,
				);
		}
	}
	const bodies = [
		{ source: "core", body: coreDoc, bodyLine: 1 },
		...resolved.selected.map((m) => ({
			source:
				m.source.startsWith("builtin/") || m.package
					? m.source
					: relative(state, m.source),
			body: m.body ?? "",
			bodyLine: m.bodyLine,
		})),
	].map((body) => ({
		source: body.source,
		...normalizedText(body.body, body.bodyLine),
	}));
	for (const block of blocks) {
		const normalized = normalizedText(block.source).text;
		if (words(normalized) < 20) continue;
		for (const body of bodies) {
			const match = ` ${body.text} `.indexOf(` ${normalized} `);
			if (match < 0) continue;
			add(
				"info",
				"charter-module-restatement",
				`possible repeated rule: ${body.source}:${body.lines[match]}; review ownership before removing text`,
				block.line,
			);
			break;
		}
	}
	return findings;
}
