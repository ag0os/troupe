import {
	accessSync,
	constants,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { codexDefaults, configuredHome } from "./codex-defaults";
import { loadConfig, userConfigFile } from "./config";
import type { ToolEnv } from "./sessions";

export type DoctorCheck = {
	id: string;
	status: "ok" | "gap" | "skip";
	subject?: string;
	summary: string;
	edit?: string;
};
export type DoctorResult = {
	home: string;
	today: string;
	checks: DoctorCheck[];
	totals: Record<DoctorCheck["status"], number>;
};

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readObject(file: string): {
	value: Record<string, unknown>;
	error?: string;
} {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!object(value)) throw new Error("expected a JSON object");
		return { value };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { value: {} };
		return { value: {}, error: reason(error) };
	}
}
function isFile(path: string, executable = false): boolean {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return false;
		if (executable) accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function directory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
function realpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
function quote(path: string): string {
	return `'${path.replaceAll("'", "'\\''")}'`;
}

// Read shell words without evaluating expansions or running the command.
function shellWords(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let quoted = "";
	let wordStarted = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i] ?? "";
		if (!quoted && char === "#" && !wordStarted) {
			while (i < command.length && command[i] !== "\n") i++;
			i--;
			continue;
		}
		if (char === "\\" && quoted !== "'") {
			const next = command[i + 1] ?? "";
			if (!quoted || /["\\$`\n]/.test(next)) {
				word += next === "\n" ? "" : next;
				i++;
			} else word += char;
		} else if (quoted) {
			if (char === quoted) quoted = "";
			else word += char;
		} else if (char === "'" || char === '"') quoted = char;
		else if (/\s|[;|&<>]/.test(char)) {
			if (word) words.push(word);
			word = "";
			wordStarted = false;
			continue;
		} else word += char;
		wordStarted = true;
	}
	if (quoted) return [];
	if (word) words.push(word);
	return words;
}
function hookPaths(settings: Record<string, unknown>, home: string): string[] {
	const hooks = settings.hooks;
	if (!object(hooks) || !Array.isArray(hooks.SessionStart)) return [];
	return hooks.SessionStart.flatMap((entry: unknown) => {
		if (!object(entry) || !Array.isArray(entry.hooks)) return [];
		return entry.hooks.flatMap((hook: unknown) => {
			if (!object(hook) || typeof hook.command !== "string") return [];
			const path = shellWords(hook.command).find((word) =>
				word.endsWith("herdr-agent-state.sh"),
			);
			return path
				? [path.startsWith("~/") ? join(home, path.slice(2)) : path]
				: [];
		});
	});
}

const statusLineCommand = `jq -r '"\\(.model.display_name) \\(.context_window.used_percentage // 0 | floor)%"'`;
const statusLineJson = `"statusLine": {"type": "command", "command": ${JSON.stringify(statusLineCommand)}}`;

/** Inspect only injected environment values and files, without starting commands. */
export function runDoctor(toolEnv: ToolEnv): DoctorResult {
	const { home, env, now } = toolEnv;
	const checks: DoctorCheck[] = [];
	const add = (
		id: string,
		status: DoctorCheck["status"],
		summary: string,
		subject?: string,
		edit?: string,
	) => {
		checks.push({
			id,
			status,
			...(subject ? { subject } : {}),
			summary,
			...(edit ? { edit } : {}),
		});
	};
	const configFile = userConfigFile(toolEnv);
	const config = loadConfig({ home, env, workspaceChain: [] });
	const homes: { path: string; source: string }[] = [];
	const addHome = (path: string, source: string) => {
		if (!homes.some((candidate) => realpath(candidate.path) === realpath(path)))
			homes.push({ path, source });
	};
	const configured = configuredHome(config, toolEnv);
	const validation = codexDefaults(
		config,
		{ ...toolEnv, env: { ...env, CODEX_HOME: undefined } },
		[],
		"new",
		false,
	);
	const validationError =
		config.codex.homeFile || !configured.path || !isAbsolute(configured.path)
			? validation.error
			: undefined;
	if (configured.path && !validationError) addHome(configured.path, "config");
	const environmentHome = env.CODEX_HOME
		? env.CODEX_HOME === "~"
			? home
			: env.CODEX_HOME.startsWith("~/")
				? join(home, env.CODEX_HOME.slice(2))
				: env.CODEX_HOME
		: undefined;
	if (environmentHome && isAbsolute(environmentHome))
		addHome(environmentHome, "environment");
	let enumerationError: string | undefined;
	try {
		for (const name of readdirSync(home).sort()) {
			if (name.startsWith(".codex") && directory(join(home, name)))
				addHome(join(home, name), "found");
		}
	} catch (error) {
		enumerationError = reason(error);
	}
	const codexConfigured =
		Object.hasOwn(readObject(configFile).value, "codex") ||
		Boolean(env.CODEX_HOME) ||
		homes.length > 0;
	const onPath = (name: string) => {
		if (env.PATH === undefined) return undefined;
		for (const entry of env.PATH.split(":")) {
			// Relative PATH entries resolve against the injected launch directory.
			const path = join(
				isAbsolute(entry) ? entry : join(toolEnv.cwd, entry),
				name,
			);
			if (isFile(path, true)) return path;
		}
		return undefined;
	};
	const herdr = onPath("herdr");
	for (const name of ["claude", "codex", "herdr", "jq"]) {
		const path = onPath(name);
		if (path) add(`path:${name}`, "ok", `${name} on PATH: ${path}`);
		else if (name === "codex" && !codexConfigured)
			add("path:codex", "skip", "codex not on PATH; Codex not configured");
		else if (name === "herdr")
			add(
				"path:herdr",
				"skip",
				"herdr not on PATH; Herdr hook checks skipped (Shepherd runs without it)",
			);
		else
			add(
				`path:${name}`,
				"gap",
				name === "jq"
					? "jq not on PATH; the status line needs it"
					: `${name} not on PATH`,
				undefined,
				name === "claude"
					? "install Claude Code: https://claude.com/claude-code"
					: name === "codex"
						? "install the Codex CLI: https://github.com/openai/codex"
						: "install jq: https://jqlang.org/download/",
			);
	}
	const shepherd = onPath("shepherd");
	if (!toolEnv.execPath)
		add("path:shepherd", "skip", "Shepherd executable path not provided");
	else if (shepherd && realpath(shepherd) === realpath(toolEnv.execPath))
		add("path:shepherd", "ok", `shepherd on PATH: ${shepherd}`);
	else
		add(
			"path:shepherd",
			"gap",
			shepherd ? "shepherd on PATH is not this binary" : "shepherd not on PATH",
			undefined,
			`add to your shell rc: export PATH=${quote(dirname(toolEnv.execPath))}:"$PATH"`,
		);
	for (const problem of config.problems) {
		const edit = `${problem.file}: ${problem.key}: ${problem.problem}`;
		add(
			"config:user",
			"gap",
			`${problem.key}: ${problem.problem}`,
			configFile,
			edit,
		);
	}
	if (validationError)
		add("config:user", "gap", validationError, configFile, validationError);
	if (environmentHome && !isAbsolute(environmentHome))
		add(
			"config:user",
			"gap",
			`CODEX_HOME is not an absolute path: ${env.CODEX_HOME}`,
			configFile,
			`CODEX_HOME is not an absolute path: ${env.CODEX_HOME}`,
		);
	if (!checks.some((check) => check.id === "config:user"))
		add("config:user", "ok", "user config valid or absent", configFile);
	const settingsFile = join(
		env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR)
			? env.CLAUDE_CONFIG_DIR
			: join(home, ".claude"),
		"settings.json",
	);
	const settings = readObject(settingsFile);
	add(
		"claude:settings",
		settings.error ? "gap" : "ok",
		settings.error ?? "valid JSON or absent",
		settingsFile,
		settings.error
			? `fix the JSON in ${settingsFile}: ${settings.error}`
			: undefined,
	);
	const hookCheck = (
		id: string,
		file: string,
		settings: ReturnType<typeof readObject>,
		backend: string,
		installEdit = `herdr integration install ${backend}`,
	) => {
		if (!herdr) {
			add(id, "skip", "Herdr not on PATH; hook check skipped", file);
			return;
		}
		if (settings.error) {
			add(
				id,
				"gap",
				settings.error,
				file,
				`fix the JSON in ${file}: ${settings.error}`,
			);
			return;
		}
		const paths = hookPaths(settings.value, home);
		const ok = paths.some((path) => isAbsolute(path) && isFile(path));
		add(
			id,
			ok ? "ok" : "gap",
			ok
				? "Herdr SessionStart hook installed"
				: paths.some((path) => !isAbsolute(path))
					? "hook script path must be absolute"
					: "Herdr SessionStart hook missing or script absent",
			file,
			ok ? undefined : installEdit,
		);
	};
	if (settings.error) {
		for (const id of ["cross-session-inbound", "status-line", "herdr-hook"])
			add(`claude:${id}`, "skip", "Claude settings unavailable", settingsFile);
	} else {
		const inbound = settings.value.crossSessionInbound === "accept";
		add(
			"claude:cross-session-inbound",
			inbound ? "ok" : "gap",
			inbound
				? 'crossSessionInbound is "accept"'
				: 'crossSessionInbound is not "accept"',
			settingsFile,
			inbound
				? undefined
				: `in ${settingsFile} add: "crossSessionInbound": "accept"`,
		);
		const status = settings.value.statusLine;
		const statusOk =
			object(status) &&
			status.type === "command" &&
			typeof status.command === "string" &&
			status.command.includes("used_percentage");
		add(
			"claude:status-line",
			statusOk ? "ok" : "gap",
			statusOk
				? "status line shows context %"
				: "no status line showing context %",
			settingsFile,
			statusOk ? undefined : `in ${settingsFile} add:\n${statusLineJson}`,
		);
		hookCheck("claude:herdr-hook", settingsFile, settings, "claude");
	}
	if (enumerationError)
		add(
			"codex:home",
			"skip",
			`Codex homes under HOME not listed: ${enumerationError}`,
		);
	if (!homes.length && !codexConfigured)
		add("codex:home", "skip", "Codex not configured");
	for (const { path, source } of homes) {
		const exists = directory(path);
		const loggedIn = exists && isFile(join(path, "auth.json"));
		add(
			`codex:home:${path}`,
			loggedIn ? "ok" : "gap",
			`Codex home ${path} (${source}): ${loggedIn ? "logged in (auth.json present)" : exists ? "not logged in" : "directory missing"}`,
			path,
			loggedIn
				? undefined
				: `${exists ? "" : `mkdir -p ${quote(path)}\n`}CODEX_HOME=${quote(path)} codex login`,
		);
	}
	for (const { path } of homes)
		hookCheck(
			`codex:herdr-hook:${path}`,
			join(path, "hooks.json"),
			readObject(join(path, "hooks.json")),
			"codex",
			realpath(path) === realpath(join(home, ".codex"))
				? "herdr integration install codex"
				: `herdr integration install codex (it installs into ~/.codex; for ${quote(path)}, symlink its hooks.json and herdr-agent-state.sh from there)`,
		);
	const totals = { ok: 0, gap: 0, skip: 0 };
	for (const check of checks) totals[check.status]++;
	const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	return { home, today, checks, totals };
}

export function renderDoctor(result: DoctorResult): string {
	const lines = [`Shepherd doctor, home ${result.home}, ${result.today}`, ""];
	for (const check of result.checks) {
		const summary =
			check.subject && !check.summary.includes(check.subject)
				? `${check.subject}: ${check.summary}`
				: check.summary;
		lines.push(`${check.status.toUpperCase().padEnd(6)}${summary}`);
		if (check.edit)
			lines.push(...check.edit.split("\n").map((line) => `      ${line}`));
	}
	lines.push(
		"",
		`${result.totals.ok} ok, ${result.totals.gap} ${result.totals.gap === 1 ? "gap" : "gaps"}, ${result.totals.skip} skipped`,
	);
	return lines.join("\n");
}
export function doctorJson(result: DoctorResult) {
	return { schema: 1, command: "doctor", ...result };
}
export function doctorExitCode(result: DoctorResult): 0 | 1 {
	return result.totals.gap > 0 ? 1 : 0;
}
