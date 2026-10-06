import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexDefaults, passthroughModelToken } from "./codex-defaults";
import type { Config } from "./config";
import { launchKind } from "./session-name";
import type { ToolEnv } from "./sessions";
import { fakeToolEnv, makeTree } from "./test-support";

const fixtures: ReturnType<typeof makeTree>[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		fixture.cleanup();
	}
});

function fixture(): string {
	const tree = makeTree({}, { prefix: "shepherd-codex-defaults-" });
	fixtures.push(tree);
	return tree.root;
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
	return fakeToolEnv({ home, env });
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
		for (const [backend, passthrough] of [
			["codex", ["resume", "id"]],
			["codex", ["fork", "id"]],
			["claude", ["--resume", "x", "--fork-session"]],
		] as const) {
			const kind = launchKind(backend, passthrough);
			expect(kind).toBe("resume");
			const result = codexDefaults(
				config({ home: codexHome, model: "configured", effort: "high" }),
				environment(home),
				passthrough,
				kind,
				false,
			);
			expect(result.codexHome).toBe(codexHome);
			expect(result.headerLine).toBe(`- Codex home: ${codexHome} (config)`);
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

	test("rejects relative configured homes with their source file", () => {
		const home = fixture();
		const userFile = join(home, ".config", "shepherd", "config.json");
		expect(
			codexDefaults(
				config({ home: "relative/home" }),
				environment(home),
				[],
				"new",
				false,
			).error,
		).toBe(`${userFile}: Codex home is not an absolute path: relative/home`);
	});

	test("rejects a relative home read from homeFile with the homeFile source", () => {
		const home = fixture();
		const homeFile = join(home, ".codex-active");
		writeFileSync(homeFile, "relative/home\n");
		expect(
			codexDefaults(config({ homeFile }), environment(home), [], "new", false)
				.error,
		).toBe(`${homeFile}: Codex home is not an absolute path: relative/home`);
	});

	test("leaves a relative environment home inherited and keeps its header", () => {
		const home = fixture();
		const result = codexDefaults(
			config(),
			environment(home, { CODEX_HOME: "relative/home" }),
			[],
			"new",
			false,
		);
		expect(result).toEqual({
			headerLine: "- Codex home: relative/home (environment)",
		});
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
