import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join, sep } from "node:path";
import { coveredPaths, hashPaths } from "./checkpoint";
import type { ToolEnv } from "./sessions";
import { fakeToolEnv, type MakeTreeOptions, makeTree } from "./test-support";
import { journalChain } from "./text";
import { runTool } from "./tool";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const FS_CALLS = {
	readFileSync: fs.readFileSync,
	readdirSync: fs.readdirSync,
	lstatSync: fs.lstatSync,
	statSync: fs.statSync,
	existsSync: fs.existsSync,
} as const;

type FsCall = { fn: keyof typeof FS_CALLS; path: string };

/** Record every path the five filesystem calls receive while run is pending. */
async function spyFs<T>(run: () => Promise<T>): Promise<{
	value: T;
	calls: FsCall[];
}> {
	const calls: FsCall[] = [];
	const spies = Object.entries(FS_CALLS).map(([name, original]) => {
		const fn = name as keyof typeof FS_CALLS;
		return spyOn(fs, fn).mockImplementation(((...args: unknown[]) => {
			calls.push({ fn, path: String(args[0]) });
			return Reflect.apply(original, fs, args);
		}) as never);
	});
	try {
		return { value: await run(), calls };
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
}

const ITEMS = `Updated: 2026-10-13 17:26, forge-1013b

## Items
- **NEXT** [evals](work/in-progress/evals/STATUS.md): the trials
  as a merge gate
- **ASK** [lock](work/todo/lock/STATUS.md): which lock
- **WAITING** on review: a small entry

## Live sessions
- forge-1013b: Claude Code, Opus, Shepherd
`;

const STATUS = `---
state: in-progress
opened: 2026-10-13
---
# evals: the trials

## What and origin
The origin.

## State
Running.
`;

function workspace(
	prefix: string,
	current = ITEMS,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		[`${prefix}/.shepherd/CURRENT.md`]: current,
		[`${prefix}/.shepherd/charter.md`]: `# ${prefix}\n`,
		[`${prefix}/.shepherd/journal.md`]: "## 2026-10-13\n- 10:00 started\n",
		[`${prefix}/.shepherd/config.json`]: '{"sessionPrefix":"ws"}',
		[`${prefix}/.shepherd/work/in-progress/evals/STATUS.md`]: STATUS,
		[`${prefix}/.shepherd/work/todo/lock/STATUS.md`]: STATUS.replace(
			"in-progress",
			"todo",
		),
		...Object.fromEntries(
			Object.entries(extra).map(([path, text]) => [`${prefix}/${path}`, text]),
		),
	};
}

/** A root with shared layer and two complete children, a and b, as sentinels. */
function contractTree(
	extra: Record<string, string> = {},
	options: MakeTreeOptions = {},
) {
	const tree = makeTree(
		{
			"xdg/shepherd/config.json": JSON.stringify({
				codex: { homeFile: "~/.codex-active" },
			}),
			"home/.codex-active": "/nowhere\n",
			...workspace("root"),
			"root/.shepherd/shared/people.md": "# People\n",
			...workspace("root/a"),
			...workspace("root/b"),
			...extra,
		},
		options,
	);
	cleanups.push(tree.cleanup);
	return {
		base: tree.root,
		root: join(tree.root, "root"),
		a: join(tree.root, "root", "a"),
		b: join(tree.root, "root", "b"),
		userConfig: join(tree.root, "xdg", "shepherd", "config.json"),
		env: (
			cwd: string,
			options: Partial<Parameters<typeof fakeToolEnv>[0]> = {},
		) =>
			fakeToolEnv({
				home: join(tree.root, "home"),
				cwd,
				env: { XDG_CONFIG_HOME: join(tree.root, "xdg") },
				...options,
			}),
	};
}

async function query(
	args: string[],
	env: ToolEnv,
	flags: Record<string, string | boolean> = {},
) {
	const output = await runTool(
		["query", ...args],
		{ json: true, ...flags },
		env,
	);
	return {
		...output,
		json: output.code === 2 ? undefined : JSON.parse(output.text),
	};
}

function codes(json: { problems: { code: string }[] }): string[] {
	return json.problems.map(({ code }) => code);
}

/** Whether a call is part of the ancestor walk from start. */
function ancestorWalk(call: FsCall, start: string): boolean {
	if (call.fn !== "lstatSync") return false;
	for (let dir = start; dir !== dirname(dir); dir = dirname(dir)) {
		if (call.path === dir || call.path === join(dir, ".shepherd")) return true;
	}
	return false;
}

/** Assert the ordinary read contract: user config, the walk, and target paths. */
function expectContract(
	calls: FsCall[],
	fixture: ReturnType<typeof contractTree>,
	target: string,
	allowed: (relative: string, call: FsCall) => boolean,
): void {
	const state = join(target, ".shepherd");
	const stray = calls.filter((call) => {
		if (call.path === fixture.userConfig) return call.fn !== "readFileSync";
		if (ancestorWalk(call, target)) return false;
		if (call.path.startsWith(`${state}${sep}`)) {
			return !allowed(call.path.slice(state.length + 1), call);
		}
		return true;
	});
	expect(stray).toEqual([]);
}

describe("tool query items", () => {
	test("returns the envelope and every Items entry", async () => {
		const fixture = contractTree();
		const env = fixture.env(fixture.a);
		const { code, json } = await query(["items"], env);

		expect(code).toBe(0);
		expect(json.observed).toMatch(/^2026-10-05T\d{2}:00:00[+-]\d{2}:\d{2}$/);
		expect(new Date(json.observed).getTime()).toBe(env.clock().getTime());
		expect(json).toMatchObject({
			schema: 1,
			command: "query",
			query: "items",
			root: fixture.root,
			observed: expect.any(String),
			retried: false,
			scope: "workspace",
			workspace: {
				name: "a",
				dir: fixture.a,
				state: join(fixture.a, ".shepherd"),
			},
			problems: [],
			file: "CURRENT.md",
			updated: "2026-10-13 17:26, forge-1013b",
			noNext: false,
			section: { line: 3, endLine: 8 },
		});
		expect(json.items).toEqual([
			{
				word: "NEXT",
				known: true,
				slug: "evals",
				link: "work/in-progress/evals/STATUS.md",
				status: { path: "work/in-progress/evals/STATUS.md", exists: true },
				text: "evals: the trials as a merge gate",
				raw: "- **NEXT** [evals](work/in-progress/evals/STATUS.md): the trials\n  as a merge gate",
				line: 4,
				endLine: 5,
			},
			{
				word: "ASK",
				known: true,
				slug: "lock",
				link: "work/todo/lock/STATUS.md",
				status: { path: "work/todo/lock/STATUS.md", exists: true },
				text: "lock: which lock",
				raw: "- **ASK** [lock](work/todo/lock/STATUS.md): which lock",
				line: 6,
				endLine: 6,
			},
			{
				word: "WAITING",
				known: true,
				slug: null,
				link: null,
				status: null,
				text: "on review: a small entry",
				raw: "- **WAITING** on review: a small entry",
				line: 7,
				endLine: 7,
			},
		]);
	});

	test("filters by a status word and refuses an unknown one", async () => {
		const fixture = contractTree();
		const env = fixture.env(fixture.a);
		const { json } = await query(["items", "ASK"], env);
		expect(json.items.map(({ slug }: { slug: string }) => slug)).toEqual([
			"lock",
		]);

		for (const args of [
			["items", "FOO"],
			["items", "ASK", "NEXT"],
		]) {
			expect(await query(args, env)).toMatchObject({
				code: 2,
				stream: "stderr",
			});
		}
	});

	test("reports a missing CURRENT with every field present", async () => {
		const fixture = contractTree();
		fs.rmSync(join(fixture.a, ".shepherd", "CURRENT.md"));
		const { code, json, notice } = await query(
			["items"],
			fixture.env(fixture.a),
		);
		expect(code).toBe(1);
		expect(notice).toBeUndefined();
		expect(json).toMatchObject({
			file: "CURRENT.md",
			updated: null,
			noNext: null,
			section: null,
			items: [],
			problems: [
				expect.objectContaining({
					code: "current-missing",
					file: "CURRENT.md",
				}),
			],
		});
	});

	test("refuses a symlinked CURRENT without reading its target", async () => {
		const fixture = contractTree({ "outside/CURRENT.md": ITEMS });
		const current = join(fixture.a, ".shepherd", "CURRENT.md");
		fs.rmSync(current);
		fs.symlinkSync(join(fixture.base, "outside", "CURRENT.md"), current);
		const { value, calls } = await spyFs(() =>
			query(["items"], fixture.env(fixture.a)),
		);

		expect(value.code).toBe(1);
		expect(codes(value.json)).toEqual(["record-unsafe"]);
		expect(value.json.problems[0].file).toBe("CURRENT.md");
		expect(
			calls.filter(
				({ fn, path }) =>
					path.includes(`${sep}outside`) ||
					(fn === "readFileSync" && path === current),
			),
		).toEqual([]);
	});

	test("flags links outside the record and through a symlinked work", async () => {
		const fixture = contractTree({
			"outside/work/in-progress/evals/STATUS.md": STATUS,
		});
		fs.writeFileSync(
			join(fixture.a, ".shepherd", "CURRENT.md"),
			"## Items\n- **NEXT** [x](../../x/STATUS.md): out\n",
		);
		const outside = await query(["items"], fixture.env(fixture.a));
		expect(outside.code).toBe(1);
		expect(codes(outside.json)).toEqual(["link-unsafe"]);
		expect(outside.json.items[0].status).toBeNull();

		const state = join(fixture.b, ".shepherd");
		fs.rmSync(join(state, "work"), { recursive: true });
		fs.symlinkSync(join(fixture.base, "outside", "work"), join(state, "work"));
		const linked = await query(["items"], fixture.env(fixture.b));
		expect(linked.code).toBe(1);
		expect(codes(linked.json)).toEqual(["link-unsafe", "link-unsafe"]);
		expect(linked.json.items[0].status).toBeNull();
	});

	test("renders the text form", async () => {
		const fixture = contractTree();
		const output = await runTool(
			["query", "items"],
			{},
			fixture.env(fixture.a),
		);
		expect(output).toEqual({
			text: [
				"CURRENT.md:4 NEXT evals  evals: the trials as a merge gate",
				"CURRENT.md:6 ASK lock  lock: which lock",
				"CURRENT.md:7 WAITING  on review: a small entry",
				"",
			].join("\n"),
			code: 0,
			stream: "stdout",
		});
		fs.writeFileSync(
			join(fixture.a, ".shepherd", "CURRENT.md"),
			"## Items\nNo NEXT is set.\n",
		);
		expect(
			(await runTool(["query", "items"], {}, fixture.env(fixture.a))).text,
		).toBe("no NEXT is set\n");
	});

	test("puts problem lines in the notice in text mode", async () => {
		const fixture = contractTree();
		fs.writeFileSync(join(fixture.a, ".shepherd", "CURRENT.md"), "no items\n");
		const output = await runTool(
			["query", "items"],
			{},
			fixture.env(fixture.a),
		);
		expect(output).toMatchObject({ code: 1, stream: "stdout", text: "\n" });
		expect(output.notice).toBe(
			"shepherd: CURRENT.md: CURRENT.md has no `## Items` section",
		);
	});
});

describe("tool query item", () => {
	test("resolves by link and projects STATUS", async () => {
		const fixture = contractTree();
		const { code, json } = await query(
			["item", "evals"],
			fixture.env(fixture.a),
		);
		expect(code).toBe(0);
		expect(json).toMatchObject({
			query: "item",
			problems: [],
			slug: "evals",
			resolved: "link",
			dir: "work/in-progress/evals",
			state: "in-progress",
			candidates: ["work/in-progress/evals"],
			status: {
				path: "work/in-progress/evals/STATUS.md",
				raw: STATUS,
				lines: 11,
				frontmatter: {
					raw: "state: in-progress\nopened: 2026-10-13",
					fields: { state: "in-progress", opened: "2026-10-13" },
				},
				title: "evals: the trials",
				sections: [
					expect.objectContaining({
						heading: "What and origin",
						text: "The origin.",
					}),
					expect.objectContaining({ heading: "State", text: "Running." }),
				],
			},
		});
		expect(json.entries).toHaveLength(1);
		expect(json.entries[0].line).toBe(4);
	});

	test("resolves an unlinked item by its directory", async () => {
		const fixture = contractTree({
			"root/a/.shepherd/work/done/old/STATUS.md": STATUS,
		});
		const { code, json } = await query(["item", "old"], fixture.env(fixture.a));
		expect(code).toBe(0);
		expect(json).toMatchObject({
			entries: [],
			resolved: "directory",
			dir: "work/done/old",
			state: "done",
			candidates: ["work/done/old"],
			status: { path: "work/done/old/STATUS.md" },
		});
	});

	test("keeps two entries with the same link", async () => {
		const fixture = contractTree();
		fs.writeFileSync(
			join(fixture.a, ".shepherd", "CURRENT.md"),
			"## Items\n- **NEXT** [evals](work/in-progress/evals/STATUS.md): one\n- **ASK** [evals](work/in-progress/evals/STATUS.md): two\n",
		);
		const { code, json } = await query(
			["item", "evals"],
			fixture.env(fixture.a),
		);
		expect(code).toBe(0);
		expect(json.entries).toHaveLength(2);
		expect(json.resolved).toBe("link");
	});

	test("reports entries with different links as duplicates", async () => {
		const fixture = contractTree();
		fs.writeFileSync(
			join(fixture.a, ".shepherd", "CURRENT.md"),
			"## Items\n- **NEXT** [evals](work/in-progress/evals/STATUS.md): one\n- **ASK** [evals](work/todo/evals/STATUS.md): two\n",
		);
		const { code, json } = await query(
			["item", "evals"],
			fixture.env(fixture.a),
		);
		expect(code).toBe(1);
		expect(codes(json)).toEqual(["item-duplicate"]);
		expect(json).toMatchObject({
			resolved: null,
			dir: null,
			status: null,
			candidates: ["work/in-progress/evals", "work/todo/evals"],
		});
	});

	test("reports a linked item whose directory is gone", async () => {
		const fixture = contractTree();
		fs.rmSync(join(fixture.a, ".shepherd", "work", "todo", "lock"), {
			recursive: true,
		});
		const { code, json } = await query(
			["item", "lock"],
			fixture.env(fixture.a),
		);
		expect(code).toBe(1);
		expect(codes(json)).toEqual(["status-missing"]);
		expect(json.status).toBeNull();
	});

	test("does not look up an unlinked entry's label", async () => {
		const fixture = contractTree();
		fs.writeFileSync(
			join(fixture.a, ".shepherd", "CURRENT.md"),
			"## Items\n- **WAITING** small: no link\n",
		);
		const { code, json } = await query(
			["item", "small"],
			fixture.env(fixture.a),
		);
		expect(code).toBe(1);
		expect(codes(json)).toEqual(["item-unknown"]);
	});

	test("reports a slug in two buckets as a duplicate", async () => {
		const fixture = contractTree({
			"root/a/.shepherd/work/todo/twice/STATUS.md": STATUS,
			"root/a/.shepherd/work/done/twice/STATUS.md": STATUS,
		});
		const { code, json } = await query(
			["item", "twice"],
			fixture.env(fixture.a),
		);
		expect(code).toBe(1);
		expect(codes(json)).toEqual(["item-duplicate"]);
		expect(json.candidates).toEqual(["work/todo/twice", "work/done/twice"]);
	});

	test("refuses a bad slug before any filesystem call", async () => {
		const fixture = contractTree();
		for (const slug of ["../x", "a/b", "."]) {
			const { value, calls } = await spyFs(() =>
				runTool(
					["query", "item", slug],
					{ json: true },
					fixture.env(fixture.a),
				),
			);
			expect(value).toMatchObject({ code: 2, stream: "stderr" });
			expect(calls).toEqual([]);
		}
	});

	for (const [label, link] of [
		["work", "work"],
		["bucket", "work/todo"],
		["item directory", "work/todo/lock"],
	] as const) {
		test(`refuses a symlinked ${label} without reading or enumerating it`, async () => {
			const fixture = contractTree({
				"outside/work/todo/lock/STATUS.md": STATUS,
				"outside/work/in-progress/evals/STATUS.md": STATUS,
			});
			const state = join(fixture.a, ".shepherd");
			fs.rmSync(join(state, link), { recursive: true });
			fs.symlinkSync(join(fixture.base, "outside", link), join(state, link));
			fs.writeFileSync(join(state, "CURRENT.md"), "## Items\n");
			const { value, calls } = await spyFs(() =>
				query(["item", "lock"], fixture.env(fixture.a)),
			);
			expect(value.code).toBe(1);
			expect(codes(value.json)).toContain("record-unsafe");
			expect(
				value.json.problems.find(
					({ code }: { code: string }) => code === "record-unsafe",
				).file,
			).toBe(link);
			expect(
				calls.filter(
					({ fn, path }) =>
						path.includes(`${sep}outside`) ||
						fn === "readdirSync" ||
						path.startsWith(`${join(state, link)}${sep}`),
				),
			).toEqual([]);
		});
	}

	test("renders the text form", async () => {
		const fixture = contractTree();
		const output = await runTool(
			["query", "item", "evals"],
			{},
			fixture.env(fixture.a),
		);
		expect(output.text).toBe(
			[
				"work/in-progress/evals/STATUS.md",
				"state: in-progress",
				"opened: 2026-10-13",
				"## What and origin",
				"The origin.",
				"## State",
				"Running.",
				"",
			].join("\n"),
		);
	});
});

describe("tool query workspace resolution", () => {
	test("names the nearest workspace outside one", async () => {
		const fixture = contractTree({ "root/a/notes/readme.md": "x" });
		const output = await runTool(
			["query", "items"],
			{},
			fixture.env(join(fixture.a, "notes")),
		);
		expect(output).toEqual({
			text: `not a workspace: ${join(fixture.a, "notes")}; the nearest one is ${fixture.a}, use --cwd\n`,
			code: 2,
			stream: "stderr",
		});
	});

	test("refuses an invalid user config with exit 2", async () => {
		const fixture = contractTree({ "xdg/shepherd/config.json": "{" });
		expect(await query(["items"], fixture.env(fixture.a))).toMatchObject({
			code: 2,
			stream: "stderr",
		});
	});

	test("refuses the journal flags on other queries and unknown queries", async () => {
		const fixture = contractTree();
		const env = fixture.env(fixture.a);
		expect(
			await runTool(["query", "items"], { since: "2026-10-01" }, env),
		).toEqual({
			text: "shepherd: --since applies only to tool query journal\n",
			code: 2,
			stream: "stderr",
		});
		expect(await runTool(["query", "item", "x"], { max: "5" }, env)).toEqual({
			text: "shepherd: --max applies only to tool query journal\n",
			code: 2,
			stream: "stderr",
		});
		for (const args of [["query"], ["query", "sweep"]]) {
			const output = await runTool(args, {}, env);
			expect(output).toMatchObject({ code: 2, stream: "stderr" });
			expect(output.text).toContain("shepherd tool query journal");
		}
	});
});

describe("tool query autonomy", () => {
	function grant(value: unknown): Record<string, string> {
		return {
			"root/a/.shepherd/config.json": JSON.stringify({ autonomy: value }),
		};
	}

	async function autonomy(
		files: Record<string, string>,
		clock?: () => Date,
		flags: Record<string, string | boolean> = {},
	) {
		const fixture = contractTree(files);
		return query(
			["autonomy"],
			fixture.env(fixture.a, clock ? { clock } : {}),
			flags,
		);
	}

	test("reports an absent config file as not set", async () => {
		const fixture = contractTree();
		fs.rmSync(join(fixture.a, ".shepherd", "config.json"));
		const { code, json } = await query(["autonomy"], fixture.env(fixture.a));
		expect(code).toBe(0);
		expect(json).toMatchObject({
			query: "autonomy",
			problems: [],
			file: join(fixture.a, ".shepherd", "config.json"),
			present: false,
			autonomy: null,
			active: false,
			expired: null,
		});
	});

	test("reports a config without the key as not set", async () => {
		const { code, json } = await autonomy({});
		expect(code).toBe(0);
		expect(json).toMatchObject({
			present: false,
			autonomy: null,
			active: false,
			expired: null,
		});
	});

	test("an enabled grant without until is active", async () => {
		const { code, json } = await autonomy(grant({ enabled: true }));
		expect(code).toBe(0);
		expect(json).toMatchObject({
			present: true,
			autonomy: { enabled: true },
			active: true,
			expired: null,
		});
	});

	test("a disabled grant is present and inactive", async () => {
		const { json } = await autonomy(
			grant({ enabled: false, until: "2026-12-01" }),
		);
		expect(json).toMatchObject({
			present: true,
			active: false,
			expired: false,
		});
	});

	test("a bare date holds through the end of its local day", async () => {
		const late = () => new Date(2026, 9, 5, 23, 59, 59);
		const midnight = () => new Date(2026, 9, 6, 0, 0, 0);
		for (const [until, clock, active] of [
			["2026-10-04", late, false],
			["2026-10-05", late, true],
			["2026-10-06", late, true],
			["2026-10-05", midnight, false],
			["2026-10-06", midnight, true],
		] as const) {
			const { code, json } = await autonomy(
				grant({ enabled: true, until }),
				clock,
			);
			expect(code).toBe(0);
			expect({ until, active: json.active, expired: json.expired }).toEqual({
				until,
				active,
				expired: !active,
			});
		}
	});

	test("an instant holds strictly before it, in any offset", async () => {
		for (const [until, active] of [
			["2026-10-05T11:59:59Z", false],
			["2026-10-05T12:00:00Z", false],
			["2026-10-05T12:00:01Z", true],
			["2026-10-05T09:00:01-03:00", true],
			["2026-10-05T14:00:01+02:00", true],
			["2026-10-05T14:00+02:00", false],
		] as const) {
			const { json } = await autonomy(grant({ enabled: true, until }));
			expect({ until, active: json.active, expired: json.expired }).toEqual({
				until,
				active,
				expired: !active,
			});
		}
	});

	test("an invalid config file stops the caller", async () => {
		for (const text of [
			"{",
			'{"autonomy":{"enabled":true,"until":"2026-02-30"}}',
			'{"autonomy":{"enabled":"yes"}}',
		]) {
			const { code, json } = await autonomy({
				"root/a/.shepherd/config.json": text,
			});
			expect(code).toBe(1);
			expect(json).toMatchObject({
				present: null,
				autonomy: null,
				active: false,
				expired: null,
			});
			expect(codes(json)).toEqual(["config-invalid"]);
			expect(json.problems[0].file).toBe(
				join(json.workspace.state, "config.json"),
			);
		}
	});

	test("refuses a symlinked config without reading its target", async () => {
		const fixture = contractTree({
			"outside/config.json": '{"autonomy":{"enabled":true}}',
		});
		const config = join(fixture.a, ".shepherd", "config.json");
		fs.rmSync(config);
		fs.symlinkSync(join(fixture.base, "outside", "config.json"), config);
		const { value, calls } = await spyFs(() =>
			query(["autonomy"], fixture.env(fixture.a)),
		);
		expect(value.code).toBe(1);
		expect(value.json).toMatchObject({
			present: null,
			autonomy: null,
			active: false,
		});
		expect(codes(value.json)).toEqual(["record-unsafe"]);
		expect(
			calls.filter(
				({ fn, path }) =>
					path.includes(`${sep}outside`) ||
					(fn === "readFileSync" && path === config),
			),
		).toEqual([]);
	});

	test("answers from the child's file alone, never the parent's grant", async () => {
		const parent = {
			"root/.shepherd/config.json": '{"autonomy":{"enabled":true}}',
		};
		const absent = contractTree(parent);
		fs.rmSync(join(absent.a, ".shepherd", "config.json"));
		expect(
			(await query(["autonomy"], absent.env(absent.a))).json,
		).toMatchObject({ present: false, active: false });

		expect(
			(await autonomy({ ...parent, ...grant({ enabled: false }) })).json,
		).toMatchObject({ present: true, active: false });

		const invalid = await autonomy({
			...parent,
			...grant({ enabled: true, extra: 1 }),
		});
		expect(invalid.code).toBe(1);
		expect(invalid.json).toMatchObject({ present: null, active: false });
	});

	test("renders the text form", async () => {
		const fixture = contractTree(grant({ enabled: true, until: "2026-10-20" }));
		expect(
			await runTool(["query", "autonomy"], {}, fixture.env(fixture.a)),
		).toEqual({
			text: "autonomy: active until 2026-10-20 (config.json)\n",
			code: 0,
			stream: "stdout",
		});
		expect(
			(await runTool(["query", "autonomy"], {}, fixture.env(fixture.b))).text,
		).toBe("autonomy: off (not set)\n");
	});
});

const ARCHIVE = "## 2026-09-30\n- 09:00 september one\n- 10:00 september two\n";
const JOURNAL = "## 2026-10-13\n- 10:00 started\n- 11:00 more\n- 12:00 last\n";

/** A with an archive month and a three entry journal, certified by cursors. */
function checkpointTree(extra: Record<string, string> = {}) {
	const fixture = contractTree({
		"root/a/.shepherd/archive/journal/2026-09.md": ARCHIVE,
		"root/a/.shepherd/journal.md": JOURNAL,
		"root/a/.shepherd/MEMORY.md": "# Memory\n",
		...extra,
	});
	const state = join(fixture.a, ".shepherd");
	return {
		...fixture,
		state,
		certify(
			cursors: (ids: string[]) => { from: string | null; to: string | null },
		) {
			const ids = journalChain(state).entries.map(({ id }) => id);
			const { from, to } = cursors(ids);
			const checkpoint = {
				schema: 1,
				revision: 3,
				written: "2026-10-13T15:25:02-03:00",
				session: "ws-1013",
				snapshot: "checkpoints/CURRENT.r3",
				journal: {
					from,
					to,
					count:
						from === null || to === null
							? 0
							: Math.max(0, ids.indexOf(to) - ids.indexOf(from) + 1),
				},
				files: hashPaths(
					{ name: "a", dir: fixture.a, state },
					coveredPaths(state),
				),
				evidence: {},
			};
			fs.writeFileSync(
				join(state, "checkpoint.json"),
				JSON.stringify(checkpoint),
			);
			return checkpoint;
		},
	};
}

/** Certify from the first archive entry to journal.md's first entry. */
const BOUNDARY = (ids: string[]) => ({
	from: ids[0] as string,
	to: ids[2] as string,
});

describe("tool query checkpoint", () => {
	test("reports no checkpoint with every field present", async () => {
		const fixture = checkpointTree();
		const { code, json } = await query(["checkpoint"], fixture.env(fixture.a));
		expect(code).toBe(0);
		expect(json).toMatchObject({
			query: "checkpoint",
			problems: [],
			status: "none",
			reason: null,
			revision: null,
			written: null,
			session: null,
			snapshot: null,
			journal: null,
			chain: null,
			boundary: { state: "none", position: null, file: null, line: null },
			entriesSince: null,
			compared: null,
			changed: null,
		});
	});

	test("reports an invalid checkpoint", async () => {
		const fixture = checkpointTree({
			"root/a/.shepherd/checkpoint.json": '{"schema":2}',
		});
		const { code, json } = await query(["checkpoint"], fixture.env(fixture.a));
		expect(code).toBe(1);
		expect(codes(json)).toEqual(["checkpoint-invalid"]);
		expect(json).toMatchObject({
			status: "invalid",
			reason: "schema must be 1",
			revision: null,
			boundary: { state: "none" },
			entriesSince: null,
			compared: null,
			changed: null,
		});
	});

	test("reports a valid checkpoint with its boundary and nothing changed", async () => {
		const fixture = checkpointTree();
		const certified = fixture.certify(BOUNDARY);
		const { code, json } = await query(["checkpoint"], fixture.env(fixture.a));
		expect(code).toBe(0);
		expect(json).toMatchObject({
			problems: [],
			status: "ok",
			reason: null,
			revision: 3,
			written: "2026-10-13T15:25:02-03:00",
			session: "ws-1013",
			snapshot: "checkpoints/CURRENT.r3",
			journal: {
				from: certified.journal.from,
				to: certified.journal.to,
				count: 3,
			},
			chain: {
				files: ["archive/journal/2026-09.md", "journal.md"],
				unreadable: [],
			},
			boundary: { state: "found", position: 3, file: "journal.md", line: 2 },
			entriesSince: 2,
			compared: 7,
			changed: [],
		});
	});

	test("lists changed, appeared, removed and unsafe covered files only", async () => {
		const fixture = checkpointTree({
			"outside/STATUS.md": STATUS,
		});
		fixture.certify(BOUNDARY);
		const { state } = fixture;
		fs.appendFileSync(join(state, "CURRENT.md"), "- **ASK** more\n");
		fs.mkdirSync(join(state, "work", "todo", "new"));
		fs.writeFileSync(join(state, "work", "todo", "new", "STATUS.md"), STATUS);
		fs.rmSync(join(state, "work", "todo", "lock"), { recursive: true });
		const evals = join(state, "work", "in-progress", "evals", "STATUS.md");
		fs.rmSync(evals);
		fs.symlinkSync(join(fixture.base, "outside", "STATUS.md"), evals);
		const { value, calls } = await spyFs(() =>
			query(["checkpoint"], fixture.env(fixture.a)),
		);
		expect(value.code).toBe(0);
		expect(value.json.compared).toBe(8);
		expect(value.json.changed).toEqual([
			{ path: "CURRENT.md", kind: "changed" },
			{
				path: "work/in-progress/evals/STATUS.md",
				kind: "unsafe",
				reason: "is a symlink",
			},
			{ path: "work/todo/lock/STATUS.md", kind: "removed" },
			{ path: "work/todo/new/STATUS.md", kind: "appeared" },
		]);
		expect(
			calls.filter(
				({ fn, path }) =>
					path.includes(`${sep}outside`) ||
					(fn === "readFileSync" && path === evals),
			),
		).toEqual([]);
	});

	for (const link of ["work", "work/todo"]) {
		test(`refuses a symlinked ${link} without enumerating its target`, async () => {
			const fixture = checkpointTree({
				"outside/work/todo/lock/STATUS.md": STATUS,
				"outside/work/todo/other/STATUS.md": STATUS,
				"outside/work/in-progress/evals/STATUS.md": STATUS,
			});
			fixture.certify(BOUNDARY);
			const linked = join(fixture.state, link);
			fs.rmSync(linked, { recursive: true });
			fs.symlinkSync(join(fixture.base, "outside", link), linked);
			const { value, calls } = await spyFs(() =>
				query(["checkpoint"], fixture.env(fixture.a)),
			);
			expect(value.code).toBe(0);
			expect(value.json.changed).toContainEqual({
				path: link,
				kind: "unsafe",
				reason: "is a symlink",
			});
			expect(
				value.json.changed.some(
					({ path }: { path: string }) => path === "work/todo/other/STATUS.md",
				),
			).toBeFalse();
			expect(
				calls.filter(
					({ fn, path }) =>
						path.includes(`${sep}outside`) ||
						path.startsWith(`${linked}${sep}`) ||
						(fn === "readdirSync" && path === linked),
				),
			).toEqual([]);
		});
	}

	test("loses the boundary when the certified entries moved", async () => {
		const edited = checkpointTree();
		edited.certify(BOUNDARY);
		fs.writeFileSync(
			join(edited.state, "journal.md"),
			JOURNAL.replace("10:00 started", "10:00 started, edited"),
		);
		const pruned = checkpointTree();
		pruned.certify(BOUNDARY);
		fs.rmSync(join(pruned.state, "archive", "journal", "2026-09.md"));
		const reversed = checkpointTree();
		reversed.certify((ids) => ({
			from: ids[2] as string,
			to: ids[0] as string,
		}));
		for (const fixture of [edited, pruned, reversed]) {
			const { code, json } = await query(
				["checkpoint"],
				fixture.env(fixture.a),
			);
			expect(code).toBe(0);
			expect(json.status).toBe("ok");
			expect(json.boundary).toEqual({
				state: "lost",
				position: null,
				file: null,
				line: null,
			});
			expect(json.entriesSince).toBeNull();
		}
	});

	test("counts headed entries from the start with null cursors", async () => {
		const fixture = checkpointTree({
			"root/a/.shepherd/journal.md": `- 08:00 above the heading\n\n${JOURNAL}`,
		});
		fixture.certify(() => ({ from: null, to: null }));
		const { code, json } = await query(["checkpoint"], fixture.env(fixture.a));
		expect(code).toBe(0);
		expect(json.boundary).toEqual({
			state: "null",
			position: 0,
			file: null,
			line: null,
		});
		expect(json.entriesSince).toBe(5);
	});

	test("an unreadable chain file leaves entriesSince null", async () => {
		const fixture = checkpointTree();
		fixture.certify(BOUNDARY);
		fs.appendFileSync(
			join(fixture.state, "archive", "journal", "2026-09.md"),
			"```\nopen fence\n",
		);
		const { code, json } = await query(["checkpoint"], fixture.env(fixture.a));
		expect(code).toBe(1);
		expect(codes(json)).toEqual(["journal-unreadable"]);
		expect(json.problems[0].file).toBe("archive/journal/2026-09.md");
		expect(json.chain.unreadable).toHaveLength(1);
		expect(json.entriesSince).toBeNull();
	});

	test("refuses a symlinked checkpoint without reading its target", async () => {
		const fixture = checkpointTree({ "outside/checkpoint.json": "{}" });
		const path = join(fixture.state, "checkpoint.json");
		fs.symlinkSync(join(fixture.base, "outside", "checkpoint.json"), path);
		const { value, calls } = await spyFs(() =>
			query(["checkpoint"], fixture.env(fixture.a)),
		);
		expect(value.code).toBe(1);
		expect(codes(value.json)).toEqual(["record-unsafe"]);
		expect(value.json.status).toBe("invalid");
		expect(
			calls.filter(
				({ fn, path: called }) =>
					called.includes(`${sep}outside`) ||
					(fn === "readFileSync" && called === path),
			),
		).toEqual([]);
	});

	test("renders the text form", async () => {
		const fixture = checkpointTree();
		fixture.certify(BOUNDARY);
		fs.appendFileSync(join(fixture.state, "CURRENT.md"), "- **ASK** more\n");
		const output = await runTool(
			["query", "checkpoint"],
			{},
			fixture.env(fixture.a),
		);
		expect(output).toEqual({
			text: [
				"revision 3 by ws-1013 at 2026-10-13T15:25:02-03:00",
				"boundary: found at journal.md:2",
				"entries since: 2; compared: 7; changed: 1",
				"  changed CURRENT.md",
				"",
			].join("\n"),
			code: 0,
			stream: "stdout",
		});
		expect(
			(await runTool(["query", "checkpoint"], {}, fixture.env(fixture.b))).text,
		).toBe("no checkpoint\nboundary: none\n");
	});
});

describe("tool query read contract", () => {
	test("items reads the user config and only CURRENT and link targets", async () => {
		const fixture = contractTree();
		const { value, calls } = await spyFs(() =>
			query(["items"], fixture.env(fixture.a)),
		);
		expect(value.code).toBe(0);
		expectContract(calls, fixture, fixture.a, (path, call) =>
			call.fn === "readFileSync"
				? path === "CURRENT.md"
				: call.fn === "lstatSync" &&
					(path === "CURRENT.md" ||
						/^work(\/(in-progress|todo)(\/(evals|lock)(\/STATUS\.md)?)?)?$/.test(
							path,
						)),
		);
		expect(calls.some(({ path }) => path === fixture.userConfig)).toBeTrue();
	});

	test("item reads CURRENT, the bucket checks and one STATUS", async () => {
		const fixture = contractTree();
		for (const slug of ["evals", "missing"]) {
			const { calls } = await spyFs(() =>
				query(["item", slug], fixture.env(fixture.a)),
			);
			expectContract(calls, fixture, fixture.a, (path, call) =>
				call.fn === "readFileSync"
					? path === "CURRENT.md" || path === "work/in-progress/evals/STATUS.md"
					: call.fn === "lstatSync" &&
						(path === "CURRENT.md" ||
							/^work(\/(in-progress|todo|done)(\/(evals|lock|missing)(\/STATUS\.md)?)?)?$/.test(
								path,
							)),
			);
		}
	});
	test("autonomy reads the user config and only its own config", async () => {
		const fixture = contractTree({
			"root/.shepherd/config.json": '{"autonomy":{"enabled":true}}',
		});
		const { value, calls } = await spyFs(() =>
			query(["autonomy"], fixture.env(fixture.a)),
		);
		expect(value.code).toBe(0);
		expectContract(
			calls,
			fixture,
			fixture.a,
			(path, call) =>
				path === "config.json" &&
				(call.fn === "lstatSync" || call.fn === "readFileSync"),
		);
		expect(calls).toContainEqual({
			fn: "readFileSync",
			path: join(fixture.a, ".shepherd", "config.json"),
		});
	});

	test("checkpoint reads the checkpoint, the chain and the covered records", async () => {
		const fixture = checkpointTree();
		fixture.certify(BOUNDARY);
		const { value, calls } = await spyFs(() =>
			query(["checkpoint"], fixture.env(fixture.a)),
		);
		expect(value.code).toBe(0);
		const records =
			/^(checkpoint\.json|journal\.md|archive\/journal\/\d{4}-\d{2}\.md|CURRENT\.md|MEMORY\.md|docs\/INDEX\.md|pending\.md|charter\.md|work\/(todo|in-progress)\/[^/]+\/STATUS\.md)$/;
		expectContract(calls, fixture, fixture.a, (path, call) => {
			if (call.fn === "readdirSync") {
				return /^(work\/(todo|in-progress)|archive\/journal)$/.test(path);
			}
			if (call.fn === "readFileSync") return records.test(path);
			return (
				call.fn === "lstatSync" &&
				(records.test(path) ||
					/^(docs|archive(\/journal)?|work(\/(todo|in-progress)(\/[^/]+)?)?)$/.test(
						path,
					))
			);
		});
		expect(calls).toContainEqual({
			fn: "readFileSync",
			path: join(fixture.a, ".shepherd", "charter.md"),
		});
	});
});
