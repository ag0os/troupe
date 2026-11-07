import { afterEach, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dayOf } from "./dates";
import { renderTemplate, TEMPLATES } from "./guides";
import { appendEntries, runJournal } from "./journal";
import { withStateLock } from "./lock";
import { fakeClock, fakeToolEnv, makeTree } from "./test-support";
import { journalChain } from "./text";

const cleanups: Array<() => void> = [];
const lock = { pid: 101, timeoutMs: 1000, pollMs: 5 };
const start = new Date(2026, 9, 5, 12, 34);
const day = dayOf(start);

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(content: string | null = "# Journal\n") {
	const tree = makeTree(
		content === null ? { keep: "" } : { "journal.md": content },
	);
	cleanups.push(tree.cleanup);
	const time = fakeClock(start);
	return {
		state: tree.root,
		path: join(tree.root, "journal.md"),
		time,
		env: fakeToolEnv({
			home: tree.root,
			clock: time.clock,
			alivePids: [101, 102],
		}),
	};
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("a new day gets exactly one heading", async () => {
	const { state, path, env, time } = fixture();
	await appendEntries(state, ["first"], env, { lock });
	time.advance(86_400_000);
	const [entry] = await appendEntries(state, ["next day"], env, { lock });
	expect(entry?.headingAdded).toBe(true);
	expect(
		readFileSync(path, "utf8").match(
			new RegExp(`^## ${dayOf(time.clock())}$`, "gm"),
		),
	).toHaveLength(1);
});

test("two appends on the same day get one heading and end with newlines", async () => {
	const { state, path, env, time } = fixture();
	const [first] = await appendEntries(state, ["first"], env, { lock });
	expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
	time.advance(60_000);
	const [second] = await appendEntries(state, ["second"], env, { lock });
	expect(first?.headingAdded).toBe(true);
	expect(second?.headingAdded).toBe(false);
	expect(second?.time).toBe("12:35");
	expect(readFileSync(path, "utf8").match(/^## /gm)).toHaveLength(1);
	expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
});

test("reads another writer's line after waiting and does not duplicate its heading", async () => {
	const { state, path, env } = fixture();
	const entered = deferred();
	const release = deferred();
	const holder = withStateLock(
		state,
		env,
		async () => {
			entered.resolve();
			await release.promise;
		},
		{ ...lock, pid: 102 },
	);
	await entered.promise;
	const waiting = appendEntries(state, ["waiting writer"], env, { lock });
	try {
		appendFileSync(path, `\n## ${day}\n\n- 12:33 other writer\n`);
	} finally {
		release.resolve();
	}
	await holder;
	const [entry] = await waiting;
	expect(entry?.headingAdded).toBe(false);
	expect(readFileSync(path, "utf8")).toContain(
		"- 12:33 other writer\n- 12:34 waiting writer\n",
	);
	expect(readFileSync(path, "utf8").match(/^## /gm)).toHaveLength(1);
});

test("a stale lock reports unlock and leaves the journal unchanged", async () => {
	const { state, path, env } = fixture();
	mkdirSync(join(state, ".state.lock"));
	writeFileSync(
		join(state, ".state.lock/owner"),
		JSON.stringify({ pid: 999, started: start.toISOString() }),
	);
	const result = await runJournal(state, "blocked", env, false, { lock });
	expect(result.code).toBe(1);
	expect(result.stream).toBe("stderr");
	expect(result.text).toContain("shepherd tool unlock");
	expect(readFileSync(path, "utf8")).toBe("# Journal\n");
});

test("a legacy bullet dated today does not replace yesterday's heading", async () => {
	const { state, path, env } = fixture(
		`## 2026-10-04\n\n- ${day} 12:33 legacy\n`,
	);
	const [entry] = await appendEntries(state, ["today"], env, { lock });
	expect(entry?.headingAdded).toBe(true);
	expect(readFileSync(path, "utf8")).toContain(
		`\n## ${day}\n\n- 12:34 today\n`,
	);
});

test("dated headings inside fenced code are ignored", async () => {
	const { state, env } = fixture(`## ${day}\n\n~~~md\n## 2999-01-01\n~~~\n`);
	const [entry] = await appendEntries(state, ["today"], env, { lock });
	expect(entry?.headingAdded).toBe(false);
});

test("an interrupted last line is preserved with a newline before the entry", async () => {
	const { state, path, env } = fixture(`## ${day}\n\n- interrupted`);
	const [entry] = await appendEntries(state, ["clean"], env, { lock });
	expect(readFileSync(path, "utf8")).toBe(
		`## ${day}\n\n- interrupted\n- 12:34 clean\n`,
	);
	expect(entry?.line).toBe(4);
});

for (const dangling of [false, true]) {
	test(`a ${dangling ? "dangling " : ""}symlinked journal is refused`, async () => {
		const tree = makeTree(dangling ? {} : { target: "untouched" }, {
			symlinks: { "journal.md": "target" },
		});
		cleanups.push(tree.cleanup);
		const env = fakeToolEnv({ home: tree.root });
		const result = await runJournal(tree.root, "unsafe", env, false, { lock });
		expect(result).toMatchObject({
			code: 1,
			stream: "stderr",
			text: "journal.md is a symlink",
		});
		if (!dangling)
			expect(readFileSync(join(tree.root, "target"), "utf8")).toBe("untouched");
		else expect(existsSync(join(tree.root, "target"))).toBe(false);
	});
}

test("a nonregular journal is refused", async () => {
	const { state, path, env } = fixture(null);
	mkdirSync(path);
	expect(await runJournal(state, "unsafe", env, false, { lock })).toMatchObject(
		{ code: 1, stream: "stderr", text: "journal.md is not a regular file" },
	);
});

test("a missing journal is created from the rendered template", async () => {
	const { state, path, env } = fixture(null);
	await appendEntries(state, ["created"], env, { lock });
	const template = TEMPLATES.find(({ path }) => path === "journal.md");
	expect(template).toBeDefined();
	expect(
		readFileSync(path, "utf8").startsWith(
			renderTemplate(template?.text ?? "", env.now),
		),
	).toBe(true);
	expect(readFileSync(path, "utf8").endsWith("- 12:34 created\n")).toBe(true);
});

for (const prefix of ["08:15", "08:15:", "08:15 UTC:", "08:15 UTC"]) {
	test(`strips leading ${prefix} with the clock notice`, async () => {
		const { state, env } = fixture();
		const result = await runJournal(
			state,
			`${prefix}  hello\n\t world \n`,
			env,
			false,
			{ lock },
		);
		expect(result).toMatchObject({
			code: 0,
			stream: "stdout",
			notice: "time comes from the clock",
		});
		const entry = journalChain(state).entries.at(-1);
		expect(entry?.text).toBe("12:34 hello world");
		expect(result.text).toBe(
			`- 12:34 hello world\n${entry?.id} (line ${entry?.line})`,
		);
	});
}

for (const input of [" \n\t ", "08:15 UTC:"]) {
	test(`empty normalized input ${JSON.stringify(input)} writes nothing`, async () => {
		const { state, path, env } = fixture(null);
		expect(await runJournal(state, input, env, false, { lock })).toMatchObject({
			code: 1,
			text: "nothing to append",
			stream: "stderr",
		});
		expect(existsSync(path)).toBe(false);
		expect(existsSync(join(state, ".state.lock"))).toBe(false);
	});
}

test("JSON returns the six fields with chain text and the actual line", async () => {
	const { state, path, env } = fixture();
	const result = await runJournal(state, "hello\n world", env, true, { lock });
	const entry = journalChain(state).entries.at(-1);
	expect(JSON.parse(result.text)).toEqual({
		line: entry?.line,
		id: entry?.id,
		day,
		time: "12:34",
		text: "12:34 hello world",
		headingAdded: true,
	});
	expect(readFileSync(path, "utf8").split("\n")[(entry?.line ?? 0) - 1]).toBe(
		"- 12:34 hello world",
	);
	expect(result.notice).toBeUndefined();
});

test("three entries have distinct ids matching the archived and current chain", async () => {
	const { state, env, time } = fixture();
	mkdirSync(join(state, "archive/journal"), { recursive: true });
	writeFileSync(
		join(state, "archive/journal/2026-09.md"),
		"## 2026-09-30\n- 12:34 archived\n",
	);
	env.clock = () => {
		const now = time.clock();
		time.advance(60_000);
		return now;
	};
	const entries = await appendEntries(state, ["same", "same", "same"], env, {
		lock,
	});
	expect(new Set(entries.map(({ id }) => id)).size).toBe(3);
	expect(entries.map(({ id }) => id)).toEqual(
		journalChain(state)
			.entries.slice(1)
			.map(({ id }) => id),
	);
	expect(entries.map(({ time }) => time)).toEqual(["12:35", "12:36", "12:37"]);
});

test("locked true appends while the caller holds the lock", async () => {
	const { state, env } = fixture();
	const entries = await withStateLock(
		state,
		env,
		() =>
			appendEntries(state, ["inside"], env, {
				locked: true,
				lock: { ...lock, timeoutMs: 0 },
			}),
		lock,
	);
	expect(entries[0]?.text).toBe("12:34 inside");
});

test("local time crosses midnight while waiting for the lock in a TZ child", async () => {
	const { state } = fixture();
	const script = `
		import { appendEntries } from ${JSON.stringify(join(import.meta.dir, "journal.ts"))};
		import { withStateLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};
		import { fakeClock, fakeToolEnv } from ${JSON.stringify(join(import.meta.dir, "test-support.ts"))};
		const state = process.argv[1];
		const time = fakeClock("2026-10-06T02:59:00Z");
		const env = fakeToolEnv({ home: state, clock: time.clock, alivePids: [101, 102] });
		let release;
		let entered;
		const ready = new Promise(done => { entered = done; });
		const hold = new Promise(done => { release = done; });
		const holder = withStateLock(state, env, async () => { entered(); await hold; }, { pid: 102 });
		await ready;
		const waiting = appendEntries(state, ["after midnight"], env, { lock: { pid: 101, pollMs: 5 } });
		time.advance(120000);
		release();
		await holder;
		console.log(JSON.stringify(await waiting));
	`;
	const child = Bun.spawn([process.execPath, "--eval", script, state], {
		env: { ...process.env, TZ: "America/Argentina/Buenos_Aires" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = await new Response(child.stdout).text();
	const errors = await new Response(child.stderr).text();
	expect(await child.exited).toBe(0);
	expect(errors).toBe("");
	expect(JSON.parse(output)[0]).toMatchObject({
		day: "2026-10-06",
		time: "00:01",
		text: "00:01 after midnight",
		headingAdded: true,
	});
});

test("a locked batch refuses an unclosed fence before appending any entry", async () => {
	const before = "## 2026-10-05\n- 12:00 visible\n````\n```\noutput\n";
	const { state, path, env } = fixture(before);
	await expect(
		appendEntries(state, ["first", "second"], env, { locked: true }),
	).rejects.toThrow(
		"journal.md fence opened at line 3 is never closed; close or remove it",
	);
	expect(readFileSync(path, "utf8")).toBe(before);
});
