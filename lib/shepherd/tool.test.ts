import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeToolEnv, makeTree } from "./test-support";
import { runTool } from "./tool";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
	const tree = makeTree({
		"root/.shepherd/charter.md": "# Root\n",
		"root/.shepherd/CURRENT.md":
			"Updated: 2026-10-05\n\n## Items\n- NEXT: Continue\n",
		"root/.shepherd/journal.md": "# Journal\n",
		"root/child/.shepherd/charter.md": "# Child\n",
		"root/child/.shepherd/CURRENT.md": "Updated: 2026-10-05\n",
		"root/child/.shepherd/journal.md": "# Journal\n",
	});
	cleanups.push(tree.cleanup);
	const cwd = join(tree.root, "root");
	return {
		tree,
		cwd,
		env: fakeToolEnv({ home: join(tree.root, "home"), cwd }),
	};
}

describe("runTool usage and validation", () => {
	test("requires check or archive and prints both usage lines", async () => {
		const { env } = fixture();
		for (const args of [[], ["sweep"]]) {
			const output = await runTool(args, {}, env);
			expect(output).toMatchObject({ code: 2, stream: "stderr" });
			expect(output.text).toContain("shepherd tool check");
			expect(output.text).toContain("shepherd tool archive");
		}
	});

	test("rejects command-specific flags and conflicting check modes", async () => {
		const { env } = fixture();
		expect(await runTool(["check"], { apply: true }, env)).toMatchObject({
			code: 2,
			stream: "stderr",
		});
		expect(await runTool(["archive"], { status: true }, env)).toMatchObject({
			code: 2,
			stream: "stderr",
		});
		expect(
			await runTool(["check"], { status: true, context: true }, env),
		).toMatchObject({ code: 2, stream: "stderr" });
	});

	test("rejects malformed dates and unknown workspaces", async () => {
		const { env } = fixture();
		for (const command of ["check", "archive"] as const) {
			expect(
				await runTool([command], { today: "2026-13-40" }, env),
			).toMatchObject({ code: 2, stream: "stderr" });
		}
		const unknown = await runTool(["check", "missing"], {}, env);
		expect(unknown).toMatchObject({ code: 2, stream: "stderr" });
		expect(unknown.text).toContain("unknown workspace: missing");
	});

	test("names the nearest workspace for a non-workspace cwd", async () => {
		const { tree, cwd, env } = fixture();
		const nested = join(cwd, "notes");
		const output = await runTool(["check"], {}, { ...env, cwd: nested });
		expect(output).toMatchObject({ code: 2, stream: "stderr" });
		expect(output.text).toContain(
			`the nearest one is ${join(tree.root, "root")}`,
		);
	});
});

describe("runTool output", () => {
	test("returns findings JSON with the specified envelope and totals", async () => {
		const { cwd, env } = fixture();
		const output = await runTool(
			["check"],
			{ json: true, today: "2026-10-05" },
			env,
		);
		const json = JSON.parse(output.text);
		expect(json).toMatchObject({
			schema: 1,
			command: "check",
			mode: "findings",
			root: cwd,
			today: "2026-10-05",
			totals: {
				error: expect.any(Number),
				warn: expect.any(Number),
				info: expect.any(Number),
			},
		});
		expect(json.workspaces).toHaveLength(2);
		expect(json.workspaces[0]).toMatchObject({
			name: "root",
			dir: cwd,
			counts: {
				error: expect.any(Number),
				warn: expect.any(Number),
				info: expect.any(Number),
			},
			findings: expect.any(Array),
		});
	});

	test("returns context and status JSON shapes", async () => {
		const { env } = fixture();
		const context = JSON.parse(
			(await runTool(["check"], { context: true, json: true }, env)).text,
		);
		expect(context).toMatchObject({
			schema: 1,
			command: "check",
			mode: "context",
		});
		expect(context.workspaces[0]).toMatchObject({
			name: "root",
			loaded: expect.any(Number),
			start: expect.any(Number),
			opens: expect.any(Number),
			onDemand: expect.any(Number),
			cold: expect.any(Number),
			over: expect.any(Array),
		});
		const status = JSON.parse(
			(await runTool(["check"], { status: true, json: true }, env)).text,
		);
		expect(status).toMatchObject({
			schema: 1,
			command: "check",
			mode: "status",
			workspaces: expect.any(Array),
			unattributed: expect.any(Array),
			sources: {
				claude: expect.any(Object),
				herdr: expect.any(Object),
				codex: expect.any(Object),
			},
		});
	});

	test("returns archive JSON and applies requested moves", async () => {
		const tree = makeTree({
			"ws/.shepherd/charter.md": "# Workspace\n",
			"ws/.shepherd/CURRENT.md": "Updated: 2026-10-05\n",
			"ws/.shepherd/journal.md": "# Journal\n\n## 2026-09-01\nOld entry.\n",
		});
		cleanups.push(tree.cleanup);
		const cwd = join(tree.root, "ws");
		const output = await runTool(
			["archive"],
			{ apply: true, json: true },
			fakeToolEnv({ home: join(tree.root, "home"), cwd }),
		);
		const json = JSON.parse(output.text);
		expect(json).toMatchObject({
			schema: 1,
			command: "archive",
			root: cwd,
			applied: true,
			workspaces: [
				{
					name: "ws",
					moves: [
						expect.objectContaining({ kind: "journal", status: "moved" }),
					],
				},
			],
			rewrites: [],
		});
		expect(
			existsSync(join(cwd, ".shepherd/archive/journal/2026-09.md")),
		).toBeTrue();
	});
});
