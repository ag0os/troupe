import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { generateEntry } from "./compiler";
import { installFakeClis, waitForFile } from "./fake-cli";
import type { AgentMode, AgentSpec } from "./types";

// docs/AGENT-FORMAT.md, Command line: on a normal exit the binary waits until
// the writes it made through the runner to stdout and stderr have completed,
// for a destination that accepts output; a terminating signal ends the wait
// and exits with 128 plus the signal number. These tests run a generated
// entry in a child whose stream is a pipe. The reader starts only once the
// child has made the write under test (a marker file says so), and that write
// is twice the largest default pipe capacity (1 MiB on Linux), so the child
// reaches its exit with bytes still pending on a default pipe.

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agent-exit-flush-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Twice the largest default pipe (1 MiB on Linux), numbered so a lost or moved byte shows. */
const SIZE = 2 * 1_048_576 + 4_321;

function big(size = SIZE): string {
	let text = "";
	for (let i = 0; text.length < size; i++) text += `line ${i}\n`;
	return text.slice(0, size);
}

/**
 * The extension. `FLUSH_PRESSURE` names a stream it fills at import with a
 * direct write, so a later small write waits behind it. `FLUSH_MARK` is a
 * file it creates after each write of at least `FLUSH_MARK_MIN` characters to
 * stdout or stderr, the point the reader waits for. `FLUSH_LISTEN` is a file
 * it creates once, after such a write, a listener for the signal
 * `FLUSH_LISTEN_FOR` has been added: there the process handles that signal
 * itself instead of dying by it.
 */
const EXTENSION = `
import { writeFileSync } from "node:fs";
const SIZE = ${SIZE};
function big(size = SIZE): string {
	let text = "";
	for (let i = 0; text.length < size; i++) text += \`line \${i}\\n\`;
	return text.slice(0, size);
}
const pressure = process.env.FLUSH_PRESSURE;
if (pressure === "stdout" || pressure === "stderr") process[pressure].write("p".repeat(SIZE));
const mark = process.env.FLUSH_MARK;
const min = Number(process.env.FLUSH_MARK_MIN ?? "1");
let written = false;
if (mark) {
	for (const name of ["stdout", "stderr"] as const) {
		const stream = process[name];
		const write = stream.write.bind(stream);
		stream.write = ((text: string, ...rest: unknown[]) => {
			const result = (write as (...args: unknown[]) => boolean)(text, ...rest);
			if (typeof text === "string" && text.length >= min) {
				written = true;
				writeFileSync(mark, name);
			}
			return result;
		}) as typeof stream.write;
	}
}
const listen = process.env.FLUSH_LISTEN;
const listenFor = process.env.FLUSH_LISTEN_FOR;
if (listen) {
	const on = process.on.bind(process);
	process.on = ((event: string, listener: (...args: unknown[]) => void) => {
		const result = on(event, listener);
		if (written && event === listenFor) writeFileSync(listen, event);
		return result;
	}) as typeof process.on;
}
const stream = (argv: readonly string[]) =>
	argv.includes("err") ? "stderr" : "stdout";
export function dispatch(argv: string[]) {
	if (argv[0] !== "tool") return undefined;
	return { exit: { message: big(), code: 7, stream: stream(argv) } };
}
export function prepare(ctx: { args: readonly string[]; mode: string; preview: boolean }) {
	if (ctx.preview) return { systemPromptFragments: [big()] };
	if (ctx.args.includes("before")) return { beforeRunMessages: [big()] };
	if (ctx.mode === "stream") return { afterRunMessages: [big()] };
	if (ctx.mode === "print") return {};
	return { exit: { message: big(), code: 5, stream: stream(ctx.args) } };
}
export function finish() {
	return { exitCode: 3, stdout: big() };
}
`;

/** Writes a generated entry whose declared mode is `mode`. */
function entry(
	options: { mode?: AgentMode; versionLine?: string } = {},
): string {
	const extension = join(root, "flusher.ts");
	writeFileSync(extension, EXTENSION);
	const spec: AgentSpec = {
		id: "flusher",
		description: "Fixture",
		backends: ["claude"],
		promptMode: "append",
		mode: options.mode ?? "interactive",
		initialPrompt: "{{args}}",
		systemPrompt: "Body",
		flags: {},
	};
	const file = join(root, "entry.ts");
	writeFileSync(
		file,
		generateEntry(
			{
				id: "flusher",
				file: join(root, "flusher.md"),
				spec,
				extension: {
					file: extension,
					exports: ["dispatch", "prepare", "finish"],
				},
			},
			options.versionLine,
		),
	);
	return file;
}

/**
 * A `claude` that says whether the reader had started reading when it ran
 * (`piped` creates `$READING` just before it reads), on a PATH of its own.
 */
function echoBackend(): string {
	const bin = join(root, "echo-bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "claude"),
		'#!/bin/sh\nif [ -e "$READING" ]; then echo backend-after-reader; else echo backend-before-reader; fi\n',
	);
	chmodSync(join(bin, "claude"), 0o755);
	return bin;
}

/** The repository's fake `claude` and `codex`, on a PATH of their own. */
function fakeBackends(): string {
	const bin = join(root, "fake-bin");
	mkdirSync(bin, { recursive: true });
	return installFakeClis(bin);
}

interface RunOptions {
	/** The stream that goes to the pipe; the other is discarded. */
	stream: "stdout" | "stderr";
	path?: string;
	env?: Record<string, string>;
}

/** What one stream of the entry holds when it goes to a regular file. */
function toFile(file: string, args: string[], options: RunOptions) {
	const out = join(root, `reference-${options.stream}`);
	const result = Bun.spawnSync([process.execPath, file, ...args], {
		cwd: root,
		env: {
			...process.env,
			...options.env,
			PATH: options.path ?? "/nonexistent",
		},
		stdout: options.stream === "stdout" ? Bun.file(out) : "ignore",
		stderr: options.stream === "stderr" ? Bun.file(out) : "ignore",
	});
	return { text: readFileSync(out, "utf8"), code: result.exitCode };
}

/**
 * Runs the entry with one stream piped into a reader that starts only once
 * the entry has made a write of at least `markMin` characters and a further
 * 0.3 s has passed, then returns the bytes it received and the entry's exit
 * code. Just before reading, the reader creates `$READING`. A reader that
 * gave up waiting after ten seconds still reads, so the entry can end, but
 * fails the test: it proves nothing about the write, even if the marker
 * appears later.
 */
function piped(
	file: string,
	args: string[],
	options: RunOptions & { markMin?: number },
) {
	mkdirSync(join(root, "out"), { recursive: true });
	const out = join(root, "out", `${options.stream}-${args.join("-")}`);
	const mark = `${out}.mark`;
	const reading = `${out}.reading`;
	const late = `${out}.late`;
	const redirect =
		options.stream === "stdout" ? "2>/dev/null" : "2>&1 >/dev/null";
	const writer = `"$BUN" "$ENTRY" "$@" ${redirect}; echo $? > "$OUT.code"`;
	const reader = `i=0; until [ -e "$MARK" ] || [ $i -ge 200 ]; do /bin/sleep 0.05; i=$((i+1)); done; [ -e "$MARK" ] || : > "$LATE"; /bin/sleep 0.3; : > "$READING"; /bin/cat > "$OUT"`;
	const result = Bun.spawnSync(
		["/bin/sh", "-c", `{ ${writer}; } | { ${reader}; }`, "sh", ...args],
		{
			cwd: root,
			env: {
				...process.env,
				...options.env,
				BUN: process.execPath,
				ENTRY: file,
				OUT: out,
				MARK: mark,
				READING: reading,
				LATE: late,
				FLUSH_MARK: mark,
				FLUSH_MARK_MIN: String(options.markMin ?? 1),
				PATH: options.path ?? "/nonexistent",
			},
		},
	);
	expect(result.exitCode).toBe(0);
	expect({ releasedByDeadline: existsSync(late) }).toEqual({
		releasedByDeadline: false,
	});
	expect(existsSync(mark)).toBe(true);
	return {
		text: readFileSync(out, "utf8"),
		code: Number(readFileSync(`${out}.code`, "utf8").trim()),
	};
}

/** Exact comparison without printing two megabytes on a failure. */
function expectSame(received: string, want: string) {
	expect(received.length).toBe(want.length);
	expect(received === want).toBe(true);
}

describe("exit after flush: output past a default pipe's capacity reaches a reader that starts late", () => {
	test.each([
		["dispatch, stdout", ["tool"], "stdout", 7],
		["dispatch, stderr", ["tool", "err"], "stderr", 7],
		["run, stdout", ["go"], "stdout", 5],
		["run, stderr", ["err"], "stderr", 5],
	] as const)(
		"%s",
		(_name, args, stream, code) => {
			const received = piped(entry(), [...args], { stream });
			expectSame(received.text, big());
			expect(received.code).toBe(code);
		},
		20_000,
	);

	test("the entry's own exits wait too: --version and a parse error behind pending output", () => {
		const file = entry({ versionLine: "flusher v1" });
		const fill = "p".repeat(SIZE);
		const version = piped(file, ["--version"], {
			stream: "stdout",
			env: { FLUSH_PRESSURE: "stdout" },
		});
		expectSame(version.text, `${fill}flusher v1\n`);
		expect(version.code).toBe(0);
		const message = toFile(file, ["--no-such-flag"], { stream: "stderr" });
		expect(message.text.length).toBeGreaterThan(0);
		const refused = piped(file, ["--no-such-flag"], {
			stream: "stderr",
			env: { FLUSH_PRESSURE: "stderr" },
		});
		expectSame(refused.text, `${fill}${message.text}`);
		expect(refused.code).not.toBe(0);
	}, 20_000);

	test("preview: the whole envelope", () => {
		const file = entry();
		const reference = toFile(file, ["--show-prompt"], { stream: "stdout" });
		expect(reference.text.length).toBeGreaterThan(SIZE);
		const received = piped(file, ["--show-prompt"], {
			stream: "stdout",
			markMin: SIZE,
		});
		expectSame(received.text, reference.text);
		expect(received.code).toBe(0);
	}, 20_000);

	test("print: finish's whole stdout after the backend ran", () => {
		const file = entry();
		const path = fakeBackends();
		const received = piped(file, ["--print", "hi"], {
			stream: "stdout",
			path,
			markMin: SIZE,
		});
		expectSame(received.text, big());
		expect(received.code).toBe(3);
	}, 20_000);

	test("stream: the whole after-run message behind the decoded events", () => {
		const file = entry({ mode: "stream" });
		const path = fakeBackends();
		const reference = toFile(file, ["hi"], { stream: "stdout", path });
		expect(reference.code).toBe(0);
		expect(reference.text.endsWith(`${big()}\n`)).toBe(true);
		const received = piped(file, ["hi"], {
			stream: "stdout",
			path,
			markMin: SIZE,
		});
		expectSame(received.text, reference.text);
		expect(received.code).toBe(0);
	}, 20_000);

	test("before the backend spawns: the before-run message completes first, so the backend runs only once the reader reads", () => {
		const file = entry();
		const received = piped(file, ["before"], {
			stream: "stdout",
			path: echoBackend(),
			markMin: SIZE,
		});
		expectSame(received.text, `${big()}\nbackend-after-reader\n`);
		expect(received.code).toBe(0);
	}, 20_000);
});

describe("drainingStdio: an empty write keeps the wait on the pending one", () => {
	test.each(["stdout", "stderr"] as const)(
		"%s",
		(stream) => {
			const run = join(import.meta.dir, "run.ts");
			const script = join(root, "empty-tail.ts");
			writeFileSync(
				script,
				[
					`import { writeFileSync } from "node:fs";`,
					`import { drainingStdio } from ${JSON.stringify(run)};`,
					`const stdio = drainingStdio();`,
					`stdio.${stream}(${JSON.stringify(big())});`,
					`writeFileSync(process.env.FLUSH_MARK, "written");`,
					`stdio.${stream}("");`,
					"await stdio.exit(7);",
					"",
				].join("\n"),
			);
			const received = piped(script, [], { stream });
			expectSame(received.text, big());
			expect(received.code).toBe(7);
		},
		20_000,
	);
});

type Signal = "SIGINT" | "SIGTERM";

/**
 * Starts the entry with stdout on a FIFO whose read end this process holds
 * open and never reads, waits until the entry made its large write (or,
 * with `listenFor`, until after that write it listens for that signal),
 * calls `send` to signal it, and returns the exit code and signal it ended
 * with. A child still alive five seconds after `send` returns is killed by
 * its pid and reported as wedged.
 */
async function signalledWithStuckReader(
	file: string,
	args: string[],
	options: { path: string; listenFor?: Signal; env?: Record<string, string> },
	send: (child: Subprocess) => Promise<void> | void,
) {
	const fifo = join(root, "stuck.fifo");
	const made = Bun.spawnSync(["/usr/bin/mkfifo", fifo]);
	expect(made.exitCode).toBe(0);
	const readEnd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
	const writeEnd = openSync(fifo, constants.O_WRONLY);
	const mark = join(root, "stuck.mark");
	const listen = join(root, "stuck.listen");
	const child = Bun.spawn([process.execPath, file, ...args], {
		cwd: root,
		env: {
			...process.env,
			...options.env,
			FLUSH_MARK: mark,
			FLUSH_MARK_MIN: String(SIZE),
			...(options.listenFor
				? { FLUSH_LISTEN: listen, FLUSH_LISTEN_FOR: options.listenFor }
				: {}),
			PATH: options.path,
		},
		stdin: "ignore",
		stdout: writeEnd,
		stderr: "ignore",
	});
	closeSync(writeEnd);
	try {
		await waitForFile(options.listenFor ? listen : mark, {
			diagnose: () => `exit ${child.exitCode} signal ${child.signalCode}`,
		});
		await send(child);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ended = await Promise.race([
			child.exited.then(() => true),
			new Promise<false>((done) => {
				timer = setTimeout(() => done(false), 5_000);
			}),
		]);
		clearTimeout(timer);
		if (!ended) {
			process.kill(child.pid, "SIGKILL");
			await child.exited;
			return { wedged: true, code: null, signal: null };
		}
		return {
			wedged: false,
			code: child.exitCode,
			signal: child.signalCode,
		};
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			process.kill(child.pid, "SIGKILL");
			await child.exited;
		}
		closeSync(readEnd);
	}
}

/**
 * A `claude` for stream mode that writes one assistant event of `SIZE`
 * characters, notes each SIGTERM in `$BACKEND_TERM` without exiting, and
 * stays alive until killed; its pid goes to `$BACKEND_PID`.
 */
function stubbornBackend(): string {
	const bin = join(root, "stubborn-bin");
	mkdirSync(bin, { recursive: true });
	const event = JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "text", text: "X".repeat(SIZE) }] },
	});
	writeFileSync(
		join(bin, "claude"),
		[
			`#!${process.execPath}`,
			`import { writeFileSync } from "node:fs";`,
			"writeFileSync(process.env.BACKEND_PID, String(process.pid));",
			`process.on("SIGTERM", () => writeFileSync(process.env.BACKEND_TERM, "1"));`,
			`await Bun.write(Bun.stdout, ${JSON.stringify(`${event}\n`)});`,
			"setInterval(() => {}, 1000);",
			"",
		].join("\n"),
	);
	chmodSync(join(bin, "claude"), 0o755);
	return bin;
}

describe("a terminating signal ends the wait for a reader that never reads", () => {
	// The run scope owns these signals from before the large write until the
	// final exit takes them over, so the entry must exit with 128+n.
	test.each([
		["before the backend spawns, SIGINT", ["before"], "SIGINT", 130],
		["before the backend spawns, SIGTERM", ["before"], "SIGTERM", 143],
		["a run's exit, SIGTERM", ["go"], "SIGTERM", 143],
	] as const)(
		"%s",
		async (_name, args, signal, code) => {
			const outcome = await signalledWithStuckReader(
				entry(),
				[...args],
				{ path: echoBackend() },
				(child) => {
					child.kill(signal);
				},
			);
			expect(outcome).toEqual({ wedged: false, code, signal: null });
		},
		20_000,
	);

	// Dispatch's data exit and preview's envelope are written after any run
	// scope is gone, and nothing listens until the final exit adds its
	// listener, so the signal goes only once that listener is in place.
	test.each([
		["a dispatch exit, SIGINT", ["tool"], "SIGINT", 130],
		["preview, SIGTERM", ["--show-prompt"], "SIGTERM", 143],
	] as const)(
		"%s, once the exit listens",
		async (_name, args, signal, code) => {
			const outcome = await signalledWithStuckReader(
				entry(),
				[...args],
				{ path: echoBackend(), listenFor: signal },
				(child) => {
					child.kill(signal);
				},
			);
			expect(outcome).toEqual({ wedged: false, code, signal: null });
		},
		20_000,
	);

	test("two different signals while a backend that ignores SIGTERM winds down: the first one's code, no third signal", async () => {
		const pid = join(root, "backend.pid");
		const term = join(root, "backend.term");
		try {
			const outcome = await signalledWithStuckReader(
				entry({ mode: "stream" }),
				["hi"],
				{
					path: stubbornBackend(),
					env: { BACKEND_PID: pid, BACKEND_TERM: term },
				},
				async (child) => {
					child.kill("SIGTERM");
					await waitForFile(term);
					child.kill("SIGINT");
				},
			);
			expect(outcome).toEqual({ wedged: false, code: 143, signal: null });
		} finally {
			if (existsSync(pid)) {
				try {
					process.kill(Number(readFileSync(pid, "utf8")), "SIGKILL");
				} catch {
					// Already gone: the second signal killed it.
				}
			}
		}
	}, 20_000);
});
