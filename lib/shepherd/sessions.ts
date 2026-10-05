import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CommandRequest, CommandResult } from "../agent-format/types";
import type { Config } from "./config";

export type Running = {
	name: string;
	cwd: string;
	status: string;
	harness: "claude" | "codex";
};

export type AdapterResult =
	| { available: true; sessions: Running[] }
	| { available: false; reason: string };

export type ToolEnv = {
	cwd: string;
	home: string;
	env: Readonly<Record<string, string | undefined>>;
	now: Date;
	runCommand: (request: CommandRequest) => Promise<CommandResult>;
	pidAlive: (pid: number) => boolean;
};

export type RunningSessionsResult = {
	sessions: Running[];
	claude: AdapterResult;
	herdr: AdapterResult;
	codex: AdapterResult;
};

type HerdrAgent = {
	agent?: string;
	agent_session?: { value?: string };
	cwd?: string;
	agent_status?: string;
	name?: string;
};

type HerdrResult = AdapterResult & { agents?: HerdrAgent[] };

function text(file: string): string {
	return readFileSync(file, "utf8");
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : "unknown error";
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/** Live Claude sessions from the harness registry. */
export function claudeSessions(toolEnv: ToolEnv): AdapterResult {
	const dir = join(toolEnv.home, ".claude", "sessions");
	if (!existsSync(dir)) {
		return { available: false, reason: "Claude session registry not found" };
	}

	const sessions: Running[] = [];
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch (error) {
		return {
			available: false,
			reason: `Claude session registry could not be read: ${reason(error)}`,
		};
	}
	for (const file of files) {
		if (!/^\d+\.json$/.test(file)) continue;
		try {
			const entry = JSON.parse(text(join(dir, file))) as Record<
				string,
				unknown
			>;
			const pid = Number(entry.pid);
			if (!entry.name || !Number.isFinite(pid) || !toolEnv.pidAlive(pid)) {
				continue;
			}
			sessions.push({
				name: String(entry.name),
				cwd: typeof entry.cwd === "string" ? entry.cwd : "",
				status: typeof entry.status === "string" ? entry.status : "?",
				harness: "claude",
			});
		} catch {
			// A malformed entry or a dead process does not invalidate the registry.
		}
	}
	return { available: true, sessions };
}

/** Newest Claude transcript modification time for sessions launched in cwd. */
export function latestClaudeTranscriptMtime(
	toolEnv: Pick<ToolEnv, "home">,
	cwd: string,
): number | undefined {
	const key = cwd.replace(/[^A-Za-z0-9]/g, "-");
	const dir = join(toolEnv.home, ".claude", "projects", key);
	try {
		const mtimes = readdirSync(dir)
			.filter((file) => file.endsWith(".jsonl"))
			.flatMap((file) => {
				try {
					return [statSync(join(dir, file)).mtimeMs];
				} catch {
					return [];
				}
			});
		return mtimes.length > 0 ? Math.max(...mtimes) : undefined;
	} catch {
		return undefined;
	}
}

function asRunning(agent: HerdrAgent): Running | undefined {
	if (agent.agent !== "claude" && agent.agent !== "codex") return undefined;
	const id = agent.agent_session?.value ?? "";
	return {
		name:
			agent.name ??
			(agent.agent === "codex"
				? `codex ${id.slice(0, 8)} (unnamed)`
				: `claude ${id.slice(0, 8)} (unnamed)`),
		cwd: agent.cwd ?? "",
		status: agent.agent_status ?? "?",
		harness: agent.agent,
	};
}

/** Herdr's agent list, available only from inside a Herdr environment. */
export async function herdrSessions(
	toolEnv: ToolEnv,
	timeoutMs = 10_000,
): Promise<HerdrResult> {
	if (toolEnv.env.HERDR_ENV !== "1") {
		return { available: false, reason: "not inside Herdr" };
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("herdr agent list timed out")),
				timeoutMs,
			);
		});
		const result = await Promise.race([
			toolEnv.runCommand({ argv: ["herdr", "agent", "list"] }),
			timedOut,
		]);
		if (result.exitCode !== 0) {
			return {
				available: false,
				reason: `herdr agent list exited ${result.exitCode}`,
			};
		}
		const parsed = JSON.parse(result.stdout) as {
			result?: { agents?: unknown };
		};
		if (!Array.isArray(parsed.result?.agents)) {
			return {
				available: false,
				reason: "herdr agent list returned invalid JSON",
			};
		}
		const agents = parsed.result.agents.filter(
			(value): value is HerdrAgent =>
				typeof value === "object" && value !== null,
		);
		return {
			available: true,
			sessions: agents.flatMap((agent) => {
				const session = asRunning(agent);
				return session ? [session] : [];
			}),
			agents,
		};
	} catch (error) {
		return { available: false, reason: reason(error) };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function configuredCodexHome(
	toolEnv: ToolEnv,
	config: Config,
): string | undefined {
	if (config.codex.home) return expandHome(config.codex.home, toolEnv.home);
	if (!config.codex.homeFile) return undefined;
	try {
		const line = text(expandHome(config.codex.homeFile, toolEnv.home))
			.split("\n")
			.find((candidate) => candidate.trim());
		if (!line) return undefined;
		return expandHome(line.trim(), toolEnv.home);
	} catch {
		return undefined;
	}
}

function codexHomes(toolEnv: ToolEnv, config: Config): string[] {
	const homes = new Set<string>();
	const add = (path: string | undefined) => {
		if (!path) return;
		const expanded = expandHome(path, toolEnv.home);
		if (isAbsolute(expanded)) homes.add(expanded);
	};
	add(toolEnv.env.CODEX_HOME);
	add(configuredCodexHome(toolEnv, config));
	try {
		for (const entry of readdirSync(toolEnv.home, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith(".codex")) continue;
			const home = join(toolEnv.home, entry.name);
			if (existsSync(join(home, "session_index.jsonl"))) homes.add(home);
		}
	} catch {
		// Explicit Codex homes can still be read when the home directory cannot.
	}
	return [...homes];
}

/** Codex thread names from every eligible home, with the last rename winning. */
export function codexThreadNames(
	toolEnv: ToolEnv,
	config: Config,
): Map<string, string> {
	const names = new Map<string, string>();
	for (const home of codexHomes(toolEnv, config)) {
		try {
			for (const line of text(join(home, "session_index.jsonl")).split("\n")) {
				try {
					const entry = JSON.parse(line) as Record<string, unknown>;
					if (
						typeof entry.id === "string" &&
						typeof entry.thread_name === "string"
					) {
						names.set(entry.id, entry.thread_name);
					}
				} catch {
					// Blank and partial trailing lines are normal for an active index.
				}
			}
		} catch {
			// One unreadable home does not hide indexes from the other homes.
		}
	}
	return names;
}

function codexSessions(
	toolEnv: ToolEnv,
	config: Config,
	herdr: HerdrResult,
): AdapterResult {
	if (!herdr.available) return { available: false, reason: herdr.reason };
	const names = codexThreadNames(toolEnv, config);
	const sessions = (herdr.agents ?? [])
		.filter((agent) => agent.agent === "codex")
		.map((agent): Running => {
			const id = agent.agent_session?.value ?? "";
			return {
				name:
					names.get(id) ??
					(agent.name
						? `${agent.name} (Herdr label; session unnamed)`
						: `codex ${id.slice(0, 8)} (unnamed)`),
				cwd: agent.cwd ?? "",
				status: agent.agent_status ?? "?",
				harness: "codex",
			};
		});
	return { available: true, sessions };
}

/** Collect running sessions and the availability of all three sources. */
export async function runningSessions(
	toolEnv: ToolEnv,
	config: Config,
): Promise<RunningSessionsResult> {
	const claude = claudeSessions(toolEnv);
	const herdr = await herdrSessions(toolEnv);
	const codex = codexSessions(toolEnv, config, herdr);
	return {
		sessions: [
			...(claude.available ? claude.sessions : []),
			...(codex.available ? codex.sessions : []),
		],
		claude,
		herdr,
		codex,
	};
}
