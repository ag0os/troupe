import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Config } from "./config";
import type { LaunchKind } from "./session-name";
import type { ToolEnv } from "./sessions";

export type CodexDefaultsResult = {
	codexHome?: string;
	model?: string;
	effort?: string;
	headerLine: string;
	error?: string;
};

/** Backend options before the passthrough's own `--`. */
function backendOptions(passthrough: readonly string[]): readonly string[] {
	const end = passthrough.indexOf("--");
	return end === -1 ? passthrough : passthrough.slice(0, end);
}

/** The first passthrough token that gives the backend a model. */
export function passthroughModelToken(
	passthrough: readonly string[],
): string | undefined {
	return backendOptions(passthrough).find(
		(token) =>
			token === "-m" || token === "--model" || token.startsWith("--model="),
	);
}

function hasPassthroughEffort(passthrough: readonly string[]): boolean {
	return backendOptions(passthrough).some((token) =>
		token.includes("model_reasoning_effort="),
	);
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

function configuredHome(
	config: Config,
	toolEnv: ToolEnv,
): { path?: string; source?: string; error?: string } {
	if (config.codex.homeFile) {
		let contents: string;
		try {
			contents = readFileSync(config.codex.homeFile, "utf8");
		} catch (error) {
			const reason =
				error instanceof Error ? error.message : "could not read file";
			return { error: `${config.codex.homeFile}: ${reason}` };
		}
		const line = contents.split(/\r?\n/).find((value) => value.trim());
		if (!line) {
			return {
				error: `${config.codex.homeFile}: expected a non-empty Codex home path`,
			};
		}
		return {
			path: expandHome(line.trim(), toolEnv.home),
			source: config.codex.homeFile,
		};
	}
	if (config.codex.home) {
		const configHome = expandHome(
			toolEnv.env.XDG_CONFIG_HOME || join(toolEnv.home, ".config"),
			toolEnv.home,
		);
		return {
			path: config.codex.home,
			source: join(configHome, "shepherd", "config.json"),
		};
	}
	return {};
}

function isDirectory(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Resolve Codex-only launch defaults and the matching prompt header line. */
export function codexDefaults(
	config: Config,
	toolEnv: ToolEnv,
	passthrough: readonly string[],
	kind: LaunchKind,
	modelFromFlag: boolean,
): CodexDefaultsResult {
	const passthroughModel = passthroughModelToken(passthrough);
	if (modelFromFlag && passthroughModel) {
		return {
			headerLine: "",
			error: `model given twice: --model and ${passthroughModel} after --`,
		};
	}

	let codexHome: string | undefined;
	let headerLine: string;
	if (toolEnv.env.CODEX_HOME) {
		const environmentHome = expandHome(toolEnv.env.CODEX_HOME, toolEnv.home);
		if (isAbsolute(environmentHome)) codexHome = environmentHome;
		headerLine = `- Codex home: ${environmentHome} (environment)`;
	} else {
		const configured = configuredHome(config, toolEnv);
		if (configured.error) return { headerLine: "", error: configured.error };
		if (configured.path) {
			if (!isAbsolute(configured.path)) {
				return {
					headerLine: "",
					error: `${configured.source}: Codex home is not an absolute path: ${configured.path}`,
				};
			}
			if (!isDirectory(configured.path)) {
				return {
					headerLine: "",
					error: `${configured.source}: Codex home is not an existing directory: ${configured.path}`,
				};
			}
			codexHome = configured.path;
			headerLine = `- Codex home: ${codexHome} (config)`;
		} else {
			headerLine = `- Codex home: ${join(toolEnv.home, ".codex")} (Codex default)`;
		}
	}

	const keepsConversation = kind !== "new";
	return {
		...(codexHome ? { codexHome } : {}),
		...(!modelFromFlag &&
		!passthroughModel &&
		!keepsConversation &&
		config.codex.model !== undefined
			? { model: config.codex.model }
			: {}),
		...(!hasPassthroughEffort(passthrough) &&
		!keepsConversation &&
		config.codex.effort !== undefined
			? { effort: config.codex.effort }
			: {}),
		headerLine,
	};
}
