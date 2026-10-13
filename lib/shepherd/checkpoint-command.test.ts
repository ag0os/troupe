import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { checkWorkspace } from "./check";
import { assessCheckpoint, readCheckpoint } from "./checkpoint";
import { type CheckpointHooks, runCheckpoint } from "./checkpoint-command";
import {
	captureState,
	commitCheckpoint,
	nextCheckpoint,
} from "./checkpoint-write";
import { loadConfig } from "./config";
import { contentHash } from "./current-prev";
import { appendEntries } from "./journal";
import { runStart } from "./start";
import { fakeClock, fakeToolEnv, makeTree } from "./test-support";
import { journalChain } from "./text";
import { discoverTree } from "./tree";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
const current =
	"# Current\nPreserve this important line\nRetain another important fact\n";
const journal = "## 2026-10-06\n- 09:00 A\n## 2026-10-07\n- 10:00 B\n";
function fixture(files: Record<string, string> = {}) {
	const tree = makeTree(
		Object.fromEntries(
			Object.entries({
				"CURRENT.md": current,
				"journal.md": journal,
				...files,
			}).map(([path, text]) => [`.shepherd/${path}`, text]),
		),
	);
	cleanups.push(tree.cleanup);
	const workspace = {
		name: "test",
		dir: tree.root,
		state: join(tree.root, ".shepherd"),
	};
	const clock = fakeClock("2026-10-08T13:52:13Z");
	const env = fakeToolEnv({
		home: tree.root,
		clock: clock.clock,
		alivePids: [process.pid],
	});
	const put = (path: string, text: string) => {
		const full = join(workspace.state, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	};
	const read = (path: string) =>
		readFileSync(join(workspace.state, path), "utf8");
	const remove = (path: string) =>
		rmSync(join(workspace.state, path), { recursive: true, force: true });
	const dry = (json = false) =>
		runCheckpoint(workspace, env, { apply: false, json });
	const apply = (
		token = captureState(workspace, env).token,
		hooks: CheckpointHooks = {},
		acceptDropped?: string,
		json = false,
	) =>
		runCheckpoint(
			workspace,
			env,
			{ apply: true, token, json, session: "test-session", acceptDropped },
			hooks,
		);
	const assess = () => assessCheckpoint(workspace, env);
	const checkpoint = () => {
		const value = readCheckpoint(workspace.state);
		if (value.status !== "ok") throw new Error("no checkpoint");
		return value.checkpoint;
	};
	return { workspace, env, put, read, remove, dry, apply, assess, checkpoint };
}

for (const dropped of ["none", "accounted", "unaccounted"] as const)
	test(`dry run prints an apply command requiring placeholder replacement for ${dropped} dropped lines`, async () => {
		const f = fixture();
		await f.apply();
		if (dropped !== "none") {
			f.put("CURRENT.md", "# Current\nRetain another important fact\n");
			if (dropped === "accounted")
				f.put("memories/copy.md", "Preserve this important line\n");
		}
		const dry = await f.dry();
		const facts = JSON.parse((await f.dry(true)).text);
		const command = dry.text.split("then: ").at(-1) ?? "";
		expect(dry.code).toBe(0);
		expect(facts.apply).toBe(command);
		expect(command).toBe(
			`shepherd tool checkpoint --apply --token ${facts.token} --session <your session name>${dropped === "unaccounted" ? ' --accept-dropped "<why each line may go>"' : ""}`,
		);
		const shell = spawnSync("bash", ["-n", "-c", command], {
			encoding: "utf8",
		});
		if (shell.status === 0) {
			const bin = join(f.workspace.dir, "bin");
			mkdirSync(bin);
			const stub = join(bin, "shepherd");
			writeFileSync(stub, "#!/bin/sh\necho shepherd-stub-ran\n");
			fs.chmodSync(stub, 0o755);
			const pasted = spawnSync("bash", ["-c", command], {
				cwd: f.workspace.dir,
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
				encoding: "utf8",
			});
			expect(pasted.status).not.toBe(0);
			expect(pasted.stdout).not.toContain("shepherd-stub-ran");
		} else {
			expect(shell.stderr).toContain("syntax error");
		}
	});

test("throw after the second append write reports one confirmed line and an uncertain second", async () => {
	const f = fixture();
	await f.apply();
	const old = f.read("checkpoint.json");
	f.put("CURRENT.md", "# Current\n");
	const append = fs.appendFileSync;
	let writes = 0;
	const spy = spyOn(fs, "appendFileSync").mockImplementation(((
		...args: Parameters<typeof fs.appendFileSync>
	) => {
		append(...args);
		if (String(args[0]) === join(f.workspace.state, "journal.md")) {
			writes++;
			if (writes === 2) throw new Error("forced error after write");
		}
	}) as typeof fs.appendFileSync);
	try {
		const result = await f.apply(undefined, {}, "approved");
		expect(result).toEqual({
			code: 1,
			stream: "stderr",
			text: "journal changed during the apply; 1 accepted lines appended; the append of line 2 failed and may or may not be in the journal: read it. The accepted lines already appended stay. Run the dry run again. Re-running --accept-dropped would journal them again. Restore or move the line instead, or accept it again knowing it will be journaled twice.\nforced error after write",
		});
		expect(
			journalChain(f.workspace.state).entries.filter((entry) =>
				entry.text.includes("dropped from CURRENT (approved):"),
			),
		).toHaveLength(2);
		expect(f.read("checkpoint.json")).toBe(old);
	} finally {
		spy.mockRestore();
	}
});

for (const [name, edit] of [
	[
		"journal append",
		(f: ReturnType<typeof fixture>) =>
			f.put("journal.md", `${journal}- 11:00 C\n`),
	],
	[
		"STATUS edit",
		(f: ReturnType<typeof fixture>) =>
			f.put("work/todo/item/STATUS.md", "edited"),
	],
	[
		"STATUS appears",
		(f: ReturnType<typeof fixture>) =>
			f.put("work/in-progress/new/STATUS.md", "new"),
	],
] as const)
	test(`old token refuses after ${name} without writing`, async () => {
		const f = fixture({ "work/todo/item/STATUS.md": "original" });
		const token = JSON.parse((await f.dry(true)).text).token;
		edit(f);
		const result = await f.apply(token);
		expect(result).toEqual({
			code: 1,
			stream: "stderr",
			text: "state changed since the dry run; run the dry run again",
		});
		expect(existsSync(join(f.workspace.state, "checkpoint.json"))).toBe(false);
		expect(existsSync(join(f.workspace.state, "checkpoints"))).toBe(false);
	});

test("newer revision is checked before state and names its writer and time", async () => {
	const f = fixture();
	await f.apply();
	const old = f.read("checkpoint.json");
	const token = JSON.parse((await f.dry(true)).text).token;
	const result = await f.apply(token, {
		afterLock: () => {
			const held = captureState(f.workspace, f.env);
			commitCheckpoint(
				f.workspace.state,
				held,
				nextCheckpoint(held, {
					written: "2026-10-08T10:52:13-03:00",
					session: "second-writer",
				}),
			);
		},
	});
	expect(result.code).toBe(1);
	expect(result.text).toBe(
		"checkpoint advanced to revision 2 by second-writer at 2026-10-08 10:52; run `shepherd tool start` again",
	);
	expect(f.read("checkpoint.json")).not.toBe(old);
	expect(f.checkpoint().revision).toBe(2);
});

test("writer waiting for apply lock lands after certification and remains unreviewed", async () => {
	const f = fixture();
	let writer: ReturnType<typeof appendEntries> | undefined;
	let finished = false;
	const result = await f.apply(undefined, {
		afterLock: async () => {
			writer = appendEntries(f.workspace.state, ["later writer"], f.env, {
				lock: { pollMs: 1 },
			});
			void writer.then(() => {
				finished = true;
			});
			await new Promise((done) => setTimeout(done, 10));
			expect(finished).toBe(false);
		},
		afterValidate: () => {
			expect(finished).toBe(false);
		},
	});
	expect(result.code).toBe(0);
	await writer;
	expect(f.assess().unreviewed.entries.map((entry) => entry.text)).toEqual([
		expect.stringContaining("later writer"),
	]);
});

test("CURRENT edit after validation commits held snapshot and hash and reports changed", async () => {
	const f = fixture();
	const result = await f.apply(undefined, {
		afterValidate: () => f.put("CURRENT.md", "disk edit"),
	});
	expect(result.code).toBe(0);
	const checkpoint = f.checkpoint();
	expect(f.read(checkpoint.snapshot)).toBe(current);
	expect(checkpoint.files["CURRENT.md"]).toBe(contentHash(current));
	expect(f.assess().changed).toContainEqual({
		path: "CURRENT.md",
		kind: "changed",
	});
});

for (const intruder of ["between", "after", "held edit"] as const)
	test(`${intruder} during accepted appends refuses and keeps all appends`, async () => {
		const f = fixture();
		await f.apply();
		const old = f.read("checkpoint.json");
		f.put("CURRENT.md", "# Current\n");
		const result = await f.apply(
			undefined,
			{
				afterAppend: async (index) => {
					if (
						(intruder === "between" && index === 0) ||
						(intruder === "after" && index === 1)
					)
						await appendEntries(f.workspace.state, ["intruder"], f.env, {
							locked: true,
						});
					if (intruder === "held edit" && index === 0)
						f.put(
							"journal.md",
							f.read("journal.md").replace("09:00 A", "09:00 edited A"),
						);
				},
			},
			"approved",
		);
		expect(result).toEqual({
			code: 1,
			stream: "stderr",
			text: "journal changed during the apply; your 2 accepted lines are appended and stay. Run the dry run again. Re-running --accept-dropped would journal them again. Restore or move the line instead, or accept it again knowing it will be journaled twice.",
		});
		expect(f.read("checkpoint.json")).toBe(old);
		const texts = journalChain(f.workspace.state).entries.map(
			(entry) => entry.text,
		);
		expect(
			texts.filter((text) => text.includes("dropped from CURRENT (approved):")),
		).toHaveLength(2);
		const dry = await f.dry();
		expect(dry.text).toContain(
			"dropped from CURRENT (approved): Preserve this important line",
		);
		expect(dry.text).toContain(
			"dropped from CURRENT (approved): Retain another important fact",
		);
		if (intruder !== "held edit") {
			expect(dry.text).toContain("intruder");
			expect(JSON.parse((await f.dry(true)).text).range).toHaveLength(3);
		}
	});

test("destination losing its exact copy changes token even with accept-dropped", async () => {
	const f = fixture({ "memories/copy.md": "Preserve this important line\n" });
	await f.apply();
	f.put("CURRENT.md", "# Current\nRetain another important fact\n");
	const token = JSON.parse((await f.dry(true)).text).token;
	const old = f.read("checkpoint.json");
	f.put("memories/copy.md", "lost copy");
	const result = await f.apply(token, {}, "approved");
	expect(result.text).toBe(
		"state changed since the dry run; run the dry run again",
	);
	expect(result.code).toBe(1);
	expect(f.read("checkpoint.json")).toBe(old);
	expect(f.read("journal.md")).toBe(journal);
});

test("removed exempt item changes token even with accept-dropped", async () => {
	const f = fixture({
		"CURRENT.md": "## Items\n- [item](work/done/item/STATUS.md)\n",
		"work/done/item/STATUS.md": "---\nstate: done\n---\n## Outcome\nFinished\n",
	});
	await f.apply();
	f.put("CURRENT.md", "# Current\n");
	const held = captureState(f.workspace, f.env);
	expect(held.dropped?.candidates[0]?.disposition.kind).toBe("exempt");
	const token = held.token;
	const old = f.read("checkpoint.json");
	f.remove("work/done/item");
	const changed = captureState(f.workspace, f.env);
	expect(changed.files).toEqual(held.files);
	expect(changed.dropped?.candidates[0]?.disposition.kind).toBe("unaccounted");
	const result = await f.apply(token, {}, "approved");
	expect(result.code).toBe(1);
	expect(result.text).toBe(
		"state changed since the dry run; run the dry run again",
	);
	expect(f.read("checkpoint.json")).toBe(old);
	expect(f.read("journal.md")).toBe(journal);
});

test("accept-dropped appends one entry per held line and advances to the last", async () => {
	const f = fixture();
	await f.apply();
	f.put("CURRENT.md", "# Current\n");
	const token = JSON.parse((await f.dry(true)).text).token;
	const result = await f.apply(token, {}, "user approved", true);
	expect(result.code).toBe(0);
	const texts = journalChain(f.workspace.state).entries;
	expect(
		texts.slice(2).map((entry) => entry.text.replace(/^\d{2}:\d{2} /, "")),
	).toEqual([
		"dropped from CURRENT (user approved): Preserve this important line",
		"dropped from CURRENT (user approved): Retain another important fact",
	]);
	expect(JSON.parse(result.text)).toMatchObject({
		applied: true,
		revision: 2,
		journal: { to: texts.at(-1)?.id, count: 4 },
	});
	expect(f.assess().verdict).toBe("CLEAN");
});

test("unaccounted lines without acceptance refuse and list every line", async () => {
	const f = fixture();
	await f.apply();
	f.put("CURRENT.md", "# Current\n");
	const old = f.read("checkpoint.json");
	const result = await f.apply();
	expect(result.code).toBe(1);
	expect(result.text).toContain("  - Preserve this important line");
	expect(result.text).toContain("  - Retain another important fact");
	expect(f.read("checkpoint.json")).toBe(old);
	expect(f.read("journal.md")).toBe(journal);
});

test("evidence edited after validation records held hash and next assessment loses evidence", async () => {
	const copy = "Preserve this important line\n";
	const f = fixture({ "memories/copy.md": copy });
	await f.apply();
	f.put("CURRENT.md", "# Current\nRetain another important fact\n");
	const result = await f.apply(undefined, {
		afterValidate: () => f.put("memories/copy.md", "lost copy"),
	});
	expect(result.code).toBe(0);
	expect(f.checkpoint().evidence).toEqual({
		"memories/copy.md": contentHash(copy),
	});
	expect(f.assess().evidenceLost).toEqual([
		{ path: "memories/copy.md", kind: "changed" },
	]);
	expect(f.assess().verdict).toBe("RECONCILE");
});

test("dry run includes every archived range entry and whole changed or appeared file", async () => {
	const f = fixture({
		"archive/journal/1.md": "## 2026-10-05\n- archived full entry\n",
		"journal.md": "## 2026-10-06\n- live full entry\n",
		"work/todo/item/STATUS.md": "old status\n",
	});
	const dry = await f.dry();
	expect(dry.code).toBe(0);
	expect(dry.text).toContain("  - archive/journal/1.md:2 archived full entry");
	expect(dry.text).toContain("  - 2 live full entry");
	expect(dry.text).toContain(`--- CURRENT.md ---\n${current.trimEnd()}`);
	expect(existsSync(join(f.workspace.state, ".state.lock"))).toBe(false);
	await f.apply();
	f.put("CURRENT.md", `${current}New final line\n`);
	f.put("work/todo/item/STATUS.md", "changed status\ncomplete body\n");
	f.put(
		"work/in-progress/new/STATUS.md",
		"appeared status\ncomplete new body\n",
	);
	const changed = await f.dry();
	expect(changed.text).toContain("CURRENT.md (changed, 13 words)");
	expect(changed.text).toContain("work/todo/item/STATUS.md (changed, 4 words)");
	expect(changed.text).toContain(
		"work/in-progress/new/STATUS.md (appeared, 5 words)",
	);
	expect(changed.text).toContain(
		`--- CURRENT.md ---\n${current}New final line`,
	);
	expect(changed.text).toContain(
		"--- work/todo/item/STATUS.md ---\nchanged status\ncomplete body",
	);
	expect(changed.text).toContain(
		"--- work/in-progress/new/STATUS.md ---\nappeared status\ncomplete new body",
	);
	const facts = JSON.parse((await f.dry(true)).text);
	expect(facts.changed).toContainEqual({
		path: "CURRENT.md",
		kind: "changed",
		words: 13,
		text: `${current}New final line\n`,
	});
});

test("dry run names removed paths and prints dropped lines with nearest suggestion", async () => {
	const f = fixture({
		"work/todo/item/STATUS.md": "status",
		"memories/near.md": "Preserve this important changed line\n",
	});
	await f.apply();
	f.remove("work/todo/item");
	f.put("CURRENT.md", "# Current\nRetain another important fact\n");
	const result = await f.dry();
	expect(result.text).toContain("work/todo/item/STATUS.md (removed, 0 words)");
	expect(result.text).toContain(
		"dropped from CURRENT, NOT accounted for: 1\n  - Preserve this important line\n    nearest: memories/near.md:1",
	);
});

test("orphan range refuses dry run and apply and withholds token", async () => {
	const f = fixture({ "journal.md": "- orphan\n" });
	const token = captureState(f.workspace, f.env).token;
	const dry = await f.dry();
	expect(dry.code).toBe(1);
	expect(dry.text).toContain(
		"1 entries without a heading at journal.md:1 sit inside the range; put a `## YYYY-MM-DD` heading",
	);
	expect(dry.text).not.toContain("token:");
	const json = JSON.parse((await f.dry(true)).text);
	expect(json.refused).toContain("entries without a heading");
	expect(json.token).toBeUndefined();
	const result = await f.apply(token);
	expect(result.code).toBe(1);
	expect(result.text).toBe(json.refused);
	expect(existsSync(join(f.workspace.state, "checkpoint.json"))).toBe(false);
});

for (const options of [
	{ apply: true, json: false },
	{ apply: false, token: "r0-000000000000", json: false },
	{ apply: true, token: "bad", json: false },
])
	test(`usage refuses ${JSON.stringify(options)}`, async () => {
		const f = fixture();
		const result = await runCheckpoint(f.workspace, f.env, options);
		expect(result.code).toBe(2);
		expect(result.stream).toBe("stderr");
		expect(result.text).toStartWith("usage:");
		expect(existsSync(join(f.workspace.state, ".state.lock"))).toBe(false);
	});

test("stale lock refuses apply with unlock instruction", async () => {
	const f = fixture({
		".state.lock/owner": JSON.stringify({
			pid: 987654,
			started: "2026-10-08T00:00:00Z",
		}),
	});
	const result = await f.apply();
	expect(result.code).toBe(1);
	expect(result.text).toContain(
		"stale lock `.shepherd/.state.lock` left by pid 987654; run `shepherd tool unlock`",
	);
	expect((await f.dry()).text).toContain("lock: stale, left by pid 987654");
});

test("missing CURRENT refuses apply", async () => {
	const f = fixture();
	f.remove("CURRENT.md");
	expect(await f.apply()).toEqual({
		code: 1,
		text: "nothing to certify without CURRENT.md",
		stream: "stderr",
	});
});

test("symlinked checkpoint refuses without replacing the target", async () => {
	const f = fixture();
	symlinkSync("CURRENT.md", join(f.workspace.state, "checkpoint.json"));
	const result = await f.apply();
	expect(result.code).toBe(1);
	expect(result.text).toBe("checkpoint.json is a symlink");
	expect(f.read("CURRENT.md")).toBe(current);
});

test("dry run token applies and assessment is CLEAN", async () => {
	const f = fixture();
	const dry = await f.dry();
	const token = dry.text.match(/^token: (.+)$/m)?.[1];
	expect(token).toMatch(/^r0-[a-f0-9]{12}$/);
	expect(dry.text).toStartWith(
		"checkpoint: no checkpoint -> would write revision 1\njournal: 2 entries in the fallback range, journal.md:2 to 4 (all shown below)",
	);
	expect(dry.text).toEndWith(
		`Read every entry and changed file above, then: shepherd tool checkpoint --apply --token ${token} --session <your session name>`,
	);
	expect((await f.apply(token)).code).toBe(0);
	expect(f.assess().verdict).toBe("CLEAN");
	expect(f.checkpoint().revision).toBe(1);
	expect((await f.dry()).text).toContain(
		"checkpoint: revision 1 by test-session,",
	);
	const facts = JSON.parse((await f.dry(true)).text);
	expect(facts).toMatchObject({
		revision: 1,
		nextRevision: 2,
		range: [],
		uncertified: 0,
		changed: [],
		lock: "free",
	});
});

test("written uses the clock in local time with offset in a child process", async () => {
	const f = fixture();
	const script = `import { runCheckpoint } from ${JSON.stringify(join(import.meta.dir, "checkpoint-command.ts"))};
import { captureState } from ${JSON.stringify(join(import.meta.dir, "checkpoint-write.ts"))};
import { fakeToolEnv } from ${JSON.stringify(join(import.meta.dir, "test-support.ts"))};
const workspace = ${JSON.stringify(f.workspace)};
const env = fakeToolEnv({ home: workspace.dir, clock: () => new Date("2026-10-08T13:52:13Z") });
const token = captureState(workspace, env).token;
console.log((await runCheckpoint(workspace, env, { apply: true, token, json: true })).text);`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env: { ...process.env, TZ: "America/Argentina/Buenos_Aires" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = await new Response(child.stdout).text();
	expect(await child.exited).toBe(0);
	expect(JSON.parse(output).written).toBe("2026-10-08T10:52:13-03:00");
});

test("refused range omits prior certified history and retains the uncertified count", async () => {
	const f = fixture();
	await f.apply();
	f.put("archive/journal/1.md", journal);
	f.put("journal.md", "- orphan\n## 2026-10-08\n- new entry\n");
	const result = await f.dry(true);
	expect(result.code).toBe(1);
	const facts = JSON.parse(result.text);
	expect(facts.range.map((entry: { text: string }) => entry.text)).toEqual([
		"orphan",
		"new entry",
	]);
	expect(facts.uncertified).toBe(0);
});

test("invalid checkpoint dry run resets to revision one", async () => {
	const f = fixture({ "checkpoint.json": "invalid json" });
	const dry = await f.dry();
	expect(dry.code).toBe(0);
	expect(dry.text).toContain("checkpoint: invalid checkpoint:");
	expect(dry.text.split("\n")[0]).toEndWith("-> would write revision 1");
	expect((await f.apply()).code).toBe(0);
	expect(f.checkpoint().revision).toBe(1);
	expect(f.assess().verdict).toBe("CLEAN");
});

test("rewritten accepted line between append and readback refuses instead of certifying intruder", async () => {
	const f = fixture();
	await f.apply();
	const old = f.read("checkpoint.json");
	f.put("CURRENT.md", "# Current\nRetain another important fact\n");
	const append = fs.appendFileSync;
	const spy = spyOn(fs, "appendFileSync").mockImplementation(((
		...args: Parameters<typeof fs.appendFileSync>
	) => {
		append(...args);
		if (String(args[0]) === join(f.workspace.state, "journal.md"))
			f.put(
				"journal.md",
				f
					.read("journal.md")
					.replace(
						/dropped from CURRENT \(approved\): Preserve this important line/,
						"intruder rewrite",
					),
			);
	}) as typeof fs.appendFileSync);
	try {
		const result = await f.apply(undefined, {}, "approved");
		expect(result.code).toBe(1);
		expect(result.text).toStartWith(
			"journal changed during the apply; your 1 accepted lines are appended and stay. Run the dry run again",
		);
		expect(f.read("checkpoint.json")).toBe(old);
		expect(f.read("journal.md")).toContain("intruder rewrite");
		expect(f.assess().verdict).toBe("RECONCILE");
	} finally {
		spy.mockRestore();
	}
});

test("empty-range token refuses journal deletion without writing", async () => {
	const f = fixture();
	await f.apply();
	const old = f.read("checkpoint.json");
	const dry = JSON.parse((await f.dry(true)).text);
	expect(dry.range).toEqual([]);
	f.remove("journal.md");
	const result = await f.apply(dry.token);
	expect(result).toEqual({
		code: 1,
		stream: "stderr",
		text: "state changed since the dry run; run the dry run again",
	});
	expect(f.read("checkpoint.json")).toBe(old);
});

test("append error after first accepted line refuses with error and keeps the append", async () => {
	const f = fixture();
	await f.apply();
	const old = f.read("checkpoint.json");
	f.put("CURRENT.md", "# Current\n");
	const result = await f.apply(
		undefined,
		{
			afterAppend: (index) => {
				if (index !== 0) return;
				f.put("saved-journal.md", f.read("journal.md"));
				f.remove("journal.md");
				symlinkSync("saved-journal.md", join(f.workspace.state, "journal.md"));
			},
		},
		"approved",
	);
	expect(result.code).toBe(1);
	expect(result.text).toStartWith(
		"journal changed during the apply; 1 accepted lines appended; the append of line 2 failed and may or may not be in the journal: read it. The accepted lines already appended stay. Run the dry run again",
	);
	expect(result.text).toContain(
		"Re-running --accept-dropped would journal them again",
	);
	expect(result.text).toContain("journal.md is a symlink");
	expect(f.read("saved-journal.md")).toContain(
		"dropped from CURRENT (approved): Preserve this important line",
	);
	expect(f.read("checkpoint.json")).toBe(old);
});

test("checkpoint made invalid after dry run names its reason instead of revision zero", async () => {
	const f = fixture();
	await f.apply();
	const dry = JSON.parse((await f.dry(true)).text);
	f.put("checkpoint.json", "broken");
	const reason = readCheckpoint(f.workspace.state);
	const result = await f.apply(dry.token);
	expect(result.code).toBe(1);
	expect(result.text).toBe(
		`checkpoint is now invalid: ${reason.status === "invalid" ? reason.reason : ""}; run the dry run again`,
	);
	expect(result.text).not.toContain("revision 0");
	expect(f.read("checkpoint.json")).toBe("broken");
});

for (const json of [false, true])
	test(`successful commit with lock release failure retains written result (${json ? "JSON" : "text"})`, async () => {
		const f = fixture();
		const rename = fs.renameSync;
		let spy: ReturnType<typeof spyOn<typeof fs, "renameSync">> | undefined;
		try {
			const result = await f.apply(
				undefined,
				{
					commit: {
						afterRename: () => {
							spy = spyOn(fs, "renameSync").mockImplementation(((
								...args: Parameters<typeof fs.renameSync>
							) => {
								if (String(args[0]) === join(f.workspace.state, ".state.lock"))
									throw new Error("release blocked");
								return rename(...args);
							}) as typeof fs.renameSync);
						},
					},
				},
				undefined,
				json,
			);
			expect(result.code).toBe(1);
			expect(result.text).toContain("lock release failed");
			if (json)
				expect(JSON.parse(result.text)).toMatchObject({
					applied: true,
					revision: 1,
					journal: { to: f.checkpoint().journal.to },
					error: "lock release failed",
				});
			else {
				expect(result.text).toContain("checkpoint: wrote revision 1");
				expect(result.text).toContain('new boundary: 4 "10:00 B"');
			}
			expect(f.checkpoint().revision).toBe(1);
		} finally {
			spy?.mockRestore();
		}
	});

for (const flag of ["session", "acceptDropped"] as const)
	for (const value of [
		"",
		"   ",
		"YOUR_SESSION_NAME",
		"REASON",
		"<replace me>",
		" <why each line may go> ",
	])
		test(`placeholder ${flag} ${JSON.stringify(value)} refuses before lock`, async () => {
			const f = fixture();
			let locked = false;
			const result = await runCheckpoint(
				f.workspace,
				f.env,
				{
					apply: true,
					token: captureState(f.workspace, f.env).token,
					json: false,
					[flag]: value,
				},
				{
					afterLock: () => {
						locked = true;
					},
				},
			);
			expect(result.code).toBe(1);
			expect(result.text).toBe(
				`replace the placeholder in --${flag === "session" ? "session" : "accept-dropped"} with a real value`,
			);
			expect(locked).toBe(false);
		});

test("dry run distinguishes fallback and boundary ranges", async () => {
	const f = fixture();
	expect((await f.dry()).text).toContain(
		"journal: 2 entries in the fallback range",
	);
	expect((await f.apply()).code).toBe(0);
	expect((await f.dry()).text).toContain(
		"journal: 0 entries since the boundary",
	);
	f.put("journal.md", "## 2026-10-08\n- replaced history\n");
	expect((await f.dry()).text).toContain(
		"journal: 1 entries in the fallback range",
	);
});

for (const loss of [
	"empty",
	"missing",
	"unsafe",
	"moved",
	"edited",
	"legacy",
] as const)
	test(`lost evidence ${loss} is carried into the next apply`, async () => {
		const warning = "- Warning: never paste the deploy key into a brief.";
		const f = fixture({ "CURRENT.md": `# Current\n${warning}\n` });
		expect((await f.apply()).code).toBe(0);
		f.put("memories/backup.md", `${warning}\n`);
		f.put("CURRENT.md", "# Current\n");
		expect((await f.apply()).code).toBe(0);
		expect(f.checkpoint().evidenceLines).toEqual({
			"memories/backup.md": [warning],
		});
		if (loss === "legacy") {
			const checkpoint = f.checkpoint();
			delete checkpoint.evidenceLines;
			f.put("checkpoint.json", JSON.stringify(checkpoint));
		}
		f.put(
			"memories/backup.md",
			loss === "edited" ? `${warning}\nOther text\n` : "",
		);
		if (loss === "missing" || loss === "unsafe") f.remove("memories/backup.md");
		if (loss === "unsafe")
			symlinkSync(
				"../CURRENT.md",
				join(f.workspace.state, "memories/backup.md"),
			);
		if (loss === "moved") f.put("memories/other.md", `${warning}\n`);
		const accounted = loss === "moved" || loss === "edited";
		const text =
			loss === "legacy"
				? "memories/backup.md held the copy of a dropped CURRENT line; its text was not recorded"
				: warning;
		const assessment = f.assess();
		expect(assessment.evidenceLost).toHaveLength(1);
		const dry = await f.dry();
		const facts = JSON.parse((await f.dry(true)).text);
		const lines = accounted
			? facts.dropped.accounted
			: facts.dropped.unaccounted;
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			line: 0,
			text,
			carriedFrom: "memories/backup.md",
		});
		if (accounted) {
			expect((await f.apply()).code).toBe(0);
			const holder =
				loss === "moved" ? "memories/other.md" : "memories/backup.md";
			expect(f.checkpoint().evidenceLines).toEqual({ [holder]: [warning] });
			expect(Object.keys(f.checkpoint().evidence)).toEqual([holder]);
		} else {
			expect(dry.text).toContain(
				`NOT accounted for: 1\n  - ${text} (copy was in memories/backup.md)`,
			);
			expect(assessment.reasons).toContain(
				"1 CURRENT lines dropped and not accounted for",
			);
			const start = runStart(
				f.workspace,
				discoverTree(f.workspace.dir),
				f.env,
				loadConfig({
					home: f.workspace.dir,
					env: {},
					workspaceChain: [f.workspace.dir],
				}),
				{ json: false, today: f.env.now },
			);
			expect(start.code).toBe(0);
			expect(start.text).toContain(
				"1 CURRENT lines dropped and not accounted for",
			);
			expect(start.text).toContain(text);
			expect((await f.apply()).code).toBe(1);
			expect((await f.apply(undefined, {}, "retired by owner")).code).toBe(0);
			expect(f.read("journal.md")).toContain(
				`dropped from CURRENT (retired by owner): ${text}`,
			);
			expect(f.checkpoint().evidenceLines).toEqual({});
		}
	});

test("unchanged evidence becomes ordinary content after one apply", async () => {
	const f = fixture();
	await f.apply();
	f.put("memories/copy.md", "Preserve this important line\n");
	f.put("CURRENT.md", "# Current\nRetain another important fact\n");
	await f.apply();
	expect(JSON.parse((await f.dry(true)).text).dropped.candidates).toEqual([]);
	await f.apply();
	expect(f.checkpoint().evidence).toEqual({});
	expect(f.checkpoint().evidenceLines).toEqual({});
});

test("lost snapshot keeps lost evidence text through dry run, start, check and apply", async () => {
	const warning = "- Warning: never paste the deploy key into a brief.";
	const f = fixture({ "CURRENT.md": `# Current\n${warning}\n` });
	expect((await f.apply()).code).toBe(0);
	f.put("memories/a.md", `${warning}\n`);
	f.put("CURRENT.md", "# Current\n");
	expect((await f.apply()).code).toBe(0);
	expect(f.checkpoint().evidenceLines).toEqual({ "memories/a.md": [warning] });
	f.put("memories/a.md", "");
	f.remove("checkpoints");
	const dry = await f.dry();
	expect(dry.text).toContain(
		"invalid checkpoint: snapshot missing or does not match",
	);
	expect(dry.text).toContain(
		`NOT accounted for: 1\n  - ${warning} (copy was in memories/a.md)`,
	);
	const tree = discoverTree(f.workspace.dir);
	const config = loadConfig({
		home: f.workspace.dir,
		env: {},
		workspaceChain: [f.workspace.dir],
	});
	const start = runStart(f.workspace, tree, f.env, config, {
		json: false,
		today: f.env.now,
	});
	expect(start.text).toContain("snapshot missing or does not match");
	expect(start.text).toContain("1 CURRENT lines dropped and not accounted for");
	expect(start.text).toContain(warning);
	const findings = checkWorkspace(f.workspace, tree, config, f.env.now);
	expect(
		findings.some(
			({ code, message }) =>
				code === "checkpoint-invalid" && message.includes("snapshot missing"),
		),
	).toBe(true);
	expect(findings.some(({ code }) => code === "evidence-lost")).toBe(true);
	expect(
		findings.some(
			({ code, message }) =>
				code === "current-line-dropped" && message.includes(warning),
		),
	).toBe(true);
	expect((await f.apply()).code).toBe(1);
	expect((await f.apply(undefined, {}, "retired by owner")).code).toBe(0);
	expect(f.read("journal.md")).toContain(
		`dropped from CURRENT (retired by owner): ${warning}`,
	);
});
