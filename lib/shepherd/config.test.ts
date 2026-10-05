import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MARKS, DEFAULT_WINDOWS, loadConfig } from "./config";

const fixtures: string[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		rmSync(fixture, { recursive: true, force: true });
	}
});

function fixture(): string {
	const root = mkdtempSync(
		join(process.env.TMPDIR ?? "/tmp", "shepherd-config-"),
	);
	fixtures.push(root);
	return root;
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify(value));
}

function workspaceFile(workspace: string): string {
	return join(workspace, ".shepherd", "config.json");
}

describe("loadConfig", () => {
	test("returns the built-in defaults when config files are absent", () => {
		const home = fixture();

		expect(loadConfig({ home, env: {}, workspaceChain: [] })).toEqual({
			marks: DEFAULT_MARKS,
			windows: DEFAULT_WINDOWS,
			codex: {},
			problems: [],
		});
	});

	test("layers each marks and windows key from outermost to target", () => {
		const home = fixture();
		const outer = join(home, "work");
		const inner = join(outer, "project");
		const target = join(inner, "service");
		writeJson(join(home, ".config", "shepherd", "config.json"), {
			marks: { opening: 20_000, charter: 2_000 },
			windows: { doneDays: 40 },
			codex: {
				home: "~/.codex-work",
				model: "gpt-5.6-sol",
				effort: "high",
			},
		});
		writeJson(workspaceFile(outer), {
			marks: { opening: 18_000, current: 1_800 },
			windows: { currentStaleDays: 10 },
			sessionPrefix: "outer",
		});
		writeJson(workspaceFile(inner), {
			marks: { current: 1_600, shared: 1_700 },
			windows: { doneDays: 35 },
			sessionPrefix: "inner",
		});
		writeJson(workspaceFile(target), {
			marks: { opening: 16_000 },
			sessionPrefix: "flock-2",
		});

		expect(
			loadConfig({ home, env: {}, workspaceChain: [outer, inner, target] }),
		).toEqual({
			marks: {
				opening: 16_000,
				charter: 2_000,
				current: 1_600,
				shared: 1_700,
			},
			windows: { doneDays: 35, currentStaleDays: 10 },
			sessionPrefix: "flock-2",
			codex: {
				home: join(home, ".codex-work"),
				model: "gpt-5.6-sol",
				effort: "high",
			},
			problems: [],
		});
	});

	test("does not inherit sessionPrefix from an enclosing workspace", () => {
		const home = fixture();
		const outer = join(home, "outer");
		const target = join(outer, "target");
		writeJson(workspaceFile(outer), { sessionPrefix: "outer" });
		writeJson(workspaceFile(target), { marks: { current: 2_000 } });

		expect(
			loadConfig({ home, env: {}, workspaceChain: [outer, target] }),
		).toMatchObject({ sessionPrefix: undefined });
	});

	test("uses XDG_CONFIG_HOME and expands a homeFile", () => {
		const home = fixture();
		const xdg = join(home, "settings");
		writeJson(join(xdg, "shepherd", "config.json"), {
			codex: { homeFile: "~/.codex-active" },
		});

		expect(
			loadConfig({
				home,
				env: { XDG_CONFIG_HOME: xdg },
				workspaceChain: [],
			}).codex,
		).toEqual({ homeFile: join(home, ".codex-active") });
	});

	test("reports unknown and misplaced keys and skips their files", () => {
		const home = fixture();
		const workspace = join(home, "project");
		const userFile = join(home, ".config", "shepherd", "config.json");
		const localFile = workspaceFile(workspace);
		writeJson(userFile, { sessionPrefix: "user", marks: { opening: 99 } });
		writeJson(localFile, { codex: { model: "other" }, marks: { current: 99 } });

		const config = loadConfig({ home, env: {}, workspaceChain: [workspace] });

		expect(config.marks).toEqual(DEFAULT_MARKS);
		expect(config.problems).toEqual([
			{ file: userFile, key: "sessionPrefix", problem: "unknown key" },
			{ file: localFile, key: "codex", problem: "unknown key" },
		]);
	});

	test("reports both codex home settings and skips the user file", () => {
		const home = fixture();
		const userFile = join(home, ".config", "shepherd", "config.json");
		writeJson(userFile, {
			marks: { opening: 99 },
			codex: { home: "/tmp/codex", homeFile: "~/.codex-active" },
		});

		const config = loadConfig({ home, env: {}, workspaceChain: [] });

		expect(config.marks).toEqual(DEFAULT_MARKS);
		expect(config.codex).toEqual({});
		expect(config.problems).toEqual([
			{
				file: userFile,
				key: "codex.homeFile",
				problem: "cannot be used together with home",
			},
		]);
	});

	test("reports invalid values and JSON while applying other valid layers", () => {
		const home = fixture();
		const outer = join(home, "outer");
		const target = join(outer, "target");
		const outerFile = workspaceFile(outer);
		const targetFile = workspaceFile(target);
		writeJson(outerFile, { marks: { opening: 15_000 } });
		mkdirSync(join(target, ".shepherd"), { recursive: true });
		writeFileSync(targetFile, "{not json");

		const config = loadConfig({
			home,
			env: {},
			workspaceChain: [outer, target],
		});

		expect(config.marks.opening).toBe(15_000);
		expect(config.sessionPrefix).toBeUndefined();
		expect(config.problems).toHaveLength(1);
		expect(config.problems[0]).toMatchObject({
			file: targetFile,
			key: "config",
		});
	});

	test("requires positive integers and a valid session prefix", () => {
		const home = fixture();
		const workspace = join(home, "project");
		const file = workspaceFile(workspace);
		writeJson(file, {
			marks: { opening: 0, charter: 1.5 },
			windows: { doneDays: -1 },
			sessionPrefix: "2 bad",
		});

		const config = loadConfig({ home, env: {}, workspaceChain: [workspace] });

		expect(config.problems.map((problem) => problem.key)).toEqual([
			"marks.opening",
			"marks.charter",
			"windows.doneDays",
			"sessionPrefix",
		]);
	});
});
