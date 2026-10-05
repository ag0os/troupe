import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spec as fixtureSpec } from "./adapters/test-fixtures";
import { parseCli } from "./cli";
import { installFakeClis, readRecords } from "./fake-cli";
import {
	type AgentExtension,
	executeAgent,
	previewAgent,
} from "./run";
import type { AgentSpec, PrepareContext } from "./types";

let root: string;
let workspace: string;
let bin: string;
let recordFile: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agent-contract-")));
	workspace = join(root, "workspace");
	bin = join(root, "bin");
	mkdirSync(workspace);
	mkdirSync(bin);
	installFakeClis(bin);
	recordFile = join(root, "records.jsonl");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function preview(
	spec: AgentSpec,
	argv: string[],
	extension: AgentExtension,
) {
	const parsed = parseCli(spec, ["--show-prompt", ...argv], { cwd: workspace });
	if (parsed.kind !== "run") throw new Error("expected a run outcome");
	const output = { stdout: "", stderr: "" };
	const code = await previewAgent(spec, extension, parsed.invocation, {
		stdout: (text) => {
			output.stdout += text;
		},
		stderr: (text) => {
			output.stderr += text;
		},
		isDirectory: () => true,
		runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
	});
	return { code, ...output };
}

function previewArgv(output: string): string[] {
	return JSON.parse(output.split("\n").at(-2) ?? "[]") as string[];
}

async function execute(
	spec: AgentSpec,
	argv: string[],
	extension: AgentExtension,
	options: {
		interpolatedEnv?: Record<string, string>;
		env?: Record<string, string>;
	} = {},
) {
	const parsed = parseCli(spec, argv, { cwd: workspace });
	if (parsed.kind !== "run") throw new Error("expected a run outcome");
	let stderr = "";
	const code = await executeAgent(spec, extension, parsed.invocation, {
		stdout: () => {},
		stderr: (text) => {
			stderr += text;
		},
		isDirectory: (path) => existsSync(path) || "missing",
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			FAKE_RECORD: recordFile,
			...options.env,
		},
		interpolate: async () => ({
			mcp: {},
			env: options.interpolatedEnv ?? {},
		}),
	});
	return { code, stderr };
}

describe("contract 1b: PrepareContext.passthrough", () => {
	test("prepare receives a frozen copy and the adapter receives the original tail", async () => {
		const tail = ["--resume", "thread", "--", "untouched"];
		let seen: readonly string[] | undefined;
		const result = await preview(fixtureSpec(), ["--", ...tail], {
			prepare(ctx) {
				seen = ctx.passthrough;
				expect(Object.isFrozen(ctx.passthrough)).toBe(true);
				expect(() => (ctx.passthrough as string[]).push("changed")).toThrow(
					TypeError,
				);
				return {};
			},
		});
		expect(result.code).toBe(0);
		expect(seen).toEqual(tail);
		for (const token of tail) expect(previewArgv(result.stdout)).toContain(token);
		expect(previewArgv(result.stdout).slice(-tail.length)).toEqual(tail);
	});
});

describe("contract 1c: PrepareResult.sessionName", () => {
	test("interactive Claude receives the name exactly once", async () => {
		const result = await preview(fixtureSpec(), [], {
			prepare: () => ({ sessionName: "shepherd-1005" }),
		});
		expect(result.code).toBe(0);
		const argv = previewArgv(result.stdout);
		expect(argv.filter((token) => token === "-n")).toHaveLength(1);
		expect(argv.slice(argv.indexOf("-n"), argv.indexOf("-n") + 2)).toEqual([
			"-n",
			"shepherd-1005",
		]);
	});

	test("execute passes the prepared name to Claude", async () => {
		const result = await execute(fixtureSpec(), [], {
			prepare: () => ({ sessionName: "shepherd-1005" }),
		});
		expect(result).toEqual({ code: 0, stderr: "" });
		const argv = readRecords(recordFile)[0]?.argv ?? [];
		expect(argv.filter((token) => token === "-n")).toHaveLength(1);
		expect(argv.slice(argv.indexOf("-n"), argv.indexOf("-n") + 2)).toEqual([
			"-n",
			"shepherd-1005",
		]);
	});

	test("Codex, print mode and unknown result fields fail preparation", async () => {
		const codex = await preview(fixtureSpec(), ["--backend", "codex"], {
			prepare: () => ({ sessionName: "wrong-backend" }),
		});
		expect(codex.code).toBe(1);
		expect(codex.stderr).toContain("interactive Claude");

		const print = await preview(fixtureSpec(), ["--print"], {
			prepare: () => ({ sessionName: "wrong-mode" }),
		});
		expect(print.code).toBe(1);
		expect(print.stderr).toContain("interactive Claude");

		const strict = await preview(fixtureSpec(), [], {
			prepare: () => ({ unsupported: true }) as never,
		});
		expect(strict.code).toBe(1);
		expect(strict.stderr).toContain("Unrecognized key");
	});
});

describe("contract 1d: PrepareResult.model", () => {
	test("flag, prepared and declared models have the required precedence", async () => {
		const declared = fixtureSpec({
			model: { claude: "declared-claude", codex: "declared-codex" },
		});
		const flagged = parseCli(declared, ["--model", "from-flag"], {
			cwd: workspace,
		});
		const defaulted = parseCli(declared, [], { cwd: workspace });
		expect(flagged.kind === "run" && flagged.invocation.modelFromFlag).toBe(
			true,
		);
		expect(defaulted.kind === "run" && defaulted.invocation.modelFromFlag).toBe(
			false,
		);
		const cases: [string[], AgentExtension, string, boolean][] = [
			[
				["--model", "from-flag"],
				{ prepare: () => ({ model: "from-prepare" }) },
				"from-flag",
				true,
			],
			[
				[],
				{ prepare: () => ({ model: "from-prepare" }) },
				"from-prepare",
				false,
			],
			[[], { prepare: () => ({}) }, "declared-claude", false],
		];
		for (const [argv, extension, expected, fromFlag] of cases) {
			let seen: boolean | undefined;
			const prepare = extension.prepare;
			const result = await preview(declared, argv, {
				prepare(ctx) {
					seen = ctx.modelFromFlag;
					return prepare?.(ctx) ?? {};
				},
			});
			expect(result.code).toBe(0);
			expect(seen).toBe(fromFlag);
			const values = previewArgv(result.stdout).flatMap((token, index, all) =>
				token === "--model" ? [all[index + 1]] : [],
			);
			expect(values).toEqual([expected]);
		}

		const codex = await preview(declared, ["--backend", "codex"], {
			prepare: () => ({ model: "prepared-codex" }),
		});
		expect(previewArgv(codex.stdout)).toContain("prepared-codex");
		expect(previewArgv(codex.stdout)).not.toContain("declared-codex");
	});

	test("execute passes prepared models to both adapters and a flag still wins", async () => {
		for (const backend of ["claude", "codex"] as const) {
			const backendArgs = backend === "codex" ? ["--backend", "codex"] : [];
			const prepared = await execute(fixtureSpec(), backendArgs, {
				prepare: () => ({ model: "from-prepare" }),
			});
			expect(prepared).toEqual({ code: 0, stderr: "" });
			const preparedArgv = readRecords(recordFile).at(-1)?.argv ?? [];
			const modelFlag = backend === "claude" ? "--model" : "-m";
			expect(preparedArgv[preparedArgv.indexOf(modelFlag) + 1]).toBe(
				"from-prepare",
			);

			const flagged = await execute(
				fixtureSpec(),
				[...backendArgs, "--model", "from-flag"],
				{ prepare: () => ({ model: "from-prepare" }) },
			);
			expect(flagged).toEqual({ code: 0, stderr: "" });
			const flaggedArgv = readRecords(recordFile).at(-1)?.argv ?? [];
			expect(flaggedArgv[flaggedArgv.indexOf(modelFlag) + 1]).toBe(
				"from-flag",
			);
			expect(flaggedArgv).not.toContain("from-prepare");
		}
	});
});

describe("contract 1e: PrepareResult.effort", () => {
	test("prepared effort replaces the declaration on both adapters", async () => {
		const declared = fixtureSpec({
			effort: { claude: "low", codex: "minimal" },
		});
		const claude = await preview(declared, [], {
			prepare: () => ({ effort: "high" }),
		});
		expect(previewArgv(claude.stdout)).toContain("--effort");
		expect(previewArgv(claude.stdout)).toContain("high");
		expect(previewArgv(claude.stdout)).not.toContain("low");

		const codex = await preview(declared, ["--backend", "codex"], {
			prepare: () => ({ effort: "xhigh" }),
		});
		expect(previewArgv(codex.stdout)).toContain(
			'model_reasoning_effort="xhigh"',
		);
		expect(previewArgv(codex.stdout).join(" ")).not.toContain("minimal");
	});

	test("execute passes prepared effort to both adapters", async () => {
		for (const backend of ["claude", "codex"] as const) {
			const argv = backend === "codex" ? ["--backend", "codex"] : [];
			const result = await execute(fixtureSpec(), argv, {
				prepare: () => ({ effort: "high" }),
			});
			expect(result).toEqual({ code: 0, stderr: "" });
			const recorded = readRecords(recordFile).at(-1)?.argv ?? [];
			if (backend === "claude") {
				expect(recorded[recorded.indexOf("--effort") + 1]).toBe("high");
			} else {
				expect(recorded).toContain('model_reasoning_effort="high"');
			}
		}
	});

	test("effort accepts lowercase letters only", async () => {
		for (const effort of ["", "very-high", "HIGH", "high2"]) {
			const result = await preview(fixtureSpec(), [], {
				prepare: () => ({ effort }),
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Invalid string");
		}
	});
});

describe("contract 1f: PrepareResult.codexHome", () => {
	test("Codex receives the absolute home in its environment, not argv", async () => {
		const home = join(root, "codex-home");
		const result = await execute(
			fixtureSpec(),
			["--backend", "codex"],
			{ prepare: () => ({ codexHome: home }) },
			{ env: { TROUPE_KEEP: "yes" } },
		);
		expect(result).toEqual({ code: 0, stderr: "" });
		const [record] = readRecords(recordFile);
		expect(record?.codexHome).toBe(home);
		expect(record?.argv).not.toContain(home);
		expect(record?.troupeEnv).toEqual({ TROUPE_KEEP: "yes" });
	});

	test("later runner environment layers retain precedence", async () => {
		const result = await execute(
			fixtureSpec(),
			["--backend", "codex"],
			{ prepare: () => ({ codexHome: join(root, "prepared-home") }) },
			{ interpolatedEnv: { CODEX_HOME: join(root, "interpolated-home") } },
		);
		expect(result.code).toBe(0);
		expect(readRecords(recordFile)[0]?.codexHome).toBe(
			join(root, "interpolated-home"),
		);
	});

	test("Claude and relative paths fail, while preview exposes no argv value", async () => {
		const claude = await preview(fixtureSpec(), [], {
			prepare: () => ({ codexHome: join(root, "wrong-backend") }),
		});
		expect(claude.code).toBe(1);
		expect(claude.stderr).toContain("only for Codex");

		const relative = await preview(
			fixtureSpec(),
			["--backend", "codex"],
			{ prepare: () => ({ codexHome: "relative/home" }) },
		);
		expect(relative.code).toBe(1);
		expect(relative.stderr).toContain("absolute path");

		const home = join(root, "preview-home");
		const valid = await preview(fixtureSpec(), ["--backend", "codex"], {
			prepare: () => ({ codexHome: home }),
		});
		expect(valid.code).toBe(0);
		expect(valid.stdout).not.toContain(home);
	});
});
