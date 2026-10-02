import {
	type Document,
	isMap,
	isScalar,
	isSeq,
	LineCounter,
	type Node,
	parseDocument,
} from "yaml";
import { z } from "zod";
import { mcpSecretEnvName, scanInterpolations } from "./command-text";
import { AgentSourceError, type SourceIssue } from "./errors";
import { DEFAULT_INITIAL_PROMPT, validateTemplate } from "./template";
import {
	ACCESS_LEVELS,
	AGENT_MODES,
	type AgentSource,
	type AgentSpec,
	BACKENDS,
	type Backend,
	FRAMEWORK_OPTIONS,
	FRAMEWORK_SHORTS,
	type FrameworkOption,
	type McpServer,
	type NativeArg,
	type NativeDeclarations,
	PROMPT_MODES,
} from "./types";

/** Framework flags every binary owns; declarations may not reuse them. */
export const FRAMEWORK_FLAGS = Object.keys(
	FRAMEWORK_OPTIONS,
) as readonly FrameworkOption[];
export const RESERVED_SHORTS = Object.keys(
	FRAMEWORK_SHORTS,
) as readonly string[];

/** Stable separator between the body and each include. */
export const PROMPT_SEPARATOR = "\n\n---\n\n";

type Path = readonly (string | number)[];

export interface ParsedAgent {
	readonly file: string;
	readonly source: AgentSource;
	readonly body: string;
	/** 1-based file line of a frontmatter field, when it can be located. */
	lineOf(path: Path): number | undefined;
}

export interface IncludeText {
	/** Path as the compiler resolved it, for diagnostics only. */
	path: string;
	text: string;
}

const nonEmpty = z.string().min(1, "must be a non-empty string");
const short = z
	.string()
	.regex(/^[A-Za-z]$/, "must be a single ASCII letter")
	.optional();
const stringRecord = z.record(z.string(), z.string());

const flagSpec = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("boolean"),
		description: nonEmpty,
		short,
		default: z.boolean().optional(),
	}),
	z.strictObject({
		type: z.literal("string"),
		description: nonEmpty,
		short,
		default: z.string().optional(),
	}),
	z.strictObject({
		type: z.literal("enum"),
		description: nonEmpty,
		short,
		values: z.array(nonEmpty).min(1, "must list at least one value"),
		default: z.string().optional(),
	}),
]);

const stdioServer = z.strictObject({
	command: nonEmpty,
	args: z.array(z.string()).optional(),
	env: stringRecord.optional(),
	cwd: nonEmpty.optional(),
});
const httpServer = z.strictObject({
	url: nonEmpty,
	headers: stringRecord.optional(),
});

const nativeArg = z.union([z.string(), z.strictObject({ flag: nonEmpty })]);
const opaque = z.record(z.string(), z.unknown());

const sourceSchema = z.strictObject({
	description: nonEmpty,
	backends: z.array(z.enum(BACKENDS)).min(1, "must list at least one backend"),
	promptMode: z.enum(PROMPT_MODES).optional(),
	mode: z.enum(AGENT_MODES).optional(),
	initialPrompt: z.string().optional(),
	includes: z.array(nonEmpty).optional(),
	flags: z
		.record(
			z
				.string()
				.regex(
					/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
					"flag names must be kebab-case",
				),
			flagSpec,
		)
		.optional(),
	model: z
		.strictObject({ claude: nonEmpty, codex: nonEmpty })
		.partial()
		.optional(),
	effort: z
		.strictObject({
			claude: z.enum(["low", "medium", "high", "max"]),
			codex: z.enum(["minimal", "low", "medium", "high"]),
		})
		.partial()
		.optional(),
	access: z.enum(ACCESS_LEVELS).optional(),
	mcp: z
		.record(
			z
				.string()
				.regex(/^[A-Za-z0-9_-]+$/, "server names use letters, digits, - and _"),
			z.unknown(),
		)
		.optional(),
	native: z
		.strictObject({
			claude: z
				.strictObject({ args: z.array(nativeArg), settings: opaque })
				.partial(),
			codex: z
				.strictObject({ args: z.array(nativeArg), config: opaque })
				.partial(),
		})
		.partial()
		.optional(),
	passthrough: z.boolean().optional(),
});

/**
 * Split `text` into frontmatter and body, then validate the frontmatter
 * strictly. Pure: the caller supplies the file contents.
 */
export function parseAgentMarkdown(file: string, text: string): ParsedAgent {
	const split = splitFrontmatter(text);
	if (!split) {
		throw new AgentSourceError([
			{
				file,
				line: 1,
				field: "frontmatter",
				message: 'expected a "---" frontmatter block at the top of the file',
			},
		]);
	}

	const lineCounter = new LineCounter();
	const doc = parseDocument(split.yaml, {
		lineCounter,
		// Duplicates are detected after key normalization in keyIssues.
		uniqueKeys: false,
		prettyErrors: false,
	});
	const toFileLine = (offset: number | undefined) =>
		offset === undefined
			? undefined
			: lineCounter.linePos(offset).line + split.yamlStartLine - 1;

	const yamlIssues = [...doc.errors, ...doc.warnings].map(
		(error): SourceIssue => ({
			file,
			line: toFileLine(error.pos[0]),
			field: "frontmatter",
			message: error.message.split("\n")[0] ?? error.message,
		}),
	);
	if (yamlIssues.length > 0) throw new AgentSourceError(yamlIssues);

	const keyProblems = keyIssues(doc.contents, []).map(
		(problem): SourceIssue => ({
			file,
			line: toFileLine(problem.offset),
			field: formatPath(problem.path),
			message:
				problem.firstOffset === undefined
					? problem.message
					: `${problem.message} (first at line ${toFileLine(problem.firstOffset)})`,
		}),
	);
	if (keyProblems.length > 0) throw new AgentSourceError(keyProblems);

	const lineOf = (path: Path) => toFileLine(locate(doc, path));
	const issue = (path: Path, message: string): SourceIssue => ({
		file,
		line: lineOf(path),
		field: formatPath(path),
		message,
	});

	const result = sourceSchema.safeParse(doc.toJS());
	if (!result.success) {
		throw new AgentSourceError(
			result.error.issues.flatMap((zodIssue) => {
				const path = zodIssue.path.filter(
					(segment): segment is string | number => typeof segment !== "symbol",
				);
				if (zodIssue.code === "unrecognized_keys") {
					return zodIssue.keys.map((key) =>
						issue([...path, key], "unknown key"),
					);
				}
				return [issue(path, zodIssue.message)];
			}),
		);
	}

	const data = result.data;
	const issues: SourceIssue[] = [];
	const report = (path: Path, message: string) =>
		issues.push(issue(path, message));

	const backends = data.backends as [Backend, ...Backend[]];
	checkBackends(backends, report);
	checkFlags(data.flags ?? {}, report);
	checkDeclaredBackendKeys(data, backends, report);
	const mcp = checkMcp(data.mcp ?? {}, backends, report);
	checkNative(data.native ?? {}, report);
	if (data.initialPrompt !== undefined) {
		for (const problem of validateTemplate(
			data.initialPrompt,
			data.flags ?? {},
		)) {
			report(["initialPrompt"], problem.message);
		}
	}
	if (issues.length > 0) throw new AgentSourceError(issues);

	const { mcp: _declaredMcp, ...rest } = data;
	const source: AgentSource = {
		...rest,
		backends,
		...(data.mcp ? { mcp } : {}),
	};
	return { file, source, body: split.body, lineOf };
}

/**
 * Build the embedded spec from a parsed declaration and the include texts
 * the compiler read, in declaration order.
 */
export function materializeAgentSpec(
	parsed: ParsedAgent,
	options: { id: string; includes: readonly IncludeText[] },
): AgentSpec {
	const { source } = parsed;
	const declared = source.includes ?? [];
	if (options.includes.length !== declared.length) {
		throw new Error(
			`${parsed.file}: expected ${declared.length} include texts, got ${options.includes.length}`,
		);
	}
	if (!/^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)*$/.test(options.id)) {
		throw new AgentSourceError([
			{
				file: parsed.file,
				field: "id",
				message: `"${options.id}" is not a valid agent id (lowercase kebab-case segments joined by ":")`,
			},
		]);
	}

	const systemPrompt = [parsed.body, ...options.includes.map((i) => i.text)]
		.map(normalizePart)
		.filter((part) => part.length > 0)
		.join(PROMPT_SEPARATOR);

	const spec: AgentSpec = {
		id: options.id,
		description: source.description,
		backends: source.backends,
		promptMode: source.promptMode ?? "append",
		mode: source.mode ?? "interactive",
		initialPrompt: source.initialPrompt ?? DEFAULT_INITIAL_PROMPT,
		systemPrompt,
		flags: source.flags ?? {},
	};
	if (source.model) spec.model = source.model;
	if (source.effort) spec.effort = source.effort;
	if (source.access) spec.access = source.access;
	if (source.mcp) spec.mcp = source.mcp;
	if (source.native) spec.native = source.native;
	if (source.passthrough !== undefined) spec.passthrough = source.passthrough;
	return spec;
}

function normalizePart(text: string): string {
	return text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
}

function splitFrontmatter(
	text: string,
): { yaml: string; yamlStartLine: number; body: string } | undefined {
	const normalized = text.startsWith("﻿") ? text.slice(1) : text;
	const open = /^---[ \t]*\r?\n/.exec(normalized);
	if (!open) return undefined;
	const rest = normalized.slice(open[0].length);
	const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
	if (!close) return undefined;
	return {
		yaml: rest.slice(0, close.index),
		yamlStartLine: 2,
		body: rest.slice(close.index + close[0].length),
	};
}

const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface KeyProblem {
	path: Path;
	offset: number | undefined;
	firstOffset?: number;
	message: string;
}

/**
 * Mapping keys compared as the strings they become in JS, so `true` and
 * `"true"` collide, plus keys that would touch object prototypes.
 */
function keyIssues(node: unknown, path: Path): KeyProblem[] {
	if (isSeq(node)) {
		return node.items.flatMap((item, i) => keyIssues(item, [...path, i]));
	}
	if (!isMap(node)) return [];
	const problems: KeyProblem[] = [];
	const seen = new Map<string, number | undefined>();
	for (const pair of node.items) {
		const keyNode = pair.key as Node | null;
		const offset = keyNode?.range?.[0];
		if (!isScalar(keyNode)) {
			problems.push({ path, offset, message: "mapping keys must be scalars" });
			continue;
		}
		const key = String(keyNode.value);
		const keyPath = [...path, key];
		if (RESERVED_OBJECT_KEYS.has(key)) {
			problems.push({ path: keyPath, offset, message: "reserved object key" });
		}
		if (seen.has(key)) {
			problems.push({
				path: keyPath,
				offset,
				firstOffset: seen.get(key),
				message: `duplicate key "${key}"`,
			});
		} else {
			seen.set(key, offset);
		}
		problems.push(...keyIssues(pair.value, keyPath));
	}
	return problems;
}

/** Offset of the deepest node on `path` (the key, for mapping entries). */
function locate(doc: Document, path: Path): number | undefined {
	let node: unknown = doc.contents;
	let offset = (node as Node | null)?.range?.[0];
	for (const segment of path) {
		if (isMap(node)) {
			const pair = node.items.find(
				(item) =>
					isScalar(item.key) && String(item.key.value) === String(segment),
			);
			if (!pair) break;
			offset = (pair.key as Node).range?.[0] ?? offset;
			node = pair.value;
		} else if (isSeq(node) && typeof segment === "number") {
			const item = node.items[segment] as Node | undefined;
			if (!item) break;
			offset = item.range?.[0] ?? offset;
			node = item;
		} else {
			break;
		}
	}
	return offset;
}

function formatPath(path: Path): string {
	if (path.length === 0) return "frontmatter";
	return path
		.map((segment, i) =>
			typeof segment === "number"
				? `[${segment}]`
				: i === 0
					? segment
					: `.${segment}`,
		)
		.join("");
}

type Report = (path: Path, message: string) => void;
type SourceData = z.infer<typeof sourceSchema>;

function checkBackends(backends: readonly Backend[], report: Report) {
	backends.forEach((backend, i) => {
		if (backends.indexOf(backend) !== i) {
			report(["backends", i], `duplicate backend "${backend}"`);
		}
	});
}

function checkFlags(flags: NonNullable<SourceData["flags"]>, report: Report) {
	const shorts = new Map<string, string>();
	for (const [name, spec] of Object.entries(flags)) {
		if ((FRAMEWORK_FLAGS as readonly string[]).includes(name)) {
			report(["flags", name], `"--${name}" is a reserved framework flag`);
		}
		if (spec.short !== undefined) {
			const owner = shorts.get(spec.short);
			if (owner) {
				report(
					["flags", name, "short"],
					`duplicate short "-${spec.short}" (also used by "${owner}")`,
				);
			} else if ((RESERVED_SHORTS as readonly string[]).includes(spec.short)) {
				report(["flags", name, "short"], `"-${spec.short}" is reserved`);
			} else {
				shorts.set(spec.short, name);
			}
		}
		if (spec.type === "boolean" && spec.default === true) {
			report(
				["flags", name, "default"],
				"a boolean flag always defaults to false (there is no --no-<name> form); rename the flag so passing it turns the behavior on",
			);
		}
		if (spec.type === "enum") {
			spec.values.forEach((value, i) => {
				if (spec.values.indexOf(value) !== i) {
					report(
						["flags", name, "values", i],
						`duplicate enum value "${value}"`,
					);
				}
			});
			if (spec.default !== undefined && !spec.values.includes(spec.default)) {
				report(
					["flags", name, "default"],
					`default "${spec.default}" is not one of ${spec.values.map((v) => `"${v}"`).join(", ")}`,
				);
			}
		}
	}
}

function checkDeclaredBackendKeys(
	data: SourceData,
	backends: readonly Backend[],
	report: Report,
) {
	for (const field of ["model", "effort", "native"] as const) {
		for (const key of Object.keys(data[field] ?? {})) {
			if (!backends.includes(key as Backend)) {
				report([field, key], `backend "${key}" is not declared in backends`);
			}
		}
	}
}

function checkMcp(
	servers: Record<string, unknown>,
	backends: readonly Backend[],
	report: Report,
): Record<string, McpServer> {
	const claude = backends.includes("claude");
	const parsed: Record<string, McpServer> = {};
	for (const [name, value] of Object.entries(servers)) {
		const base = ["mcp", name];
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			report(base, "must be an object with command (stdio) or url (http)");
			continue;
		}
		const hasCommand = "command" in value;
		const hasUrl = "url" in value;
		if (hasCommand && hasUrl) {
			report(base, "mixes stdio (command) and http (url) transports");
			continue;
		}
		if (!hasCommand && !hasUrl) {
			report(base, "must declare command (stdio) or url (http)");
			continue;
		}
		const result = (hasCommand ? stdioServer : httpServer).safeParse(value);
		if (!result.success) {
			for (const zodIssue of result.error.issues) {
				const path = [
					...base,
					...zodIssue.path.filter(
						(s): s is string | number => typeof s !== "symbol",
					),
				];
				if (zodIssue.code === "unrecognized_keys") {
					for (const key of zodIssue.keys) {
						report(
							[...path, key],
							hasCommand
								? "unknown key for a stdio server"
								: "unknown key for an http server",
						);
					}
				} else {
					report(path, zodIssue.message);
				}
			}
			continue;
		}
		for (const [path, leaf] of stringLeaves(result.data, base)) {
			const scan = scanInterpolations(leaf);
			if (!scan.ok) {
				report(path, scan.error);
				continue;
			}
			// D-033: Claude expands every `${VAR}` in inline MCP JSON, so a
			// literal one would not stay literal.
			if (claude && literalDollarBrace(leaf, scan.references)) {
				report(
					path,
					'contains a literal "${" that Claude would expand; only ${env:NAME} and ${cmd:...} are allowed when claude is a declared backend',
				);
			}
		}
		// Keys are never interpolated, and Claude's handling of "${" in a key
		// is unverified, so any "${" in an env or header name is refused.
		const keyed =
			"command" in result.data
				? (["env", result.data.env] as const)
				: (["headers", result.data.headers] as const);
		for (const key of Object.keys(keyed[1] ?? {})) {
			if (key.includes("${")) {
				report(
					[...base, keyed[0]],
					`name "${key}" contains "\${"; ${keyed[0] === "env" ? "env" : "header"} names are never interpolated`,
				);
			}
		}
		// D-032: Claude ignores a stdio server's cwd.
		if (claude && "command" in result.data && result.data.cwd !== undefined) {
			report(
				[...base, "cwd"],
				"a stdio cwd is not supported when claude is a declared backend (Claude ignores it)",
			);
		}
		parsed[name] = result.data;
	}
	checkSecretEnvNames(parsed, report);
	return parsed;
}

function literalDollarBrace(
	leaf: string,
	references: readonly { raw: string }[],
): boolean {
	let rest = leaf;
	for (const reference of references) {
		// A separator, so text on either side cannot join into "${".
		rest = rest.replace(reference.raw, () => "\0");
	}
	return rest.includes("${");
}

/** Interpolated header values must map to distinct D-029 variable names. */
function checkSecretEnvNames(
	servers: Record<string, McpServer>,
	report: Report,
) {
	const owners = new Map<string, string>();
	for (const [name, server] of Object.entries(servers)) {
		if (!("url" in server)) continue;
		for (const [header, value] of Object.entries(server.headers ?? {})) {
			const scan = scanInterpolations(value);
			if (!scan.ok || scan.references.length === 0) continue;
			const variable = mcpSecretEnvName(name, header);
			const owner = owners.get(variable);
			if (owner) {
				report(
					["mcp", name, "headers", header],
					`secret header variable ${variable} collides with ${owner}`,
				);
			} else {
				owners.set(variable, `mcp.${name}.headers.${header}`);
			}
		}
	}
}

function stringLeaves(value: unknown, path: Path): [Path, string][] {
	if (typeof value === "string") return [[path, value]];
	if (Array.isArray(value)) {
		return value.flatMap((item, i) => stringLeaves(item, [...path, i]));
	}
	if (typeof value === "object" && value !== null) {
		return Object.entries(value).flatMap(([key, item]) =>
			stringLeaves(item, [...path, key]),
		);
	}
	return [];
}

const LONG_FLAG = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
const SHORT_FLAG = /^-[A-Za-z]$/;
/** A `-c` key path Codex splits on "." without TOML parsing. */
export const BARE_CONFIG_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const CONFIG_KEY = /^[A-Za-z0-9_-]+(?:\.(?:[A-Za-z0-9_-]+|"[^"]*"))*$/;

const CLAUDE_PROMPT_FLAGS = new Set([
	"--system-prompt",
	"--system-prompt-file",
	"--append-system-prompt",
	"--append-system-prompt-file",
]);
/** Settings that run commands the way lifecycle hooks do. */
const CLAUDE_COMMAND_SETTINGS = new Set(["statusLine", "apiKeyHelper"]);
const COMMAND_HOOK =
	"runs commands like a lifecycle hook; not supported in agent declarations";
const CODEX_PROMPT_KEYS = new Set([
	"developer_instructions",
	"model_instructions_file",
	"instructions",
	"experimental_instructions_file",
]);

/**
 * The D-013 guards on authored native declarations, as `field: message`
 * lines. Adapters rerun them on specs that did not come through the parser.
 */
export function nativeDeclarationProblems(
	native: NativeDeclarations,
): string[] {
	const problems: string[] = [];
	checkNative(native, (path, message) =>
		problems.push(`${formatPath(path)}: ${message}`),
	);
	return problems;
}

function checkNative(
	native: NonNullable<SourceData["native"]>,
	report: Report,
) {
	if (native.claude?.args) {
		checkNativeArgs("claude", native.claude.args, report);
	}
	if (native.codex?.args) {
		checkNativeArgs("codex", native.codex.args, report);
	}
	for (const key of Object.keys(native.claude?.settings ?? {})) {
		if (key === "hooks") {
			report(
				["native", "claude", "settings", key],
				"lifecycle hooks are not supported in agent declarations",
			);
		} else if (CLAUDE_COMMAND_SETTINGS.has(key)) {
			report(["native", "claude", "settings", key], COMMAND_HOOK);
		}
	}
	for (const key of Object.keys(native.codex?.config ?? {})) {
		const problem = BARE_CONFIG_PATH.test(key)
			? codexKeyProblem(key)
			: 'must be a bare dotted key ([A-Za-z0-9_-] segments joined by "."): Codex does not parse quoted -c keys';
		if (problem) report(["native", "codex", "config", key], problem);
	}
}

function checkNativeArgs(
	backend: Backend,
	args: readonly NativeArg[],
	report: Report,
) {
	const base = ["native", backend, "args"];
	let i = 0;
	while (i < args.length) {
		const arg = args[i] as NativeArg;
		const at = [...base, i];
		if (typeof arg === "object") {
			if (!LONG_FLAG.test(arg.flag) && !SHORT_FLAG.test(arg.flag)) {
				report([...at, "flag"], `"${arg.flag}" is not a --long or -s flag`);
			} else {
				const problem = reservedArgProblem(backend, arg.flag, undefined);
				if (problem) report(at, problem);
			}
			i++;
			continue;
		}
		const equals = /^(--[^=]+)=([\s\S]*)$/.exec(arg);
		if (equals) {
			const [, flag = "", value = ""] = equals;
			if (!LONG_FLAG.test(flag)) {
				report(at, `"${flag}" is not a valid --long flag`);
			} else {
				const problem = reservedArgProblem(backend, flag, value);
				if (problem) report(at, problem);
			}
			i++;
			continue;
		}
		if (LONG_FLAG.test(arg) || SHORT_FLAG.test(arg)) {
			const next = args[i + 1];
			if (typeof next !== "string" || next.startsWith("-")) {
				report(
					at,
					`"${arg}" needs a value: use "${arg}=value", "${arg}" followed by a value, or {flag: "${arg}"} for a boolean flag`,
				);
				i++;
				continue;
			}
			const problem = reservedArgProblem(backend, arg, next);
			if (problem) report(at, problem);
			i += 2;
			continue;
		}
		report(
			at,
			`"${arg}" is not a --flag=value token, a --flag value pair or a {flag} entry`,
		);
		i++;
	}
}

function reservedArgProblem(
	backend: Backend,
	flag: string,
	value: string | undefined,
): string | undefined {
	if (backend === "claude") {
		if (CLAUDE_PROMPT_FLAGS.has(flag)) {
			return `"${flag}" is reserved: prompt transport comes from promptMode and the body`;
		}
		if (flag === "--settings") {
			return '"--settings" is reserved: declare settings under native.claude.settings';
		}
		return undefined;
	}
	if (flag === "--dangerously-bypass-hook-trust") {
		return "lifecycle hooks are not supported in agent declarations";
	}
	if (flag === "-c" || flag === "--config") {
		if (value === undefined) return `"${flag}" needs a key=value entry`;
		const separator = value.indexOf("=");
		const key = separator === -1 ? value : value.slice(0, separator);
		if (
			separator <= 0 ||
			separator === value.length - 1 ||
			!CONFIG_KEY.test(key)
		) {
			return `"${flag} ${value}" is not a well-formed key=value entry`;
		}
		return codexKeyProblem(key);
	}
	return undefined;
}

function codexKeyProblem(key: string): string | undefined {
	const root = key.split(".")[0] ?? key;
	if (root === "base_instructions") {
		return '"base_instructions" is never emitted: Codex ignores it';
	}
	if (CODEX_PROMPT_KEYS.has(root)) {
		return `"${root}" is reserved: prompt transport comes from promptMode and the body`;
	}
	if (root === "hooks") {
		return "lifecycle hooks are not supported in agent declarations";
	}
	if (root === "notify") return COMMAND_HOOK;
	return undefined;
}
