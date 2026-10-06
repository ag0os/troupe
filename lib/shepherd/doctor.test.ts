import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { doctorExitCode, doctorJson, renderDoctor, runDoctor } from "./doctor";
import { fakeToolEnv, makeTree } from "./test-support";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(
	options: { absent?: boolean; homeName?: string; bins?: string[] } = {},
) {
	const tree = makeTree({});
	cleanups.push(tree.cleanup);
	const home = join(tree.root, options.homeName ?? "home");
	const bin = join(tree.root, "bin");
	mkdirSync(bin);
	if (!options.absent) mkdirSync(home);
	for (const name of options.bins ?? ["claude", "codex", "herdr", "jq"]) {
		writeFileSync(join(bin, name), "");
		chmodSync(join(bin, name), 0o755);
	}
	const toolEnv = fakeToolEnv({
		home,
		env: { PATH: bin },
		runCommand: async () => {
			throw new Error("doctor must not run commands");
		},
	});
	const put = (path: string, contents: string) => {
		const file = join(home, path);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, contents);
		return file;
	};
	const run = () => {
		const path = relative(tree.root, toolEnv.home);
		expect(path).not.toStartWith("..");
		expect(path).not.toBe("");
		return runDoctor(toolEnv);
	};
	return { ...tree, home, bin, toolEnv, put, run };
}
function check(result: ReturnType<typeof runDoctor>, id: string) {
	const found = result.checks.find((entry) => entry.id === id);
	expect(found).toBeDefined();
	if (!found) throw new Error(`missing check ${id}`);
	return found;
}
function hooks(command: string) {
	return {
		hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
	};
}
function complete(f: ReturnType<typeof fixture>) {
	const script = f.put(".claude/herdr-agent-state.sh", "");
	f.put(
		".claude/settings.json",
		JSON.stringify({
			crossSessionInbound: "accept",
			statusLine: { type: "command", command: "jq used_percentage" },
			...hooks(`'${script}'`),
		}),
	);
	f.put(".codex/auth.json", "{}");
	f.put(".codex/hooks.json", JSON.stringify(hooks(`'${script}'`)));
	f.toolEnv.execPath = join(f.bin, "shepherd");
	writeFileSync(f.toolEnv.execPath, "");
	chmodSync(f.toolEnv.execPath, 0o755);
}

describe("doctor filesystem checks", () => {
	test("everything present, stable table order, no external commands", () => {
		const f = fixture();
		complete(f);
		const result = f.run();
		expect(result.totals).toEqual({ ok: 12, gap: 0, skip: 0 });
		expect(doctorExitCode(result)).toBe(0);
		expect(result.checks.map((entry) => entry.id)).toEqual([
			"path:claude",
			"path:codex",
			"path:herdr",
			"path:jq",
			"path:shepherd",
			"config:user",
			"claude:settings",
			"claude:cross-session-inbound",
			"claude:status-line",
			"claude:herdr-hook",
			`codex:home:${join(f.home, ".codex")}`,
			`codex:herdr-hook:${join(f.home, ".codex")}`,
		]);
	});
	test("bare absent HOME reports the dry run gaps and enumeration skip", () => {
		const f = fixture({ absent: true, bins: [] });
		const result = f.run();
		expect(
			result.checks
				.filter((entry) => entry.status === "gap")
				.map((entry) => entry.id),
		).toEqual([
			"path:claude",
			"path:jq",
			"claude:cross-session-inbound",
			"claude:status-line",
		]);
		expect(check(result, "path:claude").edit).toBe(
			"install Claude Code: https://claude.com/claude-code",
		);
		expect(check(result, "path:jq").edit).toBe(
			"install jq: https://jqlang.org/download/",
		);
		expect(check(result, "claude:cross-session-inbound").edit).toBe(
			`in ${f.home}/.claude/settings.json add: "crossSessionInbound": "accept"`,
		);
		expect(check(result, "claude:status-line").edit).toBe(
			`in ${f.home}/.claude/settings.json add:\n"statusLine": {"type": "command", "command": "jq -r '\\"\\\\(.model.display_name) \\\\(.context_window.used_percentage // 0 | floor)%\\"'"}`,
		);
		expect(
			result.checks
				.filter((entry) => entry.id === "codex:home")
				.map((entry) => entry.summary),
		).toEqual([
			expect.stringContaining("Codex homes under HOME not listed:"),
			"Codex not configured",
		]);
		for (const id of [
			"path:codex",
			"path:herdr",
			"path:shepherd",
			"claude:herdr-hook",
		])
			expect(check(result, id).status).toBe("skip");
		expect(doctorExitCode(result)).toBe(1);
	});
	for (const value of ["null", "[]", '"string"', "{invalid"]) {
		test(`invalid settings ${value} produces one gap and three dependent skips`, () => {
			const f = fixture();
			f.put(".claude/settings.json", value);
			const result = f.run();
			expect(check(result, "claude:settings").status).toBe("gap");
			expect(check(result, "claude:settings").edit).toStartWith(
				`fix the JSON in ${f.home}/.claude/settings.json:`,
			);
			for (const id of ["cross-session-inbound", "status-line", "herdr-hook"])
				expect(check(result, `claude:${id}`).status).toBe("skip");
		});
	}
	test.skipIf(process.getuid?.() === 0)("unreadable settings", () => {
		const f = fixture();
		const path = f.put(".claude/settings.json", "{}");
		chmodSync(path, 0);
		try {
			expect(check(f.run(), "claude:settings").status).toBe("gap");
		} finally {
			chmodSync(path, 0o600);
		}
	});
	test("malformed nested hook shapes are ignored", () => {
		const f = fixture();
		for (const value of [
			{ hooks: { SessionStart: {} } },
			{ hooks: { SessionStart: [null, { hooks: [null, { command: 3 }] }] } },
		]) {
			f.put(".claude/settings.json", JSON.stringify(value));
			expect(check(f.run(), "claude:herdr-hook").edit).toBe(
				"herdr integration install claude",
			);
		}
	});
	test("quoted missing script, relative script, tilde, and shell word concatenation", () => {
		const f = fixture();
		f.put(
			".claude/settings.json",
			JSON.stringify(hooks(`'${f.home}/missing script/herdr-agent-state.sh'`)),
		);
		expect(check(f.run(), "claude:herdr-hook").status).toBe("gap");
		f.put(
			".claude/settings.json",
			JSON.stringify(hooks("./herdr-agent-state.sh")),
		);
		expect(check(f.run(), "claude:herdr-hook").summary).toBe(
			"hook script path must be absolute",
		);
		f.put("script dir/herdr-agent-state.sh", "");
		for (const command of [
			'"~/script dir/herdr-agent-state.sh"',
			`"${f.home}/script dir/"herdr-agent-state.sh`,
			`${f.home}/script\\ dir/herdr-agent-state.sh`,
		]) {
			f.put(".claude/settings.json", JSON.stringify(hooks(command)));
			expect(check(f.run(), "claude:herdr-hook").status).toBe("ok");
		}
	});
	test("missing herdr skips both integrations and missing percentage is a gap", () => {
		const f = fixture({ bins: ["claude", "codex", "jq"] });
		f.put(".codex/auth.json", "{}");
		f.put(
			".claude/settings.json",
			JSON.stringify({ statusLine: { type: "command", command: "jq model" } }),
		);
		const result = f.run();
		expect(check(result, "claude:status-line").status).toBe("gap");
		expect(check(result, "claude:herdr-hook").status).toBe("skip");
		expect(check(result, `codex:herdr-hook:${f.home}/.codex`).status).toBe(
			"skip",
		);
	});
	for (const contents of ["", "relative/path", "~/missing-home"]) {
		test(`homeFile ${JSON.stringify(contents)} reuses launcher errors without a home check`, () => {
			const f = fixture();
			const file = f.put("selected-home", contents);
			f.put(
				".config/shepherd/config.json",
				JSON.stringify({ codex: { homeFile: file } }),
			);
			const result = f.run();
			const gap = check(result, "config:user");
			expect(gap.status).toBe("gap");
			expect(gap.edit).toBe(
				contents === ""
					? `${file}: expected a non-empty Codex home path`
					: contents === "relative/path"
						? `${file}: Codex home is not an absolute path: relative/path`
						: `${file}: Codex home is not an existing directory: ${f.home}/missing-home`,
			);
			expect(
				result.checks.some((entry) => entry.id.startsWith("codex:home:")),
			).toBe(false);
		});
	}
	test("homeFile reads the first nonempty line and expands the home prefix", () => {
		const f = fixture();
		f.put(".codex-picked/auth.json", "{}");
		f.put("selected-home", "\n  ~/.codex-picked\nignored\n");
		f.put(
			".config/shepherd/config.json",
			JSON.stringify({ codex: { homeFile: "~/selected-home" } }),
		);
		const result = f.run();
		expect(check(result, "config:user").status).toBe("ok");
		expect(
			check(result, `codex:home:${f.home}/.codex-picked`).summary,
		).toContain("(config): logged in");
		expect(
			result.checks.filter((entry) => entry.id.startsWith("codex:home:")),
		).toHaveLength(1);
	});

	test("missing homeFile and invalid user config stay diagnostic", () => {
		const f = fixture();
		f.put(
			".config/shepherd/config.json",
			JSON.stringify({ codex: { homeFile: `${f.home}/missing-file` } }),
		);
		expect(check(f.run(), "config:user").edit).toContain(
			`${f.home}/missing-file:`,
		);
		f.put(
			".config/shepherd/config.json",
			JSON.stringify({ unknown: 1, windows: { doneDays: -1 } }),
		);
		expect(
			f.run().checks.filter((entry) => entry.id === "config:user"),
		).toHaveLength(2);
	});
	test("relative CODEX_HOME is a config gap", () => {
		const f = fixture();
		f.toolEnv.env = { ...f.toolEnv.env, CODEX_HOME: "relative" };
		expect(check(f.run(), "config:user").edit).toBe(
			"CODEX_HOME is not an absolute path: relative",
		);
	});
	test("homes follow config, environment, sorted discovery and deduplicate realpaths", () => {
		const f = fixture();
		f.put(".codex/auth.json", "{}");
		mkdirSync(join(f.home, ".codex-work"));
		symlinkSync(join(f.home, ".codex"), join(f.home, ".codex-alias"));
		f.put(
			".config/shepherd/config.json",
			JSON.stringify({ codex: { home: "~/.codex-alias" } }),
		);
		f.toolEnv.env = { ...f.toolEnv.env, CODEX_HOME: join(f.home, ".codex") };
		const homes = f
			.run()
			.checks.filter((entry) => entry.id.startsWith("codex:home:"));
		expect(homes.map((entry) => entry.subject)).toEqual([
			`${f.home}/.codex-alias`,
			`${f.home}/.codex-work`,
		]);
		expect(homes.map((entry) => entry.status)).toEqual(["ok", "gap"]);
		expect(homes[0]?.summary).toContain("logged in (auth.json present)");
	});
	test("absent HOME still checks explicit config and environment homes", () => {
		const f = fixture({ absent: true });
		const explicit = join(f.root, "explicit");
		mkdirSync(explicit);
		writeFileSync(join(explicit, "auth.json"), "{}");
		const configDir = join(f.root, "config");
		mkdirSync(join(configDir, "shepherd"), { recursive: true });
		writeFileSync(
			join(configDir, "shepherd/config.json"),
			JSON.stringify({ codex: { home: explicit } }),
		);
		f.toolEnv.env = {
			...f.toolEnv.env,
			XDG_CONFIG_HOME: configDir,
			CODEX_HOME: join(f.root, "missing"),
		};
		const result = f.run();
		expect(check(result, `codex:home:${explicit}`).status).toBe("ok");
		expect(check(result, `codex:home:${f.root}/missing`).edit).toBe(
			`mkdir -p '${f.root}/missing'\nCODEX_HOME='${f.root}/missing' codex login`,
		);
		expect(
			result.checks.filter((entry) => entry.id === "codex:home"),
		).toHaveLength(1);
	});
	test.skipIf(process.getuid?.() === 0)(
		"unlistable HOME still checks explicit home",
		() => {
			const f = fixture();
			mkdirSync(join(f.root, "explicit"));
			f.toolEnv.env = {
				...f.toolEnv.env,
				CODEX_HOME: join(f.root, "explicit"),
			};
			chmodSync(f.home, 0);
			try {
				const result = f.run();
				expect(check(result, "codex:home").summary).toStartWith(
					"Codex homes under HOME not listed:",
				);
				expect(check(result, `codex:home:${f.root}/explicit`).status).toBe(
					"gap",
				);
			} finally {
				chmodSync(f.home, 0o700);
			}
		},
	);
	test("edits quote spaces, apostrophes and dollars with absolute paths", () => {
		const f = fixture({ homeName: "home with ' and $" });
		mkdirSync(join(f.home, ".codex-work"));
		f.toolEnv.execPath = join(f.home, "bin/shepherd");
		const result = f.run();
		const escaped = f.home.replaceAll("'", "'\\''");
		expect(check(result, "path:shepherd").edit).toBe(
			`add to your shell rc: export PATH='${escaped}/bin':"$PATH"`,
		);
		expect(check(result, `codex:home:${f.home}/.codex-work`).edit).toBe(
			`CODEX_HOME='${escaped}/.codex-work' codex login`,
		);
		expect(doctorJson(result).home).toBe(f.home);
	});
	test("shepherd must be executable and resolve to execPath, including symlinks", () => {
		const f = fixture();
		f.toolEnv.execPath = join(f.bin, "claude");
		expect(check(f.run(), "path:shepherd").status).toBe("gap");
		symlinkSync(f.toolEnv.execPath, join(f.bin, "shepherd"));
		expect(check(f.run(), "path:shepherd").status).toBe("ok");
		chmodSync(f.toolEnv.execPath, 0o644);
		expect(check(f.run(), "path:shepherd").status).toBe("gap");
		delete f.toolEnv.execPath;
		expect(check(f.run(), "path:shepherd").status).toBe("skip");
	});
	test("PATH ignores directories and nonexecutable files, and absent PATH has no entries", () => {
		const f = fixture({ bins: [] });
		mkdirSync(join(f.bin, "claude"));
		writeFileSync(join(f.bin, "jq"), "");
		chmodSync(join(f.bin, "jq"), 0o644);
		expect(check(f.run(), "path:claude").status).toBe("gap");
		expect(check(f.run(), "path:jq").status).toBe("gap");
		const localClaude = f.put("claude", "");
		chmodSync(localClaude, 0o755);
		f.toolEnv.env = {};
		expect(check(f.run(), "path:claude").status).toBe("gap");
		f.toolEnv.env = { PATH: "" };
		expect(check(f.run(), "path:claude").status).toBe("ok");
	});

	test("settings location uses only absolute CLAUDE_CONFIG_DIR", () => {
		const f = fixture();
		const file = f.put("alternate/settings.json", "null");
		f.toolEnv.env = {
			...f.toolEnv.env,
			CLAUDE_CONFIG_DIR: join(f.home, "alternate"),
		};
		expect(check(f.run(), "claude:settings").subject).toBe(file);
		f.toolEnv.env = { ...f.toolEnv.env, CLAUDE_CONFIG_DIR: "relative" };
		expect(check(f.run(), "claude:settings").subject).toBe(
			`${f.home}/.claude/settings.json`,
		);
	});
	for (const contents of ["null", "[]", "bad"]) {
		test(`malformed Codex hooks ${contents} are a gap`, () => {
			const f = fixture();
			f.put(".codex/hooks.json", contents);
			expect(check(f.run(), `codex:herdr-hook:${f.home}/.codex`).status).toBe(
				"gap",
			);
		});
	}
	test("Codex configured without executable gets the install edit", () => {
		const f = fixture({ bins: [] });
		f.put(".config/shepherd/config.json", '{"codex":{}}');
		expect(check(f.run(), "path:codex").edit).toBe(
			"install the Codex CLI: https://github.com/openai/codex",
		);
	});
});

test("human mixed rendering and JSON schema", () => {
	const result = {
		home: "/fake/home",
		today: "2026-10-06",
		checks: [
			{
				id: "path:claude",
				status: "ok" as const,
				summary: "claude on PATH: /fake/bin/claude",
			},
			{
				id: "claude:status-line",
				status: "gap" as const,
				subject: "/fake/home/.claude/settings.json",
				summary: "no status line showing context %",
				edit: 'in /fake/home/.claude/settings.json add:\n"statusLine": {}',
			},
			{
				id: "path:herdr",
				status: "skip" as const,
				summary: "herdr not on PATH",
			},
		],
		totals: { ok: 1, gap: 1, skip: 1 },
	};
	expect(renderDoctor(result)).toBe(
		'Shepherd doctor, home /fake/home, 2026-10-06\n\nOK    claude on PATH: /fake/bin/claude\nGAP   /fake/home/.claude/settings.json: no status line showing context %\n      in /fake/home/.claude/settings.json add:\n      "statusLine": {}\nSKIP  herdr not on PATH\n\n1 ok, 1 gap, 1 skipped',
	);
	expect(doctorJson(result)).toEqual({
		schema: 1,
		command: "doctor",
		...result,
	});
	expect(JSON.parse(JSON.stringify(doctorJson(result)))).toEqual(
		doctorJson(result),
	);
});
