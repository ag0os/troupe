import { resolve } from "node:path";
import {
	type AgentMode,
	type AgentSpec,
	BACKENDS,
	type Backend,
	FRAMEWORK_OPTIONS,
	FRAMEWORK_SHORTS,
	type FrameworkOption,
	forwardsPassthrough,
} from "./types";

/**
 * The parsed command line of a generated binary: what the runner hands to
 * preparation, preview and the adapters. Framework flags are resolved into
 * `backend`, `mode`, `model`, `cwd` and `showPrompt`; only declared agent
 * flags appear in `flags`.
 */
export interface ParsedInvocation {
	backend: Backend;
	/** Effective mode: `print` under `--print`, else the spec's mode. */
	mode: AgentMode;
	/** `--model`, else the spec's model for the selected backend. */
	model?: string;
	/** Absolute effective working directory; `resolveCli` checks it exists. */
	cwd: string;
	/** Declared agent flags with defaults applied; booleans default to false. */
	flags: Record<string, string | boolean>;
	/** Positionals in order, plus every post-`--` token when the spec opts out (D-039). */
	args: string[];
	/** Every token after the first standalone `--`, verbatim; always empty when the spec opts out (D-039). */
	passthrough: string[];
	showPrompt: boolean;
}

export type CliOutcome =
	| { kind: "help"; text: string }
	| { kind: "run"; invocation: ParsedInvocation };

/** A parse, cwd or backend error: reported on stderr with a nonzero exit. */
export class CliError extends Error {
	readonly exitCode = 2;

	constructor(message: string) {
		super(message);
		this.name = "CliError";
	}
}

export interface CliIo {
	/** Base directory for `--cwd` and the default working directory. */
	cwd: string;
	stdout(text: string): void;
	stderr(text: string): void;
	/** Whether `path` is a directory, or "missing" when nothing is there. */
	isDirectory(path: string): boolean | "missing";
}

type Option =
	| { kind: "framework"; name: FrameworkOption; takesValue: boolean }
	| { kind: "agent"; name: string; takesValue: boolean };

const HELP_TOKENS = new Set([
	"--help",
	...Object.entries(FRAMEWORK_SHORTS)
		.filter(([, name]) => name === "help")
		.map(([short]) => `-${short}`),
]);

/**
 * Parse a binary's argv (without the executable and script) against its
 * spec. Everything after the first standalone `--` is passthrough and is
 * never inspected (D-013, D-028), unless the spec opts out with
 * `passthrough: false`: then those tokens are positional arguments, appended
 * to `args` in order, and the tail stays empty (D-039). Before it, only framework flags, declared
 * agent flags and positionals are accepted. `--help`/`-h` anywhere before
 * the separator wins over every other input. The backend is `--backend`,
 * else the first declared backend; the environment is never read (D-021).
 * Parsing is pure: `cwd` is resolved but not checked (see `resolveCli`).
 */
export function parseCli(
	spec: Readonly<AgentSpec>,
	argv: readonly string[],
	options: { cwd: string },
): CliOutcome {
	const separator = argv.indexOf("--");
	const before = separator === -1 ? argv : argv.slice(0, separator);
	const tail = separator === -1 ? [] : argv.slice(separator + 1);
	const forwards = forwardsPassthrough(spec);
	const passthrough = forwards ? tail : [];

	if (before.some((token) => HELP_TOKENS.has(token))) {
		return { kind: "help", text: formatHelp(spec) };
	}

	const framework: Partial<Record<FrameworkOption, string | true>> = {};
	const given: Record<string, string | boolean> = {};
	const args: string[] = [];

	for (let i = 0; i < before.length; i++) {
		const token = before[i] ?? "";
		if (!token.startsWith("-") || token === "-") {
			args.push(token);
			continue;
		}
		const equals = token.startsWith("--") ? token.indexOf("=") : -1;
		const written = equals === -1 ? token : token.slice(0, equals);
		const option = lookupOption(spec, written);
		if (!option) {
			throw new CliError(
				forwards
					? `${spec.id}: unknown option "${written}". Backend flags go after a standalone -- (for example: ${spec.id} -- ${written}); see --help`
					: `${spec.id}: unknown option "${written}"; this agent passes nothing to the backend CLI, see --help`,
			);
		}
		let value: string | true = true;
		if (option.takesValue) {
			if (equals !== -1) {
				value = token.slice(equals + 1);
			} else {
				const next = before[i + 1];
				if (next === undefined || next.startsWith("-")) {
					throw new CliError(
						`${spec.id}: "${written}" requires a value (${valueHint(option, written)})`,
					);
				}
				value = next;
				i++;
			}
		} else if (equals !== -1) {
			throw new CliError(`${spec.id}: "${written}" does not take a value`);
		}

		if (option.kind === "framework") {
			if (value === "") {
				throw new CliError(
					`${spec.id}: "${written}" requires a non-empty value`,
				);
			}
			framework[option.name] = value;
			continue;
		}
		const flag = spec.flags[option.name];
		if (flag?.type === "enum" && !flag.values.includes(value as string)) {
			throw new CliError(
				`${spec.id}: "--${option.name}" must be one of ${flag.values.join(", ")} (got "${value}")`,
			);
		}
		given[option.name] = value;
	}
	if (!forwards) args.push(...tail);

	const backend = resolveBackend(spec, framework.backend);
	const cwd =
		typeof framework.cwd === "string"
			? resolve(options.cwd, framework.cwd)
			: resolve(options.cwd);
	const model =
		typeof framework.model === "string"
			? framework.model
			: spec.model?.[backend];

	const flags: Record<string, string | boolean> = {};
	for (const [name, flag] of Object.entries(spec.flags)) {
		const value = given[name] ?? flag.default;
		if (value !== undefined) flags[name] = value;
		else if (flag.type === "boolean") flags[name] = false;
	}

	const invocation: ParsedInvocation = {
		backend,
		mode: framework.print ? "print" : spec.mode,
		cwd,
		flags,
		args,
		passthrough,
		showPrompt: framework["show-prompt"] === true,
	};
	if (model !== undefined) invocation.model = model;
	return { kind: "run", invocation };
}

/**
 * The CLI front of a generated binary: help goes to stdout with exit 0,
 * parse/cwd/backend errors to stderr with exit 2, and only a valid command
 * line yields an invocation, so no error path can reach preparation.
 */
export function resolveCli(
	spec: Readonly<AgentSpec>,
	argv: readonly string[],
	io: CliIo,
): { exitCode: number } | { invocation: ParsedInvocation } {
	let outcome: CliOutcome;
	try {
		outcome = parseCli(spec, argv, { cwd: io.cwd });
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
		io.stderr(`${error.message}\n`);
		return { exitCode: error.exitCode };
	}
	if (outcome.kind === "help") {
		io.stdout(outcome.text);
		return { exitCode: 0 };
	}
	const { cwd } = outcome.invocation;
	const isDirectory = io.isDirectory(cwd);
	if (isDirectory !== true) {
		const problem =
			isDirectory === "missing" ? "does not exist" : "is not a directory";
		io.stderr(`${spec.id}: working directory ${cwd} ${problem}\n`);
		return { exitCode: 2 };
	}
	return { invocation: outcome.invocation };
}

function lookupOption(
	spec: Readonly<AgentSpec>,
	written: string,
): Option | undefined {
	if (written.startsWith("--")) {
		const name = written.slice(2);
		if (Object.hasOwn(FRAMEWORK_OPTIONS, name)) {
			const framework = name as FrameworkOption;
			return {
				kind: "framework",
				name: framework,
				takesValue: FRAMEWORK_OPTIONS[framework].takesValue,
			};
		}
		const flag = Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined;
		if (!flag) return undefined;
		return { kind: "agent", name, takesValue: flag.type !== "boolean" };
	}
	if (!/^-[A-Za-z]$/.test(written)) return undefined;
	const short = written.slice(1);
	for (const [name, flag] of Object.entries(spec.flags)) {
		if (flag.short === short) {
			return { kind: "agent", name, takesValue: flag.type !== "boolean" };
		}
	}
	return undefined;
}

function resolveBackend(
	spec: Readonly<AgentSpec>,
	requested: string | true | undefined,
): Backend {
	if (typeof requested !== "string") return spec.backends[0];
	const declared = spec.backends.join(", ");
	if (!(BACKENDS as readonly string[]).includes(requested)) {
		throw new CliError(
			`${spec.id}: unknown backend "${requested}" (declared: ${declared})`,
		);
	}
	const backend = requested as Backend;
	if (!spec.backends.includes(backend)) {
		throw new CliError(
			`${spec.id}: backend "${backend}" is not declared by this agent (declared: ${declared})`,
		);
	}
	return backend;
}

/** How to pass a value, including one that starts with "-". */
function valueHint(option: Option, written: string): string {
	const long = `--${option.name}`;
	const dashValue = `for a value starting with "-" use ${long}=<value>`;
	if (written === long) return `use ${long} <value>; ${dashValue}`;
	return `use ${written} <value> or ${long} <value>; ${dashValue}`;
}

/** `--help` text, generated entirely from the spec. */
export function formatHelp(spec: Readonly<AgentSpec>): string {
	const [first, ...rest] = spec.backends;
	const models = spec.backends
		.filter((backend) => spec.model?.[backend] !== undefined)
		.map((backend) => `${backend}=${spec.model?.[backend]}`);

	const framework: [string, string][] = [
		[
			`--backend <${spec.backends.join("|")}>`,
			`Backend to run on (default: ${first})`,
		],
		["--cwd <dir>", "Working directory (default: current directory)"],
		[
			"--model <id>",
			models.length > 0
				? `Override the backend model (declared: ${models.join(", ")})`
				: "Override the backend model",
		],
		["--print", "Run in print mode (non-interactive, prints the result)"],
		[
			"--show-prompt",
			"Print the resolved prompt and argv per backend, then exit",
		],
		["-h, --help", "Show this help and exit"],
	];

	const agent: [string, string][] = Object.entries(spec.flags).map(
		([name, flag]) => {
			const long = `--${name}`;
			const value =
				flag.type === "boolean"
					? ""
					: flag.type === "enum"
						? ` <${flag.values.join("|")}>`
						: " <value>";
			const label = `${flag.short ? `-${flag.short}, ` : ""}${long}${value}`;
			const fallback =
				flag.type === "boolean" ? (flag.default ?? false) : flag.default;
			const shown =
				fallback === undefined
					? ""
					: ` (default: ${typeof fallback === "string" ? JSON.stringify(fallback) : fallback})`;
			return [label, `${flag.description}${shown}`];
		},
	);

	return [
		`${spec.id}: ${spec.description}`,
		"",
		forwardsPassthrough(spec)
			? `Usage: ${spec.id} [options] [args...] [-- backend-args...]`
			: `Usage: ${spec.id} [options] [args...] [-- args...]`,
		"",
		`Backends: ${[`${first} (default)`, ...rest].join(", ")}`,
		`Mode: ${spec.mode}`,
		"",
		"Framework options:",
		...table(framework),
		"",
		"Agent options:",
		...(agent.length > 0 ? table(agent) : ["  (none)"]),
		"",
		"Passthrough:",
		...(forwardsPassthrough(spec)
			? [
					"  Everything after a standalone -- goes to the backend CLI verbatim,",
					`  for example: ${spec.id} -- --resume <session-id>`,
				]
			: [
					"  None. This agent passes nothing to the backend CLI: arguments after",
					"  a standalone -- are taken as positional arguments.",
				]),
		"",
	].join("\n");
}

function table(rows: [string, string][]): string[] {
	const width = Math.max(...rows.map(([label]) => label.length)) + 2;
	return rows.map(([label, text]) => `  ${label.padEnd(width)}${text}`);
}
