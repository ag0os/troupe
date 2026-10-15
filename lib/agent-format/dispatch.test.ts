import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForFile } from "./fake-cli";
import { type DispatchIo, type RunnerSignal, runDispatch } from "./run";
import type { AgentSpec, DispatchResult } from "./types";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agent-dispatch-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const spec = { id: "fixture" } as AgentSpec;

/** A POSIX sh executable under the test root. */
function tool(name: string, body: string): string {
	const file = join(root, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

function io(overrides: Partial<DispatchIo> = {}) {
	const out = { stdout: "", stderr: "" };
	const value: DispatchIo = {
		cwd: root,
		env: { PATH: process.env.PATH, CALLER: "kept" },
		stdout: (text) => {
			out.stdout += text;
		},
		stderr: (text) => {
			out.stderr += text;
		},
		...overrides,
	};
	return { io: value, out };
}

describe("runDispatch (O12, D1)", () => {
	test("no dispatch export, or undefined from it, falls through", async () => {
		expect(await runDispatch(spec, {}, ["tool", "x"], io().io)).toBeUndefined();
		expect(
			await runDispatch(spec, { dispatch: () => undefined }, ["x"], io().io),
		).toBeUndefined();
	});

	test("an exec description runs the file with its args, cwd and env, and returns its code", async () => {
		const record = join(root, "record.json");
		const file = tool(
			"recorder",
			`printf '{"argv":"%s","cwd":"%s","pkg":"%s","caller":"%s"}' "$*" "$(pwd -P)" "$SHEPHERD_PACKAGE" "$CALLER" > "${record}"\nexit 3`,
		);
		const cwd = root;
		const seen: { argv: readonly string[]; cwd: string }[] = [];
		const { io: dispatchIo } = io();
		const code = await runDispatch(
			spec,
			{
				dispatch: (argv, ctx) => {
					seen.push({ argv, cwd: ctx.cwd });
					return {
						exec: {
							file,
							args: ["--base", "main", "--json", "-h"],
							cwd,
							env: { SHEPHERD_PACKAGE: "software" },
						},
					};
				},
			},
			["tool", "software", "x"],
			dispatchIo,
		);
		expect(code).toBe(3);
		expect(seen).toEqual([{ argv: ["tool", "software", "x"], cwd: root }]);
		expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
			argv: "--base main --json -h",
			cwd,
			pkg: "software",
			caller: "kept",
		});
	});

	test("an exit description writes its message on its stream and returns its code", async () => {
		const { io: dispatchIo, out } = io();
		const code = await runDispatch(
			spec,
			{
				dispatch: () => ({
					exit: { message: "shepherd: refused\n", code: 2, stream: "stderr" },
				}),
			},
			["tool"],
			dispatchIo,
		);
		expect({ code, ...out }).toEqual({
			code: 2,
			stdout: "",
			stderr: "shepherd: refused\n",
		});
	});

	test("an invalid description is refused and nothing runs", async () => {
		const marker = join(root, "ran");
		const file = tool("marker", `touch "${marker}"`);
		for (const bad of [
			{ exec: { file: "relative", args: [], cwd: root, env: {} } },
			{ exec: { file, args: [], cwd: "relative", env: {} } },
			{ exec: { file, args: [], cwd: root, env: { "BAD-NAME": "x" } } },
			{ exec: { file, args: [], cwd: root, env: {}, shell: true } },
			{ argv: [file] },
		]) {
			const { io: dispatchIo, out } = io();
			const code = await runDispatch(
				spec,
				{ dispatch: () => bad as unknown as DispatchResult },
				["tool"],
				dispatchIo,
			);
			expect(code).toBe(1);
			expect(out.stderr).toContain("fixture: dispatch returned an invalid result");
		}
		expect(existsSync(marker)).toBe(false);
	});

	test("a dispatch throw is stderr and 1", async () => {
		const { io: dispatchIo, out } = io();
		const code = await runDispatch(
			spec,
			{
				dispatch: () => {
					throw new Error("boom");
				},
			},
			["tool"],
			dispatchIo,
		);
		expect(code).toBe(1);
		expect(out.stderr).toBe("fixture: dispatch failed: boom\n");
	});

	test("a signal is forwarded to the tool and the code is 128 plus its number", async () => {
		const started = join(root, "started");
		const file = tool(
			"sleeper",
			`echo $$ > "${started}"\nwhile :; do sleep 0.05; done`,
		);
		let handler: ((signal: RunnerSignal) => void) | undefined;
		const { io: dispatchIo } = io({
			signals: (next) => {
				handler = next;
				return () => {
					handler = undefined;
				};
			},
		});
		const pending = runDispatch(
			spec,
			{
				dispatch: () => ({ exec: { file, args: [], cwd: root, env: {} } }),
			},
			["tool"],
			dispatchIo,
		);
		await waitForFile(started);
		handler?.("SIGTERM");
		expect(await pending).toBe(143);
		expect(handler).toBeUndefined();
	});
});
