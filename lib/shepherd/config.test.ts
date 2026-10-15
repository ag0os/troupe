import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_HANDOFF_CEILINGS,
	DEFAULT_MARKS,
	DEFAULT_START,
	DEFAULT_WINDOWS,
	handoffCeiling,
	loadConfig,
	splitConfigProblems,
} from "./config";

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

		const config = loadConfig({ home, env: {}, workspaceChain: [] });
		expect(config.marks.current).toBe(600);
		expect(config.windows.pendingDays).toBe(14);
		expect(config.start.journalWords).toBe(1_500);
		expect(config).toEqual({
			marks: DEFAULT_MARKS,
			windows: DEFAULT_WINDOWS,
			start: DEFAULT_START,
			handoffCeilings: DEFAULT_HANDOFF_CEILINGS,
			codex: {},
			problems: [],
		});
	});

	test("layers each marks, windows and start key from outermost to target", () => {
		const home = fixture();
		const outer = join(home, "work");
		const inner = join(outer, "project");
		const target = join(inner, "service");
		writeJson(join(home, ".config", "shepherd", "config.json"), {
			marks: { opening: 20_000, charter: 2_000 },
			windows: { doneDays: 40, pendingDays: 20 },
			start: { journalWords: 2_000 },
			codex: {
				home: "~/.codex-work",
				model: "gpt-5.6-sol",
				effort: "high",
			},
		});
		writeJson(workspaceFile(outer), {
			marks: { opening: 18_000, current: 1_800 },
			windows: { currentStaleDays: 10, pendingDays: 18 },
			start: { journalWords: 1_800 },
			sessionPrefix: "outer",
		});
		writeJson(workspaceFile(inner), {
			marks: { current: 1_600, shared: 1_700 },
			windows: { doneDays: 35, pendingDays: 16 },
			start: { journalWords: 1_600 },
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
			windows: { doneDays: 35, currentStaleDays: 10, pendingDays: 16 },
			start: { journalWords: 1_600 },
			handoffCeilings: DEFAULT_HANDOFF_CEILINGS,
			sessionPrefix: "flock-2",
			codex: {
				home: join(home, ".codex-work"),
				model: "gpt-5.6-sol",
				effort: "high",
			},
			problems: [],
		});
	});

	for (const scope of ["user", "workspace"] as const) {
		test(`accepts new keys from the ${scope} layer`, () => {
			const home = fixture();
			const workspace = join(home, "project");
			const file =
				scope === "user"
					? join(home, ".config", "shepherd", "config.json")
					: workspaceFile(workspace);
			writeJson(file, {
				windows: { pendingDays: 21 },
				start: { journalWords: 2_100 },
			});

			const config = loadConfig({ home, env: {}, workspaceChain: [workspace] });

			expect(config.windows).toEqual({ ...DEFAULT_WINDOWS, pendingDays: 21 });
			expect(config.start).toEqual({ journalWords: 2_100 });
			expect(config.problems).toEqual([]);
		});

		for (const [group, key] of [
			["windows", "pendingDays"],
			["start", "journalWords"],
		] as const) {
			for (const value of [0, -1, 1.5, "14"]) {
				test(`rejects ${JSON.stringify(value)} for ${group}.${key} in the ${scope} layer`, () => {
					const home = fixture();
					const workspace = join(home, "project");
					const file =
						scope === "user"
							? join(home, ".config", "shepherd", "config.json")
							: workspaceFile(workspace);
					writeJson(file, { [group]: { [key]: value } });

					const config = loadConfig({
						home,
						env: {},
						workspaceChain: [workspace],
					});

					expect(config.windows).toEqual(DEFAULT_WINDOWS);
					expect(config.start).toEqual(DEFAULT_START);
					expect(config.problems).toHaveLength(1);
					expect(config.problems[0]).toMatchObject({
						file,
						key: `${group}.${key}`,
					});
				});
			}
		}

		test(`rejects unknown start keys in the ${scope} layer and skips the file`, () => {
			const home = fixture();
			const workspace = join(home, "project");
			const file =
				scope === "user"
					? join(home, ".config", "shepherd", "config.json")
					: workspaceFile(workspace);
			writeJson(file, {
				windows: { pendingDays: 21 },
				start: { journalWords: 2_100, unknown: 1 },
			});

			const config = loadConfig({ home, env: {}, workspaceChain: [workspace] });

			expect(config.windows).toEqual(DEFAULT_WINDOWS);
			expect(config.start).toEqual(DEFAULT_START);
			expect(config.problems).toEqual([
				{ file, key: "start.unknown", problem: "unknown key" },
			]);
		});
	}

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
		writeJson(outerFile, {
			marks: { opening: 15_000 },
			sessionPrefix: "outer",
		});
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

	test("splits user problems from workspace problems", () => {
		const home = fixture();
		const userFile = join(home, ".config", "shepherd", "config.json");
		const workspace = join(home, "project");
		const localFile = workspaceFile(workspace);
		writeJson(userFile, { sessionPrefix: "wrong-scope" });
		writeJson(localFile, { codex: { model: "wrong-scope" } });

		const config = loadConfig({ home, env: {}, workspaceChain: [workspace] });

		expect(splitConfigProblems(config.problems, { home, env: {} })).toEqual({
			user: [{ file: userFile, key: "sessionPrefix", problem: "unknown key" }],
			workspace: [{ file: localFile, key: "codex", problem: "unknown key" }],
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

describe("autonomy", () => {
	test("accepts an autonomy grant in the workspace file", () => {
		const home = fixture();
		const workspace = join(home, "project");
		writeJson(workspaceFile(workspace), {
			autonomy: { enabled: true, until: "2026-10-20" },
		});

		const config = loadConfig({ home, env: {}, workspaceChain: [workspace] });

		expect(config.problems).toEqual([]);
		expect(config.autonomy).toEqual({ enabled: true, until: "2026-10-20" });
	});

	test("accepts enabled alone and both until forms", () => {
		const home = fixture();
		const workspace = join(home, "project");
		for (const autonomy of [
			{ enabled: false },
			{ enabled: true, until: "2026-10-20T10:00Z" },
			{ enabled: true, until: "2026-10-20T10:00:59-03:00" },
			{ enabled: true, until: "2026-10-20T23:59+14:00" },
		]) {
			writeJson(workspaceFile(workspace), { autonomy });
			const config = loadConfig({
				home,
				env: {},
				workspaceChain: [workspace],
			});
			expect(config.problems).toEqual([]);
			expect(config.autonomy).toEqual(autonomy);
		}
	});

	for (const [label, autonomy] of [
		["an invalid month and day", { enabled: true, until: "2026-13-40" }],
		["a day the month lacks", { enabled: true, until: "2026-02-30" }],
		["hour 24", { enabled: true, until: "2026-10-20T24:00Z" }],
		[
			"an offset past 14 hours",
			{ enabled: true, until: "2026-10-20T10:00+15:00" },
		],
		[
			"an offset of 14 hours and 30 minutes",
			{ enabled: true, until: "2026-10-20T10:00+14:30" },
		],
		[
			"an instant without an offset",
			{ enabled: true, until: "2026-10-20T10:00" },
		],
		["a string enabled", { enabled: "yes" }],
		["an extra subkey", { enabled: true, notify: "herdr" }],
	] as const) {
		test(`reports ${label} as one problem and skips the file`, () => {
			const home = fixture();
			const workspace = join(home, "project");
			writeJson(workspaceFile(workspace), { autonomy });

			const config = loadConfig({
				home,
				env: {},
				workspaceChain: [workspace],
			});

			expect(config.problems).toHaveLength(1);
			expect(config.problems[0]?.key).toStartWith("autonomy");
			expect(config.autonomy).toBeUndefined();
		});
	}

	test("rejects autonomy in the user file", () => {
		const home = fixture();
		const userFile = join(home, ".config", "shepherd", "config.json");
		writeJson(userFile, { autonomy: { enabled: true } });

		const config = loadConfig({ home, env: {}, workspaceChain: [] });

		expect(config.problems).toEqual([
			{ file: userFile, key: "autonomy", problem: "unknown key" },
		]);
		expect(config.autonomy).toBeUndefined();
	});

	test("does not inherit autonomy from an enclosing workspace", () => {
		const home = fixture();
		const outer = join(home, "outer");
		const target = join(outer, "target");
		writeJson(workspaceFile(outer), { autonomy: { enabled: true } });
		writeJson(workspaceFile(target), { marks: { current: 2_000 } });

		const config = loadConfig({
			home,
			env: {},
			workspaceChain: [outer, target],
		});

		expect(config.problems).toEqual([]);
		expect(config.autonomy).toBeUndefined();
	});
});

describe("handoff ceilings", () => {
	test("layers individual model ceilings without losing other entries", () => {
		const home = fixture();
		const outer = join(home, "outer");
		const inner = join(outer, "inner");
		writeJson(join(home, ".config", "shepherd", "config.json"), {
			handoffCeilings: { "gpt-custom": 85, "claude-custom": 42 },
		});
		writeJson(workspaceFile(outer), { handoffCeilings: { "gpt-custom": 90 } });
		writeJson(workspaceFile(inner), {
			handoffCeilings: { "claude-custom": 47.5 },
		});
		const config = loadConfig({
			home,
			env: {},
			workspaceChain: [outer, inner],
		});
		expect(config.problems).toEqual([]);
		expect(config.handoffCeilings).toEqual({
			claude: 45,
			codex: 80,
			default: 45,
			"gpt-custom": 90,
			"claude-custom": 47.5,
		});
	});

	for (const scope of ["user", "workspace"] as const) {
		for (const value of [0, -1, 101, "80", null]) {
			test(`rejects ceiling ${JSON.stringify(value)} in the ${scope} layer`, () => {
				const home = fixture();
				const workspace = join(home, "work");
				const file =
					scope === "user"
						? join(home, ".config", "shepherd", "config.json")
						: workspaceFile(workspace);
				writeJson(file, {
					marks: { current: 99 },
					handoffCeilings: { "gpt-custom": value },
				});
				const config = loadConfig({
					home,
					env: {},
					workspaceChain: [workspace],
				});
				expect(config.problems).toHaveLength(1);
				expect(config.problems[0]).toMatchObject({
					file,
					key: "handoffCeilings.gpt-custom",
				});
				expect(config.marks.current).toBe(DEFAULT_MARKS.current);
			});
		}
	}
});

test("handoffCeiling uses exact entries, family boundaries, backend and default", () => {
	const config = {
		handoffCeilings: { claude: 48, codex: 88, default: 55, "gpt-5": 91 },
	};
	for (const [backend, model, expected] of [
		["claude", "gpt-5", 91],
		["claude", "gpt-4", 88],
		["codex", "claude-opus", 48],
		["other", "claude", 48],
		["other", "opus", 48],
		["other", "sonnet-latest", 48],
		["other", "haiku", 48],
		["other", "gpt", 88],
		["other", "codex-mini", 88],
		["other", "gpt4", 55],
		["other", "claudette", 55],
		["claude", "gpt4", 48],
		["codex", "claudette", 88],
		["codex", "o3", 88],
		["codex", "o4-mini", 88],
		["other", "o3", 55],
		["claude", undefined, 48],
		["codex", undefined, 88],
		["other", undefined, 55],
		["codex", "", 88],
	] as const) {
		expect({
			backend,
			model,
			ceiling: handoffCeiling(config, backend, model),
		}).toEqual({ backend, model, ceiling: expected });
	}
});
