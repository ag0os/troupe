import { basename } from "node:path";
import type { AgentMode, Backend } from "../agent-format/types";

export type LaunchKind = "new" | "resume";

export type SessionNameOptions = {
	backend: Backend;
	passthrough: readonly string[];
	mode: AgentMode;
	cwd: string;
	requestedName?: string;
	sessionPrefix?: string;
	now: Date;
	hasChildren: boolean;
	takenNames: ReadonlySet<string>;
};

export type SessionNameResult = {
	kind: LaunchKind;
	sessionName?: string;
	headerLines: string[];
	error?: string;
};

const SESSION_NAME = /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)+$/;
const CLAUDE_RESUME = new Set([
	"--resume",
	"-r",
	"--continue",
	"-c",
	"--from-pr",
	"--teleport",
]);

/** Backend options before the passthrough's own `--`. */
function backendOptions(passthrough: readonly string[]): readonly string[] {
	const end = passthrough.indexOf("--");
	return end === -1 ? passthrough : passthrough.slice(0, end);
}

function isClaudeResume(token: string): boolean {
	if (CLAUDE_RESUME.has(token)) return true;
	return ["--resume=", "--continue=", "--from-pr=", "--teleport="].some(
		(prefix) => token.startsWith(prefix),
	);
}

/** Classify a launch from the backend options in its verbatim passthrough. */
export function launchKind(
	backend: Backend,
	passthrough: readonly string[],
): LaunchKind {
	const options = backendOptions(passthrough);
	if (backend === "codex") {
		return options.includes("resume") || options.includes("fork")
			? "resume"
			: "new";
	}
	return options.some(isClaudeResume) ? "resume" : "new";
}

function claudePassthroughName(
	passthrough: readonly string[],
): string | undefined {
	const options = backendOptions(passthrough);
	for (let index = 0; index < options.length; index++) {
		const token = options[index] ?? "";
		if (token === "-n" || token === "--name") return options[index + 1];
		if (token.startsWith("--name=")) return token.slice("--name=".length);
	}
	return undefined;
}

function twoDigits(value: number): string {
	return String(value).padStart(2, "0");
}

/** The unsuffixed conventional name for a launch directory and local date. */
export function defaultSessionName(
	cwd: string,
	now: Date,
	sessionPrefix: string | undefined,
	hasChildren: boolean,
): string {
	let prefix =
		sessionPrefix ??
		basename(cwd)
			.replace(/[^A-Za-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
	if (!prefix) prefix = "ws";
	if (!/^[A-Za-z]/.test(prefix)) prefix = `ws-${prefix}`;
	if (/shepherd/i.test(prefix)) prefix = hasChildren ? "root" : "ws";
	return `${prefix}-${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`;
}

function availableName(
	base: string,
	taken: ReadonlySet<string>,
	now: Date,
): string {
	if (!taken.has(base)) return base;
	for (let code = "b".charCodeAt(0); code <= "z".charCodeAt(0); code++) {
		const candidate = `${base}${String.fromCharCode(code)}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}`;
}

function validateRequestedName(name: string): string | undefined {
	if (!SESSION_NAME.test(name)) {
		return "session name must start with a letter and contain at least one hyphen-separated letters-or-digits segment";
	}
	if (/shepherd/i.test(name)) {
		return 'session name must not contain "shepherd"';
	}
	return undefined;
}

/** Resolve the launch name, the matching prompt header line, or a usage error. */
export function sessionNameFor(options: SessionNameOptions): SessionNameResult {
	const kind = launchKind(options.backend, options.passthrough);
	const passthroughName =
		options.backend === "claude"
			? claudePassthroughName(options.passthrough)
			: undefined;

	if (
		kind === "resume" &&
		(options.requestedName || passthroughName !== undefined)
	) {
		return {
			kind,
			headerLines: [],
			error:
				"a resumed session keeps its name; rename it from inside the session",
		};
	}
	if (options.backend === "codex" && options.requestedName) {
		return {
			kind,
			headerLines: [],
			error:
				"Codex takes no session name at launch; start the session and name it with its rename dialog",
		};
	}
	if (options.requestedName && passthroughName !== undefined) {
		return {
			kind,
			headerLines: [],
			error: "session name given twice: --name and a name after --",
		};
	}
	if (options.requestedName) {
		const error = validateRequestedName(options.requestedName);
		if (error) return { kind, headerLines: [], error };
	}

	if (options.mode !== "interactive" || kind !== "new") {
		return { kind, headerLines: [] };
	}

	if (options.requestedName) {
		return {
			kind,
			sessionName: options.requestedName,
			headerLines: [
				`- Session name: ${options.requestedName} (set by the launcher: use it as it stands in CURRENT.md and in messages, do not rename yourself)`,
			],
		};
	}
	if (passthroughName !== undefined) {
		return {
			kind,
			headerLines: [
				`- Session name: ${passthroughName} (given at launch: use it as it stands in CURRENT.md and in messages, do not rename yourself)`,
			],
		};
	}

	const base = defaultSessionName(
		options.cwd,
		options.now,
		options.sessionPrefix,
		options.hasChildren,
	);
	const name = availableName(base, options.takenNames, options.now);
	if (options.backend === "codex") {
		return {
			kind,
			headerLines: [
				`- Session name: not set (Codex takes no name at launch: name it with its rename dialog, suggested ${name}, then record the name the host reports)`,
			],
		};
	}
	return {
		kind,
		sessionName: name,
		headerLines: [
			`- Session name: ${name} (set by the launcher: use it as it stands in CURRENT.md and in messages, do not rename yourself)`,
		],
	};
}
