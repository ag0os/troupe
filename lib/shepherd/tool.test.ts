import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fakeToolEnv, makeTree } from "./test-support";
import { isToolCommand, runTool } from "./tool";

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
	test("requires check, archive, guide, init, or doctor and prints all usage lines", async () => {
		const { env } = fixture();
		for (const args of [[], ["sweep"]]) {
			const output = await runTool(args, {}, env);
			expect(output).toMatchObject({ code: 2, stream: "stderr" });
			expect(output.text).toContain("shepherd tool check");
			expect(output.text).toContain("shepherd tool archive");
			expect(output.text).toContain("shepherd tool guide [<name>]");
			expect(output.text).toContain("shepherd tool init [--master] [--json]");
			expect(output.text).toContain("shepherd tool doctor [--json]");
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
			[
				"json",
				true,
				"tool check, tool archive, tool init, tool doctor, tool start, tool journal, tool checkpoint and tool unlock",
			],
			["today", "2026-13-40", "tool check and tool archive"],
			["all", true, "tool check"],
			["status", true, "tool check"],
			["context", true, "tool check"],
			["apply", true, "tool archive and tool checkpoint"],
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
	"pending.md",
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
					created: INIT_PATHS.slice(0, 7),
					kept: [],
					failed: { path: "work/todo/", error: "a file is in the way" },
				});
			} else {
				expect(output.text).toBe(
					[
						`Initialized ${cwd}/.shepherd (workspace)`,
						...INIT_PATHS.slice(0, 7).map((path) => `  created ${path}`),
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
			["apply", true, "tool archive and tool checkpoint"],
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
			skippedRewrites: [],
		});
		expect(
			existsSync(join(cwd, ".shepherd/archive/journal/2026-09.md")),
		).toBeTrue();
	});

	const archiveModes: Readonly<Record<string, string | boolean>>[] = [
		{},
		{ recursive: true },
		{ apply: true },
		{ apply: true, recursive: true },
	];

	test.each(archiveModes)(
		"archive ignores a current-month-only symlinked journal (%j)",
		async (flags) => {
			const journal = "## 2026-10-01\n- Current\n";
			const tree = makeTree(
				{
					"root/.shepherd/charter.md": "Charter",
					"journal-target.md": journal,
				},
				{ symlinks: { "root/.shepherd/journal.md": "journal-target.md" } },
			);
			cleanups.push(tree.cleanup);
			const env = fakeToolEnv({
				cwd: join(tree.root, "root"),
				home: join(tree.root, "home"),
			});
			const human = await runTool(["archive"], flags, env);
			expect(human.code).toBe(0);
			expect(human.text.trim()).toBe("root: nothing to archive");
			const json = await runTool(["archive"], { ...flags, json: true }, env);
			expect(json.code).toBe(0);
			expect(JSON.parse(json.text).workspaces[0].moves).toEqual([]);
			expect(readFileSync(join(tree.root, "journal-target.md"), "utf8")).toBe(
				journal,
			);
		},
	);

	test.each(archiveModes)(
		"archive skips only real past-month moves for a symlinked journal (%j)",
		async (flags) => {
			const journal = "## 2026-09-01\n- Past\n\n## 2026-10-01\n- Current\n";
			const tree = makeTree(
				{
					"root/.shepherd/charter.md": "Charter",
					"journal-target.md": journal,
				},
				{ symlinks: { "root/.shepherd/journal.md": "journal-target.md" } },
			);
			cleanups.push(tree.cleanup);
			const env = fakeToolEnv({
				cwd: join(tree.root, "root"),
				home: join(tree.root, "home"),
			});
			const human = await runTool(["archive"], flags, env);
			expect(human.code).toBe(1);
			expect(human.text).toContain("skip journal: journal.md is a symlink");
			const json = await runTool(["archive"], { ...flags, json: true }, env);
			expect(json.code).toBe(1);
			expect(JSON.parse(json.text).workspaces[0].moves).toEqual([
				{
					kind: "journal",
					from: "journal.md",
					to: "archive/journal/2026-09.md",
					detail: "journal.md is a symlink",
					status: "skipped",
				},
			]);
			expect(readFileSync(join(tree.root, "journal-target.md"), "utf8")).toBe(
				journal,
			);
			expect(existsSync(join(tree.root, "root/.shepherd/archive"))).toBeFalse();
		},
	);

	test.each([true, false])(
		"archive apply refuses an unselected child's lock (alive: %s)",
		async (alive) => {
			const { cwd, env } = fixture();
			const journal = join(cwd, ".shepherd/journal.md");
			writeFileSync(journal, "## 2026-09-01\n- Old\n");
			const item = join(cwd, ".shepherd/work/done/release");
			mkdirSync(item, { recursive: true });
			writeFileSync(
				join(item, "STATUS.md"),
				"---\nclosed: 2026-08-01\n---\n# Release\n",
			);
			const lock = join(cwd, "child/.shepherd/.state.lock");
			mkdirSync(lock);
			writeFileSync(
				join(lock, "owner"),
				JSON.stringify({ pid: 101, started: env.now.toISOString() }),
			);
			env.pidAlive = (pid) => alive && pid === 101;
			const output = await runTool(["archive"], { apply: true }, env, {
				timeoutMs: 0,
			});
			expect(output.code).toBe(1);
			expect(output.text).toStartWith("child: ");
			expect(output.text).toContain(
				alive ? "locked by pid 101 (alive)" : "run `shepherd tool unlock`",
			);
			expect(readFileSync(journal, "utf8")).toBe("## 2026-09-01\n- Old\n");
			expect(existsSync(item)).toBeTrue();
			expect(existsSync(join(cwd, ".shepherd/archive"))).toBeFalse();
			expect(existsSync(join(cwd, ".shepherd/.state.lock"))).toBeFalse();
		},
	);

	test("archive dry run works with a live lock held and takes no locks", async () => {
		const { cwd, env } = fixture();
		writeFileSync(join(cwd, ".shepherd/journal.md"), "## 2026-09-01\n- Old\n");
		const lock = join(cwd, ".shepherd/.state.lock");
		mkdirSync(lock);
		writeFileSync(
			join(lock, "owner"),
			JSON.stringify({ pid: 101, started: env.now.toISOString() }),
		);
		env.pidAlive = () => true;
		env.clock = () => {
			throw new Error("dry run must not acquire locks");
		};
		const output = await runTool(["archive"], {}, env);
		expect(output.code).toBe(0);
		expect(output.text).toContain("1 move(s) (dry run)");
		expect(existsSync(lock)).toBeTrue();
		expect(existsSync(join(cwd, "child/.shepherd/.state.lock"))).toBeFalse();
	});

	test("archive apply plans after tree locks are acquired and prints its own plan", async () => {
		const { cwd, env } = fixture();
		const journal = join(cwd, ".shepherd/journal.md");
		writeFileSync(journal, "## 2026-08-01\n- Old\n");
		const dry = await runTool(["archive"], { json: true }, env);
		expect(JSON.parse(dry.text).workspaces[0].moves[0].to).toBe(
			"archive/journal/2026-08.md",
		);
		let calls = 0;
		env.clock = () => {
			if (++calls === 2) {
				expect(existsSync(join(cwd, ".shepherd/.state.lock"))).toBeTrue();
				writeFileSync(journal, "## 2026-09-01\n- Changed during acquisition\n");
			}
			return new Date(env.now);
		};
		const output = await runTool(["archive"], { apply: true, json: true }, env);
		expect(output.code).toBe(0);
		expect(calls).toBe(2);
		expect(JSON.parse(output.text).workspaces[0].moves[0]).toMatchObject({
			to: "archive/journal/2026-09.md",
			status: "moved",
		});
		expect(
			existsSync(join(cwd, ".shepherd/archive/journal/2026-08.md")),
		).toBeFalse();
		expect(
			readFileSync(join(cwd, ".shepherd/archive/journal/2026-09.md"), "utf8"),
		).toContain("Changed during acquisition");
	});

	test.each([false, true])(
		"archive prints the applied result when lock release fails (json: %s)",
		async (json) => {
			const { cwd, env } = fixture();
			writeFileSync(
				join(cwd, ".shepherd/journal.md"),
				"## 2026-09-01\n- Old\n",
			);
			let calls = 0;
			env.clock = () => {
				if (++calls === 2) {
					const lock = join(cwd, ".shepherd/.state.lock");
					rmSync(lock, { recursive: true });
					writeFileSync(lock, "simulate failed cleanup");
				}
				return new Date(env.now);
			};
			const output = await runTool(["archive"], { apply: true, json }, env);
			expect(output.code).toBe(1);
			expect(output.text).toContain("lock release failed");
			if (json) {
				const applied = JSON.parse(output.text);
				expect(applied.releaseError).toBe("lock release failed");
				expect(applied.applied).toBeTrue();
				expect(applied.workspaces[0].moves[0].status).toBe("moved");
			} else {
				expect(output.text).toContain("root: 1 move(s)\n");
				expect(output.text).not.toContain("dry run");
			}
			expect(
				existsSync(join(cwd, ".shepherd/archive/journal/2026-09.md")),
			).toBeTrue();
			expect(existsSync(join(cwd, "child/.shepherd/.state.lock"))).toBeFalse();
		},
	);

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

describe("runTool doctor", () => {
	function doctorFixture(healthy: boolean, brokenConfig = false) {
		const tree = makeTree({
			"launch/placeholder": "",
			"home/placeholder": "",
			...(healthy
				? {
						"bin/claude": "",
						"bin/jq": "",
						"home/.claude/settings.json": JSON.stringify({
							crossSessionInbound: "accept",
							statusLine: { type: "command", command: "jq used_percentage" },
						}),
					}
				: {}),
			...(brokenConfig ? { "home/.config/shepherd/config.json": "{" } : {}),
		});
		cleanups.push(tree.cleanup);
		if (healthy) {
			for (const name of ["claude", "jq"])
				chmodSync(join(tree.root, "bin", name), 0o755);
		}
		return fakeToolEnv({
			cwd: join(tree.root, "launch"),
			home: join(tree.root, "home"),
			env: { PATH: join(tree.root, "bin") },
			runCommand: async () => {
				throw new Error("doctor must run no external command");
			},
		});
	}

	test("recognizes doctor and renders human and JSON reports outside a workspace", async () => {
		expect(isToolCommand("doctor")).toBeTrue();
		for (const healthy of [false, true]) {
			const env = doctorFixture(healthy);
			expect(existsSync(join(env.cwd, ".shepherd"))).toBeFalse();
			const human = await runTool(["doctor"], {}, env);
			const json = await runTool(["doctor"], { json: true }, env);
			for (const output of [human, json])
				expect(output).toMatchObject({
					code: healthy ? 0 : 1,
					stream: "stdout",
				});
			expect(human.text).toStartWith(`Shepherd doctor, home ${env.home}, `);
			expect(human.text).toContain(healthy ? "0 gaps" : "install jq:");
			const report = JSON.parse(json.text);
			if (!healthy) expect(report.totals.gap).toBeGreaterThan(0);
			expect(report).toMatchObject({
				schema: 1,
				command: "doctor",
				home: env.home,
				today: expect.any(String),
				checks: expect.any(Array),
				totals: {
					ok: expect.any(Number),
					gap: healthy ? 0 : expect.any(Number),
					skip: expect.any(Number),
				},
			});
		}
	});

	test("reports broken user config as a gap with exit 1", async () => {
		const env = doctorFixture(true, true);
		for (const flags of [{ json: false }, { json: true }]) {
			const output = await runTool(["doctor"], flags, env);
			expect(output).toMatchObject({ code: 1, stream: "stdout" });
			if (flags.json) {
				expect(JSON.parse(output.text).checks).toContainEqual(
					expect.objectContaining({
						id: "config:user",
						status: "gap",
						subject: join(env.home, ".config/shepherd/config.json"),
					}),
				);
			} else expect(output.text).toContain("config.json");
		}
	});

	test("rejects positionals and flags belonging to other tools", async () => {
		const env = doctorFixture(false);
		expect(await runTool(["doctor", "workspace"], {}, env)).toMatchObject({
			code: 2,
			stream: "stderr",
		});
		for (const name of [
			"all",
			"status",
			"context",
			"today",
			"apply",
			"recursive",
			"master",
			"name",
		]) {
			expect(
				await runTool(
					["doctor"],
					{ [name]: name === "today" ? "2026-10-05" : true },
					env,
				),
			).toMatchObject({ code: 2, stream: "stderr" });
		}
	});
});

describe("staged context tool commands", () => {
	for (const command of ["start", "journal", "checkpoint", "unlock"]) {
		test(`${command} is recognized and appears in usage`, async () => {
			const { env } = fixture();
			expect(isToolCommand(command)).toBe(true);
			expect((await runTool([], {}, env)).text).toContain(
				`shepherd tool ${command}`,
			);
		});

		test(`${command} rejects workspace selectors`, async () => {
			const { env } = fixture();
			const args =
				command === "journal" ? [command, "text", "child"] : [command, "child"];
			expect(await runTool(args, {}, env)).toMatchObject({
				code: 2,
				stream: "stderr",
			});
		});

		test(`${command} rejects a directory without state`, async () => {
			const { cwd, env } = fixture();
			const args = command === "journal" ? [command, "text"] : [command];
			const output = await runTool(
				args,
				{},
				{ ...env, cwd: join(cwd, "notes") },
			);
			expect(output).toMatchObject({ code: 2, stream: "stderr" });
			expect(output.text).toContain("not a workspace:");
		});
	}

	test("start renders the selected child with a zero budget and template-only pending", async () => {
		const { cwd, env } = fixture();
		const child = join(cwd, "child");
		await runTool(["init"], {}, { ...env, cwd: child });
		const output = await runTool(
			["start"],
			{ budget: "0", json: true },
			{ ...env, cwd: child },
		);
		expect(output.code).toBe(0);
		expect(JSON.parse(output.text)).toMatchObject({
			command: "start",
			workspace: "child",
			pending: "none",
		});
	});

	test("journal appends one text only to the selected workspace", async () => {
		const { cwd, env } = fixture();
		const output = await runTool(
			["journal", "A discovery"],
			{},
			{ ...env, cwd: join(cwd, "child") },
		);
		expect(output).toMatchObject({ code: 0, stream: "stdout" });
		expect(output.text).toContain("A discovery");
		expect(
			readFileSync(join(cwd, "child/.shepherd/journal.md"), "utf8"),
		).toContain("A discovery");
		expect(readFileSync(join(cwd, ".shepherd/journal.md"), "utf8")).toBe(
			"# Journal\n",
		);
	});

	test("journal stdin uses the injected reader and separates clock notices", async () => {
		const { env } = fixture();
		let reads = 0;
		const output = await runTool(
			["journal"],
			{ stdin: true },
			env,
			{},
			async () => {
				reads++;
				return "09:30 UTC: A\n discovery";
			},
		);
		expect(reads).toBe(1);
		expect(output).toMatchObject({ code: 0, stream: "stdout" });
		expect(output.notice).toBe("time comes from the clock");
		expect(output.text).toStartWith("- ");
		expect(output.text).not.toContain("notice");
		expect(output.text).not.toContain("time comes from the clock");
		expect(output.text).toContain("A discovery");
		expect(output.text).not.toContain("09:30 UTC:");
	});

	for (const [args, flags] of [
		[["journal"], {}],
		[["journal", "text"], { stdin: true }],
		[["start"], { budget: "-1" }],
		[["start"], { budget: "x" }],
		[["start"], { budget: "1.5" }],
		[["checkpoint"], { apply: true }],
		[["checkpoint"], { token: "r0-000000000000" }],
	] as const) {
		test(`usage rejects ${args.join(" ")} ${JSON.stringify(flags)}`, async () => {
			const { env } = fixture();
			expect(await runTool(args, flags, env)).toMatchObject({
				code: 2,
				stream: "stderr",
			});
		});
	}

	test("checkpoint dispatches dry run and token apply with session", async () => {
		const { cwd, env } = fixture();
		const dry = await runTool(["checkpoint"], { json: true }, env);
		expect(dry.code).toBe(0);
		const token = JSON.parse(dry.text).token;
		expect(token).toMatch(/^r0-[a-f0-9]{12}$/);
		const applied = await runTool(
			["checkpoint"],
			{ apply: true, token, session: "staged-T12", json: true },
			env,
		);
		expect(applied.code).toBe(0);
		expect(JSON.parse(applied.text)).toMatchObject({
			revision: 1,
			session: "staged-T12",
			applied: true,
		});
		expect(existsSync(join(cwd, ".shepherd/checkpoint.json"))).toBe(true);
		expect(existsSync(join(cwd, "child/.shepherd/checkpoint.json"))).toBe(
			false,
		);
	});

	test("unlock dispatches text and JSON and clears only the selected state", async () => {
		const { cwd, env } = fixture();
		const owner = { pid: 12345, started: env.now.toISOString() };
		for (const state of [
			join(cwd, ".shepherd"),
			join(cwd, "child/.shepherd"),
		]) {
			mkdirSync(join(state, ".state.lock"));
			writeFileSync(join(state, ".state.lock/owner"), JSON.stringify(owner));
		}
		const output = await runTool(["unlock"], { json: true }, env);
		expect(output.code).toBe(0);
		expect(JSON.parse(output.text)).toEqual({
			outcome: "cleared",
			pid: 12345,
			code: 0,
		});
		expect(existsSync(join(cwd, "child/.shepherd/.state.lock"))).toBe(true);
		expect(await runTool(["unlock"], {}, env)).toEqual({
			text: "nothing to clear\n",
			code: 0,
			stream: "stdout",
		});
	});

	test("unlock JSON preserves refusal code and live pid", async () => {
		const { cwd, env } = fixture();
		mkdirSync(join(cwd, ".shepherd/.state.lock"));
		writeFileSync(
			join(cwd, ".shepherd/.state.lock/owner"),
			JSON.stringify({ pid: 42, started: env.now.toISOString() }),
		);
		const output = await runTool(
			["unlock"],
			{ json: true },
			{ ...env, pidAlive: () => true },
		);
		expect(output.code).toBe(1);
		expect(JSON.parse(output.text)).toEqual({
			outcome: "alive",
			pid: 42,
			code: 1,
		});
	});

	for (const [name, value, owner] of [
		["budget", "10", "start"],
		["stdin", true, "journal"],
		["token", "r0-000000000000", "checkpoint"],
		["session", "T12", "checkpoint"],
		["accept-dropped", "reason", "checkpoint"],
	] as const) {
		test(`refuses --${name} on every other command`, async () => {
			const { env } = fixture();
			for (const command of [
				"check",
				"archive",
				"guide",
				"init",
				"doctor",
				"start",
				"journal",
				"checkpoint",
				"unlock",
			]) {
				if (command === owner) continue;
				expect(await runTool([command], { [name]: value }, env)).toEqual({
					text: `shepherd: --${name} applies only to tool ${owner}\n`,
					code: 2,
					stream: "stderr",
				});
			}
		});
	}

	test("check context passes the real environment for clock and lock reads", async () => {
		const { cwd, env } = fixture();
		mkdirSync(join(cwd, ".shepherd/.state.lock"));
		writeFileSync(
			join(cwd, ".shepherd/.state.lock/owner"),
			JSON.stringify({ pid: 42, started: env.now.toISOString() }),
		);
		const pids: number[] = [];
		let ticks = 0;
		const output = await runTool(
			["check"],
			{ context: true, json: true },
			{
				...env,
				clock: () => {
					ticks++;
					return env.now;
				},
				pidAlive: (pid) => {
					pids.push(pid);
					return true;
				},
			},
		);
		expect(output.code).toBe(0);
		expect(pids).toContain(42);
		expect(ticks).toBeGreaterThan(0);
	});
});

test("checkpoint passes the hyphenated accept-dropped reason to certification", async () => {
	const { cwd, env } = fixture();
	const dry = await runTool(["checkpoint"], { json: true }, env);
	await runTool(
		["checkpoint"],
		{ apply: true, token: JSON.parse(dry.text).token },
		env,
	);
	writeFileSync(
		join(cwd, ".shepherd/CURRENT.md"),
		"Updated: 2026-10-05\n\n## Items\n",
	);
	const next = await runTool(["checkpoint"], { json: true }, env);
	const token = JSON.parse(next.text).token;
	expect(
		(await runTool(["checkpoint"], { apply: true, token }, env)).code,
	).toBe(1);
	const output = await runTool(
		["checkpoint"],
		{ apply: true, token, "accept-dropped": "completed" },
		env,
	);
	expect(output.code).toBe(0);
	expect(readFileSync(join(cwd, ".shepherd/journal.md"), "utf8")).toContain(
		"dropped from CURRENT (completed): - NEXT: Continue",
	);
});

test("stamped journal JSON remains parseable and carries the notice separately", async () => {
	const { env } = fixture();
	const output = await runTool(
		["journal", "09:30 UTC: A discovery"],
		{ json: true },
		env,
	);
	expect(output).toMatchObject({
		code: 0,
		stream: "stdout",
		notice: "time comes from the clock",
	});
	expect(JSON.parse(output.text).text).toEndWith(" A discovery");
	expect(output.text).not.toContain("time comes from the clock");
	expect(output.text.endsWith("\n")).toBe(true);
});

test("a refused journal append ends with a newline and preserves its separate notice", async () => {
	const { env } = fixture();
	expect(await runTool(["journal", "09:30 UTC:"], { json: true }, env)).toEqual(
		{
			code: 1,
			stream: "stderr",
			text: "nothing to append\n",
			notice: "time comes from the clock",
		},
	);
});

test("journal human output ends with a newline", async () => {
	const { env } = fixture();
	const output = await runTool(["journal", "recorded"], {}, env);
	expect(output.code).toBe(0);
	expect(output.text.endsWith("\n")).toBe(true);
});

test("module findings preserve JSON, lines, all visibility and error-only exit", async () => {
	const { cwd, env } = fixture();
	mkdirSync(join(cwd, ".shepherd/integrations"), { recursive: true });
	writeFileSync(
		join(cwd, ".shepherd/integrations/bad.md"),
		"---\nname: bad\ntype: domain\ndescription: rules\nbudget: 3\nextra: true\n---\nbody\n",
	);
	const output = await runTool(["check"], { json: true }, env);
	expect(output.code).toBe(1);
	const report = JSON.parse(output.text);
	expect(report.workspaces[0].findings).toContainEqual(
		expect.objectContaining({
			code: "module-schema",
			level: "error",
			file: "integrations/bad.md",
			line: 6,
		}),
	);
	writeFileSync(join(cwd, ".shepherd/integrations/bad.md"), "legacy");
	const warn = await runTool(["check"], {}, env);
	expect(warn.code).toBe(0);
	expect(warn.text).not.toContain("module-frontmatter-missing");
	expect((await runTool(["check"], { all: true }, env)).text).toContain(
		"legacy module: loaded unchanged",
	);
});

test("JSON check sees enclosing schema and duplicates outside checked workspaces", async () => {
	const { moduleCatalog, resolveModules } = await import("./module-resolution");
	const tree = makeTree({
		"parent/.shepherd/integrations/bad.md":
			"---\nname: bad\ntype: domain\ndescription: rules\nbudget: x\n---\ninherited body\n",
		"parent/child/.shepherd/charter.md": "",
		"parent/child/.shepherd/CURRENT.md": "Updated: 2026-10-05\n",
		"parent/child/.shepherd/integrations/bad.md": "local body\n",
	});
	cleanups.push(tree.cleanup);
	const cwd = join(tree.root, "parent/child");
	const catalog = moduleCatalog(cwd);
	const inherited = catalog.candidates.find((m) => m.layer === "inherited");
	if (!inherited) throw new Error("missing inherited module");
	const launch = resolveModules(catalog);
	const output = await runTool(
		["check"],
		{ json: true },
		fakeToolEnv({ home: tree.root, cwd }),
	);
	expect(output.code).toBe(1);
	const report = JSON.parse(output.text);
	expect(report.workspaces.map((w: { dir: string }) => w.dir)).toEqual([cwd]);
	expect(report.workspaces[0].findings).toContainEqual({
		...inherited.problems[0],
		code: "module-schema",
		level: "error",
		file: "../../.shepherd/integrations/bad.md",
	});
	expect(launch.problems[0]?.file).toBe(inherited.source);
	expect(
		launch.selected.filter((m) => m.name === "bad.md").map((m) => m.layer),
	).toEqual(["inherited", "local"]);
	expect(report.workspaces[0].findings).toContainEqual(
		expect.objectContaining({
			code: "module-duplicate",
			file: "integrations/bad.md",
			message:
				"local bad.md has the same name as the inherited module; both load at launch",
		}),
	);
});

test("charter finding JSON pins severities and lines, info visibility and error-only exit", async () => {
	const { cwd, env } = fixture();
	const sentence =
		"Keep every synthetic project decision visible to the team and record the exact reason for each change before proceeding with the next task.";
	mkdirSync(join(cwd, ".shepherd/integrations"), { recursive: true });
	writeFileSync(
		join(cwd, ".shepherd/integrations/reader.md"),
		`---\nname: reader\ntype: domain\ndescription: rules\nbudget: 100\ncharter-keys:\n  reader.value: required\n---\n${sentence}\n`,
	);
	const charter = `## Done\nNone\n## Done\nNone\n- software.grants: value\n- reader.value:\n\n${sentence}\n`;
	writeFileSync(join(cwd, ".shepherd/charter.md"), charter);
	const output = await runTool(["check"], { json: true }, env);
	expect(output.code).toBe(0);
	const report = JSON.parse(output.text);
	for (const [code, level, line] of [
		["charter-slot-duplicate", "warn", 3],
		["charter-key-undeclared", "warn", 5],
		["charter-key-required", "warn", 6],
		["charter-module-restatement", "info", 8],
	]) {
		expect(report.workspaces[0].findings).toContainEqual(
			expect.objectContaining({ code, level, line, file: "charter.md" }),
		);
	}
	expect((await runTool(["check"], {}, env)).text).not.toContain(
		"possible repeated rule",
	);
	expect((await runTool(["check"], { all: true }, env)).text).toContain(
		"possible repeated rule: integrations/reader.md:9",
	);
	writeFileSync(
		join(cwd, ".shepherd/charter.md"),
		`${charter}- software.grants: again\n`,
	);
	const error = await runTool(["check"], { json: true }, env);
	expect(error.code).toBe(1);
	expect(JSON.parse(error.text).workspaces[0].findings).toContainEqual(
		expect.objectContaining({
			code: "charter-slot-duplicate",
			level: "error",
			line: 9,
		}),
	);
});

test("repeated filename bullets do not fail tool check", async () => {
	const { cwd, env } = fixture();
	writeFileSync(
		join(cwd, ".shepherd/charter.md"),
		"## Structure\n- package.json: scripts\n- biome.json: formatting\n- package.json: more scripts\n",
	);
	const output = await runTool(["check"], { json: true }, env);
	expect(output.code).toBe(0);
	expect(
		JSON.parse(output.text).workspaces[0].findings.filter(
			(f: { code: string }) => f.code.startsWith("charter-"),
		),
	).toEqual([]);
});

const softwareUnknownMessage = (key: string) =>
	`"${key}" is not a slot any module declares (read as prose); declared software keys: software.attribution, software.grants, software.merge-grant, software.plans`;

test.each([
	[
		"typo",
		"- software.grant: push branches\n",
		{},
		[1],
		[softwareUnknownMessage("software.grant")],
		0,
	],
	[
		"known namespace filename",
		"- software.md: notes\n",
		{},
		[1],
		[softwareUnknownMessage("software.md")],
		0,
	],
	[
		"unknown namespace",
		"- package.json: scripts\n- index.ts: entry\n",
		{},
		[],
		[],
		0,
	],
	[
		"inactive namespace",
		"- dormant.typo: notes\n",
		{
			".shepherd/integrations/dormant.md":
				"---\nname: dormant\ntype: domain\ndescription: rules\nbudget: 100\napplies-when:\n  has-children: false\ncharter-keys:\n  dormant.value: optional\n---\nrules\n",
		},
		[1],
		[
			'"dormant.typo" is not a slot any module declares (read as prose); declared dormant keys: dormant.value',
		],
		0,
	],
	[
		"enclosing provider namespace",
		"- craft.typo: notes\n",
		{
			"../.shepherd/charter.md": "",
			"../.shepherd/integrations/reader.md":
				"---\nname: reader\ntype: domain\ndescription: rules\nbudget: 100\nprovides: craft\ncharter-keys:\n  craft.value: optional\n---\nrules\n",
		},
		[1],
		[
			'"craft.typo" is not a slot any module declares (read as prose); declared craft keys: craft.value',
		],
		0,
	],
	[
		"repeated unknown bullet",
		"- software.grant: push\n* **software.grant:** again\n",
		{},
		[1, 2],
		[
			softwareUnknownMessage("software.grant"),
			softwareUnknownMessage("software.grant"),
		],
		0,
	],
	[
		"broken namespace",
		"- broken.typo: notes\n",
		{
			".shepherd/integrations/broken.md":
				"---\nname: broken\ntype: domain\ndescription: rules\nbudget: invalid\ncharter-keys:\n  broken.value: optional\n---\nrules\n",
		},
		[],
		[],
		1,
	],
	[
		"excluded syntax",
		"```\n- software.grant: code\n```\n> - software.grant: quote\n- Software.grant: case\n- core.unknown: existing slot\n",
		{},
		[],
		[],
		0,
	],
	[
		"known namespace without keys",
		"- empty.typo: notes\n",
		{
			".shepherd/integrations/empty.md":
				"---\nname: empty\ntype: domain\ndescription: rules\nbudget: 100\n---\nrules\n",
		},
		[1],
		[
			'"empty.typo" is not a slot any module declares (read as prose); declared empty keys: none',
		],
		0,
	],
] as const)(
	"unknown dotted charter keys: %s",
	async (_, charter, files, lines, messages, exit) => {
		const { cwd, env } = fixture();
		for (const [path, raw] of Object.entries(files)) {
			const target = join(cwd, path);
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, raw);
		}
		writeFileSync(join(cwd, ".shepherd/charter.md"), charter);
		const output = await runTool(["check"], { json: true }, env);
		expect(output.code).toBe(exit);
		const findings = JSON.parse(output.text).workspaces[0].findings;
		const unknown = findings.filter(
			(f: { code: string }) => f.code === "charter-key-unknown",
		);
		expect(unknown.map((f: { line: number }) => f.line)).toEqual([...lines]);
		expect(unknown.map((f: { message: string }) => f.message)).toEqual([
			...messages,
		]);
		for (const finding of unknown)
			expect(finding).toMatchObject({ level: "warn", file: "charter.md" });
		expect(
			findings.some(
				(f: { code: string }) => f.code === "charter-slot-duplicate",
			),
		).toBe(false);
		if (lines.length)
			expect((await runTool(["check"], {}, env)).text).toContain(
				"is not a slot any module declares (read as prose)",
			);
	},
);
