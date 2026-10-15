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

export const IDENTITY_SESSION = "0f3c2a71-5b2e-4a8e-9d55-3f1e2b9c7a10";

/**
 * A workspace "forge" (prefix forge) whose CURRENT lists `listed` live and
 * names it on the Updated: line, certified by `writer`, while the Claude
 * registry runs `running` in the workspace as pid 4242, the caller.
 */
export async function identityFixture({
	listed,
	writer,
	running,
	extraRunning = [],
	herdrAgents,
}: {
	listed: string;
	writer: string;
	running: string;
	extraRunning?: { pid: number; name: string; cwd?: string }[];
	herdrAgents?: (dir: string) => unknown[];
}) {
	const tree = makeTree({
		"xdg/shepherd/config.json": "{}",
		"forge/.shepherd/charter.md": "# forge\n",
		"forge/.shepherd/config.json": '{"sessionPrefix":"forge"}',
		"forge/.shepherd/journal.md": "## 2026-10-15\n- 09:00 started\n",
		"forge/.shepherd/CURRENT.md": `# Current\nUpdated: 2026-10-15 09:00, ${listed}\n\n## Items\n- **NEXT** carry on\n\n## Live sessions\n- ${listed}: Claude Code, Shepherd\n`,
	});
	const dir = join(tree.root, "forge");
	const home = join(tree.root, "home");
	const workspace = { name: "forge", dir, state: join(dir, ".shepherd") };
	const config = testConfig({ sessionPrefix: "forge" });
	// Imported here so test-support stays light for tests that mock modules.
	const { runCheckpoint } = await import("./checkpoint-command");
	const { captureState } = await import("./checkpoint-write");
	const quiet = fakeToolEnv({ home, cwd: dir });
	const certified = await runCheckpoint(workspace, quiet, config, {
		apply: true,
		token: captureState(workspace, quiet).token,
		session: writer,
		json: false,
	});
	if (certified.code !== 0) throw new Error(certified.text);
	const sessions = join(home, ".claude", "sessions");
	mkdirSync(sessions, { recursive: true });
	const entries = [
		{ pid: 4242, name: running, sessionId: IDENTITY_SESSION, cwd: dir },
		...extraRunning.map((entry) => ({
			sessionId: `session-${entry.pid}`,
			cwd: dir,
			...entry,
		})),
	];
	for (const entry of entries)
		writeFileSync(
			join(sessions, `${entry.pid}.json`),
			JSON.stringify({ status: "idle", nameSource: "user", ...entry }),
		);
	const env = fakeToolEnv({
		home,
		cwd: dir,
		alivePids: entries.map(({ pid }) => pid),
		env: {
			XDG_CONFIG_HOME: join(tree.root, "xdg"),
			CLAUDE_PID: "4242",
			CLAUDE_CODE_SESSION_ID: IDENTITY_SESSION,
			...(herdrAgents ? { HERDR_ENV: "1" } : {}),
		},
		runCommand: async () =>
			jsonCommandResult({ result: { agents: herdrAgents?.(dir) ?? [] } }),
	});
	return { ...tree, dir, home, workspace, config, env };
}
