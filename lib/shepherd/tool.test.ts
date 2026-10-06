import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	test("requires check, archive, guide, or init and prints all usage lines", async () => {
		const { env } = fixture();
		for (const args of [[], ["sweep"]]) {
			const output = await runTool(args, {}, env);
			expect(output).toMatchObject({ code: 2, stream: "stderr" });
			expect(output.text).toContain("shepherd tool check");
			expect(output.text).toContain("shepherd tool archive");
			expect(output.text).toContain("shepherd tool guide [<name>]");
			expect(output.text).toContain("shepherd tool init [--master] [--json]");
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

	test("rejects an invalid user config from XDG_CONFIG_HOME", async () => {
		const { tree, env } = fixture();
		const xdg = join(tree.root, "xdg");
		const configFile = join(xdg, "shepherd", "config.json");
		mkdirSync(join(xdg, "shepherd"), { recursive: true });
		writeFileSync(configFile, JSON.stringify({ extra: true }));

		expect(
			await runTool(["check"], {}, { ...env, env: { XDG_CONFIG_HOME: xdg } }),
		).toEqual({
			text: `shepherd: ${configFile}: extra: unknown key\n`,
			code: 2,
			stream: "stderr",
		});
	});
});

describe("runTool guide", () => {
	test("lists all three guides with their purpose lines", async () => {
		const { env } = fixture();
		expect(await runTool(["guide"], {}, env)).toEqual({
			text: [
				"charter: the init conversation's questions and the charter's shape",
				"memory: the memory file format and what each type holds",
				"tools: generic traps in Claude Code delegates, the Codex CLI and the shell",
				"",
			].join("\n"),
			code: 0,
			stream: "stdout",
		});
	});

	for (const name of ["charter", "memory", "tools"]) {
		test(`prints ${name} byte for byte`, async () => {
			const { env } = fixture();
			const output = await runTool(["guide", name], {}, env);
			expect(output).toMatchObject({ code: 0, stream: "stdout" });
			expect(Buffer.from(output.text)).toEqual(
				readFileSync(
					join(
						import.meta.dir,
						"../../system-prompts/shepherd/guides",
						`${name}.md`,
					),
				),
			);
		});
	}

	test("rejects unknown names and extra positionals", async () => {
		const { env } = fixture();
		expect(await runTool(["guide", "missing"], {}, env)).toEqual({
			text: 'shepherd: no guide named "missing"; guides: charter, memory, tools\n',
			code: 2,
			stream: "stderr",
		});
		const extra = await runTool(["guide", "charter", "memory"], {}, env);
		expect(extra).toMatchObject({ code: 2, stream: "stderr" });
		expect(extra.text).toContain("shepherd tool guide [<name>]");
	});

	test("rejects every misplaced tool flag", async () => {
		const { env } = fixture();
		for (const [name, value, owner] of [
			["json", true, "tool check, tool archive and tool init"],
			["today", "2026-13-40", "tool check and tool archive"],
			["all", true, "tool check"],
			["status", true, "tool check"],
			["context", true, "tool check"],
			["apply", true, "tool archive"],
			["recursive", true, "tool archive"],
			["name", "session", "launches"],
			["master", true, "tool init"],
		] as const) {
			expect(await runTool(["guide"], { [name]: value }, env)).toEqual({
				text: `shepherd: --${name} applies only to ${owner}\n`,
				code: 2,
				stream: "stderr",
			});
		}
	});

	test("works outside a workspace with a broken user config", async () => {
		const tree = makeTree({
			"launch/placeholder": "",
			"home/.config/shepherd/config.json": "{broken",
		});
		cleanups.push(tree.cleanup);
		const env = fakeToolEnv({
			cwd: join(tree.root, "launch"),
			home: join(tree.root, "home"),
		});
		for (const args of [["guide"], ["guide", "charter"]]) {
			expect(await runTool(args, {}, env)).toMatchObject({
				code: 0,
				stream: "stdout",
			});
		}
	});

	test("reads no workspace, config, or clock input", async () => {
		const { env } = fixture();
		const unreadable = () => {
			throw new Error("guide must not read ToolEnv");
		};
		for (const key of ["cwd", "home", "env", "now"]) {
			Object.defineProperty(env, key, { get: unreadable });
		}
		for (const args of [["guide"], ["guide", "memory"]]) {
			expect(await runTool(args, {}, env)).toMatchObject({ code: 0 });
		}
	});
});

const INIT_PATHS = [
	"CURRENT.md",
	"MEMORY.md",
	"journal.md",
	"docs/INDEX.md",
	"docs/STATUS-template.md",
	"archive/INDEX.md",
	"work/todo/",
	"work/in-progress/",
	"work/done/",
];
const SHARED_PATHS = [
	"shared/user.md",
	"shared/machine.md",
	"shared/roster.md",
	"shared/tools.md",
	"integrations/shared.md",
];
const INIT_NEXT =
	"Next: launch `shepherd` here and run the init conversation; `shepherd tool guide charter` has the questions and the charter's shape.";

function initFixture(files: Record<string, string> = {}) {
	const tree = makeTree({ "launch/placeholder": "", ...files });
	cleanups.push(tree.cleanup);
	const cwd = join(tree.root, "launch");
	return { cwd, env: fakeToolEnv({ home: join(tree.root, "home"), cwd }) };
}

describe("runTool init", () => {
	test("initializes a non-workspace and renders fresh and all-kept output exactly", async () => {
		const { cwd, env } = initFixture();
		expect(existsSync(join(cwd, ".shepherd"))).toBe(false);
		for (const status of ["created", "kept"]) {
			expect(await runTool(["init"], {}, env)).toEqual({
				text: [
					`Initialized ${cwd}/.shepherd (workspace)`,
					...INIT_PATHS.map((path) => `  ${status.padEnd(7)} ${path}`),
					INIT_NEXT,
					"",
				].join("\n"),
				code: 0,
				stream: "stdout",
			});
		}
		for (const path of INIT_PATHS) {
			expect(existsSync(join(cwd, ".shepherd", path))).toBe(true);
		}
	});

	test("returns the exact fresh and all-kept JSON envelopes", async () => {
		const { cwd, env } = initFixture();
		for (const fresh of [true, false]) {
			expect(await runTool(["init"], { json: true }, env)).toEqual({
				text: `${JSON.stringify(
					{
						schema: 1,
						command: "init",
						root: cwd,
						state: join(cwd, ".shepherd"),
						master: false,
						created: fresh ? INIT_PATHS : [],
						kept: fresh ? [] : INIT_PATHS,
						failed: null,
					},
					null,
					2,
				)}\n`,
				code: 0,
				stream: "stdout",
			});
		}
	});

	test("reports completed writes and the failure on stdout with exit 1", async () => {
		for (const json of [false, true]) {
			const { cwd, env } = initFixture({
				"launch/.shepherd/work/todo": "blocked",
			});
			const output = await runTool(["init"], { json }, env);
			expect(output).toMatchObject({ code: 1, stream: "stdout" });
			if (json) {
				expect(JSON.parse(output.text)).toEqual({
					schema: 1,
					command: "init",
					root: cwd,
					state: join(cwd, ".shepherd"),
					master: false,
					created: INIT_PATHS.slice(0, 6),
					kept: [],
					failed: { path: "work/todo/", error: "a file is in the way" },
				});
			} else {
				expect(output.text).toBe(
					[
						`Initialized ${cwd}/.shepherd (workspace)`,
						...INIT_PATHS.slice(0, 6).map((path) => `  created ${path}`),
						"  failed  work/todo/: a file is in the way",
						"",
					].join("\n"),
				);
			}
			expect(existsSync(join(cwd, ".shepherd/work/in-progress"))).toBe(false);
		}
	});

	test("ignores broken user config and reads no HOME or environment input", async () => {
		const { env } = initFixture({
			"home/.config/shepherd/config.json": "{broken",
		});
		expect(await runTool(["init"], {}, env)).toMatchObject({ code: 0 });
		for (const key of ["home", "env"]) {
			Object.defineProperty(env, key, {
				get: () => {
					throw new Error("init must not read config inputs");
				},
			});
		}
		expect(await runTool(["init"], {}, env)).toMatchObject({ code: 0 });
	});

	test("master creates 14 entries and upgrades a workspace without overwriting it", async () => {
		for (const upgrade of [false, true]) {
			const { cwd, env } = initFixture();
			if (upgrade) {
				await runTool(["init"], {}, env);
				writeFileSync(join(cwd, ".shepherd/CURRENT.md"), "custom state");
			}
			const output = await runTool(["init"], { master: true, json: true }, env);
			expect(output).toMatchObject({ code: 0, stream: "stdout" });
			expect(JSON.parse(output.text)).toEqual({
				schema: 1,
				command: "init",
				root: cwd,
				state: join(cwd, ".shepherd"),
				master: true,
				created: upgrade ? SHARED_PATHS : [...INIT_PATHS, ...SHARED_PATHS],
				kept: upgrade ? INIT_PATHS : [],
				failed: null,
			});
			for (const path of [...INIT_PATHS, ...SHARED_PATHS]) {
				expect(existsSync(join(cwd, ".shepherd", path))).toBe(true);
			}
			if (upgrade)
				expect(readFileSync(join(cwd, ".shepherd/CURRENT.md"), "utf8")).toBe(
					"custom state",
				);
		}
	});

	test("rejects positionals and misplaced flags before writing", async () => {
		const { cwd, env } = initFixture();
		expect(await runTool(["init", "child"], {}, env)).toMatchObject({
			code: 2,
			stream: "stderr",
		});
		for (const [name, value, owner] of [
			["today", "invalid", "tool check and tool archive"],
			["all", true, "tool check"],
			["status", true, "tool check"],
			["context", true, "tool check"],
			["apply", true, "tool archive"],
			["recursive", true, "tool archive"],
			["name", "session", "launches"],
		] as const) {
			expect(await runTool(["init"], { [name]: value }, env)).toEqual({
				text: `shepherd: --${name} applies only to ${owner}\n`,
				code: 2,
				stream: "stderr",
			});
		}
		for (const command of ["check", "archive", "guide"]) {
			expect(await runTool([command], { master: true }, env)).toEqual({
				text: "shepherd: --master applies only to tool init\n",
				code: 2,
				stream: "stderr",
			});
		}
		expect(existsSync(join(cwd, ".shepherd"))).toBe(false);
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
		expect(json).toEqual({
			schema: 1,
			command: "archive",
			root: cwd,
			today: "2026-10-05",
			applied: true,
			workspaces: [
				{
					name: "ws",
					moves: [
						{
							kind: "journal",
							from: "journal.md",
							to: "archive/journal/2026-09.md",
							detail: "1 day(s) of 2026-09",
							status: "moved",
						},
					],
				},
			],
			rewrites: [],
		});
		expect(
			existsSync(join(cwd, ".shepherd/archive/journal/2026-09.md")),
		).toBeTrue();
	});

	test("prints unattributed sessions only when no selector was given", async () => {
		const tree = makeTree({
			"home/.claude/sessions/101.json": JSON.stringify({
				name: "loose-one",
				cwd: "/outside/workspace",
				status: "working",
				pid: 101,
			}),
			"root/.shepherd/charter.md": "Root",
			"root/.shepherd/CURRENT.md": "Updated: 2026-10-05",
		});
		cleanups.push(tree.cleanup);
		const home = join(tree.root, "home");
		const cwd = join(tree.root, "root");
		const env = fakeToolEnv({ home, cwd, alivePids: [101] });

		const all = await runTool(["check"], { status: true }, env);
		const selected = await runTool(["check", "root"], { status: true }, env);

		expect(all.text).toContain(
			"Running sessions no workspace lists or contains:",
		);
		expect(all.text).toContain("loose-one (working, /outside/workspace)");
		expect(selected.text).not.toContain(
			"Running sessions no workspace lists or contains:",
		);
		expect(selected.text).not.toContain("loose-one");
	});

	test("uses each workspace config for recursive archive planning", async () => {
		const tree = makeTree({
			"root/.shepherd/charter.md": "Root",
			"root/.shepherd/CURRENT.md": "Updated: 2026-10-05",
			"root/.shepherd/work/done/root-item/STATUS.md":
				"---\nclosed: 2026-08-06\n---\n# Root item\n",
			"root/child/.shepherd/config.json": JSON.stringify({
				windows: { doneDays: 365 },
			}),
			"root/child/.shepherd/charter.md": "Child",
			"root/child/.shepherd/CURRENT.md": "Updated: 2026-10-05",
			"root/child/.shepherd/work/done/child-item/STATUS.md":
				"---\nclosed: 2026-08-06\n---\n# Child item\n",
		});
		cleanups.push(tree.cleanup);
		const cwd = join(tree.root, "root");

		const output = await runTool(
			["archive"],
			{ recursive: true, apply: true, json: true, today: "2026-10-05" },
			fakeToolEnv({ home: tree.root, cwd }),
		);
		const json = JSON.parse(output.text);

		expect(json.workspaces[0].moves).toHaveLength(1);
		expect(json.workspaces[1].moves).toHaveLength(0);
		expect(
			existsSync(join(cwd, ".shepherd/archive/2026-08/root-item")),
		).toBeTrue();
		expect(
			existsSync(join(cwd, "child/.shepherd/work/done/child-item")),
		).toBeTrue();
	});

	test("reports an invalid child config from the root", async () => {
		const tree = makeTree({
			"root/.shepherd/charter.md": "Root",
			"root/.shepherd/CURRENT.md": "Updated: 2026-10-05",
			"root/child/.shepherd/config.json": JSON.stringify({ extra: true }),
			"root/child/.shepherd/charter.md": "Child",
			"root/child/.shepherd/CURRENT.md": "Updated: 2026-10-05",
		});
		cleanups.push(tree.cleanup);
		const cwd = join(tree.root, "root");

		const output = await runTool(
			["check"],
			{ json: true },
			fakeToolEnv({ home: tree.root, cwd }),
		);
		const json = JSON.parse(output.text);
		const child = json.workspaces.find(
			(workspace: { name: string }) => workspace.name === "child",
		);

		expect(output.code).toBe(1);
		expect(child.findings).toContainEqual(
			expect.objectContaining({ code: "config-invalid", file: "config.json" }),
		);
	});

	test("uses child marks for context rows", async () => {
		const tree = makeTree({
			"root/.shepherd/charter.md": "Root",
			"root/.shepherd/CURRENT.md": "Updated: 2026-10-05",
			"root/child/.shepherd/config.json": JSON.stringify({
				marks: { current: 2 },
			}),
			"root/child/.shepherd/charter.md": "Child",
			"root/child/.shepherd/CURRENT.md": "Updated: 2026-10-05 extra words",
		});
		cleanups.push(tree.cleanup);
		const cwd = join(tree.root, "root");

		const output = await runTool(
			["check"],
			{ context: true, json: true },
			fakeToolEnv({ home: tree.root, cwd }),
		);
		const json = JSON.parse(output.text);
		const child = json.workspaces.find(
			(workspace: { name: string }) => workspace.name === "child",
		);

		expect(child.over).toContain("CURRENT > 2");
	});

	test("resolves tilde links against the user home", async () => {
		const tree = makeTree({
			"home/.shepherd/charter.md": "Home",
			"home/.shepherd/CURRENT.md": "Updated: 2026-10-05",
			"home/Projects/existing.md": "Exists",
			"home/work/.shepherd/charter.md": "Work",
			"home/work/.shepherd/CURRENT.md": [
				"Updated: 2026-10-05",
				"[Existing](~/Projects/existing.md)",
				"[Missing](~/Projects/missing.md)",
			].join("\n"),
		});
		cleanups.push(tree.cleanup);
		const home = join(tree.root, "home");
		const cwd = join(home, "work");

		const output = await runTool(
			["check"],
			{ json: true },
			fakeToolEnv({ home, cwd }),
		);
		const json = JSON.parse(output.text);
		const links = json.workspaces[0].findings.filter(
			(finding: { code: string }) => finding.code === "link-broken",
		);

		expect(links).toEqual([
			expect.objectContaining({
				line: 3,
				message: "link to ~/Projects/missing.md does not resolve",
			}),
		]);
	});
});
