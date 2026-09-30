import { resolve } from "node:path";
import { adapterFor } from "./adapters";
import type { Invocation } from "./adapters/types";
import type { CliIo, ParsedInvocation } from "./cli";
import { formatPreview, previewMcp, previewResourcePaths } from "./preview";
import { PROMPT_SEPARATOR } from "./schema";
import { renderTemplate } from "./template";
import type {
	AgentSpec,
	CommandRequest,
	CommandResult,
	Finish,
	Prepare,
	PrepareContext,
	PrepareResult,
} from "./types";

/** The reserved exports a generated entry imports from a sibling extension. */
export interface AgentExtension {
	prepare?: Prepare;
	finish?: Finish;
}

export type RunCommand = PrepareContext["runCommand"];

/**
 * The runner-owned command facility handed to preparation (D-016, D-018).
 * Children run without a shell, with stdin ignored and stdout/stderr
 * captured, so they can never write to the terminal; they share `signal`.
 * Child tracking, abort forwarding and cleanup are TASK-005.
 */
export function createRunCommand(options: {
	cwd: string;
	signal: AbortSignal;
}): RunCommand {
	return async (request: CommandRequest): Promise<CommandResult> => {
		options.signal.throwIfAborted();
		const child = Bun.spawn(request.argv, {
			cwd: request.cwd ?? options.cwd,
			env: { ...process.env, ...request.env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			signal: options.signal,
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	};
}

export function createPrepareContext(
	spec: Readonly<AgentSpec>,
	invocation: ParsedInvocation,
	options: { signal: AbortSignal; runCommand?: RunCommand },
): PrepareContext {
	return Object.freeze({
		flags: Object.freeze({ ...invocation.flags }),
		args: Object.freeze([...invocation.args]),
		cwd: invocation.cwd,
		backend: invocation.backend,
		mode: invocation.mode,
		preview: invocation.showPrompt,
		// The runner keeps building from its own spec; prepare sees a copy.
		spec: frozenCopy(spec),
		signal: options.signal,
		runCommand:
			options.runCommand ??
			createRunCommand({ cwd: invocation.cwd, signal: options.signal }),
	});
}

/**
 * Console methods that can reach stdout. Bun's bypass `process.stdout.write`;
 * `write` is Bun's own. The `time*` family writes to stderr on Bun 1.2 but is
 * silenced too, so a runtime change cannot leak through it.
 */
const STDOUT_CONSOLE = [
	"log",
	"info",
	"debug",
	"dir",
	"dirxml",
	"table",
	"count",
	"countReset",
	"group",
	"groupCollapsed",
	"groupEnd",
	"trace",
	"timeLog",
	"timeEnd",
	"clear",
	"write",
] as const;

/**
 * Discard this process's stdout until the returned function restores it:
 * `process.stdout.write` and every console method in `STDOUT_CONSOLE`.
 * Preparation must print nothing in preview (D-012); this keeps a careless
 * extension from corrupting the envelope. Not covered: writes to fd 1
 * (`fs.writeSync(1, ...)`, `Bun.write(Bun.stdout, ...)`) and children that
 * inherit stdout, which the extension contract already forbids (D-015).
 */
export function absorbStdout(): () => void {
	const target = console as unknown as Record<string, unknown>;
	const write = process.stdout.write;
	const methods = STDOUT_CONSOLE.map((name) => [name, target[name]] as const);
	process.stdout.write = ((
		_chunk: unknown,
		encodingOrCallback?: unknown,
		callback?: unknown,
	) => {
		const done =
			typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (typeof done === "function") queueMicrotask(() => done());
		return true;
	}) as typeof process.stdout.write;
	for (const [name] of methods) target[name] = () => {};
	return () => {
		process.stdout.write = write;
		for (const [name, method] of methods) target[name] = method;
	};
}

/** Run `fn` with stdout absorbed, restoring it afterwards even on a throw. */
export async function withStdoutAbsorbed<T>(fn: () => Promise<T>): Promise<T> {
	const restore = absorbStdout();
	try {
		return await fn();
	} finally {
		restore();
	}
}

/** A deep-frozen copy, so preparation cannot rewrite the declaration. */
function frozenCopy<T>(value: T): T {
	const copy = structuredClone(value);
	const freeze = (node: unknown) => {
		if (typeof node !== "object" || node === null) return;
		for (const child of Object.values(node)) freeze(child);
		Object.freeze(node);
	};
	freeze(copy);
	return copy;
}

/** What preparation contributed to one invocation, after the runner's checks. */
export interface Prepared {
	systemPrompt: string;
	initialPrompt: string;
	cwd: string;
	extraAllowRules?: { rules: string[]; additionalDirectories?: string[] };
	beforeRunMessages: string[];
	afterRunMessages: string[];
}

export type PrepareOutcome =
	| { kind: "prepared"; prepared: Prepared }
	| {
			kind: "exit";
			exit: { message: string; code: number; stream: "stdout" | "stderr" };
	  };

/**
 * Call the extension's `prepare` (if any) and fold its result into the
 * compiled prompt and rendered template. Fragments follow the compiled
 * prompt with the include separator; a returned `initialPrompt` replaces the
 * rendered template; a returned `cwd` resolves against the invocation's.
 * `flagOverrides` needs the runner's revalidation (TASK-005) and is refused
 * until then rather than silently ignored.
 */
export async function runPrepare(
	spec: Readonly<AgentSpec>,
	extension: AgentExtension,
	ctx: PrepareContext,
	io: Pick<CliIo, "isDirectory">,
): Promise<PrepareOutcome> {
	const result: PrepareResult = extension.prepare
		? await extension.prepare(ctx)
		: {};
	if ("exit" in result) return { kind: "exit", exit: result.exit };
	if (result.flagOverrides && Object.keys(result.flagOverrides).length > 0) {
		throw new Error("flagOverrides are not supported by this runner yet");
	}

	const cwd = result.cwd === undefined ? ctx.cwd : resolve(ctx.cwd, result.cwd);
	if (cwd !== ctx.cwd && io.isDirectory(cwd) !== true) {
		throw new Error(`prepared working directory ${cwd} is not a directory`);
	}
	const systemPrompt = [
		spec.systemPrompt,
		...(result.systemPromptFragments ?? []),
	]
		.filter((part) => part.length > 0)
		.join(PROMPT_SEPARATOR);
	const initialPrompt =
		result.initialPrompt ??
		renderTemplate(spec.initialPrompt, spec.flags, {
			args: ctx.args,
			cwd,
			flags: ctx.flags,
		});
	const prepared: Prepared = {
		systemPrompt,
		initialPrompt,
		cwd,
		beforeRunMessages: result.beforeRunMessages ?? [],
		afterRunMessages: result.afterRunMessages ?? [],
	};
	if (result.extraAllowRules) prepared.extraAllowRules = result.extraAllowRules;
	return { kind: "prepared", prepared };
}

/**
 * Whether `cwd` is inside a Git worktree, per `git rev-parse`. Only a probe
 * that ran and said so means "outside": a probe that could not run reports
 * `onError` and counts as inside, so Codex keeps its Git check.
 */
export async function probeGitWorktree(
	runCommand: RunCommand,
	cwd: string,
	onError: (message: string) => void,
): Promise<boolean> {
	try {
		const result = await runCommand({
			argv: ["git", "rev-parse", "--is-inside-work-tree"],
			cwd,
		});
		return result.exitCode === 0 && result.stdout.trim() === "true";
	} catch (error) {
		onError(`git worktree probe failed: ${messageOf(error)}`);
		return true;
	}
}

export interface PreviewIo
	extends Pick<CliIo, "stdout" | "stderr" | "isDirectory"> {
	/** Replaces the runner's command facility, e.g. in tests. */
	runCommand?: RunCommand;
	signal?: AbortSignal;
}

/**
 * `--show-prompt` (B-003, D-012): run preparation with `ctx.preview === true`
 * and its stdout absorbed, render the initial prompt, build the resolved
 * backend's plan (D-031) against placeholder resources and unresolved, redacted MCP
 * values, then write the fixed envelope to stdout in one piece. Nothing is
 * spawned but preparation's own `runCommand` children and, for a Codex exec
 * plan, the read-only worktree probe; nothing is written to the filesystem;
 * before/after-run messages are never emitted. Any failure writes a
 * diagnostic to stderr, no envelope, and returns 1 (D-030).
 */
export async function previewAgent(
	spec: Readonly<AgentSpec>,
	extension: AgentExtension,
	invocation: ParsedInvocation,
	io: PreviewIo,
): Promise<number> {
	const fail = (message: string) => {
		io.stderr(`${spec.id}: ${message}\n`);
		return 1;
	};
	const signal = io.signal ?? new AbortController().signal;
	const runCommand =
		io.runCommand ?? createRunCommand({ cwd: invocation.cwd, signal });
	const ctx = createPrepareContext(
		spec,
		{ ...invocation, showPrompt: true },
		{ signal, runCommand },
	);

	let outcome: PrepareOutcome;
	try {
		outcome = await withStdoutAbsorbed(() =>
			runPrepare(spec, extension, ctx, io),
		);
	} catch (error) {
		return fail(`prepare failed: ${messageOf(error)}`);
	}
	if (outcome.kind === "exit") {
		// D-030: a preview early exit is a diagnostic, never a run result.
		const { message } = outcome.exit;
		io.stderr(
			message.endsWith("\n") || message === "" ? message : `${message}\n`,
		);
		return 1;
	}
	const { prepared } = outcome;

	let argv: string[];
	try {
		const adapter = adapterFor(invocation.backend);
		const inv: Invocation = {
			spec,
			backend: invocation.backend,
			mode: invocation.mode,
			systemPrompt: prepared.systemPrompt,
			initialPrompt: prepared.initialPrompt,
			cwd: prepared.cwd,
			flags: ctx.flags,
			mcp: previewMcp(spec.mcp),
			passthrough: invocation.passthrough,
			insideGitWorktree:
				invocation.backend === "codex" && invocation.mode !== "interactive"
					? await probeGitWorktree(runCommand, prepared.cwd, (message) =>
							io.stderr(`${spec.id}: ${message}\n`),
						)
					: true,
		};
		if (invocation.model !== undefined) inv.model = invocation.model;
		if (prepared.extraAllowRules)
			inv.extraAllowRules = prepared.extraAllowRules;
		const plan = adapter.build(
			inv,
			previewResourcePaths(adapter.resources(inv)),
		);
		argv = [plan.executable, ...plan.displayArgv];
	} catch (error) {
		return fail(messageOf(error));
	}

	io.stdout(
		formatPreview({
			backend: invocation.backend,
			systemPrompt: prepared.systemPrompt,
			initialPrompt: prepared.initialPrompt,
			argv,
		}),
	);
	return 0;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The generated entry's `--show-prompt`: stdout stays absorbed for the rest
 * of the process, so output that preparation schedules for later (a timer,
 * an unawaited promise) cannot follow the envelope. The envelope goes
 * through the writer captured before absorbing, and the process exits once
 * both streams have flushed, before any such callback can run.
 */
export async function previewAndExit(
	spec: Readonly<AgentSpec>,
	extension: AgentExtension,
	invocation: ParsedInvocation,
	io: Pick<CliIo, "isDirectory">,
): Promise<never> {
	const writeOut = process.stdout.write.bind(process.stdout);
	absorbStdout();
	let envelope = "";
	const code = await previewAgent(spec, extension, invocation, {
		isDirectory: io.isDirectory,
		stdout: (text) => {
			envelope += text;
		},
		stderr: (text) => process.stderr.write(text),
	});
	await new Promise<void>((done) => writeOut(envelope, () => done()));
	await new Promise<void>((done) => process.stderr.write("", () => done()));
	process.exit(code);
}
