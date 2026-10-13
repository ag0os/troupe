import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";

export const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const selectable = (value: string) =>
	IDENTIFIER.test(value) && /^[a-z-]+$/.test(value);
const keyComponent = (value: string) =>
	IDENTIFIER.test(value) && /^[a-z]/.test(value);
const CORE_KEYS = new Set([
	"mission",
	"role",
	"what-lives-where",
	"way-of-working",
	"cadence",
	"done",
	"toolset",
	"structure",
]);
const FIELDS = new Set([
	"name",
	"type",
	"description",
	"applies-when",
	"provides",
	"default",
	"budget",
	"charter-keys",
]);
export type ModuleProblem = { code: string; message: string; line?: number };
export type ModuleMetadata = {
	name: string;
	type: "capability" | "method" | "role" | "domain" | "persona";
	description: string;
	budget: number;
	"applies-when"?: {
		"enclosing-modules"?: boolean;
		"has-children"?: boolean;
		"charter-declares"?: string;
	};
	provides?: string;
	default: boolean;
	"charter-keys": Record<string, "required" | "optional">;
};
export type ParsedModule = {
	kind: "legacy" | "annotated" | "malformed";
	body?: string;
	bodyLine: number;
	metadata?: ModuleMetadata;
	problems: ModuleProblem[];
};

export function parseModule(raw: string, filename: string): ParsedModule {
	const lines = [...raw.matchAll(/([^\n]*)(?:\n|$)/g)].filter(
		(m) => m[0].length > 0,
	);
	const lineText = (index: number) =>
		(lines[index]?.[1] ?? "").replace(/\r$/, "");
	const legacy: ParsedModule = {
		kind: "legacy",
		body: raw,
		bodyLine: 1,
		problems: [],
	};
	if (lineText(0) !== "---") return legacy;
	const significant = lines.findIndex(
		(_, i) => i > 0 && !/^[ \t]*(?:#.*)?$/.test(lineText(i)),
	);
	const signature = lineText(significant).match(/^([a-z-]+):/)?.[1];
	if (!signature || !FIELDS.has(signature)) return legacy;
	const close = lines.findIndex((_, i) => i > 0 && lineText(i) === "---");
	if (close < 0)
		return {
			kind: "malformed",
			body: undefined,
			bodyLine: 1,
			problems: [
				{
					code: "module-schema",
					message: "frontmatter: missing closing ---; file skipped",
					line: 1,
				},
			],
		};
	const start = lines[0]?.[0].length ?? 0;
	const end = lines[close]?.index ?? raw.length;
	const yaml = raw.slice(start, end);
	const result: ParsedModule = {
		kind: "annotated",
		body: raw.slice(end + (lines[close]?.[0].length ?? 0)),
		bodyLine: close + 2,
		problems: [],
	};
	const lineAt = (offset: number) =>
		yaml.slice(0, offset).split("\n").length + 1;
	const issue = (
		field: string,
		reason: string,
		offset = 0,
		code = "module-schema",
	) =>
		result.problems.push({
			code,
			message:
				code === "module-name"
					? reason
					: `${field || "frontmatter"}: ${reason}`,
			line: lineAt(offset),
		});
	const doc = parseDocument(yaml, {
		version: "1.2",
		strict: true,
		uniqueKeys: true,
		prettyErrors: false,
	});
	for (const error of [...doc.errors, ...doc.warnings])
		issue("frontmatter", error.message, error.pos[0]);
	if (
		/^%/m.test(yaml) ||
		doc.directives?.yaml.explicit ||
		Object.keys(doc.directives?.tags ?? {}).some((key) => key !== "!!")
	)
		issue("frontmatter", "directives are unsupported");
	const inspect = (value: unknown, field: string) => {
		if (!isNode(value)) return;
		const offset = value.range?.[0] ?? 0;
		if (value.tag) issue(field, "explicit tags are unsupported", offset);
		if (isAlias(value)) issue(field, "aliases are unsupported", offset);
		if ((isScalar(value) || isMap(value) || isSeq(value)) && value.anchor)
			issue(field, "anchors are unsupported", offset);
		if (isMap(value))
			for (const pair of value.items) {
				if (!isScalar(pair.key) || typeof pair.key.value !== "string")
					issue(
						field,
						"mapping keys must be strings",
						isNode(pair.key) ? (pair.key.range?.[0] ?? offset) : offset,
					);
				const key = isScalar(pair.key) ? String(pair.key.value) : "key";
				if (key === "<<") issue(field, "merge keys are unsupported", offset);
				inspect(pair.key, field);
				inspect(pair.value, field ? `${field}.${key}` : key);
			}
		if (isSeq(value)) for (const item of value.items) inspect(item, field);
	};
	inspect(doc.contents, "");
	const budgetNode = isMap(doc.contents)
		? doc.contents.get("budget", true)
		: undefined;
	if (isScalar(budgetNode) && !/^[1-9][0-9]*$/.test(budgetNode.source ?? "")) {
		issue(
			"budget",
			"must be a positive decimal integer",
			budgetNode.range?.[0] ?? 0,
		);
	}
	if (!isMap(doc.contents)) issue("frontmatter", "must be a mapping");
	if (result.problems.length) {
		result.problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
		return result;
	}
	const data = doc.toJS() as Record<string, unknown>;
	const offsetOf = (field: string) => {
		let node: unknown = doc.contents;
		let offset = 0;
		const parts = field.startsWith("charter-keys.")
			? ["charter-keys", field.slice("charter-keys.".length)]
			: field.split(".");
		for (const part of parts) {
			if (!isMap(node)) break;
			const pair = node.items.find(
				(p) => isScalar(p.key) && p.key.value === part,
			);
			if (!pair) break;
			offset = isNode(pair.key) ? (pair.key.range?.[0] ?? offset) : offset;
			node = pair.value;
		}
		return offset;
	};
	const invalid = (field: string, reason: string, code?: string) =>
		issue(field, reason, offsetOf(field), code);
	for (const key of Object.keys(data))
		if (!FIELDS.has(key)) invalid(key, "unknown key");
	const name = data.name;
	if (typeof name !== "string" || !IDENTIFIER.test(name))
		invalid("name", "must be a module identifier");
	else if (name !== filename.replace(/\.md$/, ""))
		invalid(
			"name",
			`name "${name}" must equal file stem "${filename.replace(/\.md$/, "")}"`,
			"module-name",
		);
	if (
		typeof data.type !== "string" ||
		!["capability", "method", "role", "domain", "persona"].includes(data.type)
	)
		invalid("type", "must be capability, method, role, domain, or persona");
	if (
		typeof data.description !== "string" ||
		!data.description.trim() ||
		/[\r\n]/.test(data.description)
	)
		invalid("description", "must be a nonblank single-line string");
	if (
		typeof data.budget !== "number" ||
		!Number.isSafeInteger(data.budget) ||
		data.budget <= 0
	)
		invalid("budget", "must be a positive safe integer");
	if (
		"provides" in data &&
		(typeof data.provides !== "string" || !selectable(data.provides))
	)
		invalid("provides", "must be a selectable slot identifier");
	if ("provides" in data && (typeof name !== "string" || !selectable(name)))
		invalid("name", "provider name must be selectable");
	if ("default" in data && typeof data.default !== "boolean")
		invalid("default", "must be a boolean");
	if ("default" in data && !("provides" in data))
		invalid("default", "requires provides");
	const mapping = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	if ("applies-when" in data) {
		if (!mapping(data["applies-when"]))
			invalid("applies-when", "must be a mapping");
		else
			for (const [key, value] of Object.entries(data["applies-when"])) {
				if (["enclosing-modules", "has-children"].includes(key)) {
					if (typeof value !== "boolean")
						invalid(`applies-when.${key}`, "must be a boolean");
				} else if (key === "charter-declares") {
					if (typeof value !== "string" || !selectable(value))
						invalid(`applies-when.${key}`, "must be a selectable identifier");
				} else invalid(`applies-when.${key}`, "unknown key");
			}
	}
	if ("charter-keys" in data) {
		if (!mapping(data["charter-keys"]))
			invalid("charter-keys", "must be a mapping");
		else
			for (const [key, value] of Object.entries(data["charter-keys"])) {
				const [namespace, component, rest] = key.split(".");
				const invalidKey = (reason: string) =>
					issue("charter-keys", reason, offsetOf(`charter-keys.${key}`));
				if (
					!namespace ||
					!component ||
					rest !== undefined ||
					!keyComponent(namespace) ||
					!keyComponent(component)
				)
					invalidKey(`invalid key "${key}"`);
				else if (
					namespace === "core"
						? !CORE_KEYS.has(component)
						: namespace !== name && namespace !== data.provides
				)
					invalidKey(`key "${key}" is outside module ownership`);
				if (value !== "required" && value !== "optional")
					invalidKey(`key "${key}" must be required or optional`);
			}
	}
	if (!result.problems.length)
		result.metadata = {
			...data,
			default: data.default ?? false,
			"charter-keys": data["charter-keys"] ?? {},
		} as ModuleMetadata;
	result.problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
	return result;
}
