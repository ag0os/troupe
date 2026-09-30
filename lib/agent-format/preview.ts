import type {
	ResolvedHeaderValue,
	ResolvedMcpServer,
	ResolvedValue,
	ResourceNeeds,
	ResourcePaths,
} from "./adapters/types";
import { mcpSecretEnvName, scanInterpolations } from "./command-text";
import type { Backend, McpServer } from "./types";

/**
 * Stable stand-ins for values that exist only at launch (D-012). Preview
 * never creates the resource or resolves the reference, so snapshots do not
 * depend on the clock, temp directories or secrets.
 */
export const PREVIEW_PLACEHOLDERS = {
	promptFile: "<temp:prompt-file>",
	tmpDir: "<temp:dir>",
	env: (name: string) => `<redacted:env:${name}>`,
	cmd: "<redacted:cmd>",
} as const;

/** Placeholder paths for exactly the resources an adapter asked for. */
export function previewResourcePaths(needs: ResourceNeeds): ResourcePaths {
	const paths: ResourcePaths = {};
	if (needs.promptFile !== undefined) {
		paths.promptFile = PREVIEW_PLACEHOLDERS.promptFile;
	}
	if (needs.tmpDir) paths.tmpDir = PREVIEW_PLACEHOLDERS.tmpDir;
	return paths;
}

/**
 * Declared MCP servers as adapter input without resolving anything: every
 * `${env:...}`/`${cmd:...}` reference becomes a redacted placeholder in both
 * `actual` and `display`, and an interpolated header value carries its
 * D-029 variable name so adapters emit a reference, never the value.
 */
export function previewMcp(
	servers: Readonly<Record<string, McpServer>> | undefined,
): Record<string, ResolvedMcpServer> {
	const resolved: Record<string, ResolvedMcpServer> = {};
	for (const [name, server] of Object.entries(servers ?? {})) {
		if ("command" in server) {
			resolved[name] = {
				command: placeholder(server.command),
				...(server.args ? { args: server.args.map(placeholder) } : {}),
				...(server.env ? { env: mapValues(server.env, placeholder) } : {}),
				...(server.cwd !== undefined ? { cwd: placeholder(server.cwd) } : {}),
			};
			continue;
		}
		const headers: Record<string, ResolvedHeaderValue> = {};
		for (const [header, value] of Object.entries(server.headers ?? {})) {
			headers[header] = interpolated(value)
				? { ...placeholder(value), secretEnv: mcpSecretEnvName(name, header) }
				: placeholder(value);
		}
		resolved[name] = {
			url: placeholder(server.url),
			...(server.headers ? { headers } : {}),
		};
	}
	return resolved;
}

function interpolated(value: string): boolean {
	const scan = scanInterpolations(value);
	return !scan.ok || scan.references.length > 0;
}

/** The value with each reference replaced; a malformed one hides the value. */
function placeholder(value: string): ResolvedValue {
	const scan = scanInterpolations(value);
	if (!scan.ok) {
		return {
			actual: PREVIEW_PLACEHOLDERS.cmd,
			display: PREVIEW_PLACEHOLDERS.cmd,
		};
	}
	let shown = value;
	for (const reference of scan.references) {
		const stand =
			reference.kind === "env"
				? PREVIEW_PLACEHOLDERS.env(reference.name)
				: PREVIEW_PLACEHOLDERS.cmd;
		shown = shown.replace(reference.raw, () => stand);
	}
	return { actual: shown, display: shown };
}

function mapValues<T, U>(
	record: Readonly<Record<string, T>>,
	map: (value: T) => U,
): Record<string, U> {
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [key, map(value)]),
	);
}

export interface PreviewEnvelope {
	backend: Backend;
	systemPrompt: string;
	initialPrompt: string;
	/** Executable followed by the plan's redacted `displayArgv`. */
	argv: readonly string[];
}

/** The fixed `--show-prompt` format (Design §3). */
export function formatPreview(envelope: PreviewEnvelope): string {
	return [
		`Backend: ${envelope.backend}`,
		"--- System prompt ---",
		envelope.systemPrompt,
		"--- Initial prompt ---",
		envelope.initialPrompt,
		"--- Argv ---",
		JSON.stringify(envelope.argv),
		"",
	].join("\n");
}
