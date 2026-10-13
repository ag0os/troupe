import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { checkWorkspace } from "./check";
import { runCheckpoint } from "./checkpoint-command";
import { captureState } from "./checkpoint-write";
import { loadConfig } from "./config";
import { contextTiers } from "./context";
import { droppedLines } from "./current-prev";
import { fakeToolEnv, makeTree } from "./test-support";
import { runTool } from "./tool";
import { discoverTree } from "./tree";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(journal = "## 2026-09-30\n- 09:00 certified\n") {
	const f = makeTree({
		".shepherd/charter.md": "Charter\n",
		".shepherd/CURRENT.md": "# Current\nKeep this fact\n",
		".shepherd/journal.md": journal,
	});
	cleanups.push(f.cleanup);
	const workspace = discoverTree(f.root).root;
	const env = fakeToolEnv({ cwd: f.root, home: f.root });
	const path = join(workspace.state, "journal.md");
	const certify = () =>
		runCheckpoint(workspace, env, {
			apply: true,
			token: captureState(workspace, env).token,
			json: false,
			session: "test",
		});
	return { ...f, workspace, env, path, certify };
}

test("nested fences leave the following unreviewed entry visible at start", async () => {
	const f = fixture();
	expect((await f.certify()).code).toBe(0);
	writeFileSync(
		f.path,
		"## 2026-09-30\n- 09:00 certified\n~~~~\n```\n~~~~\n- 09:01 WARNING never run X\n",
	);
	const start = await runTool(["start"], {}, f.env);
	expect(start.text).toContain("WARNING never run X");
	expect(start.text).toContain("RECONCILE");
});

test("an unclosed fence makes start reconcile and checkpoint dry run and apply refuse", async () => {
	const f = fixture();
	expect((await f.certify()).code).toBe(0);
	writeFileSync(
		f.path,
		"## 2026-09-30\n- 09:00 certified\n```\npasted output\n",
	);
	const reason = "fence opened at line 3 is never closed; close or remove it";
	const start = await runTool(["start"], {}, f.env);
	expect(start.text).toContain("RECONCILE");
	expect(start.text).toContain(reason);
	for (const output of [
		await runCheckpoint(f.workspace, f.env, { apply: false, json: false }),
		await f.certify(),
	]) {
		expect(output.code).toBe(1);
		expect(output.text).toContain(reason);
	}
});

test("journal refuses an unclosed fence without changing the file", async () => {
	const f = fixture("## 2026-09-30\n```\npasted output\n");
	const before = readFileSync(f.path, "utf8");
	const output = await runTool(["journal", "two"], {}, f.env);
	expect(output.code).toBe(1);
	expect(output.text).toContain(
		"fence opened at line 2 is never closed; close or remove it",
	);
	expect(readFileSync(f.path, "utf8")).toBe(before);
});

test("a symlinked archive is named by start and checkpoint and archive apply writes nothing outside", async () => {
	const f = fixture();
	expect((await f.certify()).code).toBe(0);
	const outside = join(f.root, "outside");
	mkdirSync(join(outside, "journal"), { recursive: true });
	const old = join(outside, "journal/2026-08.md");
	writeFileSync(old, "## 2026-08-01\n- 08:00 outside\n");
	symlinkSync(outside, join(f.workspace.state, "archive"));
	const before = readFileSync(f.path, "utf8");
	const start = await runTool(["start"], {}, f.env);
	expect(start.text).toContain("RECONCILE");
	expect(start.text).toContain("archive: is a symlink");
	const dry = await runCheckpoint(f.workspace, f.env, {
		apply: false,
		json: false,
	});
	expect(dry.code).toBe(1);
	expect(dry.text).toContain("archive: is a symlink");
	const archive = await runTool(
		["archive"],
		{ apply: true, today: "2026-10-01" },
		f.env,
	);
	expect(archive.code).toBe(1);
	expect(archive.text).toContain("archive is a symlink");
	expect(existsSync(join(outside, "journal/2026-09.md"))).toBe(false);
	expect(readFileSync(old, "utf8")).toBe("## 2026-08-01\n- 08:00 outside\n");
	expect(readFileSync(f.path, "utf8")).toBe(before);
});

test("checkpoint ignores a README bullet in the journal archive", async () => {
	const f = fixture();
	expect((await f.certify()).code).toBe(0);
	mkdirSync(join(f.workspace.state, "archive/journal"), { recursive: true });
	writeFileSync(
		join(f.workspace.state, "archive/journal/README.md"),
		"- not a journal entry\n",
	);
	const held = captureState(f.workspace, f.env);
	expect(held.chain.map(({ text }) => text)).toEqual(["09:00 certified"]);
	const dry = await runCheckpoint(f.workspace, f.env, {
		apply: false,
		json: false,
	});
	expect(dry.code).toBe(0);
	expect(dry.text).not.toContain("boundary lost");
});

test("rotation replaces the current journal with a renamed file", async () => {
	const f = fixture(
		"## 2026-09-30\n- 09:00 old\n## 2026-10-01\n- 10:00 keep\n",
	);
	const inode = lstatSync(f.path).ino;
	const output = await runTool(
		["archive"],
		{ apply: true, today: "2026-10-01" },
		f.env,
	);
	expect(output.code).toBe(0);
	expect(lstatSync(f.path).ino).not.toBe(inode);
	expect(readFileSync(f.path, "utf8")).toContain("10:00 keep");
	expect(existsSync(`${f.path}.tmp`)).toBe(false);
});

test("rotation refuses a symlink at journal.md.tmp before writing archives", async () => {
	const f = fixture();
	const outside = join(f.root, "outside.md");
	writeFileSync(outside, "untouched\n");
	symlinkSync(outside, `${f.path}.tmp`);
	const before = readFileSync(f.path, "utf8");
	const output = await runTool(
		["archive"],
		{ apply: true, today: "2026-10-01" },
		f.env,
	);
	expect(output.code).toBe(1);
	expect(output.text).toContain("journal.md.tmp is a symlink");
	expect(readFileSync(outside, "utf8")).toBe("untouched\n");
	expect(readFileSync(f.path, "utf8")).toBe(before);
	expect(
		existsSync(join(f.workspace.state, "archive/journal/2026-09.md")),
	).toBe(false);
});

test("inline backticks cannot hide an unreviewed entry at start", async () => {
	const f = fixture();
	expect((await f.certify()).code).toBe(0);
	writeFileSync(
		f.path,
		"## 2026-09-30\n- 09:00 certified\n```ls``` was slow\n- 09:01 WARNING never run X\n```\n",
	);
	const start = await runTool(["start"], {}, f.env);
	expect(start.text).toContain("WARNING never run X");
	expect(start.text).toContain("RECONCILE");
});

test("inline backticks cannot hide CURRENT item exemptions", () => {
	const result = droppedLines({
		baseline:
			"## Items\n```ls``` was slow\n- [release](work/done/release/STATUS.md)\n```\n```\n",
		current: "",
		destinations: {},
		items: { release: "done" },
	});
	expect(
		result.unaccounted.some(({ text }) => text.includes("[release]")),
	).toBe(false);
});

for (const kind of ["lock", "file", "directory"] as const) {
	test(`workspace check tolerates transient ${kind} entries during symlink inspection`, () => {
		const f = fixture();
		const name = kind === "lock" ? ".state.lock.123.tmp" : "vanishing";
		const path = join(f.workspace.state, name);
		if (kind === "file") writeFileSync(path, "temporary");
		else mkdirSync(path);
		const originalStat = fs.lstatSync;
		const originalList = fs.readdirSync;
		let injected = false;
		const stat = spyOn(fs, "lstatSync").mockImplementation(((
			...args: Parameters<typeof fs.lstatSync>
		) => {
			const [target] = args;
			if (
				String(target) === path &&
				new Error().stack?.includes("symlinksUnder")
			) {
				if (kind === "lock" || kind === "file") {
					injected = true;
					rmSync(path, { recursive: true });
				}
			}
			return Reflect.apply(originalStat, fs, args);
		}) as typeof fs.lstatSync);
		const list = spyOn(fs, "readdirSync").mockImplementation((...args) => {
			const [target] = args;
			if (
				kind === "directory" &&
				String(target) === path &&
				new Error().stack?.includes("symlinksUnder")
			) {
				injected = true;
				rmSync(path, { recursive: true });
			}
			return Reflect.apply(originalList, fs, args);
		});
		try {
			expect(() =>
				checkWorkspace(
					f.workspace,
					discoverTree(f.root),
					loadConfig({ home: f.root, env: {}, workspaceChain: [f.root] }),
					f.env.now,
					f.root,
					f.env,
				),
			).not.toThrow();
			expect(injected).toBe(kind !== "lock");
		} finally {
			stat.mockRestore();
			list.mockRestore();
		}
	});
}

for (const site of ["checkLinks", "wordsIn"] as const) {
	test(`${site} treats a walked file removed before reading as absent`, () => {
		const f = fixture();
		const path = join(
			f.workspace.state,
			site === "wordsIn" ? "transient.md" : "integrations/transient.md",
		);
		mkdirSync(join(f.workspace.state, "integrations"));
		writeFileSync(path, "temporary text");
		const original = fs.readFileSync;
		let injected = false;
		const reader = spyOn(fs, "readFileSync").mockImplementation(((
			...args: Parameters<typeof fs.readFileSync>
		) => {
			const [target] = args;
			if (
				String(target) === path &&
				new Error().stack?.includes(site === "wordsIn" ? "contextTiers" : site)
			) {
				injected = true;
				rmSync(path);
			}
			return Reflect.apply(original, fs, args);
		}) as typeof fs.readFileSync);
		try {
			const run = () =>
				site === "checkLinks"
					? checkWorkspace(
							f.workspace,
							discoverTree(f.root),
							loadConfig({ home: f.root, env: {}, workspaceChain: [f.root] }),
							f.env.now,
							f.root,
							f.env,
						)
					: contextTiers(
							f.workspace,
							loadConfig({ home: f.root, env: {}, workspaceChain: [f.root] }),
							undefined,
							f.env,
						);
			expect(run).not.toThrow();
			expect(injected).toBe(true);
		} finally {
			reader.mockRestore();
		}
	});
}

test("journal JSON uses the same trailing newline as unlock JSON", async () => {
	const f = fixture();
	const journal = await runTool(["journal", "entry"], { json: true }, f.env);
	const unlock = await runTool(["unlock"], { json: true }, f.env);
	expect(journal.text.endsWith("\n")).toBe(unlock.text.endsWith("\n"));
});
