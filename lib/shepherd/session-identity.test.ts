import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkWorkspace } from "./check";
import { runCheckpoint } from "./checkpoint-command";
import { captureState } from "./checkpoint-write";
import { runningSessions } from "./sessions";
import { runStart } from "./start";
import { renderStatus, statusReport } from "./status-render";
import {
	fakeToolEnv,
	jsonCommandResult,
	makeTree,
	testConfig,
} from "./test-support";
import { runTool } from "./tool";
import { discoverTree } from "./tree";

const IDENTITY_SESSION = "0f3c2a71-5b2e-4a8e-9d55-3f1e2b9c7a10";

/**
 * A workspace in directory forge with prefix fg, so the prefix cannot come
 * from the directory name, whose CURRENT lists `listed` live and
 * names it on the Updated: line, certified by `writer`, while the Claude
 * registry runs `running` in the workspace as pid 4242, the caller.
 */
async function identityFixture({
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
		"forge/.shepherd/config.json": '{"sessionPrefix":"fg"}',
		"forge/.shepherd/journal.md": "## 2026-10-15\n- 09:00 started\n",
		"forge/.shepherd/CURRENT.md": `# Current\nUpdated: 2026-10-15 09:00, ${listed}\n\n## Items\n- **NEXT** carry on\n\n## Live sessions\n- ${listed}: Claude Code, Shepherd\n`,
	});
	const dir = join(tree.root, "forge");
	const home = join(tree.root, "home");
	const workspace = { name: "forge", dir, state: join(dir, ".shepherd") };
	const config = testConfig({ sessionPrefix: "fg" });
	const quiet = fakeToolEnv({ home, cwd: dir });
	const certified = await runCheckpoint(workspace, quiet, config, false, {
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

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

type Fixture = Awaited<ReturnType<typeof identityFixture>>;
async function fixture(args: Parameters<typeof identityFixture>[0]) {
	const f = await identityFixture(args);
	cleanups.push(f.cleanup);
	return f;
}
const PREDECESSOR = {
	listed: "fg-1014",
	writer: "fg-1014",
	running: "fg-1015",
};

function identityFindings(f: Fixture) {
	return checkWorkspace(
		f.workspace,
		discoverTree(f.dir),
		f.config,
		f.env.now,
		f.home,
		f.env,
	)
		.filter(({ code }) => code.startsWith("session-"))
		.map(({ level, code, file, line, message }) => ({
			level,
			code,
			file,
			line,
			message,
		}));
}
const asFindings = (
	drift: { code: string; line?: number; message: string }[],
) =>
	drift.map(({ code, line, message }) => ({
		level: "warn",
		code,
		file: "CURRENT.md",
		line,
		message,
	}));

describe("acceptance 2: a predecessor listed while another Shepherd runs", () => {
	test("check warns, naming both sessions", async () => {
		const findings = identityFindings(await fixture(PREDECESSOR));
		expect(findings.map(({ code }) => code)).toEqual([
			"session-unrecorded",
			"session-gone",
		]);
		for (const { message } of findings) {
			expect(message).toContain("fg-1014");
			expect(message).toContain("fg-1015");
		}
	});

	test("tool start shows the warnings under Check", async () => {
		const f = await fixture(PREDECESSOR);
		const start = runStart(f.workspace, discoverTree(f.dir), f.env, f.config, {
			json: false,
			today: f.env.now,
		});
		const check = start.text.slice(start.text.indexOf("## Check"));
		expect(check).toContain("fg-1015 is running here but the record names");
		expect(check).toContain("fg-1014 is listed live");
	});

	test("status reports the same drift and gone names", async () => {
		const f = await fixture(PREDECESSOR);
		const tree = discoverTree(f.dir);
		const report = statusReport(
			tree.workspaces,
			tree,
			await runningSessions(f.env, f.config),
			f.home,
			new Map([[f.dir, f.config]]),
		);
		const live = report.workspaces[0]?.live;
		const findings = identityFindings(f);
		expect(asFindings(live?.drift ?? [])).toEqual(findings);
		expect(live?.gone.map(({ name }) => name)).toEqual(
			findings
				.filter(({ code }) => code === "session-gone")
				.map(() => "fg-1014"),
		);
		expect(renderStatus(report, f.home)).toContain(
			"  DRIFT     fg-1015 is running here",
		);
	});

	test("query sessions reports the caller and the same drift", async () => {
		const f = await fixture(PREDECESSOR);
		const output = await runTool(["query", "sessions"], { json: true }, f.env);
		const json = JSON.parse(output.text);
		expect(json.caller).toEqual({
			harness: "claude",
			id: IDENTITY_SESSION,
			name: "fg-1015",
			role: "shepherd",
		});
		expect(asFindings(json.drift)).toEqual(identityFindings(f));
		const text = await runTool(["query", "sessions"], {}, f.env);
		expect(text.text).toContain("caller: fg-1015 (shepherd)");
		expect(text.text).toContain("drift session-gone fg-1014");
	});

	test("query sessions names a Herdr Claude agent from the registry first", async () => {
		const f = await fixture({
			...PREDECESSOR,
			herdrAgents: (dir) => [
				{
					agent: "claude",
					agent_session: { value: IDENTITY_SESSION },
					name: "x",
					cwd: dir,
				},
			],
		});
		const json = JSON.parse(
			(await runTool(["query", "sessions"], { json: true }, f.env)).text,
		);
		expect(json.herdr.agents.map(({ name }: { name: string }) => name)).toEqual(
			["fg-1015"],
		);
	});
});

describe("acceptance 1: a handoff with no name typed", () => {
	test("records the successor and leaves check without an identity warning", async () => {
		const f = await fixture(PREDECESSOR);
		const current = join(f.workspace.state, "CURRENT.md");
		writeFileSync(
			current,
			readFileSync(current, "utf8").replace(
				"- fg-1014: Claude Code, Shepherd",
				"- fg-1015: Claude Code, Shepherd",
			),
		);
		const dry = JSON.parse(
			(await runTool(["checkpoint"], { json: true }, f.env)).text,
		);
		expect(dry.apply).not.toContain("--session");
		const applied = await runTool(
			["checkpoint"],
			{ apply: true, token: dry.token },
			f.env,
		);
		expect(applied.code).toBe(0);
		expect(
			JSON.parse(
				readFileSync(join(f.workspace.state, "checkpoint.json"), "utf8"),
			).session,
		).toBe("fg-1015");
		expect(readFileSync(current, "utf8")).toContain(
			"Updated: 2026-10-15 09:00, fg-1015",
		);
		expect(identityFindings(f)).toEqual([]);
	});
});

describe("a workspace with a child workspace beneath it", () => {
	test("does not own a subdirectory, so a caller there is not its Shepherd", async () => {
		const f = await fixture({ ...PREDECESSOR, listed: "fg-1015" });
		mkdirSync(join(f.dir, "kid", ".shepherd"), { recursive: true });
		writeFileSync(join(f.dir, "kid", ".shepherd", "charter.md"), "# kid\n");
		const sub = join(f.dir, "sub");
		mkdirSync(sub);
		writeFileSync(
			join(f.home, ".claude", "sessions", "4242.json"),
			JSON.stringify({
				pid: 4242,
				name: "fg-1015",
				nameSource: "user",
				sessionId: IDENTITY_SESSION,
				cwd: sub,
				status: "idle",
			}),
		);
		const dry = await runTool(["checkpoint"], {}, f.env);
		expect(dry.text).toContain(
			"writer: none (fg-1015 is not this workspace's Shepherd (prefix fg-);",
		);
	});
});
