import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Caller, callerSession } from "./caller";
import { fakeToolEnv, makeTree, testConfig } from "./test-support";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const SESSION = "0f3c2a71-5b2e-4a8e-9d55-3f1e2b9c7a10";
const THREAD = "01a0d582-7c41-4f3e-8a2b-9e1d0c3b4a55";
const CLAUDE = { CLAUDE_PID: "4242", CLAUDE_CODE_SESSION_ID: SESSION };

type Entry = {
	pid?: number;
	sessionId?: string;
	name?: string;
	nameSource?: string;
	cwd?: string;
};

/**
 * A workspace "forge" and a fake home with one registry entry for pid 4242
 * (in the workspace unless the entry says otherwise) and a Codex index.
 */
function resolve(
	entry: Entry | null,
	env: Record<string, string>,
	options: { alive?: boolean; codexNames?: [string, string][] } = {},
) {
	const tree = makeTree({
		"forge/.shepherd/CURRENT.md": "# Current\n",
		...(options.codexNames
			? {
					"home/.codex/session_index.jsonl": `${options.codexNames
						.map(([id, thread_name]) => JSON.stringify({ id, thread_name }))
						.join("\n")}\n`,
				}
			: {}),
	});
	cleanups.push(tree.cleanup);
	const dir = join(tree.root, "forge");
	const home = join(tree.root, "home");
	if (entry) {
		const full = {
			pid: 4242,
			sessionId: SESSION,
			cwd: dir,
			status: "busy",
			kind: "interactive",
			...entry,
		};
		mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
		writeFileSync(
			join(home, ".claude", "sessions", `${full.pid}.json`),
			JSON.stringify(full),
		);
	}
	return callerSession(
		fakeToolEnv({
			home,
			cwd: dir,
			env,
			alivePids: options.alive === false ? [] : [4242],
		}),
		{ dir },
		testConfig(),
		false,
	);
}

describe("callerSession", () => {
	test("a named Claude session in the workspace with its prefix is the Shepherd", () => {
		expect(resolve({ name: "forge-1015", nameSource: "user" }, CLAUDE)).toEqual(
			{
				harness: "claude",
				id: SESSION,
				name: "forge-1015",
				role: "shepherd",
			},
		);
	});

	test("a name Claude Code derived is no name", () => {
		expect(
			resolve({ name: "forge-1015", nameSource: "derived" }, CLAUDE),
		).toEqual({
			harness: "claude",
			id: SESSION,
			name: null,
			role: "other",
			reason: "name derived by Claude Code; name the session",
		});
	});

	test("a delegate in the same directory is other", () => {
		expect(resolve({ name: "si-x", nameSource: "user" }, CLAUDE)).toEqual({
			harness: "claude",
			id: SESSION,
			name: "si-x",
			role: "other",
		});
	});

	test("a prefixed session outside the workspace is other", () => {
		expect(
			resolve({ name: "forge-1015", cwd: "/elsewhere" }, CLAUDE).role,
		).toBe("other");
	});

	test("a dead pid or a session id mismatch is no caller", () => {
		const none: Caller = { harness: null, id: null, name: null, role: "none" };
		expect(resolve({ name: "forge-1015" }, CLAUDE, { alive: false })).toEqual(
			none,
		);
		expect(
			resolve({ name: "forge-1015", sessionId: "another" }, CLAUDE),
		).toEqual(none);
		expect(resolve(null, CLAUDE)).toEqual(none);
	});

	test("a Codex thread is named from the index, or unnamed", () => {
		expect(
			resolve(
				null,
				{ CODEX_THREAD_ID: THREAD },
				{ codexNames: [[THREAD, "forge-1015"]] },
			),
		).toEqual({
			harness: "codex",
			id: THREAD,
			name: "forge-1015",
			role: "shepherd",
		});
		expect(
			resolve(null, { CODEX_THREAD_ID: THREAD }, { codexNames: [] }),
		).toEqual({
			harness: "codex",
			id: THREAD,
			name: null,
			role: "other",
			reason: "Codex thread has no name; use the rename dialog",
		});
	});

	test("both harness variables set is ambiguous", () => {
		expect(
			resolve(
				{ name: "forge-1015" },
				{ ...CLAUDE, CODEX_THREAD_ID: THREAD },
				{ codexNames: [[THREAD, "forge-1015"]] },
			),
		).toEqual({
			harness: null,
			id: null,
			name: null,
			role: "none",
			reason: "both CLAUDE_PID and CODEX_THREAD_ID are set; pass --session",
		});
	});

	test("an empty environment is no caller", () => {
		expect(resolve({ name: "forge-1015" }, {})).toEqual({
			harness: null,
			id: null,
			name: null,
			role: "none",
		});
	});
});
