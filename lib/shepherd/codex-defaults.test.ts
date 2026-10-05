import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexDefaults, passthroughModelToken } from "./codex-defaults";
import type { Config } from "./config";
import type { ToolEnv } from "./sessions";

const fixtures: string[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		rmSync(fixture, { recursive: true, force: true });
	}
});

function fixture(): string {
	const root = mkdtempSync(
		join(process.env.TMPDIR ?? "/tmp", "shepherd-codex-defaults-"),
	);
	fixtures.push(root);
	return root;
}

function config(codex: Config["codex"] = {}): Config {
	return {
		marks: { opening: 1, charter: 1, current: 1, shared: 1 },
		windows: { doneDays: 1, currentStaleDays: 1 },
		codex,
		problems: [],
	};
}

function environment(
	home: string,
	env: Readonly<Record<string, string | undefined>> = {},
): ToolEnv {
	return {
		cwd: home,
		home,
		env,
		now: new Date(2026, 9, 5),
		runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		pidAlive: () => false,
	};
}

describe("codexDefaults", () => {
	test("uses environment home and configured model and effort", () => {
		const home = fixture();
		const codexHome = join(home, ".codex-work");
		expect(
			codexDefaults(
				config({ model: "gpt-5.6-sol", effort: "high" }),
				environment(home, { CODEX_HOME: codexHome }),
				[],
				"new",
				false,
			),
		).toEqual({
			codexHome,
			model: "gpt-5.6-sol",
			effort: "high",
			headerLine: `- Codex home: ${codexHome} (environment)`,
		});
	});

	test("launch values win and scans stop at the backend separator", () => {
		const home = fixture();
		const configured = config({ model: "configured", effort: "high" });
		const toolEnv = environment(home);
		expect(
			codexDefaults(
				configured,
				toolEnv,
				["-m", "launch", "-c", "model_reasoning_effort=low"],
				"new",
				false,
			),
		).not.toHaveProperty("model");
		expect(
			codexDefaults(
				configured,
				toolEnv,
				["-m", "launch", "-c", "model_reasoning_effort=low"],
				"new",
				false,
			),
		).not.toHaveProperty("effort");
		expect(
			codexDefaults(
				configured,
				toolEnv,
				["--", "-m", "text", "model_reasoning_effort=low"],
				"new",
				false,
			),
		).toMatchObject({ model: "configured", effort: "high" });
	});

	test("resumes and forks keep home but withhold configured model and effort", () => {
		const home = fixture();
		const codexHome = join(home, "account");
		mkdirSync(codexHome);
		for (const kind of ["resume", "fork"] as const) {
			const result = codexDefaults(
				config({ home: codexHome, model: "configured", effort: "high" }),
				environment(home),
				[],
				kind,
				false,
			);
			expect(result.codexHome).toBe(codexHome);
			expect(result).not.toHaveProperty("model");
			expect(result).not.toHaveProperty("effort");
		}
	});

	test("reads the first non-empty homeFile line and expands home", () => {
		const home = fixture();
		const codexHome = join(home, ".codex-team");
		mkdirSync(codexHome);
		const homeFile = join(home, ".codex-active");
		writeFileSync(homeFile, "\n  ~/.codex-team  \nignored\n");
		expect(
			codexDefaults(config({ homeFile }), environment(home), [], "new", false),
		).toMatchObject({
			codexHome,
			headerLine: `- Codex home: ${codexHome} (config)`,
		});
	});

	test("reports a configured home that is not a directory with its source", () => {
		const home = fixture();
		const missing = join(home, "missing");
		const userFile = join(home, ".config", "shepherd", "config.json");
		expect(
			codexDefaults(
				config({ home: missing }),
				environment(home),
				[],
				"new",
				false,
			).error,
		).toBe(`${userFile}: Codex home is not an existing directory: ${missing}`);
	});

	test("reports the Codex default without setting CODEX_HOME", () => {
		const home = fixture();
		expect(
			codexDefaults(config(), environment(home), [], "new", false),
		).toEqual({
			headerLine: `- Codex home: ${join(home, ".codex")} (Codex default)`,
		});
	});

	test("detects model tokens and rejects a second typed model", () => {
		for (const token of ["-m", "--model", "--model=launch"]) {
			expect(passthroughModelToken([token, "launch"])).toBe(token);
			expect(
				codexDefaults(
					config(),
					environment(fixture()),
					[token, "launch"],
					"new",
					true,
				).error,
			).toBe(`model given twice: --model and ${token} after --`);
		}
	});
});
