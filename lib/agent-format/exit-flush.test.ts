import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEntry } from "./compiler";
import type { AgentSpec } from "./types";

// docs/AGENT-FORMAT.md, Command line: everything a binary writes to stdout
// and stderr reaches the reader before the process exits, whatever the size
// and whether the reader is a file, a pipe or a terminal. These tests run a
// generated entry in a child whose stream is a pipe with a slow reader, so
// the process reaches its exit while the pipe (64 KiB on macOS) is full.

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agent-exit-flush-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** More than twice the pipe buffer, numbered so a lost or moved byte shows. */
const SIZE = 2 * 65_536 + 4_321;

const spec: AgentSpec = {
	id: "flusher",
	description: "Fixture",
	backends: ["claude"],
	promptMode: "append",
	mode: "interactive",
	initialPrompt: "{{args}}",
	systemPrompt: "Body",
	flags: {},
};

const EXTENSION = `
const SIZE = ${SIZE};
function big(): string {
	let text = "";
	for (let i = 0; text.length < SIZE; i++) text += \`line \${i}\\n\`;
	return text.slice(0, SIZE);
}
const stream = (argv: readonly string[]) =>
	argv.includes("err") ? "stderr" : "stdout";
export function dispatch(argv: string[]) {
	if (argv[0] !== "tool") return undefined;
	return { exit: { message: big(), code: 7, stream: stream(argv) } };
}
export function prepare(ctx: { args: readonly string[] }) {
	return { exit: { message: big(), code: 5, stream: stream(ctx.args) } };
}
`;

function expected(): string {
	let text = "";
	for (let i = 0; text.length < SIZE; i++) text += `line ${i}\n`;
	return text.slice(0, SIZE);
}

function entry(versionLine?: string): string {
	const extension = join(root, "flusher.ts");
	writeFileSync(extension, EXTENSION);
	const file = join(root, "entry.ts");
	writeFileSync(
		file,
		generateEntry(
			{
				id: "flusher",
				file: join(root, "flusher.md"),
				spec,
				extension: { file: extension, exports: ["dispatch", "prepare"] },
			},
			versionLine,
		),
	);
	return file;
}

/** What one stream of the entry holds when it goes to a file. */
function toFile(file: string, args: string[], stream: "stdout" | "stderr") {
	const result = Bun.spawnSync([process.execPath, file, ...args], {
		cwd: root,
		env: { ...process.env, PATH: "/nonexistent" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return result[stream].toString();
}

/** Bytes that fill the pipe before the entry writes, so its writes wait. */
const PREFILL = 65_536;

/**
 * Runs the entry with one stream piped into a reader that waits before it
 * reads, then returns the bytes that reader received and the exit code.
 * With `prefill`, the pipe is full before the entry starts.
 */
function piped(
	file: string,
	args: string[],
	stream: "stdout" | "stderr",
	prefill = false,
) {
	const out = join(root, "out", `${stream}-${args.join("-")}`);
	mkdirSync(join(root, "out"), { recursive: true });
	const redirect = stream === "stdout" ? "2>/dev/null" : "2>&1 >/dev/null";
	const fill = prefill
		? `/usr/bin/head -c ${PREFILL} /dev/zero | /usr/bin/tr '\\0' z;`
		: "";
	const script = `${fill} "$BUN" "$ENTRY" "$@" ${redirect}; echo $? > "$OUT.code"`;
	const result = Bun.spawnSync(
		[
			"/bin/sh",
			"-c",
			`{ ${script}; } | { /bin/sleep 0.5; /bin/cat > "$OUT"; }`,
			"sh",
			...args,
		],
		{
			cwd: root,
			env: {
				...process.env,
				BUN: process.execPath,
				ENTRY: file,
				OUT: out,
				PATH: "/nonexistent",
			},
		},
	);
	expect(result.exitCode).toBe(0);
	return {
		text: readFileSync(out, "utf8"),
		code: Number(readFileSync(`${out}.code`, "utf8").trim()),
	};
}

describe("exit after flush: output past the pipe buffer reaches a slow reader", () => {
	test.each([
		["dispatch, stdout", ["tool"], "stdout", 7],
		["dispatch, stderr", ["tool", "err"], "stderr", 7],
		["run, stdout", ["go"], "stdout", 5],
		["run, stderr", ["err"], "stderr", 5],
	] as const)(
		"%s",
		(_name, args, stream, code) => {
			const received = piped(entry(), [...args], stream);
			const want = expected();
			expect(received.text.length).toBe(want.length);
			expect(received.text === want).toBe(true);
			expect(received.code).toBe(code);
		},
		20_000,
	);

	test("the entry's own exits wait too: --version and a parse error on a full pipe", () => {
		const file = entry("flusher v1");
		const fill = "z".repeat(PREFILL);
		const version = piped(file, ["--version"], "stdout", true);
		expect(version.text.length).toBe(PREFILL + "flusher v1\n".length);
		expect(version.text === `${fill}flusher v1\n`).toBe(true);
		expect(version.code).toBe(0);
		const message = toFile(file, ["--no-such-flag"], "stderr");
		expect(message.length).toBeGreaterThan(0);
		const refused = piped(file, ["--no-such-flag"], "stderr", true);
		expect(refused.text.length).toBe(PREFILL + message.length);
		expect(refused.text === `${fill}${message}`).toBe(true);
		expect(refused.code).not.toBe(0);
	}, 20_000);
});
