import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join, sep } from "node:path";
import { assessCheckpoint, coveredPaths, hashPaths } from "./checkpoint";
import type { ToolEnv } from "./sessions";
import {
	fakeToolEnv,
	jsonCommandResult,
	type MakeTreeOptions,
	makeTree,
} from "./test-support";
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

/**
 * Assert the --all read contract from the root: the user config, discovery
 * (lstat, existence checks and listings of directories beneath the root,
 * outside any state directory), and the per-query paths under each
 * workspace's .shepherd/.
 */
function expectAllContract(
	calls: FsCall[],
	fixture: ReturnType<typeof contractTree>,
	allowed: (relative: string, call: FsCall) => boolean,
): void {
	const states = [fixture.root, fixture.a, fixture.b].map((dir) =>
		join(dir, ".shepherd"),
	);
	const stray = calls.filter((call) => {
		if (call.path === fixture.userConfig) return call.fn !== "readFileSync";
		const state = states.find((dir) => call.path.startsWith(`${dir}${sep}`));
		if (state) return !allowed(call.path.slice(state.length + 1), call);
		if (ancestorWalk(call, fixture.root)) return false;
		const discovery =
			call.fn === "lstatSync" ||
			call.fn === "existsSync" ||
			(call.fn === "readdirSync" &&
				!call.path.split(sep).includes(".shepherd"));
		const beneath =
			call.path === fixture.root ||
			call.path.startsWith(`${fixture.root}${sep}`);
		return !(discovery && beneath);
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

	test("flags links through a regular file where work/ should be", async () => {
		const fixture = contractTree();
		const state = join(fixture.a, ".shepherd");
		fs.rmSync(join(state, "work"), { recursive: true });
		fs.writeFileSync(join(state, "work"), "not a directory\n");
		const { code, json } = await query(["items"], fixture.env(fixture.a));
		expect(code).toBe(1);
		expect(codes(json)).toEqual(["link-unsafe", "link-unsafe"]);
		expect(json.problems[0].message).toBe(
			"link work/in-progress/evals/STATUS.md: work is not a directory",
		);
		expect(json.items[0].status).toBeNull();
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

	test("joins two spellings of one link and gives each entry its status", async () => {
		const fixture = contractTree();
		fs.writeFileSync(
			join(fixture.a, ".shepherd", "CURRENT.md"),
			"## Items\n- **NEXT** [Evals item](./work/in-progress/evals/STATUS.md): one\n- **ASK** [evals](work/in-progress/evals/STATUS.md): two\n",
		);
		const { code, json } = await query(
			["item", "evals"],
			fixture.env(fixture.a),
		);
		expect(code).toBe(0);
		expect(codes(json)).toEqual([]);
		expect(json).toMatchObject({
			resolved: "link",
			dir: "work/in-progress/evals",
			candidates: ["work/in-progress/evals"],
		});
		const status = { path: "work/in-progress/evals/STATUS.md", exists: true };
		expect(json.entries).toEqual([
			expect.objectContaining({
				slug: "evals",
				link: "./work/in-progress/evals/STATUS.md",
				status,
				line: 2,
			}),
			expect.objectContaining({
				slug: "evals",
				link: "work/in-progress/evals/STATUS.md",
				status,
				line: 3,
			}),
		]);
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

	test("reports one link-unsafe per entry sharing an unsafe link", async () => {
		const fixture = contractTree();
		fs.writeFileSync(
			join(fixture.a, ".shepherd", "CURRENT.md"),
			"## Items\n- **NEXT** [x](../../x/STATUS.md): one\n- **ASK** [x](../../x/STATUS.md): two\n",
		);
		const { code, json } = await query(["item", "x"], fixture.env(fixture.a));
		expect(code).toBe(1);
		expect(json.problems).toEqual([
			expect.objectContaining({ code: "link-unsafe", line: 2 }),
			expect.objectContaining({ code: "link-unsafe", line: 3 }),
		]);
		expect(
			json.entries.map(({ status }: { status: unknown }) => status),
		).toEqual([null, null]);
		expect(json).toMatchObject({ resolved: null, dir: null, status: null });
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

	test("renders the text form with each section's lines as written", async () => {
		const fixture = contractTree();
		fs.writeFileSync(
			join(fixture.a, ".shepherd", "work", "in-progress", "evals", "STATUS.md"),
			STATUS.replace(
				"Running.\n",
				"Running.\n- one\n- two\n\n    an indented paragraph\n",
			),
		);
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
				"",
				"## State",
				"Running.",
				"- one",
				"- two",
				"",
				"    an indented paragraph",
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

	test("refuses a symlink to a workspace as the launch directory", async () => {
		const fixture = contractTree();
		const link = join(fixture.base, "link");
		fs.symlinkSync(fixture.a, link);
		for (const flags of [{}, { all: true }] as Record<string, boolean>[]) {
			const output = await runTool(
				["query", "items"],
				flags,
				fixture.env(link),
			);
			expect(output).toMatchObject({ code: 2, stream: "stderr" });
			expect(output.text).toContain(`not a workspace: ${link}`);
		}
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

const SESSIONS = `Updated: 2026-10-13 17:26, ws-1013

## Items
- **NEXT** [evals](work/in-progress/evals/STATUS.md): the trials

## Live sessions
- ws-1013: Claude Code, Opus, Shepherd (Herdr w9:p1M)
- ws-1012b retired at 16:00
- delegate-cdx-1: Codex delegate for evals
`;

type Registered = {
	pid: number;
	name?: string;
	sessionId?: string;
	cwd: string;
	status?: string;
};

/** A Claude agent as Herdr lists it: no label, the registry holds its name. */
function herdrClaude(
	sessionId: string,
	cwd: string,
	extra: Record<string, unknown> = {},
) {
	return {
		agent: "claude",
		agent_session: { value: sessionId },
		cwd,
		...extra,
	};
}

/** A with the sessions CURRENT and a Codex home file naming ~/.codex-fake. */
function sessionsTree(
	extra: Record<string, string> = {},
	options: MakeTreeOptions = {},
) {
	const fixture = contractTree(
		{
			"root/a/.shepherd/CURRENT.md": SESSIONS,
			"home/.codex-active": "~/.codex-fake\n",
			...extra,
		},
		options,
	);
	const home = join(fixture.base, "home");
	return {
		...fixture,
		home,
		register(entries: Registered[]) {
			const dir = join(home, ".claude", "sessions");
			fs.mkdirSync(dir, { recursive: true });
			for (const entry of entries) {
				fs.writeFileSync(join(dir, `${entry.pid}.json`), JSON.stringify(entry));
			}
		},
		/** An env with a Herdr fake listing agents, or no Herdr when undefined. */
		sessionsEnv(
			cwd: string,
			{
				agents,
				alive = [],
				env = {},
			}: {
				agents?: unknown[];
				alive?: number[];
				env?: Record<string, string>;
			} = {},
		) {
			const calls: string[][] = [];
			return {
				calls,
				env: fixture.env(cwd, {
					alivePids: alive,
					env: {
						XDG_CONFIG_HOME: join(fixture.base, "xdg"),
						...(agents ? { HERDR_ENV: "1" } : {}),
						...env,
					},
					runCommand: async ({ argv }) => {
						calls.push(argv);
						return jsonCommandResult({ result: { agents: agents ?? [] } });
					},
				}),
			};
		},
	};
}

describe("tool query sessions", () => {
	test("lists the Live sessions names with their text and flags", async () => {
		const fixture = sessionsTree();
		const { env, calls } = fixture.sessionsEnv(fixture.a);
		const { code, json } = await query(["sessions"], env);
		expect(code).toBe(0);
		expect(json).toMatchObject({
			query: "sessions",
			prefix: "ws",
			hasChildren: false,
		});
		expect(json.listed).toEqual([
			{
				name: "ws-1013",
				line: 7,
				text: "ws-1013: Claude Code, Opus, Shepherd (Herdr w9:p1M)",
				retired: false,
				subagent: false,
				codex: false,
			},
			{
				name: "ws-1012b",
				line: 8,
				text: "ws-1012b retired at 16:00",
				retired: true,
				subagent: false,
				codex: false,
			},
			{
				name: "delegate-cdx-1",
				line: 9,
				text: "delegate-cdx-1: Codex delegate for evals",
				retired: false,
				subagent: false,
				codex: true,
			},
		]);
		expect(json.claude).toEqual({
			available: false,
			reason: "Claude session registry not found",
			sessions: [],
		});
		expect(json.herdr).toEqual({
			available: false,
			reason: "not inside Herdr",
			agents: [],
		});
		expect(json.codexNames).toEqual({
			consulted: false,
			homes: [],
			failures: [],
		});
		expect(codes(json)).toEqual(["source-unavailable", "source-unavailable"]);
		expect(calls).toEqual([]);
	});

	test("keeps the registry entries the workspace owns, by the exact-directory rule", async () => {
		const fixture = sessionsTree({ "root/notes/x.md": "x" });
		fixture.register([
			{
				pid: 201,
				name: "ws-1013",
				sessionId: "c-1",
				cwd: fixture.a,
				status: "idle",
			},
			{ pid: 202, name: "ws-1013", cwd: join(fixture.a, "notes") },
			{ pid: 203, name: "root-1013", cwd: fixture.root, status: "busy" },
			{ pid: 204, name: "deep-1013", cwd: join(fixture.root, "notes") },
			{ pid: 205, name: "b-1013", cwd: fixture.b },
			{ pid: 206, name: "ws-1012b", cwd: fixture.a, status: "idle" },
			{ pid: 207, name: "other-1013", cwd: fixture.a, status: "idle" },
			{ pid: 208, name: "dead-1013", cwd: fixture.a },
			{ pid: 209, sessionId: "c-9", cwd: fixture.a, status: "busy" },
		]);
		const alive = [201, 202, 203, 204, 205, 206, 207, 209];
		const child = await query(
			["sessions"],
			fixture.sessionsEnv(fixture.a, { alive }).env,
		);
		expect(child.code).toBe(0);
		expect(child.json.hasChildren).toBe(false);
		expect(child.json.claude).toEqual({
			available: true,
			reason: null,
			sessions: [
				{
					name: "ws-1013",
					sessionId: "c-1",
					pid: 201,
					file: "201.json",
					cwd: fixture.a,
					status: "idle",
					listed: { line: 7, retired: false },
					prefixMatch: true,
				},
				{
					name: "ws-1013",
					sessionId: null,
					pid: 202,
					file: "202.json",
					cwd: join(fixture.a, "notes"),
					status: null,
					listed: { line: 7, retired: false },
					prefixMatch: true,
				},
				{
					name: "ws-1012b",
					sessionId: null,
					pid: 206,
					file: "206.json",
					cwd: fixture.a,
					status: "idle",
					listed: { line: 8, retired: true },
					prefixMatch: true,
				},
				{
					name: "other-1013",
					sessionId: null,
					pid: 207,
					file: "207.json",
					cwd: fixture.a,
					status: "idle",
					listed: null,
					prefixMatch: false,
				},
				{
					name: null,
					sessionId: "c-9",
					pid: 209,
					file: "209.json",
					cwd: fixture.a,
					status: "busy",
					listed: null,
					prefixMatch: false,
				},
			],
		});

		const root = await query(
			["sessions"],
			fixture.sessionsEnv(fixture.root, { alive }).env,
		);
		expect(root.json.hasChildren).toBe(true);
		expect(root.json.claude.sessions).toEqual([
			{
				name: "root-1013",
				sessionId: null,
				pid: 203,
				file: "203.json",
				cwd: fixture.root,
				status: "busy",
				listed: null,
				prefixMatch: false,
			},
		]);
	});

	test("takes the prefix from the directory name without sessionPrefix", async () => {
		const fixture = sessionsTree();
		fs.rmSync(join(fixture.a, ".shepherd", "config.json"));
		fixture.register([
			{ pid: 201, name: "a-1013", cwd: fixture.a },
			{ pid: 202, name: "ws-1013", cwd: fixture.a },
		]);
		const { code, json } = await query(
			["sessions"],
			fixture.sessionsEnv(fixture.a, { alive: [201, 202] }).env,
		);
		expect(code).toBe(0);
		expect(json.prefix).toBe("a");
		expect(
			json.claude.sessions.map(
				({ name, prefixMatch }: { name: string; prefixMatch: boolean }) => [
					name,
					prefixMatch,
				],
			),
		).toEqual([
			["a-1013", true],
			["ws-1013", false],
		]);
	});

	test("an invalid or symlinked config leaves the prefix unknown", async () => {
		const invalid = sessionsTree({ "root/a/.shepherd/config.json": "{" });
		invalid.register([{ pid: 201, name: "ws-1013", cwd: invalid.a }]);
		const bad = await query(
			["sessions"],
			invalid.sessionsEnv(invalid.a, { alive: [201] }).env,
		);
		expect(bad.code).toBe(1);
		expect(bad.json.prefix).toBeNull();
		expect(bad.json.claude.sessions[0].prefixMatch).toBeNull();
		expect(codes(bad.json)).toEqual(["config-invalid", "source-unavailable"]);
		expect(bad.json.problems[0].file).toBe(
			join(invalid.a, ".shepherd", "config.json"),
		);

		const linked = sessionsTree({
			"outside/config.json": '{"sessionPrefix":"ws"}',
		});
		const config = join(linked.a, ".shepherd", "config.json");
		fs.rmSync(config);
		fs.symlinkSync(join(linked.base, "outside", "config.json"), config);
		const { value, calls } = await spyFs(() =>
			query(["sessions"], linked.sessionsEnv(linked.a).env),
		);
		expect(value.code).toBe(1);
		expect(value.json.prefix).toBeNull();
		expect(codes(value.json)).toEqual([
			"record-unsafe",
			"source-unavailable",
			"source-unavailable",
		]);
		expect(value.json.problems[0].file).toBe(config);
		expect(
			calls.filter(
				({ fn, path }) =>
					path.includes(`${sep}outside`) ||
					(fn === "readFileSync" && path === config),
			),
		).toEqual([]);
	});

	test("keeps Herdr's Claude agents beside the registry, named from it, and reads no Codex index without a Codex agent", async () => {
		const fixture = sessionsTree({
			"home/.codex-fake/session_index.jsonl": "",
		});
		fixture.register([
			{
				pid: 201,
				name: "ws-1013",
				sessionId: "c-1",
				cwd: fixture.a,
				status: "idle",
			},
			{ pid: 202, sessionId: "c-4", cwd: fixture.a },
		]);
		const { env, calls: commands } = fixture.sessionsEnv(fixture.a, {
			alive: [201, 202],
			agents: [
				herdrClaude("c-1", fixture.a, { agent_status: "idle" }),
				herdrClaude("c-4", fixture.a),
				{
					agent: "claude",
					agent_session: { value: "c-2" },
					name: "ws-1014",
					cwd: join(fixture.a, "notes"),
					agent_status: "working",
				},
				{
					agent: "claude",
					agent_session: { value: "c-3" },
					name: "b-1013",
					cwd: fixture.b,
					agent_status: "idle",
				},
			],
		});
		const { value, calls } = await spyFs(() => query(["sessions"], env));
		expect(value.code).toBe(0);
		expect(commands).toEqual([["herdr", "agent", "list"]]);
		expect(value.json.problems).toEqual([]);
		expect(
			value.json.claude.sessions.map(({ pid }: { pid: number }) => pid),
		).toEqual([201, 202]);
		expect(value.json.herdr).toEqual({
			available: true,
			reason: null,
			agents: [
				{
					agent: "claude",
					sessionId: "c-1",
					label: null,
					cwd: fixture.a,
					status: "idle",
					name: "ws-1013",
					listed: { line: 7, retired: false },
					prefixMatch: true,
				},
				{
					agent: "claude",
					sessionId: "c-4",
					label: null,
					cwd: fixture.a,
					status: null,
					name: null,
					listed: null,
					prefixMatch: false,
				},
				{
					agent: "claude",
					sessionId: "c-2",
					label: "ws-1014",
					cwd: join(fixture.a, "notes"),
					status: "working",
					name: "ws-1014",
					listed: null,
					prefixMatch: true,
				},
			],
		});
		expect(value.json.codexNames).toEqual({
			consulted: false,
			homes: [],
			failures: [],
		});
		expect(calls.filter(({ path }) => path.includes(".codex"))).toEqual([]);
	});

	test("names a Herdr Claude agent from its lowest-pid registry twin", async () => {
		const fixture = sessionsTree();
		fixture.register([
			{ pid: 302, name: "ws-high", sessionId: "c-1", cwd: fixture.a },
			{ pid: 301, name: "ws-low", sessionId: "c-1", cwd: fixture.a },
		]);
		const { env } = fixture.sessionsEnv(fixture.a, {
			alive: [301, 302],
			agents: [herdrClaude("c-1", fixture.a)],
		});
		const { code, json } = await query(["sessions"], env);
		expect(code).toBe(0);
		expect(json.claude.sessions.map(({ pid }: { pid: number }) => pid)).toEqual(
			[301, 302],
		);
		expect(json.herdr.agents).toEqual([
			expect.objectContaining({ sessionId: "c-1", name: "ws-low" }),
		]);
	});

	test("keeps a Herdr label over a differently named registry twin", async () => {
		const fixture = sessionsTree();
		fixture.register([
			{
				pid: 203,
				name: "other-name",
				sessionId: "c-2",
				cwd: join(fixture.base, "elsewhere"),
			},
		]);
		const { env } = fixture.sessionsEnv(fixture.a, {
			alive: [203],
			agents: [
				{
					agent: "claude",
					agent_session: { value: "c-2" },
					name: "ws-1014",
					cwd: fixture.a,
				},
			],
		});
		const { code, json } = await query(["sessions"], env);
		expect(code).toBe(0);
		expect(json.herdr.agents).toEqual([
			expect.objectContaining({
				sessionId: "c-2",
				label: "ws-1014",
				name: "ws-1014",
			}),
		]);
	});

	test("names an unlabelled Herdr Claude agent from a twin the workspace does not own", async () => {
		const fixture = sessionsTree();
		fixture.register([
			{
				pid: 204,
				name: "ws-1015",
				sessionId: "c-5",
				cwd: join(fixture.base, "elsewhere"),
			},
		]);
		const { env } = fixture.sessionsEnv(fixture.a, {
			alive: [204],
			agents: [herdrClaude("c-5", fixture.a)],
		});
		const { code, json } = await query(["sessions"], env);
		expect(code).toBe(0);
		expect(json.claude.sessions).toEqual([]);
		expect(json.herdr.agents).toEqual([
			expect.objectContaining({
				sessionId: "c-5",
				label: null,
				name: "ws-1015",
				prefixMatch: true,
			}),
		]);
	});

	test("names Codex agents from the indexes and reports a home it cannot read", async () => {
		const fixture = sessionsTree({
			"home/.codex-fake/session_index.jsonl": `${JSON.stringify({ id: "x-1", thread_name: "delegate-cdx-1" })}\n`,
		});
		const gone = join(fixture.base, "codex-gone");
		const { env } = fixture.sessionsEnv(fixture.a, {
			env: { CODEX_HOME: gone },
			agents: [
				{
					agent: "codex",
					agent_session: { value: "x-1" },
					name: "pane-3",
					cwd: join(fixture.a, "sub"),
					agent_status: "working",
				},
				{
					agent: "codex",
					agent_session: { value: "x-2" },
					name: "pane-4",
					cwd: fixture.a,
				},
				{ agent: "codex", agent_session: { value: "x-3" }, cwd: fixture.a },
			],
		});
		const { code, json } = await query(["sessions"], env);
		expect(code).toBe(0);
		expect(json.herdr.agents).toEqual([
			{
				agent: "codex",
				sessionId: "x-1",
				label: "pane-3",
				cwd: join(fixture.a, "sub"),
				status: "working",
				name: "delegate-cdx-1",
				listed: { line: 9, retired: false },
				prefixMatch: false,
			},
			{
				agent: "codex",
				sessionId: "x-2",
				label: "pane-4",
				cwd: fixture.a,
				status: null,
				name: "pane-4",
				listed: null,
				prefixMatch: false,
			},
			{
				agent: "codex",
				sessionId: "x-3",
				label: null,
				cwd: fixture.a,
				status: null,
				name: null,
				listed: null,
				prefixMatch: false,
			},
		]);
		expect(json.codexNames).toEqual({
			consulted: true,
			homes: [join(fixture.home, ".codex-fake", "session_index.jsonl")],
			failures: [{ home: gone, reason: expect.any(String) }],
		});
		expect(codes(json)).toEqual(["source-unavailable", "source-unavailable"]);
	});

	test("renders the text form", async () => {
		const fixture = sessionsTree({
			"home/.codex-fake/session_index.jsonl": `${JSON.stringify({ id: "x-1", thread_name: "delegate-cdx-1" })}\n`,
		});
		fixture.register([
			{
				pid: 201,
				name: "ws-1013",
				sessionId: "c-1",
				cwd: fixture.a,
				status: "idle",
			},
			{ pid: 202, cwd: fixture.a },
		]);
		const { env } = fixture.sessionsEnv(fixture.a, {
			alive: [201, 202],
			agents: [
				herdrClaude("c-1", fixture.a, { agent_status: "idle" }),
				{
					agent: "codex",
					agent_session: { value: "x-1" },
					cwd: join(fixture.a, "sub"),
					agent_status: "working",
				},
			],
		});
		expect(await runTool(["query", "sessions"], {}, env)).toEqual({
			text: [
				"prefix: ws",
				"listed ws-1013  CURRENT.md:7",
				"listed ws-1012b (retired)  CURRENT.md:8",
				"listed delegate-cdx-1 (codex)  CURRENT.md:9",
				`claude ws-1013 pid 201 idle ${fixture.a}  (listed, prefix)`,
				`claude (unnamed) pid 202 ? ${fixture.a}  (unlisted, no prefix)`,
				`herdr claude ws-1013 idle ${fixture.a}  (listed, prefix)`,
				`herdr codex delegate-cdx-1 working ${join(fixture.a, "sub")}  (listed, no prefix)`,
				"claude registry: 2 sessions",
				"herdr: 2 agents",
				"codex names: 1 index read",
				"",
			].join("\n"),
			code: 0,
			stream: "stdout",
		});
		const bare = await runTool(
			["query", "sessions"],
			{},
			fixture.sessionsEnv(fixture.b).env,
		);
		expect(bare).toMatchObject({ code: 0, stream: "stdout" });
		expect(bare.text).toContain("herdr: unavailable (not inside Herdr)\n");
		expect(bare.text).toContain("codex names: not consulted\n");
		expect(bare.notice).toContain("not inside Herdr");
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

	test("reports a regular file where work/ should be as unsafe", async () => {
		const fixture = checkpointTree();
		fixture.certify(BOUNDARY);
		fs.rmSync(join(fixture.state, "work"), { recursive: true });
		fs.writeFileSync(join(fixture.state, "work"), "not a directory\n");
		const { json } = await query(["checkpoint"], fixture.env(fixture.a));
		expect(json.changed).toContainEqual({
			path: "work",
			kind: "unsafe",
			reason: "is not a directory",
		});
	});

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

const SEVEN =
	"## 2026-10-13\n- 10:00 started\n- 11:00 more\n- 12:00 last\n- 13:00 four\n- 14:00 five\n";

async function journal(
	fixture: ReturnType<typeof checkpointTree>,
	flags: Record<string, string | boolean> = {},
) {
	return query(["journal"], fixture.env(fixture.a), flags);
}

function lines(json: { entries: { file: string; line: number }[] }): string[] {
	return json.entries.map(({ file, line }) => `${file}:${line}`);
}

describe("tool query journal", () => {
	test("reads entries after the checkpoint's boundary by default", async () => {
		const fixture = checkpointTree();
		const certified = fixture.certify(BOUNDARY);
		const { code, json } = await journal(fixture);
		expect(code).toBe(0);
		expect(json).toMatchObject({
			query: "journal",
			problems: [],
			journal: { status: "ok" },
			since: {
				kind: "checkpoint",
				id: certified.journal.to,
				found: true,
				file: "journal.md",
				line: 2,
			},
			files: ["archive/journal/2026-09.md", "journal.md"],
			unreadable: [],
			count: 2,
			truncated: null,
		});
		const ids = journalChain(fixture.state).entries.map(({ id }) => id);
		expect(json.entries).toEqual([
			{
				id: ids[3],
				file: "journal.md",
				line: 3,
				day: "2026-10-13",
				time: "11:00",
				text: "11:00 more",
			},
			{
				id: ids[4],
				file: "journal.md",
				line: 4,
				day: "2026-10-13",
				time: "12:00",
				text: "12:00 last",
			},
		]);
	});

	test("reads from the start of the chain with null cursors", async () => {
		const fixture = checkpointTree();
		fixture.certify(() => ({ from: null, to: null }));
		const { code, json } = await journal(fixture);
		expect(code).toBe(0);
		expect(json.since).toMatchObject({ kind: "checkpoint-null" });
		expect(json.count).toBe(5);
		expect(lines(json)).toEqual([
			"archive/journal/2026-09.md:2",
			"archive/journal/2026-09.md:3",
			"journal.md:2",
			"journal.md:3",
			"journal.md:4",
		]);
	});

	test("returns the newest entries under an invalid checkpoint", async () => {
		const fixture = checkpointTree({
			"root/a/.shepherd/journal.md": SEVEN,
			"root/a/.shepherd/checkpoint.json": '{"schema":2}',
		});
		const { code, json } = await journal(fixture, { max: "5" });
		expect(code).toBe(1);
		expect(codes(json)).toEqual(["checkpoint-invalid"]);
		expect(json.since).toMatchObject({ kind: "checkpoint-invalid" });
		expect(json.count).toBe(7);
		expect(lines(json)).toEqual([
			"journal.md:2",
			"journal.md:3",
			"journal.md:4",
			"journal.md:5",
			"journal.md:6",
		]);
		expect(json.truncated).toEqual({
			omitted: 2,
			from: "archive/journal/2026-09.md:2",
			to: "archive/journal/2026-09.md:3",
		});
	});

	test("returns the newest entries without a checkpoint", async () => {
		const fixture = checkpointTree();
		const { code, json } = await journal(fixture);
		expect(code).toBe(0);
		expect(json.problems).toEqual([]);
		expect(json.since).toEqual({
			kind: "none",
			id: null,
			day: null,
			found: null,
			file: null,
			line: null,
		});
		expect(json.count).toBe(5);
		expect(json.entries).toHaveLength(5);
		expect(json.truncated).toBeNull();
	});

	test("tells a missing journal, an empty one and a rotated one apart", async () => {
		const missing = checkpointTree();
		fs.rmSync(join(missing.state, "journal.md"));
		const empty = checkpointTree({
			"root/a/.shepherd/journal.md": "# Journal\n\n## 2026-10-13\n",
			"root/a/.shepherd/archive/journal/2026-09.md": "## 2026-09-30\n",
		});
		const rotated = checkpointTree({
			"root/a/.shepherd/journal.md": "# Journal\n",
		});

		const lost = await journal(missing);
		expect(lost.code).toBe(1);
		expect(codes(lost.json)).toEqual(["journal-missing"]);
		expect(lost.json.journal).toEqual({ status: "missing" });
		expect(lost.json.files).toEqual(["archive/journal/2026-09.md"]);

		const none = await journal(empty);
		expect(none.code).toBe(0);
		expect(none.json).toMatchObject({
			problems: [],
			journal: { status: "empty" },
			entries: [],
			count: 0,
			truncated: null,
		});

		const after = await journal(rotated);
		expect(after.code).toBe(0);
		expect(after.json.journal).toEqual({ status: "ok" });
		expect(lines(after.json)).toEqual([
			"archive/journal/2026-09.md:2",
			"archive/journal/2026-09.md:3",
		]);
	});

	test("loses the cursor when the certified entries moved", async () => {
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
		for (const [fixture, count] of [
			[edited, 5],
			[pruned, 3],
			[reversed, 5],
		] as const) {
			const { code, json } = await journal(fixture, { max: "2" });
			expect(code).toBe(1);
			expect(codes(json)).toEqual(["cursor-lost"]);
			expect(json.since).toMatchObject({
				kind: "checkpoint",
				found: false,
				file: null,
				line: null,
			});
			expect(json.count).toBe(count);
			expect(lines(json)).toEqual(["journal.md:3", "journal.md:4"]);
			expect(json.truncated.omitted).toBe(count - 2);
		}
	});

	test("reads after an id in the archive month and loses an unknown one", async () => {
		const fixture = checkpointTree();
		fixture.certify(() => ({ from: null, to: null }));
		const ids = journalChain(fixture.state).entries.map(({ id }) => id);
		const { code, json } = await journal(fixture, { since: ids[1] as string });
		expect(code).toBe(0);
		expect(json.since).toEqual({
			kind: "id",
			id: ids[1],
			day: null,
			found: true,
			file: "archive/journal/2026-09.md",
			line: 3,
		});
		expect(json.count).toBe(3);
		expect(lines(json)).toEqual([
			"journal.md:2",
			"journal.md:3",
			"journal.md:4",
		]);

		const unknown = await journal(fixture, { since: "0123456789" });
		expect(unknown.code).toBe(1);
		expect(codes(unknown.json)).toEqual(["cursor-lost"]);
		expect(unknown.json).toMatchObject({
			since: { kind: "id", id: "0123456789", found: false },
			entries: [],
			count: 0,
			truncated: null,
		});
	});

	test("reads from a date, leaving out entries above the first heading", async () => {
		const fixture = checkpointTree({
			"root/a/.shepherd/journal.md": `- 08:00 above the heading\n\n${JOURNAL}`,
		});
		const all = await journal(fixture);
		expect(all.json.entries[2]).toMatchObject({
			file: "journal.md",
			line: 1,
			day: null,
			time: "08:00",
			text: "08:00 above the heading",
		});
		expect(all.json.count).toBe(6);

		const { code, json } = await journal(fixture, { since: "2026-10-01" });
		expect(code).toBe(0);
		expect(json.since).toEqual({
			kind: "date",
			id: null,
			day: "2026-10-01",
			found: null,
			file: null,
			line: null,
		});
		expect(lines(json)).toEqual([
			"journal.md:4",
			"journal.md:5",
			"journal.md:6",
		]);
		expect((await journal(fixture, { since: "2026-09-30" })).json.count).toBe(
			5,
		);
	});

	test("keeps the newest --max entries and reports the omitted range", async () => {
		const fixture = checkpointTree();
		const { code, json } = await journal(fixture, { max: "2" });
		expect(code).toBe(0);
		expect(json.count).toBe(5);
		expect(lines(json)).toEqual(["journal.md:3", "journal.md:4"]);
		expect(json.truncated).toEqual({
			omitted: 3,
			from: "archive/journal/2026-09.md:2",
			to: "journal.md:2",
		});
		const all = await journal(fixture, { max: "all" });
		expect(all.json.entries).toHaveLength(5);
		expect(all.json.truncated).toBeNull();
	});

	test("refuses bad --max and --since values before any filesystem call", async () => {
		const fixture = checkpointTree();
		const env = fixture.env(fixture.a);
		for (const [flags, message] of [
			[{ max: "0" }, "invalid --max: 0"],
			[{ max: "x" }, "invalid --max: x"],
			[{ since: "7D6341BB91" }, "invalid --since: 7D6341BB91"],
			[{ since: "2026-02-30" }, "invalid --since: 2026-02-30"],
		] as const) {
			const { value, calls } = await spyFs(() =>
				runTool(["query", "journal"], flags, env),
			);
			expect(value).toMatchObject({ code: 2, stream: "stderr" });
			expect(value.text).toContain(message);
			expect(calls).toEqual([]);
		}
		expect(
			await runTool(["query", "items"], { since: "2026-10-01" }, env),
		).toMatchObject({ code: 2 });
	});

	test("an open fence in an archive month makes the count unknown", async () => {
		const fixture = checkpointTree();
		fs.appendFileSync(
			join(fixture.state, "archive", "journal", "2026-09.md"),
			"```\nopen fence\n",
		);
		const { code, json } = await journal(fixture);
		expect(code).toBe(1);
		expect(codes(json)).toEqual(["journal-unreadable"]);
		expect(json.problems[0]).toMatchObject({
			file: "archive/journal/2026-09.md",
			line: 4,
		});
		expect(json.unreadable).toHaveLength(1);
		expect(json.count).toBeNull();
	});

	test("refuses a symlinked journal without reading its target", async () => {
		const fixture = checkpointTree({ "outside/journal.md": JOURNAL });
		const path = join(fixture.state, "journal.md");
		fs.rmSync(path);
		fs.symlinkSync(join(fixture.base, "outside", "journal.md"), path);
		const { value, calls } = await spyFs(() => journal(fixture));
		expect(value.code).toBe(1);
		expect(codes(value.json)).toEqual(["journal-unreadable"]);
		expect(value.json.journal).toEqual({ status: "ok" });
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
		const certified = fixture.certify(BOUNDARY);
		const ids = journalChain(fixture.state).entries.map(({ id }) => id);
		const output = await runTool(
			["query", "journal"],
			{ max: "1" },
			fixture.env(fixture.a),
		);
		expect(output).toEqual({
			text: [
				`[since checkpoint ${certified.journal.to}]`,
				`journal.md:4 ${ids[4]} 12:00 last`,
				"1 older entry omitted: journal.md:3 to journal.md:3",
				"",
			].join("\n"),
			code: 0,
			stream: "stdout",
		});
		expect(
			(
				await runTool(
					["query", "journal"],
					{ since: "2026-10-14" },
					fixture.env(fixture.a),
				)
			).text,
		).toBe("[since 2026-10-14]\nno entries\n");
	});
});

type Answer = { workspace: { name: string }; problems: { code: string }[] };

describe("tool query --all", () => {
	test("returns the root and its children, each with its own answer", async () => {
		const fixture = contractTree({
			"root/.shepherd/config.json": '{"autonomy":{"enabled":true}}',
			"root/a/.shepherd/config.json": '{"autonomy":{"enabled":false}}',
		});
		const { code, json } = await query(
			["autonomy"],
			fixture.env(fixture.root),
			{ all: true },
		);
		expect(code).toBe(0);
		expect(json).toMatchObject({
			schema: 1,
			command: "query",
			query: "autonomy",
			root: fixture.root,
			scope: "all",
		});
		expect(json.workspaces).toHaveLength(3);
		expect(json.workspaces[1]).toMatchObject({
			workspace: {
				name: "a",
				dir: fixture.a,
				state: join(fixture.a, ".shepherd"),
			},
			observed: expect.any(String),
			retried: false,
			problems: [],
			file: join(fixture.a, ".shepherd", "config.json"),
		});
		expect(
			json.workspaces.map(
				(answer: Answer & { present: boolean; active: boolean }) => [
					answer.workspace.name,
					answer.present,
					answer.active,
				],
			),
		).toEqual([
			["root", true, true],
			["a", true, false],
			["b", false, false],
		]);
	});

	test("returns a standalone root alone", async () => {
		const fixture = contractTree(workspace("solo"));
		const solo = join(fixture.base, "solo");
		const { code, json } = await query(["items"], fixture.env(solo), {
			all: true,
		});
		expect(code).toBe(0);
		expect(json).toMatchObject({ root: solo, scope: "all" });
		expect(
			json.workspaces.map(({ workspace }: Answer) => workspace.name),
		).toEqual(["solo"]);
		expect(json.workspaces[0].items).toHaveLength(3);
	});

	test("refuses --all below the root without enumerating", async () => {
		const fixture = contractTree(workspace("root/a/one/two"));
		for (const cwd of [fixture.a, join(fixture.a, "one", "two")]) {
			const { value, calls } = await spyFs(() =>
				query(["items"], fixture.env(cwd), { all: true }),
			);
			expect(value).toMatchObject({
				text: `shepherd: --all is allowed only from the root workspace; this one sits under ${fixture.root}\n`,
				code: 2,
				stream: "stderr",
			});
			expect(calls.filter(({ fn }) => fn === "readdirSync")).toEqual([]);
		}
	});

	test("exits with the highest workspace exit", async () => {
		const fixture = contractTree();
		fs.rmSync(join(fixture.b, ".shepherd", "CURRENT.md"));
		const { code, json } = await query(["items"], fixture.env(fixture.root), {
			all: true,
		});
		expect(code).toBe(1);
		expect(
			json.workspaces.map((answer: Answer) => [
				answer.workspace.name,
				codes(answer),
			]),
		).toEqual([
			["root", []],
			["a", []],
			["b", ["current-missing"]],
		]);
	});

	test("refuses item with --all before any filesystem call", async () => {
		const fixture = contractTree();
		const { value, calls } = await spyFs(() =>
			query(["item", "evals"], fixture.env(fixture.root), { all: true }),
		);
		expect(value).toMatchObject({
			text: "shepherd: tool query item takes no --all; a slug names one workspace's item\n",
			code: 2,
			stream: "stderr",
		});
		expect(calls).toEqual([]);
	});

	test("renders one block per workspace, headed by its name", async () => {
		const fixture = contractTree({
			"root/.shepherd/config.json": '{"autonomy":{"enabled":true}}',
		});
		fs.writeFileSync(join(fixture.b, ".shepherd", "config.json"), "{");
		const output = await runTool(
			["query", "autonomy"],
			{ all: true },
			fixture.env(fixture.root),
		);
		expect(output).toMatchObject({
			text: [
				"root",
				"  autonomy: active (config.json)",
				"",
				"a",
				"  autonomy: off (not set)",
				"",
				"b",
				"  autonomy: off (config.json is invalid)",
				"",
			].join("\n"),
			code: 1,
			stream: "stdout",
		});
		expect(output.notice).toStartWith(
			`shepherd: b: ${join(fixture.b, ".shepherd", "config.json")}: `,
		);
	});
});

describe("tool query stability", () => {
	/** Run with readFileSync or readdirSync calling after on each call for path. */
	async function withHook<T>(
		fn: "readFileSync" | "readdirSync",
		path: string,
		after: (count: number) => void,
		run: () => Promise<T>,
	): Promise<T> {
		const original = FS_CALLS[fn];
		let count = 0;
		const spy = spyOn(fs, fn).mockImplementation(((...args: unknown[]) => {
			const value = Reflect.apply(original, fs, args);
			if (String(args[0]) === path) after(++count);
			return value;
		}) as never);
		try {
			return await run();
		} finally {
			spy.mockRestore();
		}
	}

	test("reruns once when a read file is rewritten with the same size", async () => {
		const fixture = contractTree();
		const current = join(fixture.a, ".shepherd", "CURRENT.md");
		const past = new Date(2020, 0, 1);
		fs.utimesSync(current, past, past);
		const before = fs.lstatSync(current);
		let reads = 0;
		const { code, json } = await withHook(
			"readFileSync",
			current,
			(count) => {
				reads = count;
				if (count === 1) {
					fs.writeFileSync(current, ITEMS.replace("the trials", "the trails"));
				}
			},
			() => query(["items"], fixture.env(fixture.a)),
		);
		expect({ retried: json.retried, text: json.items[0].text }).toEqual({
			retried: true,
			text: "evals: the trails as a merge gate",
		});
		expect(code).toBe(0);
		expect(json.problems).toEqual([]);
		expect(reads).toBe(2);
		const after = fs.lstatSync(current);
		expect([after.size, after.ino]).toEqual([before.size, before.ino]);
	});

	test("reports collection-unstable when the file changes again", async () => {
		const fixture = contractTree();
		const current = join(fixture.a, ".shepherd", "CURRENT.md");
		const { code, json } = await withHook(
			"readFileSync",
			current,
			(count) => fs.writeFileSync(current, `${ITEMS}${"\n".repeat(count)}`),
			() => query(["items"], fixture.env(fixture.a)),
		);
		expect(json.retried).toBeTrue();
		expect(code).toBe(1);
		expect(json.problems).toEqual([
			{
				code: "collection-unstable",
				file: "CURRENT.md",
				message: "CURRENT.md changed during collection, twice",
			},
		]);
		expect(json.items).toHaveLength(3);
	});

	test("reruns when a journal month appears after the enumeration", async () => {
		const fixture = checkpointTree();
		const archive = join(fixture.state, "archive", "journal");
		const { code, json } = await withHook(
			"readdirSync",
			archive,
			(count) => {
				if (count === 1) {
					fs.writeFileSync(
						join(archive, "2026-08.md"),
						"## 2026-08-31\n- 09:00 august\n",
					);
				}
			},
			() => query(["journal"], fixture.env(fixture.a)),
		);
		expect(code).toBe(0);
		expect(json.retried).toBeTrue();
		expect(json.files).toEqual([
			"archive/journal/2026-08.md",
			"archive/journal/2026-09.md",
			"journal.md",
		]);
		expect(json.count).toBe(6);
	});
});

type Allowed = (relative: string, call: FsCall) => boolean;

const JOURNAL_FILES = /^(journal\.md|archive\/journal\/\d{4}-\d{2}\.md)$/;
const CHAIN =
	/^(checkpoint\.json|journal\.md|archive\/journal\/\d{4}-\d{2}\.md)$/;
const COVERED =
	/^(CURRENT\.md|MEMORY\.md|docs\/INDEX\.md|pending\.md|charter\.md|work\/(todo|in-progress)\/[^/]+\/STATUS\.md)$/;

function chainReads(records: RegExp): Allowed {
	return (path, call) => {
		if (call.fn === "readdirSync") return path === "archive/journal";
		if (call.fn === "readFileSync") return records.test(path);
		return (
			call.fn === "lstatSync" &&
			(records.test(path) || /^archive(\/journal)?$/.test(path))
		);
	};
}

function ownFiles(...files: string[]): Allowed {
	return (path, call) =>
		files.includes(path) &&
		(call.fn === "lstatSync" || call.fn === "readFileSync");
}

/** The paths under .shepherd/ each query may touch, by call. */
const ALLOWED = {
	items: (path, call) =>
		call.fn === "readFileSync"
			? path === "CURRENT.md"
			: call.fn === "lstatSync" &&
				(path === "CURRENT.md" ||
					/^work(\/(in-progress|todo)(\/(evals|lock)(\/STATUS\.md)?)?)?$/.test(
						path,
					)),
	item: (path, call) =>
		call.fn === "readFileSync"
			? path === "CURRENT.md" || path === "work/in-progress/evals/STATUS.md"
			: call.fn === "lstatSync" &&
				(path === "CURRENT.md" ||
					/^work(\/(in-progress|todo|done)(\/(evals|lock|missing)(\/STATUS\.md)?)?)?$/.test(
						path,
					)),
	autonomy: ownFiles("config.json"),
	sessions: ownFiles("CURRENT.md", "config.json"),
	journal: chainReads(CHAIN),
	"journal --since": chainReads(JOURNAL_FILES),
	checkpoint: (path, call) => {
		if (call.fn === "readdirSync") {
			return /^(work\/(todo|in-progress)|archive\/journal)$/.test(path);
		}
		const record = CHAIN.test(path) || COVERED.test(path);
		if (call.fn === "readFileSync") return record;
		return (
			call.fn === "lstatSync" &&
			(record ||
				/^(docs|archive(\/journal)?|work(\/(todo|in-progress)(\/[^/]+)?)?)$/.test(
					path,
				))
		);
	},
} satisfies Record<string, Allowed>;

describe("tool query read contract", () => {
	test("items reads the user config and only CURRENT and link targets", async () => {
		const fixture = contractTree();
		const { value, calls } = await spyFs(() =>
			query(["items"], fixture.env(fixture.a)),
		);
		expect(value.code).toBe(0);
		expectContract(calls, fixture, fixture.a, ALLOWED.items);
		expect(calls.some(({ path }) => path === fixture.userConfig)).toBeTrue();
	});

	test("item reads CURRENT, the bucket checks and one STATUS", async () => {
		const fixture = contractTree();
		for (const slug of ["evals", "missing"]) {
			const { calls } = await spyFs(() =>
				query(["item", slug], fixture.env(fixture.a)),
			);
			expectContract(calls, fixture, fixture.a, ALLOWED.item);
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
		expectContract(calls, fixture, fixture.a, ALLOWED.autonomy);
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
		expectContract(calls, fixture, fixture.a, ALLOWED.checkpoint);
		expect(calls).toContainEqual({
			fn: "readFileSync",
			path: join(fixture.a, ".shepherd", "charter.md"),
		});
	});

	test("journal reads the checkpoint and the journal chain only, and with --since never the checkpoint", async () => {
		const fixture = checkpointTree();
		fixture.certify(BOUNDARY);
		const checkpoint = join(fixture.a, ".shepherd", "checkpoint.json");
		for (const [flags, allowed] of [
			[{}, ALLOWED.journal],
			[{ since: "2026-10-01" }, ALLOWED["journal --since"]],
			[{ since: "0123456789" }, ALLOWED["journal --since"]],
		] as const) {
			const { value, calls } = await spyFs(() =>
				query(["journal"], fixture.env(fixture.a), flags),
			);
			expect(value.code).toBe(flags.since === "0123456789" ? 1 : 0);
			expectContract(calls, fixture, fixture.a, allowed);
			expect(calls).toContainEqual({
				fn: "readFileSync",
				path: join(fixture.a, ".shepherd", "journal.md"),
			});
			expect(calls.some(({ path }) => path === checkpoint)).toBe(
				flags.since === undefined,
			);
		}
	});

	test("sessions reads CURRENT, its own config and the session sources", async () => {
		const fixture = sessionsTree({
			"home/.codex-fake/session_index.jsonl": `${JSON.stringify({ id: "x-1", thread_name: "delegate-cdx-1" })}\n`,
		});
		fixture.register([
			{ pid: 201, name: "ws-1013", sessionId: "c-1", cwd: fixture.a },
		]);
		const claude = join(fixture.home, ".claude");
		const codexHome = join(fixture.home, ".codex-fake");
		const homeFile = join(fixture.home, ".codex-active");
		const codexCalls = (call: FsCall) =>
			(call.path === homeFile && call.fn === "readFileSync") ||
			(call.path === fixture.home && call.fn === "readdirSync") ||
			call.path.startsWith(`${codexHome}${sep}`);
		const claudeAgent = herdrClaude("c-1", fixture.a);
		const codexAgent = {
			agent: "codex",
			agent_session: { value: "x-1" },
			cwd: fixture.b,
		};
		for (const [agents, codex] of [
			[undefined, false],
			[[claudeAgent], false],
			[[claudeAgent, codexAgent], true],
		] as const) {
			const { env, calls: commands } = fixture.sessionsEnv(fixture.a, {
				alive: [201],
				...(agents ? { agents: [...agents] } : {}),
			});
			const { value, calls } = await spyFs(() => query(["sessions"], env));
			expect(value.code).toBe(0);
			expect(commands).toEqual(agents ? [["herdr", "agent", "list"]] : []);
			const outside = calls.filter(
				(call) =>
					!(call.path === fixture.a && call.fn === "readdirSync") &&
					!call.path.startsWith(`${claude}${sep}`) &&
					!(codex && codexCalls(call)),
			);
			expectContract(outside, fixture, fixture.a, ALLOWED.sessions);
			expect(calls).toContainEqual({
				fn: "readFileSync",
				path: join(fixture.a, ".shepherd", "config.json"),
			});
			expect(calls).toContainEqual({
				fn: "readFileSync",
				path: join(claude, "sessions", "201.json"),
			});
			expect(calls.some((call) => codexCalls(call))).toBe(codex);
			if (codex) {
				expect(calls).toContainEqual({ fn: "readFileSync", path: homeFile });
				expect(calls).toContainEqual({
					fn: "readFileSync",
					path: join(codexHome, "session_index.jsonl"),
				});
			}
		}
	});

	test("--all from the root reads each workspace's records and nothing beyond", async () => {
		const fixture = checkpointTree();
		fixture.certify(BOUNDARY);
		for (const [name, flags] of [
			["items", {}],
			["autonomy", {}],
			["journal", {}],
			["journal --since", { since: "2026-10-01" }],
			["checkpoint", {}],
		] as const) {
			const allowed = ALLOWED[name];
			const { value, calls } = await spyFs(() =>
				query([name.split(" ")[0] as string], fixture.env(fixture.root), {
					all: true,
					...flags,
				}),
			);
			expect({ name, code: value.code }).toEqual({ name, code: 0 });
			expect(
				value.json.workspaces.map(({ workspace }: Answer) => workspace.name),
			).toEqual(["root", "a", "b"]);
			expectAllContract(calls, fixture, allowed);
			for (const dir of [fixture.root, fixture.a, fixture.b]) {
				expect(
					calls.some(({ path }) => path.startsWith(join(dir, ".shepherd", ""))),
				).toBeTrue();
			}
			expect(
				calls.some(
					({ fn, path }) =>
						fn === "readFileSync" && path.endsWith("charter.md"),
				),
			).toBe(name === "checkpoint");
		}
	});

	test("sessions --all reads each session source once", async () => {
		const fixture = sessionsTree({
			"home/.codex-fake/session_index.jsonl": `${JSON.stringify({ id: "x-1", thread_name: "delegate-cdx-1" })}\n`,
		});
		fixture.register([
			{ pid: 201, name: "ws-1013", sessionId: "c-1", cwd: fixture.a },
			{ pid: 202, name: "ws-1001", cwd: fixture.root },
			{ pid: 203, name: "ws-1002", cwd: fixture.b },
		]);
		const claude = join(fixture.home, ".claude");
		const codexHome = join(fixture.home, ".codex-fake");
		const { env, calls: commands } = fixture.sessionsEnv(fixture.root, {
			alive: [201, 202, 203],
			agents: [
				herdrClaude("c-1", fixture.a),
				{ agent: "codex", agent_session: { value: "x-1" }, cwd: fixture.b },
			],
		});
		const { value, calls } = await spyFs(() =>
			query(["sessions"], env, { all: true }),
		);
		expect(value.code).toBe(0);
		expect(commands).toEqual([["herdr", "agent", "list"]]);
		expect(
			calls.filter(
				({ fn, path }) =>
					fn === "readdirSync" && path === join(claude, "sessions"),
			),
		).toHaveLength(1);
		expect(
			calls.filter(
				({ fn, path }) =>
					fn === "readFileSync" &&
					path === join(codexHome, "session_index.jsonl"),
			),
		).toHaveLength(1);
		const answers = value.json.workspaces;
		expect(
			answers.map(
				(answer: Answer & { claude: { sessions: { pid: number }[] } }) => [
					answer.workspace.name,
					answer.claude.sessions.map(({ pid }) => pid),
				],
			),
		).toEqual([
			["root", [202]],
			["a", [201]],
			["b", [203]],
		]);
		expect(answers[1].herdr.agents).toMatchObject([
			{ agent: "claude", label: null, name: "ws-1013" },
		]);
		expect(answers[2].herdr.agents).toMatchObject([
			{ agent: "codex", name: "delegate-cdx-1" },
		]);
		expect(
			new Set(answers.map(({ observed }: { observed: string }) => observed))
				.size,
		).toBe(1);
		expectAllContract(
			calls.filter(
				(call) =>
					!call.path.startsWith(`${claude}${sep}`) &&
					!call.path.startsWith(`${codexHome}${sep}`) &&
					!(call.path === join(fixture.home, ".codex-active")) &&
					!(call.path === fixture.home && call.fn === "readdirSync"),
			),
			fixture,
			ALLOWED.sessions,
		);
	});
});

const FORGE_CURRENT = `Updated: 2026-10-13 17:26, forge-1013b

## Next session
- First move: read the query-tool branch review.

## Legend
- **NEXT**: agreed, start
- **WAITING**: blocked outside the workspace
- **ASK**: needs the user

## Items
- **NEXT** [shepherd-evals](work/in-progress/shepherd-evals/STATUS.md): forge order (2), the trials
  in Troupe as a merge gate; agreed 17:41
- **WAITING** [query-tool](./work/in-progress/query-tool/STATUS.md): branch review by two readers
- **ASK:** whether the nightly sweep stays
- **SCHEDULED**: 2026-10-20 rotate the journal
- **CANDIDATE** [heartbeat](work/todo/heartbeat/STATUS.md): the scheduled tick

## Live sessions
- forge-1013b: Claude Code, Opus 5.5, Shepherd (Herdr w9:p1M)
- forge-1012 retired at 16:00
`;

const FORGE_STATUS = `---
state: in-progress
opened: 2026-10-13
closed: 2026-10-20        # once done
blocked_on: "review #2"   # while blocked
---
# shepherd-evals: the Shepherd trials in Troupe as a merge gate

## What and origin
The user, 2026-10-13: trials before merge.

## State
- trial one green
- trial two open

## Next
Run trial two.

## Next session must know
Nothing yet.
`;

describe("tool query acceptance", () => {
	test("answers all six queries on a forge-shaped workspace", async () => {
		const tree = makeTree({
			"xdg/shepherd/config.json": "{}",
			"forge/.shepherd/CURRENT.md": FORGE_CURRENT,
			"forge/.shepherd/charter.md": "# forge\n\nThe charter.\n",
			"forge/.shepherd/MEMORY.md": "# Memory\n",
			"forge/.shepherd/docs/INDEX.md": "# Docs\n",
			"forge/.shepherd/pending.md": "# Pending\n",
			"forge/.shepherd/archive/journal/2026-09.md": ARCHIVE,
			"forge/.shepherd/journal.md": `${JOURNAL}- 13:00 after the checkpoint\n`,
			"forge/.shepherd/work/in-progress/shepherd-evals/STATUS.md": FORGE_STATUS,
			"forge/.shepherd/work/in-progress/query-tool/STATUS.md":
				FORGE_STATUS.replaceAll("shepherd-evals", "query-tool"),
			"forge/.shepherd/work/todo/heartbeat/STATUS.md": FORGE_STATUS.replace(
				"state: in-progress",
				"state: todo",
			),
			"forge/.shepherd/work/done/old/STATUS.md": FORGE_STATUS,
		});
		cleanups.push(tree.cleanup);
		const dir = join(tree.root, "forge");
		const state = join(dir, ".shepherd");
		const ids = journalChain(state).entries.map(({ id }) => id);
		const to = ids.at(-3) as string;
		fs.writeFileSync(
			join(state, "checkpoint.json"),
			JSON.stringify({
				schema: 1,
				revision: 6,
				written: "2026-10-13T15:25:02-03:00",
				session: "forge-1013b",
				snapshot: "checkpoints/CURRENT.r6",
				journal: { from: ids[0], to, count: ids.length - 2 },
				files: hashPaths({ name: "forge", dir, state }, coveredPaths(state)),
				evidence: {},
			}),
		);
		const home = join(tree.root, "home");
		fs.mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
		fs.writeFileSync(
			join(home, ".claude", "sessions", "48213.json"),
			JSON.stringify({
				pid: 48213,
				name: "forge-1013b",
				cwd: dir,
				status: "idle",
			}),
		);
		const env = fakeToolEnv({
			home,
			cwd: dir,
			env: { XDG_CONFIG_HOME: join(tree.root, "xdg") },
			alivePids: [48213],
		});

		const answers: Record<string, Awaited<ReturnType<typeof query>>> = {};
		for (const [args, line] of [
			[
				["items"],
				"CURRENT.md:14 WAITING query-tool  query-tool: branch review by two readers",
			],
			[["item", "query-tool"], "work/in-progress/query-tool/STATUS.md"],
			[["sessions"], "prefix: forge"],
			[["autonomy"], "autonomy: off (not set)"],
			[["journal"], `[since checkpoint ${to}]`],
			[["checkpoint"], "entries since: 2; compared: 8; changed: 0"],
		] as [string[], string][]) {
			const answer = await query(args, env);
			answers[args[0] as string] = answer;
			const nonSource = answer.json.problems.filter(
				({ code }: { code: string }) => code !== "source-unavailable",
			);
			expect({ args, code: answer.code, problems: nonSource }).toEqual({
				args,
				code: 0,
				problems: [],
			});
			const text = await runTool(["query", ...args], {}, env);
			expect({ args, code: text.code }).toEqual({ args, code: 0 });
			expect(text.text.split("\n")).toContain(line);
		}

		const { items, item, sessions, autonomy, journal, checkpoint } = answers;
		expect(
			items?.json.items.map(
				({
					word,
					slug,
					status,
				}: {
					word: string;
					slug: string | null;
					status: { exists: boolean } | null;
				}) => [word, slug, status?.exists ?? null],
			),
		).toEqual([
			["NEXT", "shepherd-evals", true],
			["WAITING", "query-tool", true],
			["ASK", null, null],
			["SCHEDULED", null, null],
			["CANDIDATE", "heartbeat", true],
		]);
		expect(item?.json).toMatchObject({
			resolved: "link",
			dir: "work/in-progress/query-tool",
			state: "in-progress",
			status: {
				frontmatter: {
					fields: { closed: "2026-10-20", blocked_on: "review #2" },
				},
				title: "query-tool: the Shepherd trials in Troupe as a merge gate",
			},
		});
		expect(
			item?.json.status.sections.map(
				({ heading }: { heading: string }) => heading,
			),
		).toEqual(["What and origin", "State", "Next", "Next session must know"]);
		expect(sessions?.json).toMatchObject({
			prefix: "forge",
			listed: [
				{ name: "forge-1013b", retired: false },
				{ name: "forge-1012", retired: true },
			],
			claude: {
				available: true,
				sessions: [
					{
						name: "forge-1013b",
						pid: 48213,
						listed: { retired: false },
						prefixMatch: true,
					},
				],
			},
			herdr: { available: false },
		});
		expect(autonomy?.json).toMatchObject({ present: false, active: false });
		expect(journal?.json).toMatchObject({
			since: { kind: "checkpoint", id: to, found: true },
			count: 2,
		});
		expect(
			journal?.json.entries.map(({ text }: { text: string }) => text),
		).toEqual(["12:00 last", "13:00 after the checkpoint"]);
		expect(checkpoint?.json).toMatchObject({
			status: "ok",
			revision: 6,
			boundary: { state: "found" },
			entriesSince: 2,
			changed: [],
		});
	});

	test("tool check accepts a workspace config with an autonomy key", async () => {
		const tree = makeTree({ "xdg/shepherd/config.json": "{}" });
		cleanups.push(tree.cleanup);
		const dir = join(tree.root, "ws");
		fs.mkdirSync(dir);
		const env = fakeToolEnv({
			home: join(tree.root, "home"),
			cwd: dir,
			env: { XDG_CONFIG_HOME: join(tree.root, "xdg") },
		});
		expect((await runTool(["init"], {}, env)).code).toBe(0);
		const configFile = join(dir, ".shepherd", "config.json");
		const configFindings = async (config: unknown) => {
			fs.writeFileSync(configFile, JSON.stringify(config));
			const output = await runTool(["check"], { json: true }, env);
			expect(output.code).not.toBe(2);
			return JSON.parse(output.text).workspaces.flatMap(
				({ findings }: { findings: { code: string; message: string }[] }) =>
					findings.filter(({ code }) => code === "config-invalid"),
			);
		};

		expect(
			await configFindings({
				autonomy: { enabled: true, until: "2026-10-20T18:00-03:00" },
			}),
		).toEqual([]);
		expect(await configFindings({ autonomy: { enabled: "yes" } })).toEqual([
			expect.objectContaining({ code: "config-invalid" }),
		]);
	});
});

describe("F16: one boundary and one change classifier", () => {
	function certified(
		cursors: (ids: string[]) => { from: string | null; to: string | null },
		extra: Record<string, string> = {},
	) {
		const fixture = checkpointTree(extra);
		const { snapshot } = fixture.certify(cursors);
		fs.mkdirSync(join(fixture.state, "checkpoints"));
		fs.copyFileSync(
			join(fixture.state, "CURRENT.md"),
			join(fixture.state, snapshot),
		);
		return fixture;
	}
	function assessed(fixture: ReturnType<typeof checkpointTree>) {
		return assessCheckpoint(
			{ name: "a", dir: fixture.a, state: fixture.state },
			fixture.env(fixture.a),
		);
	}

	const cases: [
		string,
		(ids: string[]) => { from: string | null; to: string | null },
		((state: string) => void)?,
	][] = [
		["found across an archive month", BOUNDARY],
		[
			"lost from an edited certified entry",
			BOUNDARY,
			(state) =>
				fs.writeFileSync(
					join(state, "journal.md"),
					JOURNAL.replace("10:00 started", "10:00 started, edited"),
				),
		],
		["both cursors null", () => ({ from: null, to: null })],
	];
	for (const [name, cursors, change] of cases) {
		test(`assessCheckpoint and query checkpoint give one boundary: ${name}`, async () => {
			const fixture = certified(cursors);
			change?.(fixture.state);
			const { json } = await query(["checkpoint"], fixture.env(fixture.a));
			expect(assessed(fixture).boundary).toEqual(json.boundary);
		});
	}

	test("assessCheckpoint, query checkpoint and the dry run classify changes alike", async () => {
		const fixture = certified(BOUNDARY, {
			"outside/work/todo/lock/STATUS.md": STATUS,
		});
		const { state } = fixture;
		fs.appendFileSync(join(state, "CURRENT.md"), "- **ASK** more\n");
		fs.mkdirSync(join(state, "work", "in-progress", "new"));
		fs.writeFileSync(
			join(state, "work", "in-progress", "new", "STATUS.md"),
			STATUS,
		);
		fs.rmSync(join(state, "MEMORY.md"));
		fs.rmSync(join(state, "work", "todo"), { recursive: true });
		fs.symlinkSync(
			join(fixture.base, "outside", "work", "todo"),
			join(state, "work", "todo"),
		);
		const { json } = await query(["checkpoint"], fixture.env(fixture.a));
		expect(json.changed).toContainEqual({
			path: "work/todo",
			kind: "unsafe",
			reason: "is a symlink",
		});
		expect(assessed(fixture).changed).toEqual(json.changed);
		const dry = await runTool(
			["checkpoint"],
			{ json: true },
			fixture.env(fixture.a),
		);
		expect(
			JSON.parse(dry.text).changed.map(
				({ path, kind }: { path: string; kind: string }) => ({ path, kind }),
			),
		).toEqual(
			json.changed.map(({ path, kind }: { path: string; kind: string }) => ({
				path,
				kind,
			})),
		);
	});

	test("assessCheckpoint and query checkpoint agree on a symlinked work", async () => {
		const fixture = certified(BOUNDARY, {
			"outside/work/todo/lock/STATUS.md": STATUS,
			"outside/work/todo/other/STATUS.md": STATUS,
			"outside/work/in-progress/evals/STATUS.md": STATUS,
		});
		fs.rmSync(join(fixture.state, "work"), { recursive: true });
		fs.symlinkSync(
			join(fixture.base, "outside", "work"),
			join(fixture.state, "work"),
		);
		const { json } = await query(["checkpoint"], fixture.env(fixture.a));
		expect(assessed(fixture).changed).toEqual(json.changed);
	});
});
