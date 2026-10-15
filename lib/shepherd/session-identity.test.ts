import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkWorkspace } from "./check";
import { runningSessions } from "./sessions";
import { runStart } from "./start";
import { renderStatus, statusReport } from "./status-render";
import { IDENTITY_SESSION, identityFixture } from "./test-support";
import { runTool } from "./tool";
import { discoverTree } from "./tree";

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
	listed: "forge-1014",
	writer: "forge-1014",
	running: "forge-1015",
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
			expect(message).toContain("forge-1014");
			expect(message).toContain("forge-1015");
		}
	});

	test("tool start shows the warnings under Check", async () => {
		const f = await fixture(PREDECESSOR);
		const start = runStart(f.workspace, discoverTree(f.dir), f.env, f.config, {
			json: false,
			today: f.env.now,
		});
		const check = start.text.slice(start.text.indexOf("## Check"));
		expect(check).toContain("forge-1015 is running here but the record names");
		expect(check).toContain("forge-1014 is listed live");
	});

	test("status reports the same drift and gone names", async () => {
		const f = await fixture(PREDECESSOR);
		const tree = discoverTree(f.dir);
		const report = statusReport(
			tree.workspaces,
			tree,
			await runningSessions(f.env, f.config),
			f.home,
		);
		const live = report.workspaces[0]?.live;
		const findings = identityFindings(f);
		expect(asFindings(live?.drift ?? [])).toEqual(findings);
		expect(live?.gone.map(({ name }) => name)).toEqual(
			findings
				.filter(({ code }) => code === "session-gone")
				.map(() => "forge-1014"),
		);
		expect(renderStatus(report, f.home)).toContain(
			"  DRIFT     forge-1015 is running here",
		);
	});

	test("query sessions reports the caller and the same drift", async () => {
		const f = await fixture(PREDECESSOR);
		const output = await runTool(["query", "sessions"], { json: true }, f.env);
		const json = JSON.parse(output.text);
		expect(json.caller).toEqual({
			harness: "claude",
			id: IDENTITY_SESSION,
			name: "forge-1015",
			role: "shepherd",
		});
		expect(asFindings(json.drift)).toEqual(identityFindings(f));
		const text = await runTool(["query", "sessions"], {}, f.env);
		expect(text.text).toContain("caller: forge-1015 (shepherd)");
		expect(text.text).toContain("drift session-gone forge-1014");
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
			["forge-1015"],
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
				"- forge-1014: Claude Code, Shepherd",
				"- forge-1015: Claude Code, Shepherd",
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
		).toBe("forge-1015");
		expect(readFileSync(current, "utf8")).toContain(
			"Updated: 2026-10-15 09:00, forge-1015",
		);
		expect(identityFindings(f)).toEqual([]);
	});
});
