import { afterEach, describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import {
	claudeSessions,
	codexThreadNames,
	herdrSessions,
	latestClaudeTranscriptMtime,
	runningSessions,
} from "./sessions";
import { fakeToolEnv, jsonCommandResult, makeTree } from "./test-support";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(files: Record<string, string>) {
	const result = makeTree(files);
	cleanups.push(result.cleanup);
	return result.root;
}

function config(codex: Config["codex"] = {}): Config {
	return {
		marks: { opening: 1, charter: 1, current: 1, shared: 1 },
		windows: { doneDays: 1, currentStaleDays: 1 },
		codex,
		problems: [],
	};
}

describe("Claude adapter", () => {
	test("keeps named live sessions and skips malformed, dead and unnamed entries", () => {
		const home = fixture({
			".claude/sessions/101.json": JSON.stringify({
				name: "forge-task-001",
				cwd: "/work/forge",
				status: "working",
				pid: 101,
			}),
			".claude/sessions/102.json": JSON.stringify({
				name: "dead-task-001",
				pid: 102,
			}),
			".claude/sessions/103.json": JSON.stringify({ pid: 103 }),
			".claude/sessions/104.json": "{partial",
			".claude/sessions/note.json": JSON.stringify({
				name: "wrong-file-001",
				pid: 101,
			}),
		});

		expect(
			claudeSessions(fakeToolEnv({ home, alivePids: [101, 103] })),
		).toEqual({
			available: true,
			sessions: [
				{
					name: "forge-task-001",
					cwd: "/work/forge",
					status: "working",
					harness: "claude",
				},
			],
		});
	});

	test("reports a missing registry as unavailable", () => {
		const home = fixture({ "unrelated.txt": "" });
		expect(claudeSessions(fakeToolEnv({ home }))).toEqual({
			available: false,
			reason: "Claude session registry not found",
		});
	});

	test("finds the newest transcript for the encoded working directory", () => {
		const cwd = "/work/forge one";
		const key = cwd.replace(/[^A-Za-z0-9]/g, "-");
		const first = new Date("2026-10-05T10:00:00Z");
		const newest = new Date("2026-10-05T11:00:00Z");
		const home = fixture({
			[`.claude/projects/${key}/first.jsonl`]: "",
			[`.claude/projects/${key}/newest.jsonl`]: "",
			[`.claude/projects/${key}/note.txt`]: "",
		});
		utimesSync(
			join(home, ".claude/projects", key, "first.jsonl"),
			first,
			first,
		);
		utimesSync(
			join(home, ".claude/projects", key, "newest.jsonl"),
			newest,
			newest,
		);

		expect(latestClaudeTranscriptMtime({ home }, cwd)).toBe(newest.getTime());
		expect(latestClaudeTranscriptMtime({ home }, "/missing")).toBeUndefined();
	});
});

describe("Herdr adapter", () => {
	test("parses known harness agents and passes the exact command", async () => {
		const home = fixture({});
		const calls: string[][] = [];
		const toolEnv = fakeToolEnv({
			home,
			env: { HERDR_ENV: "1" },
			runCommand: async ({ argv }) => {
				calls.push(argv);
				return jsonCommandResult({
					result: {
						agents: [
							{
								agent: "claude",
								agent_session: { value: "abc" },
								name: "pane-label",
								cwd: "/one",
								agent_status: "idle",
							},
							{ agent: "other", name: "ignored" },
						],
					},
				});
			},
		});

		const result = await herdrSessions(toolEnv);
		expect(calls).toEqual([["herdr", "agent", "list"]]);
		expect(result).toMatchObject({
			available: true,
			sessions: [
				{
					name: "pane-label",
					cwd: "/one",
					status: "idle",
					harness: "claude",
				},
			],
		});
	});

	test("is unavailable outside Herdr and on command or JSON failures", async () => {
		const home = fixture({});
		expect(await herdrSessions(fakeToolEnv({ home }))).toEqual({
			available: false,
			reason: "not inside Herdr",
		});

		for (const result of [
			{ exitCode: 1, stdout: "", stderr: "failure" },
			{ exitCode: 0, stdout: "{broken", stderr: "" },
		]) {
			const adapter = await herdrSessions(
				fakeToolEnv({
					home,
					env: { HERDR_ENV: "1" },
					runCommand: async () => result,
				}),
			);
			expect(adapter.available).toBeFalse();
		}
	});

	test("times out a command that never resolves", async () => {
		const home = fixture({});
		const result = await herdrSessions(
			fakeToolEnv({
				home,
				env: { HERDR_ENV: "1" },
				runCommand: () => new Promise(() => {}),
			}),
			5,
		);
		expect(result).toEqual({
			available: false,
			reason: "herdr agent list timed out",
		});
	});
});

describe("Codex adapter", () => {
	test("reads all homes defensively and keeps the last rename", () => {
		const home = fixture({
			".codex/session_index.jsonl": [
				JSON.stringify({ id: "one", thread_name: "old-name" }),
				"",
				"{partial",
				JSON.stringify({ id: "one", thread_name: "new-name" }),
			].join("\n"),
			".codex-work/session_index.jsonl": `${JSON.stringify({ id: "two", thread_name: "work-name" })}\n`,
			"configured/session_index.jsonl": `${JSON.stringify({ id: "three", thread_name: "configured-name" })}\n`,
			"environment/session_index.jsonl": `${JSON.stringify({ id: "four", thread_name: "environment-name" })}\n`,
		});
		const names = codexThreadNames(
			fakeToolEnv({
				home,
				env: { CODEX_HOME: join(home, "environment") },
			}),
			config({ home: join(home, "configured") }),
		);

		expect(Object.fromEntries(names)).toEqual({
			one: "new-name",
			two: "work-name",
			three: "configured-name",
			four: "environment-name",
		});
	});

	test("reads a configured home file", () => {
		const home = fixture({
			"active-home": "\n~/.account\nignored\n",
			".account/session_index.jsonl": JSON.stringify({
				id: "account",
				thread_name: "account-name",
			}),
		});
		const names = codexThreadNames(
			fakeToolEnv({ home }),
			config({ homeFile: join(home, "active-home") }),
		);
		expect(names.get("account")).toBe("account-name");
	});

	test("names Herdr Codex agents from indexes with both fallbacks", async () => {
		const home = fixture({
			".claude/sessions/.keep": "",
			".codex/session_index.jsonl": JSON.stringify({
				id: "named-id",
				thread_name: "index-name",
			}),
		});
		const result = await runningSessions(
			fakeToolEnv({
				home,
				env: { HERDR_ENV: "1" },
				runCommand: async () =>
					jsonCommandResult({
						result: {
							agents: [
								{
									agent: "codex",
									agent_session: { value: "named-id" },
									cwd: "/named",
									agent_status: "working",
								},
								{
									agent: "codex",
									agent_session: { value: "label-id" },
									name: "pane-label",
								},
								{
									agent: "codex",
									agent_session: { value: "1234567890" },
								},
							],
						},
					}),
			}),
			config(),
		);

		expect(result.codex).toMatchObject({ available: true });
		expect(result.sessions.map(({ name }) => name)).toEqual([
			"index-name",
			"pane-label (Herdr label; session unnamed)",
			"codex 12345678 (unnamed)",
		]);
	});

	test("makes Codex unavailable whenever Herdr is unavailable", async () => {
		const home = fixture({ "unrelated.txt": "" });
		const result = await runningSessions(fakeToolEnv({ home }), config());
		expect(result.sessions).toEqual([]);
		expect(result.claude.available).toBeFalse();
		expect(result.herdr).toEqual({
			available: false,
			reason: "not inside Herdr",
		});
		expect(result.codex).toEqual(result.herdr);
	});
});
