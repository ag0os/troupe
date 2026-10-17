import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";
import { CORE_SLOTS } from "./charter-slots";

export const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const selectable = (value: string) =>
	IDENTIFIER.test(value) && /^[a-z-]+$/.test(value);
const keyComponent = (value: string) =>
	IDENTIFIER.test(value) && /^[a-z]/.test(value);
const CORE_KEYS = new Set(Object.values(CORE_SLOTS).map((key) => key.slice(5)));
const FIELDS = new Set([
	"name",
	"type",
	"description",
	"applies-when",
	"provides",
	"default",
	"budget",
	"charter-keys",
	"contract",
	"tools",
	"guides",
]);
/** Fields only a package's MODULE.md may carry (docs/PACKAGES.md). */
const PACKAGE_FIELDS = new Set(["contract", "tools", "guides"]);
/** The package contract version this binary implements. */
export const PACKAGE_CONTRACT = 1;
export type ToolDeclaration = {
	description: string;
	access: "read" | "write";
	requires: string[];
	network: boolean;
};
export type GuideDeclaration = { description: string };
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
	contract?: number;
	tools?: Record<string, ToolDeclaration>;
	guides?: Record<string, GuideDeclaration>;
};
export type ParsedModule = {
	kind: "legacy" | "annotated" | "malformed";
	body?: string;
	bodyLine: number;
	metadata?: ModuleMetadata;
	problems: ModuleProblem[];
};

/**
 * Parse a module file. With `package`, the file is a package's MODULE.md:
 * `contract` must be the integer 1 before anything else is checked, so a
 * newer package is refused with one problem, and `tools` and `guides` are
 * allowed. Elsewhere those three fields are schema errors.
 */
export function parseModule(
	raw: string,
	filename: string,
	options: { package?: boolean } = {},
): ParsedModule {
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
	const uncontracted = (found: string): ParsedModule => ({
		kind: "malformed",
		body: undefined,
		bodyLine: 1,
		problems: [
			{
				code: "package-contract",
				message: `contract: ${found}; this binary implements contract ${PACKAGE_CONTRACT}; package excluded`,
				line: 1,
			},
		],
	});
	if (lineText(0) !== "---")
		return options.package ? uncontracted("missing (no frontmatter)") : legacy;
	const significant = lines.findIndex(
		(_, i) => i > 0 && !/^[ \t]*$/.test(lineText(i)),
	);
	const signature = lineText(significant).match(/^([a-z-]+):(?:\s|$)/)?.[1];
	if (!signature || !FIELDS.has(signature))
		return options.package ? uncontracted("missing (no frontmatter)") : legacy;
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
	if (options.package && data.contract !== PACKAGE_CONTRACT) {
		const found =
			data.contract === undefined
				? "missing"
				: `found ${JSON.stringify(data.contract)}`;
		const refused = uncontracted(found);
		return {
			...refused,
			problems: refused.problems.map((p) => ({
				...p,
				line: "contract" in data ? lineAt(offsetOf("contract")) : 1,
			})),
		};
	}
	for (const key of Object.keys(data))
		if (!FIELDS.has(key)) invalid(key, "unknown key");
		else if (PACKAGE_FIELDS.has(key) && !options.package)
			invalid(key, "allowed only in a package MODULE.md");
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
	// A package loads only where a charter names it (R2 a). A provider
	// declares its slot, so the slot and its default can select it.
	if (options.package) {
		const declares = mapping(data["applies-when"])
			? data["applies-when"]["charter-declares"]
			: undefined;
		if (declares !== (data.provides ?? name))
			issue(
				"applies-when.charter-declares",
				"a package must be selected by its slot when it provides one, else by its own name",
				offsetOf("applies-when" in data ? "applies-when" : "name"),
			);
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
	const singleLine = (value: unknown) =>
		typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value);
	const declarations = (
		field: "tools" | "guides",
		keys: Record<string, (value: unknown) => string | undefined>,
		required: readonly string[],
	) => {
		const value = data[field];
		if (!options.package || value === undefined) return;
		if (!mapping(value)) return invalid(field, "must be a mapping");
		for (const [entry, declaration] of Object.entries(value)) {
			const at = `${field}.${entry}`;
			if (!IDENTIFIER.test(entry)) {
				invalid(
					field,
					`${field === "tools" ? "tool" : "guide"} name "${entry}" must match ${IDENTIFIER.source}`,
				);
				continue;
			}
			if (!mapping(declaration)) {
				invalid(at, "must be a mapping");
				continue;
			}
			for (const key of required)
				if (!(key in declaration)) invalid(`${at}.${key}`, "is required");
			for (const [key, item] of Object.entries(declaration)) {
				const check = keys[key];
				const reason = check ? check(item) : "unknown key";
				if (reason) invalid(`${at}.${key}`, reason);
			}
		}
	};
	const description = (value: unknown) =>
		singleLine(value) ? undefined : "must be a nonblank single-line string";
	declarations(
		"tools",
		{
			description,
			access: (value) =>
				value === "read" || value === "write"
					? undefined
					: "must be read or write",
			requires: (value) =>
				Array.isArray(value) &&
				value.every(
					(item) => typeof item === "string" && /^[A-Za-z0-9._+-]+$/.test(item),
				)
					? undefined
					: "must be a list of executable names",
			network: (value) =>
				typeof value === "boolean" ? undefined : "must be a boolean",
		},
		["description", "access"],
	);
	declarations("guides", { description }, ["description"]);
	if (!result.problems.length)
		result.metadata = {
			...data,
			default: data.default ?? false,
			"charter-keys": data["charter-keys"] ?? {},
		} as ModuleMetadata;
	result.problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
	return result;
}
