import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandResult } from "../agent-format/types";
import type { ToolEnv } from "./sessions";

export interface MakeTreeOptions {
	symlinks?: Record<string, string>;
	mtimes?: Record<string, Date | string | number>;
	prefix?: string;
}

export interface TreeFixture {
	root: string;
	cleanup: () => void;
}

export interface FakeToolEnvOptions {
	home: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	alivePids?: Iterable<number>;
	runCommand?: ToolEnv["runCommand"];
	clock?: ToolEnv["clock"];
}

/** Build a deterministic ToolEnv for Shepherd unit tests. */
export function fakeToolEnv({
	home,
	cwd = home,
	env = {},
	alivePids = [],
	runCommand = async () => ({ exitCode: 1, stdout: "", stderr: "" }),
	clock,
}: FakeToolEnvOptions): ToolEnv {
	const alive = new Set(alivePids);
	const now = new Date("2026-10-05T12:00:00Z");
	return {
		cwd,
		home,
		env,
		now,
		clock: clock ?? (() => new Date(now)),
		runCommand,
		pidAlive: (pid) => alive.has(pid),
	};
}

/** A controllable clock that returns independent Date instances. */
export function fakeClock(start: Date | string | number) {
	let time = new Date(start).getTime();
	return {
		clock: () => new Date(time),
		advance: (ms: number) => {
			time += ms;
		},
	};
}

/** A successful canned command result, serialized as JSON. */
export function jsonCommandResult(value: unknown): CommandResult {
	return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

/** Build an isolated filesystem tree for Shepherd tests. */
export function makeTree(
	files: Record<string, string>,
	options: MakeTreeOptions = {},
): TreeFixture {
	const root = mkdtempSync(join(tmpdir(), options.prefix ?? "shepherd-test-"));
	for (const [relative, content] of Object.entries(files)) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	for (const [relative, target] of Object.entries(options.symlinks ?? {})) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		symlinkSync(join(root, target), path);
	}
	for (const [relative, value] of Object.entries(options.mtimes ?? {})) {
		const date = value instanceof Date ? value : new Date(value);
		utimesSync(join(root, relative), date, date);
	}
	return {
		root,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** A CURRENT with two off-shape entries (lines 8 and 9) and an unknown word (line 11). */
export const OFF_SHAPE_CURRENT = `# Current
Updated: 2026-10-15 09:00, forge-1014

Some line.

## Items
- **NEXT** [session-identity](work/in-progress/session-identity/STATUS.md): step 3, the spec
- **ASK: consulting**, the user decides on PR #13
- **WAITING forge** (PR #13 gates)
- **CANDIDATE** tool friction, standing
- **BLOCKED** no access
`;
