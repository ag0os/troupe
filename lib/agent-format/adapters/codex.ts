import { BARE_CONFIG_PATH } from "../schema";
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
	Invocation,
	ResolvedHeaderValue,
	ResolvedMcpServer,
	ResolvedValue,
	ResourceNeeds,
	ResourcePaths,
	StreamDecoder,
} from "./types";

/** D-014: coarse access levels as Codex sandbox flags. */
const ACCESS_FLAGS: Record<Access, string[]> = {
	"read-only": ["-s", "read-only"],
	"workspace-write": ["-s", "workspace-write"],
	full: ["--dangerously-bypass-approvals-and-sandbox"],
};

export const codexAdapter: BackendAdapter = {
	id: "codex",

	resources(inv: Invocation): ResourceNeeds {
		if (inv.spec.promptMode === "replace" && inv.systemPrompt.length > 0) {
			return { promptFile: inv.systemPrompt };
		}
		return {};
	},

	build(inv: Invocation, paths: ResourcePaths): CommandPlan {
		assertInvocation(inv, "codex");
		const { spec } = inv;
		const extra = inv.extraAllowRules;
		if (
			extra &&
			(extra.rules.length > 0 || (extra.additionalDirectories ?? []).length > 0)
		) {
			throw new Error(
				`${spec.id}: allow rules are Claude-only and are not emulated on codex`,
			);
		}
		const out = new ArgvBuilder();
		const exec = inv.mode !== "interactive";

		if (exec) {
			out.push("exec");
			if (inv.mode === "stream") out.push("--json");
			if (!inv.insideGitWorktree) out.push("--skip-git-repo-check");
		}

		if (inv.systemPrompt.length > 0) {
			if (spec.promptMode === "replace") {
				if (!paths.promptFile) {
					throw new Error(
						"the codex adapter needs a promptFile resource path for replace mode",
					);
				}
				out.push(
					"-c",
					`model_instructions_file=${tomlString(paths.promptFile)}`,
				);
			} else {
				out.push(
					"-c",
					`developer_instructions=${tomlString(inv.systemPrompt)}`,
				);
			}
		}

		const model = inv.model ?? spec.model?.codex;
		if (model !== undefined) out.push("-m", model);
		const effort = inv.effort ?? spec.effort?.codex;
		if (effort !== undefined) {
			out.push("-c", `model_reasoning_effort=${tomlString(effort)}`);
		}
		if (spec.access !== undefined) out.push(...ACCESS_FLAGS[spec.access]);

		for (const [name, server] of Object.entries(inv.mcp)) {
			const entry = mcpEntry(name, server);
			out.push("-c").pushValue(entry.actual, entry.display);
		}

		for (const [key, value] of Object.entries(
			spec.native?.codex?.config ?? {},
		)) {
			out.push("-c", `${configKey(key)}=${tomlValue(value, key)}`);
		}
		out.push(...nativeArgv(spec.native?.codex?.args));
		out.push(...inv.passthrough);
		// `--` keeps a prompt such as `apply` or `-c x=y` from parsing as a
		// subcommand or flag.
		if (inv.initialPrompt.length > 0) out.push("--", inv.initialPrompt);

		return {
			executable: "codex",
			argv: out.argv,
			displayArgv: out.displayArgv,
			cwd: inv.cwd,
			stdin: exec ? "ignore" : "inherit",
			stdout: exec ? "pipe" : "inherit",
			stderr: inv.mode === "print" ? "pipe" : "inherit",
			env: {},
		};
	},

	decoder(): StreamDecoder {
		return {
			line(text) {
				if (text.trim().length === 0) return [];
				const event = parseJsonLine(text, "codex");
				const message = agentMessageOf(event);
				if (message !== undefined) {
					return [{ stream: "stdout", text: `${message}\n` }];
				}
				return [{ stream: "stderr", text: `${JSON.stringify(event)}\n` }];
			},
			end: (): Emission[] => [],
		};
	},
};

/** `mcp_servers.<name>={...}` as an inline TOML table. */
function mcpEntry(name: string, server: ResolvedMcpServer): Rendered {
	return render((pick) => {
		const fields: string[] = [];
		const add = (key: string, value: string) =>
			fields.push(`${tomlKey(key)} = ${value}`);
		const table = (
			record: Record<string, ResolvedValue | ResolvedHeaderValue>,
		) =>
			inlineTable(
				Object.entries(record).map(([key, value]) => [
					key,
					tomlString(pick(value)),
				]),
			);

		if (isStdio(server)) {
			add("command", tomlString(pick(server.command)));
			if (server.args) {
				add(
					"args",
					`[${server.args.map((arg) => tomlString(pick(arg))).join(", ")}]`,
				);
			}
			if (server.env) add("env", table(server.env));
			if (server.cwd) add("cwd", tomlString(pick(server.cwd)));
		} else {
			add("url", tomlString(pick(server.url)));
			const headers = Object.entries(server.headers ?? {});
			const literal = headers.filter(([, value]) => !value.secretEnv);
			// D-029: interpolated header values travel by environment reference.
			const secret = headers.filter(([, value]) => value.secretEnv);
			if (literal.length > 0) {
				add("http_headers", table(Object.fromEntries(literal)));
			}
			if (secret.length > 0) {
				add(
					"env_http_headers",
					inlineTable(
						secret.map(([key, value]) => [
							key,
							tomlString(value.secretEnv ?? ""),
						]),
					),
				);
			}
		}
		return `mcp_servers.${name}={${fields.join(", ")}}`;
	});
}

function inlineTable(entries: [string, string][]): string {
	return `{${entries.map(([key, value]) => `${tomlKey(key)} = ${value}`).join(", ")}}`;
}

/**
 * A TOML basic string. JSON escapes are valid TOML except that DEL must be
 * escaped too, and a lone surrogate has no TOML form at all.
 */
export function tomlString(text: string): string {
	if (!text.isWellFormed()) {
		throw new Error("text with an unpaired surrogate has no TOML form");
	}
	return JSON.stringify(text).replace(/\u007f/g, "\\u007F");
}

function tomlKey(key: string): string {
	return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** Codex splits `-c` keys on "." without TOML parsing, so only bare paths work. */
function configKey(key: string): string {
	if (!BARE_CONFIG_PATH.test(key)) {
		throw new Error(`native.codex.config.${key}: must be a bare dotted key`);
	}
	return key;
}

export function tomlValue(value: unknown, path: string): string {
	if (typeof value === "string") return tomlString(value);
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (Array.isArray(value)) {
		return `[${value.map((item, i) => tomlValue(item, `${path}[${i}]`)).join(", ")}]`;
	}
	if (isRecord(value)) {
		return inlineTable(
			Object.entries(value).map(([key, item]) => [
				key,
				tomlValue(item, `${path}.${key}`),
			]),
		);
	}
	throw new Error(
		`native.codex.config.${path}: ${value === null ? "null" : typeof value} has no TOML form`,
	);
}

/** Text of a completed agent message event, or undefined for any other event. */
function agentMessageOf(event: unknown): string | undefined {
	if (!isRecord(event) || event.type !== "item.completed") return undefined;
	const item = event.item;
	if (
		!isRecord(item) ||
		item.type !== "agent_message" ||
		typeof item.text !== "string"
	) {
		return undefined;
	}
	return item.text;
}
