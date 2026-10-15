import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join, sep } from "node:path";
import type { ToolEnv } from "./sessions";
import { fakeToolEnv, type MakeTreeOptions, makeTree } from "./test-support";
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
});
