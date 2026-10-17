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
import {
	type Config,
	DEFAULT_HANDOFF_CEILINGS,
	DEFAULT_MARKS,
	DEFAULT_START,
	DEFAULT_WINDOWS,
} from "./config";
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

/** A valid config with the defaults, and the given fields over them. */
export function testConfig(overrides: Partial<Config> = {}): Config {
	return {
		marks: { ...DEFAULT_MARKS },
		windows: { ...DEFAULT_WINDOWS },
		start: { ...DEFAULT_START },
		handoffCeilings: { ...DEFAULT_HANDOFF_CEILINGS },
		codex: {},
		problems: [],
		...overrides,
	};
}

/** The contract's mail example (docs/PACKAGES.md), with `extra` frontmatter appended. */
export function packageText(
	name: string,
	extra = "",
	body = `# Integration: ${name}\n\n${name} package body.\n`,
	contract = "contract: 1\n",
): string {
	return `---\nname: ${name}\ntype: domain\ndescription: ${name} package\napplies-when:\n  charter-declares: ${name}\nbudget: 400\ncharter-keys: {}\n${contract}${extra}---\n${body}`;
}

export const MAIL_TOOLS =
	"tools:\n  unread:\n    description: List unread threads in the inbox\n    access: read\n    requires: [hey]\n    network: true\n  send:\n    description: Send a drafted reply\n    access: write\nguides:\n  triage:\n    description: How to triage the inbox, in order\n";
