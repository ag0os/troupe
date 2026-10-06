import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import { adapterFor } from "./adapters";
import type {
	BackendAdapter,
	CommandPlan,
	Emission,
	Invocation,
	ResolvedMcpServer,
	ResourceNeeds,
	ResourcePaths,
	StreamDecoder,
} from "./adapters/types";
import type { CliIo, ParsedInvocation } from "./cli";
import { interpolateMcp } from "./interpolate";
import { formatPreview, previewMcp, previewResourcePaths } from "./preview";
import { PROMPT_SEPARATOR } from "./schema";
import { renderTemplate } from "./template";
import type {
	AgentSpec,
	Backend,
	CommandRequest,
	CommandResult,
	Finish,
	FinishResult,
	McpServer,
	Prepare,
	PrepareContext,
	PrepareResult,
	RunResult,
} from "./types";

/** The reserved exports a generated entry imports from a sibling extension. */
export interface AgentExtension {
	prepare?: Prepare;
	finish?: Finish;
}

export type RunCommand = PrepareContext["runCommand"];

/**
 * The runner-owned command facility handed to preparation and interpolation
 * (D-016, D-018). Children run without a shell, with stdin ignored and
 * stdout/stderr captured, so they can never write to the terminal. They
 * share `signal`; under a `RunScope` they are also tracked, so a signal or
 * the end of the run terminates and awaits them. A command that the signal
 * interrupted rejects instead of returning its exit code.
 */
export function createRunCommand(options: {
	cwd: string;
	signal: AbortSignal;
	/** Base environment; the runner's own by default. */
	env?: Readonly<Record<string, string | undefined>>;
	scope?: RunScope;
}): RunCommand {
	return async (request: CommandRequest): Promise<CommandResult> => {
		options.signal.throwIfAborted();
		const spawnOptions = {
			cwd: request.cwd ?? options.cwd,
			env: definedEnv({ ...(options.env ?? process.env), ...request.env }),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		} as const;
		const child = options.scope
			? options.scope.spawn(request.argv, spawnOptions)
			: Bun.spawn(request.argv, { ...spawnOptions, signal: options.signal });
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			readText(child.stdout),
			readText(child.stderr),
		]);
		options.signal.throwIfAborted();
		return { exitCode, stdout, stderr };
	};
}

function definedEnv(
	env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

export function createPrepareContext(
	spec: Readonly<AgentSpec>,
	invocation: ParsedInvocation,
	options: { signal: AbortSignal; runCommand?: RunCommand },
): PrepareContext {
	const context = {
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
	};
	const completeContext = Object.defineProperties(context, {
		passthrough: {
			value: Object.freeze([...invocation.passthrough]),
			enumerable: false,
		},
		modelFromFlag: { value: invocation.modelFromFlag, enumerable: false },
	}) as typeof context &
		Pick<PrepareContext, "passthrough" | "modelFromFlag">;
	return Object.freeze(completeContext);
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
	/** Parsed flags with revalidated `flagOverrides` applied. */
	flags: Readonly<Record<string, string | boolean>>;
	extraAllowRules?: { rules: string[]; additionalDirectories?: string[] };
	sessionName?: string;
	model?: string;
	effort?: string;
	codexHome?: string;
	beforeRunMessages: string[];
	afterRunMessages: string[];
}

export type EarlyExit = {
	message: string;
	code: number;
	stream: "stdout" | "stderr";
};

export type PrepareOutcome =
	| { kind: "prepared"; prepared: Readonly<Prepared> }
	| { kind: "exit"; exit: EarlyExit };

const stringList = z.array(z.string());

/**
 * The exact shapes `prepare` may return (Design §4). Anything else, such as
 * an argv or a command, is refused: extensions return data, never backend
 * commands (D-015).
 */
const PREPARE_RESULT = z.union([
	z.strictObject({
		exit: z.strictObject({
			message: z.string(),
			code: z.number().int().min(0).max(255),
			stream: z.enum(["stdout", "stderr"]),
		}),
	}),
	z.strictObject({
		systemPromptFragments: stringList.optional(),
		initialPrompt: z.string().optional(),
		extraAllowRules: z
			.strictObject({
				rules: stringList,
				additionalDirectories: stringList.optional(),
			})
			.optional(),
		sessionName: z.string().optional(),
		model: z.string().optional(),
		effort: z.string().regex(/^[a-z]+$/).optional(),
		codexHome: z.string().optional(),
		cwd: z.string().min(1).optional(),
		flagOverrides: z
			.record(z.string(), z.union([z.string(), z.boolean()]))
			.optional(),
		beforeRunMessages: stringList.optional(),
		afterRunMessages: stringList.optional(),
	}),
]);

/**
 * Call the extension's `prepare` (if any) and fold its result into the
 * compiled prompt and rendered template, after the runner's checks (D-016):
 * the result must match Design §4 exactly; `flagOverrides` are revalidated
 * against the declared flags before the template renders; a returned `cwd`
 * and additional directories resolve against the invocation's cwd; rules are
 * Claude-only, so a nonempty rule object on another backend fails closed;
 * before/after-run messages are refused when executing in print mode, whose
 * stdout is the payload (preview never emits them). Fragments follow the compiled prompt with the include separator
 * and a returned `initialPrompt` replaces the rendered template. The result
 * is a frozen copy, so nothing the extension keeps can change it later.
 */
export async function runPrepare(
	spec: Readonly<AgentSpec>,
	extension: AgentExtension,
	ctx: PrepareContext,
	io: Pick<CliIo, "isDirectory">,
): Promise<PrepareOutcome> {
	const returned: unknown = extension.prepare
		? await extension.prepare(ctx)
		: {};
	const parsed = PREPARE_RESULT.safeParse(returned);
	if (!parsed.success) {
		throw new Error(
			`prepare returned an invalid result: ${parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	const result = parsed.data as PrepareResult;
	if ("exit" in result) return { kind: "exit", exit: { ...result.exit } };

	const flags = applyFlagOverrides(spec, ctx.flags, result.flagOverrides);
	const cwd = result.cwd === undefined ? ctx.cwd : resolve(ctx.cwd, result.cwd);
	if (cwd !== ctx.cwd && io.isDirectory(cwd) !== true) {
		throw new Error(`prepared working directory ${cwd} is not a directory`);
	}

	const beforeRunMessages = result.beforeRunMessages ?? [];
	const afterRunMessages = result.afterRunMessages ?? [];
	if (
		!ctx.preview &&
		ctx.mode === "print" &&
		(beforeRunMessages.length > 0 || afterRunMessages.length > 0)
	) {
		throw new Error(
			"before/after-run messages are not allowed in print mode, where stdout is the payload",
		);
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
			flags,
		});
	const prepared: Prepared = {
		systemPrompt,
		initialPrompt,
		cwd,
		flags,
		beforeRunMessages,
		afterRunMessages,
	};
	if (result.sessionName !== undefined) {
		if (ctx.backend !== "claude" || ctx.mode !== "interactive") {
			throw new Error(
				"sessionName is allowed only for interactive Claude launches",
			);
		}
		prepared.sessionName = result.sessionName;
	}
	if (result.model !== undefined) prepared.model = result.model;
	if (result.effort !== undefined) prepared.effort = result.effort;
	if (result.codexHome !== undefined) {
		if (ctx.backend !== "codex") {
			throw new Error("codexHome is allowed only for Codex launches");
		}
		if (!isAbsolute(result.codexHome)) {
			throw new Error("codexHome must be an absolute path");
		}
		prepared.codexHome = result.codexHome;
	}
	const rules = result.extraAllowRules;
	if (
		rules &&
		(rules.rules.length > 0 || (rules.additionalDirectories ?? []).length > 0)
	) {
		if (ctx.backend !== "claude") {
			throw new Error(
				`extraAllowRules are Claude-only and are not emulated on ${ctx.backend}; return them only when ctx.backend === "claude"`,
			);
		}
		prepared.extraAllowRules = {
			rules: [...new Set(rules.rules)],
			...(rules.additionalDirectories
				? {
						additionalDirectories: [
							...new Set(
								rules.additionalDirectories.map((dir) => resolve(cwd, dir)),
							),
						],
					}
				: {}),
		};
	}
	return { kind: "prepared", prepared: frozenCopy(prepared) };
}

/**
 * The parsed flags with `prepare`'s overrides applied. Each override must
 * name a declared flag and carry a value the CLI itself would accept: a
 * boolean for a boolean flag, a string otherwise, and a declared value for
 * an enum. Framework flags are never overridable.
 */
export function applyFlagOverrides(
	spec: Readonly<AgentSpec>,
	flags: Readonly<Record<string, string | boolean>>,
	overrides: Readonly<Record<string, string | boolean>> | undefined,
): Readonly<Record<string, string | boolean>> {
	const merged = { ...flags };
	for (const [name, value] of Object.entries(overrides ?? {})) {
		const flag = Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined;
		const field = `flagOverrides.${name}`;
		if (!flag) throw new Error(`${field}: "${name}" is not a declared flag`);
		if (flag.type === "boolean" && typeof value !== "boolean") {
			throw new Error(`${field}: boolean flag needs a boolean value`);
		}
		if (flag.type !== "boolean" && typeof value !== "string") {
			throw new Error(`${field}: ${flag.type} flag needs a string value`);
		}
		if (flag.type === "enum" && !flag.values.includes(value as string)) {
			throw new Error(
				`${field}: must be one of ${flag.values.join(", ")} (got "${value}")`,
			);
		}
		merged[name] = value;
	}
	return Object.freeze(merged);
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
	/** Termination signals; preview children are tracked like execution's. */
	signals?: SignalSource;
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
	const scope = new RunScope(io.signals);
	let result: { code: number; envelope?: string };
	try {
		result = await previewInScope(spec, extension, invocation, io, scope);
	} catch (error) {
		if (!scope.received) throw error;
		result = { code: 1 };
	} finally {
		await scope.close();
	}
	if (scope.received) return signalExitCode(scope.received);
	if (result.envelope !== undefined) io.stdout(result.envelope);
	return result.code;
}

/**
 * The body of `previewAgent`: every child (preparation's and the worktree
 * probe) belongs to `scope`, and a signal rejects the guarded steps. Errors
 * go to stderr here; the envelope is returned so nothing is written once a
 * signal arrived.
 */
async function previewInScope(
	spec: Readonly<AgentSpec>,
	extension: AgentExtension,
	invocation: ParsedInvocation,
	io: PreviewIo,
	scope: RunScope,
): Promise<{ code: number; envelope?: string }> {
	const fail = (message: string) => {
		if (scope.received) throw scope.signal.reason;
		io.stderr(`${spec.id}: ${message}\n`);
		return { code: 1 };
	};
	const signal = scope.signal;
	const runCommand =
		io.runCommand ??
		createRunCommand({ cwd: invocation.cwd, signal, scope });
	const ctx = createPrepareContext(
		spec,
		{ ...invocation, showPrompt: true },
		{ signal, runCommand },
	);

	let outcome: PrepareOutcome;
	try {
		outcome = await scope.guard(
			withStdoutAbsorbed(() => runPrepare(spec, extension, ctx, io)),
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
		return { code: 1 };
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
			flags: prepared.flags,
			mcp: previewMcp(spec.mcp),
			passthrough: invocation.passthrough,
			insideGitWorktree:
				invocation.backend === "codex" && invocation.mode !== "interactive"
					? await scope.guard(
							probeGitWorktree(runCommand, prepared.cwd, (message) => {
								if (!signal.aborted) io.stderr(`${spec.id}: ${message}\n`);
							}),
						)
					: true,
		};
		const model = invocation.modelFromFlag
			? invocation.model
			: (prepared.model ?? invocation.model);
		if (model !== undefined) inv.model = model;
		if (prepared.effort !== undefined) inv.effort = prepared.effort;
		if (prepared.sessionName !== undefined) {
			inv.sessionName = prepared.sessionName;
		}
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

	return {
		code: 0,
		envelope: formatPreview({
			backend: invocation.backend,
			systemPrompt: prepared.systemPrompt,
			initialPrompt: prepared.initialPrompt,
			argv,
		}),
	};
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
		signals: processSignals,
	});
	await new Promise<void>((done) => writeOut(envelope, () => done()));
	await new Promise<void>((done) => process.stderr.write("", () => done()));
	process.exit(code);
}

// ---------------------------------------------------------------------------
// Execution (B-006, D-018, D-019, Design §5)
// ---------------------------------------------------------------------------

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
export type RunnerSignal = keyof typeof SIGNAL_NUMBERS;
const RUNNER_SIGNALS = Object.keys(SIGNAL_NUMBERS) as RunnerSignal[];

/** Subscribes the runner to termination signals; returns the unsubscribe. */
export type SignalSource = (
	handler: (signal: RunnerSignal) => void,
) => () => void;

/** This process's SIGHUP, SIGINT and SIGTERM. */
export const processSignals: SignalSource = (handler) => {
	const listeners = RUNNER_SIGNALS.map((name) => {
		const listener = () => handler(name);
		process.on(name, listener);
		return [name, listener] as const;
	});
	return () => {
		for (const [name, listener] of listeners) process.off(name, listener);
	};
};

/** The conventional exit code of a process ended by `signal`. */
export function signalExitCode(signal: RunnerSignal): number {
	return 128 + SIGNAL_NUMBERS[signal];
}

/** The abort reason of a run a signal interrupted. */
export class SignalAbort extends Error {
	readonly signal: RunnerSignal;

	constructor(signal: RunnerSignal) {
		super(`interrupted by ${signal}`);
		this.name = "SignalAbort";
		this.signal = signal;
	}
}

type SpawnOptions = {
	cwd: string;
	env: Record<string, string>;
	stdin: "inherit" | "ignore";
	stdout: "inherit" | "pipe";
	stderr: "inherit" | "pipe";
};

/** How long a child may take to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3000;

/**
 * Everything one run owns (D-018): the shared abort signal, every child it
 * started (preparation, interpolation and backend), the resources it
 * created and its signal listeners. `close` terminates and awaits the
 * children, removes the resources and the listeners, on every exit path.
 */
export class RunScope {
	readonly #controller = new AbortController();
	readonly #children = new Set<Subprocess>();
	readonly #cleanups: (() => Promise<void> | void)[] = [];
	readonly #unsubscribe: () => void;
	readonly #killGraceMs: number;
	/** Cleanups registered while closing, which `close` still awaits. */
	readonly #late = new Set<Promise<void>>();
	#closing = false;
	#received: RunnerSignal | undefined;
	/**
	 * Set while an interactive backend owns the terminal. The terminal
	 * delivers SIGINT to it directly, and Ctrl-C means "cancel the input"
	 * there, so the runner leaves SIGINT to the child and exits with its code.
	 */
	terminalChild = false;

	constructor(
		signals?: SignalSource,
		options: { killGraceMs?: number } = {},
	) {
		this.#killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
		this.#unsubscribe = signals
			? signals((signal) => this.receive(signal))
			: () => {};
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/** The signal that interrupted this run, if any. */
	get received(): RunnerSignal | undefined {
		return this.#received;
	}

	/** Abort the run and forward `signal` to every tracked child. */
	receive(signal: RunnerSignal): void {
		if (signal === "SIGINT" && this.terminalChild) return;
		if (this.#received) {
			// A second signal while children wind down: stop waiting for them.
			for (const child of this.#children) child.kill("SIGKILL");
			return;
		}
		this.#received = signal;
		for (const child of this.#children) child.kill(signal);
		this.#controller.abort(new SignalAbort(signal));
	}

	/** Start a tracked child; refused once the run is aborted. */
	spawn(argv: readonly string[], options: SpawnOptions): Subprocess {
		this.signal.throwIfAborted();
		const child = Bun.spawn([...argv], options);
		this.#children.add(child);
		void child.exited.finally(() => this.#children.delete(child));
		return child;
	}

	/**
	 * Register a removal for `close`. On a scope that is already closing or
	 * closed the cleanup runs at once, so a late registration still removes
	 * its resource (and `close`, if still running, awaits it).
	 */
	onCleanup(cleanup: () => Promise<void> | void): void {
		if (!this.#closing) {
			this.#cleanups.push(cleanup);
			return;
		}
		const done: Promise<void> = Promise.resolve()
			.then(cleanup)
			.catch(() => {})
			.finally(() => this.#late.delete(done));
		this.#late.add(done);
	}

	/** `promise`, or a rejection with the abort reason as soon as the run aborts. */
	async guard<T>(promise: Promise<T> | T): Promise<T> {
		const signal = this.signal;
		signal.throwIfAborted();
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([promise, aborted]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	/** Terminate and await children, remove resources and listeners. */
	async close(): Promise<void> {
		this.#closing = true;
		await Promise.all(
			[...this.#children].map((child) => terminate(child, this.#killGraceMs)),
		);
		const cleanups = this.#cleanups.splice(0).reverse();
		for (const cleanup of cleanups) {
			try {
				await cleanup();
			} catch {
				// Best effort: one failed removal must not keep the others.
			}
		}
		while (this.#late.size > 0) await Promise.all(this.#late);
		this.#unsubscribe();
	}
}

/** SIGTERM, then SIGKILL if the child is still alive after `graceMs`. */
async function terminate(
	child: Subprocess,
	graceMs = KILL_GRACE_MS,
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const graceful = await Promise.race([
		child.exited.then(() => true),
		new Promise<false>((done) => {
			timer = setTimeout(() => done(false), graceMs);
		}),
	]);
	clearTimeout(timer);
	if (!graceful) {
		child.kill("SIGKILL");
		await child.exited;
	}
}

/** The exit code of a finished child, mapping a signal death to 128+n. */
function childExitCode(child: Subprocess, exited: number): number {
	if (child.signalCode) {
		const number = osConstants.signals[child.signalCode];
		if (number !== undefined) return 128 + number;
	}
	return exited;
}

/**
 * Create what the adapter asked for (D-019): an owner-only prompt file and a
 * unique, clean, owner-only directory for Claude's `TMPDIR`. Each directory
 * is registered for removal as soon as `mkdtemp` returns it. The runner
 * awaits this function rather than racing it against a signal, and a
 * registration on a closing or closed scope runs at once, so no resource
 * outlives the run.
 */
export async function createResources(
	needs: ResourceNeeds,
	scope: RunScope,
	tmpRoot: string,
): Promise<ResourcePaths> {
	const paths: ResourcePaths = {};
	const makeDir = async (prefix: string) => {
		const dir = await mkdtemp(join(tmpRoot, prefix));
		scope.onCleanup(() => rm(dir, { recursive: true, force: true }));
		return dir;
	};
	if (needs.promptFile !== undefined) {
		const file = join(await makeDir("troupe-prompt-"), "instructions.md");
		await writeFile(file, needs.promptFile, { mode: 0o600, flag: "wx" });
		await chmod(file, 0o600);
		paths.promptFile = file;
	}
	if (needs.tmpDir) paths.tmpDir = await makeDir("troupe-tmp-");
	return paths;
}

export interface InterpolationContext {
	/** The launch environment `${env:...}` reads. */
	env: Readonly<Record<string, string | undefined>>;
	/** Effective cwd, where `${cmd:...}` runs. */
	cwd: string;
	signal: AbortSignal;
	/** The runner's tracked command facility; the only way to run `${cmd:...}`. */
	runCommand: RunCommand;
}

export interface Interpolated {
	mcp: Record<string, ResolvedMcpServer>;
	/** Secrets to export into the backend's environment only (D-029). */
	env: Record<string, string>;
}

/** Resolves declared MCP servers at launch (Design §6). */
export type Interpolate = (
	servers: Readonly<Record<string, McpServer>> | undefined,
	ctx: InterpolationContext,
) => Promise<Interpolated>;

/** The real resolver (`interpolate.ts`), the default behind the seam. */
export { interpolateMcp };

export interface ExecuteIo
	extends Pick<CliIo, "stdout" | "stderr" | "isDirectory"> {
	/** The launch environment: the backend inherits it, and PATH finds it. */
	env: Readonly<Record<string, string | undefined>>;
	signals?: SignalSource;
	/** Where runner-created resources go; the OS temp directory by default. */
	tmpRoot?: string;
	interpolate?: Interpolate;
	/** Resolves once everything written so far has reached the terminal. */
	flush?: () => Promise<void>;
	/** Replaces adapter selection, e.g. in tests. */
	adapterFor?: (backend: Backend) => BackendAdapter;
	/** Replaces resource creation, e.g. to delay it in tests. */
	createResources?: typeof createResources;
	/** SIGTERM-to-SIGKILL grace for children at the end of the run. */
	killGraceMs?: number;
}

type FailureStage = NonNullable<RunResult["failure"]>["stage"];

/**
 * Run one invocation to completion (B-006, Design §5): prepare, render,
 * interpolate, create resources, probe Git, build, spawn in the plan's cwd,
 * then inherit IO (interactive), capture and `finish` (print) or decode
 * (stream). Returns the exit code after every child is gone and every
 * resource, listener and temp path is removed.
 *
 * - Early exit: exactly its message on its stream, with its code.
 * - Prepare/interpolation/adapter/spawn failure: stderr/1 in interactive
 *   and stream mode; a failure `RunResult` to `finish` in print mode.
 * - `finish` throw: cleanup, then stderr/1.
 * - Decoder failure: stderr/1, backend terminated, no after-run messages.
 * - Signal: children terminated and awaited, cleanup, 128+n.
 */
export async function executeAgent(
	spec: Readonly<AgentSpec>,
	extension: AgentExtension,
	invocation: ParsedInvocation,
	io: ExecuteIo,
): Promise<number> {
	const scope = new RunScope(
		io.signals,
		io.killGraceMs === undefined ? {} : { killGraceMs: io.killGraceMs },
	);
	const trailer: string[] = [];
	let code: number;
	try {
		code = await lifecycle(spec, extension, invocation, io, scope, trailer);
	} catch (error) {
		code = 1;
		if (!scope.received) trailer.push(`${spec.id}: ${messageOf(error)}\n`);
	} finally {
		await scope.close();
	}
	if (scope.received) return signalExitCode(scope.received);
	for (const text of trailer) io.stderr(text);
	return code;
}

async function lifecycle(
	spec: Readonly<AgentSpec>,
	extension: AgentExtension,
	invocation: ParsedInvocation,
	io: ExecuteIo,
	scope: RunScope,
	trailer: string[],
): Promise<number> {
	const { mode, backend } = invocation;
	const runCommand = createRunCommand({
		cwd: invocation.cwd,
		signal: scope.signal,
		env: io.env,
		scope,
	});
	const ctx = createPrepareContext(
		spec,
		{ ...invocation, showPrompt: false },
		{ signal: scope.signal, runCommand },
	);

	const finishRun = async (result: RunResult): Promise<number> => {
		if (!extension.finish) {
			if (result.stdout) io.stdout(result.stdout);
			if (result.stderr) io.stderr(result.stderr);
			return result.exitCode;
		}
		let finished: FinishResult;
		try {
			finished = await scope.guard(extension.finish(result, ctx));
			if (!Number.isInteger(finished?.exitCode)) {
				throw new Error("finish must return an integer exitCode");
			}
		} catch (error) {
			if (scope.received) throw error;
			trailer.push(`${spec.id}: finish failed: ${messageOf(error)}\n`);
			return 1;
		}
		if (finished.stdout) io.stdout(finished.stdout);
		if (finished.stderr) io.stderr(finished.stderr);
		return finished.exitCode;
	};

	/** Route an operational failure by mode (B-006). */
	const failed = (error: unknown, stage: FailureStage): Promise<number> => {
		if (scope.received) throw error;
		const message = messageOf(error);
		if (mode === "print") {
			return finishRun({
				exitCode: 1,
				stdout: "",
				stderr: `${stage} failed: ${message}\n`,
				failure: { stage, message },
			});
		}
		io.stderr(`${spec.id}: ${stage} failed: ${message}\n`);
		return Promise.resolve(1);
	};

	let outcome: PrepareOutcome;
	try {
		outcome = await scope.guard(runPrepare(spec, extension, ctx, io));
	} catch (error) {
		return failed(error, "prepare");
	}
	if (outcome.kind === "exit") {
		const { message, stream, code } = outcome.exit;
		io[stream](message);
		return code;
	}
	const { prepared } = outcome;

	let interpolated: Interpolated;
	try {
		interpolated = await scope.guard(
			(io.interpolate ?? interpolateMcp)(spec.mcp, {
				env: io.env,
				cwd: prepared.cwd,
				signal: scope.signal,
				runCommand,
			}),
		);
	} catch (error) {
		return failed(error, "interpolation");
	}

	let plan: CommandPlan;
	let adapter: BackendAdapter;
	try {
		adapter = (io.adapterFor ?? adapterFor)(backend);
		const inv: Invocation = {
			spec,
			backend,
			mode,
			systemPrompt: prepared.systemPrompt,
			initialPrompt: prepared.initialPrompt,
			cwd: prepared.cwd,
			flags: prepared.flags,
			mcp: interpolated.mcp,
			passthrough: invocation.passthrough,
			insideGitWorktree: true,
		};
		const model = invocation.modelFromFlag
			? invocation.model
			: (prepared.model ?? invocation.model);
		if (model !== undefined) inv.model = model;
		if (prepared.effort !== undefined) inv.effort = prepared.effort;
		if (prepared.sessionName !== undefined) {
			inv.sessionName = prepared.sessionName;
		}
		if (prepared.extraAllowRules) {
			inv.extraAllowRules = prepared.extraAllowRules;
		}
		if (backend === "codex" && mode !== "interactive") {
			inv.insideGitWorktree = await scope.guard(
				probeGitWorktree(runCommand, prepared.cwd, (message) => {
					if (!scope.signal.aborted) io.stderr(`${spec.id}: ${message}\n`);
				}),
			);
		}
		// Awaited, never raced against the signal: a creation still in flight
		// when cleanup ran would leave its resource behind.
		const paths = await (io.createResources ?? createResources)(
			adapter.resources(inv),
			scope,
			io.tmpRoot ?? tmpdir(),
		);
		scope.signal.throwIfAborted();
		plan = adapter.build(inv, paths);
	} catch (error) {
		return failed(error, "adapter");
	}

	let child: Subprocess;
	try {
		const executable = Bun.which(plan.executable, {
			PATH: io.env.PATH ?? "",
			cwd: plan.cwd,
		});
		if (!executable) {
			throw new Error(`${plan.executable}: command not found on PATH`);
		}
		for (const message of prepared.beforeRunMessages) {
			io.stdout(message.endsWith("\n") ? message : `${message}\n`);
		}
		await io.flush?.();
		const env = definedEnv({
			...io.env,
			...(prepared.codexHome === undefined
				? {}
				: { CODEX_HOME: prepared.codexHome }),
			...interpolated.env,
			...plan.env,
		});
		// Spec Migration drops CLAUDE_PROJECT_DIR: a value inherited from an
		// enclosing Claude Code session would name the wrong project.
		if (backend === "claude") delete env.CLAUDE_PROJECT_DIR;
		child = scope.spawn([executable, ...plan.argv], {
			cwd: plan.cwd,
			env,
			stdin: plan.stdin,
			stdout: plan.stdout,
			stderr: plan.stderr,
		});
	} catch (error) {
		return failed(error, "spawn");
	}

	const afterRun = () => {
		for (const message of prepared.afterRunMessages) {
			io.stdout(message.endsWith("\n") ? message : `${message}\n`);
		}
	};

	// Every wait on the backend is guarded: on a signal the run moves on to
	// `close`, which escalates to SIGKILL for a child that ignores SIGTERM.
	if (mode === "interactive") {
		scope.terminalChild = true;
		let exited: number;
		try {
			exited = await scope.guard(child.exited);
		} finally {
			scope.terminalChild = false;
		}
		const code = childExitCode(child, exited);
		if (code === 0) afterRun();
		return code;
	}

	if (mode === "print") {
		const [exited, stdout, stderr] = await scope.guard(
			Promise.all([
				child.exited,
				readText(child.stdout),
				readText(child.stderr),
			]),
		);
		const exitCode = childExitCode(child, exited);
		const result: RunResult = { exitCode, stdout, stderr };
		if (exitCode !== 0) {
			result.failure = {
				stage: "backend",
				message: `${plan.executable} exited with code ${exitCode}`,
			};
		}
		return finishRun(result);
	}

	const decoded = await scope.guard(
		decodeStream(child.stdout, adapter.decoder(), io, backend),
	);
	if (!decoded.ok) {
		scope.signal.throwIfAborted();
		io.stderr(`${spec.id}: ${decoded.message}\n`);
		await terminate(child, io.killGraceMs);
		return 1;
	}
	const code = childExitCode(child, await scope.guard(child.exited));
	if (code === 0) afterRun();
	return code;
}

function readText(stream: Subprocess["stdout"]): Promise<string> {
	return stream instanceof ReadableStream
		? new Response(stream).text()
		: Promise.resolve("");
}

/**
 * Feed complete lines to the decoder and write its emissions in order.
 * A final line without a newline must still decode. Any decoder throw
 * (malformed JSON included) stops reading and reports failure.
 */
export async function decodeStream(
	stream: Subprocess["stdout"],
	decoder: StreamDecoder,
	io: Pick<ExecuteIo, "stdout" | "stderr">,
	backend: Backend,
): Promise<{ ok: true } | { ok: false; message: string }> {
	if (!(stream instanceof ReadableStream)) {
		return { ok: false, message: "the backend stdout is not piped" };
	}
	const reader = stream.getReader();
	const text = new TextDecoder();
	const emit = (emissions: Emission[]) => {
		for (const emission of emissions) io[emission.stream](emission.text);
	};
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += text.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				emit(decoder.line(line));
				newline = buffer.indexOf("\n");
			}
		}
		buffer += text.decode();
		if (buffer.length > 0) {
			try {
				emit(decoder.line(buffer));
			} catch (error) {
				throw new Error(
					`incomplete final ${backend} stream line could not be decoded: ${messageOf(error)}`,
				);
			}
		}
		emit(decoder.end());
		return { ok: true };
	} catch (error) {
		void reader.cancel().catch(() => {});
		return {
			ok: false,
			message: `stream decoding failed: ${messageOf(error)}`,
		};
	}
}

/** Resolves once stdout and stderr have flushed what was written so far. */
export async function flushStdio(): Promise<void> {
	await new Promise<void>((done) => process.stdout.write("", () => done()));
	await new Promise<void>((done) => process.stderr.write("", () => done()));
}

/** The generated entry's execution path: run, flush, exit with the code. */
export async function runAndExit(
	spec: Readonly<AgentSpec>,
	extension: AgentExtension,
	invocation: ParsedInvocation,
	io: Pick<CliIo, "isDirectory">,
): Promise<never> {
	const code = await executeAgent(spec, extension, invocation, {
		isDirectory: io.isDirectory,
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		env: process.env,
		signals: processSignals,
		flush: flushStdio,
	});
	await flushStdio();
	process.exit(code);
}
