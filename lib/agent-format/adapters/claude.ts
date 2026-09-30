import type { Access } from "../types";
import {
	ArgvBuilder,
	assertInvocation,
	isRecord,
	isStdio,
	nativeArgv,
	parseJsonLine,
	type Rendered,
	render,
} from "./shared";
import type {
	BackendAdapter,
	CommandPlan,
	Emission,
	ExtraAllowRules,
	Invocation,
	ResolvedMcpServer,
	ResolvedValue,
	ResourceNeeds,
	ResourcePaths,
	StreamDecoder,
} from "./types";

/** D-014: coarse access levels as Claude permission modes. */
const PERMISSION_MODES: Record<Access, string> = {
	"read-only": "plan",
	"workspace-write": "acceptEdits",
	full: "bypassPermissions",
};

export const claudeAdapter: BackendAdapter = {
	id: "claude",

	resources(): ResourceNeeds {
		return { tmpDir: true };
	},

	build(inv: Invocation, paths: ResourcePaths): CommandPlan {
		assertInvocation(inv, "claude");
		if (!paths.tmpDir) {
			throw new Error("the claude adapter needs a tmpDir resource path");
		}
		const { spec } = inv;
		const out = new ArgvBuilder();

		if (inv.mode === "print") out.push("--print");
		if (inv.mode === "stream") {
			out.push("--print", "--output-format", "stream-json", "--verbose");
		}

		if (inv.systemPrompt.length > 0) {
			const flag =
				spec.promptMode === "replace"
					? "--system-prompt"
					: "--append-system-prompt";
			out.push(flag, inv.systemPrompt);
		}

		const model = inv.model ?? spec.model?.claude;
		if (model !== undefined) out.push("--model", model);
		if (spec.effort?.claude !== undefined) {
			out.push("--effort", spec.effort.claude);
		}
		if (spec.access !== undefined) {
			out.push("--permission-mode", PERMISSION_MODES[spec.access]);
		}

		const mcp = mcpConfig(inv.mcp);
		if (mcp) out.push("--mcp-config").pushValue(mcp.actual, mcp.display);

		const settings = mergeSettings(
			spec.native?.claude?.settings,
			inv.extraAllowRules,
		);
		if (settings) out.push("--settings", JSON.stringify(settings));

		out.push(...nativeArgv(spec.native?.claude?.args));
		out.push(...inv.passthrough);
		if (inv.initialPrompt.length > 0) out.push("--", inv.initialPrompt);

		const interactive = inv.mode === "interactive";
		return {
			executable: "claude",
			argv: out.argv,
			displayArgv: out.displayArgv,
			cwd: inv.cwd,
			stdin: interactive ? "inherit" : "ignore",
			stdout: interactive ? "inherit" : "pipe",
			stderr: inv.mode === "print" ? "pipe" : "inherit",
			env: { TMPDIR: paths.tmpDir },
		};
	},

	decoder(): StreamDecoder {
		return {
			line(text) {
				if (text.trim().length === 0) return [];
				const event = parseJsonLine(text, "claude");
				const assistantText = assistantTextOf(event);
				if (assistantText !== undefined) {
					return [{ stream: "stdout", text: `${assistantText}\n` }];
				}
				return [{ stream: "stderr", text: `${JSON.stringify(event)}\n` }];
			},
			end: (): Emission[] => [],
		};
	},
};

/** `--mcp-config` JSON, or nothing when no server is declared. */
function mcpConfig(
	servers: Record<string, ResolvedMcpServer>,
): Rendered | undefined {
	if (Object.keys(servers).length === 0) return undefined;
	return render((pick) =>
		JSON.stringify({
			mcpServers: Object.fromEntries(
				Object.entries(servers).map(([name, server]) => [
					name,
					serverJson(server, pick),
				]),
			),
		}),
	);
}

function serverJson(
	server: ResolvedMcpServer,
	pick: (value: ResolvedValue) => string,
): Record<string, unknown> {
	if (isStdio(server)) {
		const json: Record<string, unknown> = {
			type: "stdio",
			command: pick(server.command),
		};
		if (server.args) json.args = server.args.map(pick);
		if (server.env) json.env = mapValues(server.env, pick);
		if (server.cwd) json.cwd = pick(server.cwd);
		return json;
	}
	const json: Record<string, unknown> = { type: "http", url: pick(server.url) };
	if (server.headers) {
		// D-029: interpolated header values stay out of argv as ${VAR} references.
		json.headers = mapValues(server.headers, (value) =>
			value.secretEnv ? `\${${value.secretEnv}}` : pick(value),
		);
	}
	return json;
}

function mapValues<T, U>(
	record: Record<string, T>,
	map: (value: T) => U,
): Record<string, U> {
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [key, map(value)]),
	);
}

/**
 * Native settings with prepared rules and directories merged in once.
 * Returns nothing when the result is empty, so no `--settings` is emitted.
 */
export function mergeSettings(
	native: Readonly<Record<string, unknown>> | undefined,
	extra: ExtraAllowRules | undefined,
): Record<string, unknown> | undefined {
	const settings: Record<string, unknown> = structuredClone({ ...native });
	const rules = extra?.rules ?? [];
	const directories = extra?.additionalDirectories ?? [];
	if (rules.length > 0 || directories.length > 0) {
		const current = settings.permissions ?? {};
		if (!isRecord(current)) {
			throw new Error("native.claude.settings.permissions must be an object");
		}
		const permissions = { ...current };
		if (rules.length > 0) {
			permissions.allow = union(permissions.allow, rules, "allow");
		}
		if (directories.length > 0) {
			permissions.additionalDirectories = union(
				permissions.additionalDirectories,
				directories,
				"additionalDirectories",
			);
		}
		settings.permissions = permissions;
	}
	return Object.keys(settings).length > 0 ? settings : undefined;
}

function union(existing: unknown, added: readonly string[], field: string) {
	if (existing !== undefined && !Array.isArray(existing)) {
		throw new Error(
			`native.claude.settings.permissions.${field} must be an array`,
		);
	}
	return [...new Set([...(existing ?? []), ...added])];
}

/**
 * Text parts of an assistant message event, or undefined for any other
 * event, including assistant events that carry only tool calls.
 */
function assistantTextOf(event: unknown): string | undefined {
	if (!isRecord(event) || event.type !== "assistant") return undefined;
	const message = event.message;
	if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
	const parts = message.content.filter(
		(part): part is { type: "text"; text: string } =>
			isRecord(part) && part.type === "text" && typeof part.text === "string",
	);
	return parts.length > 0 ? parts.map((part) => part.text).join("") : undefined;
}
