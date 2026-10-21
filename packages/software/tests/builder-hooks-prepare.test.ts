// builder-hooks prepare, help and envelopes (BH-1 to BH-4), run through the
// extracted package's launcher on throwaway repositories.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Fixture, spawn, tool } from "./builder-hooks-fixture";

let f: Fixture;
beforeEach(() => {
	f = new Fixture();
});
afterEach(() => f.cleanup());

const settingsOf = (f: Fixture) =>
	JSON.parse(
		readFileSync(join(f.runDir, "builder-hooks.settings.json"), "utf8"),
	);

describe("BH-1: package and interface", () => {
	test("MODULE.md declares a write tool that requires bun and git", () => {
		const module = readFileSync(join(tool, "../../MODULE.md"), "utf8");
		expect(module).toContain(
			"  builder-hooks:\n    description: Prepare a Claude Code builder's hook settings, run its guard, health and Stop hooks, and re-check its work\n    access: write\n    requires: [bun, git]\n",
		);
		expect(statSync(tool).mode & 0o111).not.toBe(0);
	});

	test("help needs neither a manifest nor a repository", () => {
		const r = f.run(["--help"], { cwd: "/" });
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("usage: builder-hooks <mode>");
		expect(f.run(["prepare", "--help"], { cwd: "/" }).code).toBe(0);
	});

	test("hook modes refuse --json in their own protocol", () => {
		const guard = f.hook("guard", {}, {});
		expect(guard.code).toBe(2);
		const withJson = f.run(["guard", "--json"], { stdin: "{}" });
		expect(withJson.code).toBe(2);
		expect(withJson.stderr).toBe(
			"Role guard could not run: the guard takes no arguments (--json). The call is refused until the host repairs the hooks.\n",
		);
		const stop = f.run(["stop", "--json"], { stdin: "{}" });
		expect(stop.code).toBe(0);
		expect(stop.stdout).toBe("");
		expect(stop.stderr).toContain("Stop gate could not run:");
		const health = f.run(["health", "--json"], { stdin: "{}" });
		expect(health).toEqual({
			code: 0,
			stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "health check could not run on the edited file: it takes no arguments (--json)" } })}\n`,
			stderr: "",
		});
	});

	test("prepare and recheck speak the contract-1 envelope, errors included", () => {
		const ok = f.prepare(f.input());
		expect(ok.code).toBe(0);
		expect(Object.keys(ok.json)).toEqual([
			"contract",
			"tool",
			"command",
			"status",
			"findings",
			"failing",
			"result",
		]);
		expect(ok.json).toMatchObject({
			contract: 1,
			tool: "builder-hooks",
			command: "prepare",
			status: "clean",
			failing: 0,
			result: { complete: true },
		});
		const recheck = f.run(["recheck", "--manifest", f.manifest, "--json"]);
		expect(JSON.parse(recheck.stdout)).toMatchObject({
			contract: 1,
			tool: "builder-hooks",
			command: "recheck",
		});
		const bad = f.run([
			"recheck",
			"--manifest",
			"/nonexistent/m.json",
			"--json",
		]);
		expect(bad.code).toBe(2);
		expect(JSON.parse(bad.stdout)).toMatchObject({
			contract: 1,
			tool: "builder-hooks",
			command: "recheck",
			status: "error",
			findings: [],
			failing: 0,
			result: { complete: false },
			error: { code: "manifest-invalid" },
		});
		const usage = f.run(["prepare", "--json"]);
		expect(usage.code).toBe(2);
		expect(JSON.parse(usage.stdout).error.code).toBe("usage");
		expect(f.run(["frobnicate"]).code).toBe(2);
	});
});

describe("BH-2: runtime isolation", () => {
	test("the caller's bunfig preload, .env and git drivers stay inert", () => {
		const canary = join(f.root, "canary");
		writeFileSync(
			join(f.root, "preload.ts"),
			`require("node:fs").writeFileSync(${JSON.stringify(canary)}, "preload");\n`,
		);
		writeFileSync(join(f.root, "bunfig.toml"), `preload = ["./preload.ts"]\n`);
		writeFileSync(
			join(f.root, ".env"),
			"BUILDER_HOOKS_TEST_INTERRUPT=before-settings\n",
		);
		f.write("bunfig.toml", `preload = ["../preload.ts"]\n`);
		f.write(".env", "BUILDER_HOOKS_TEST_INTERRUPT=before-settings\n");
		f.write(".gitattributes", "*.md diff=evil\n");
		f.git("config", "diff.evil.command", `touch ${canary}`);
		f.git("config", "diff.evil.textconv", `touch ${canary}`);
		f.commit("Hostile");
		f.write("README.md", "changed\n");
		const r = f.prepare(f.input());
		expect(r.code).toBe(0);
		expect(r.json.result.repo).toBe(f.repo);
		f.run(["recheck", "--manifest", f.manifest]);
		f.hook("stop", { session_id: "s1", stop_hook_active: false });
		expect(existsSync(canary)).toBe(false);
	});
});

describe("BH-2: git filter drivers", () => {
	test("clean, smudge and process filters configured anywhere never run in the hooks", () => {
		const canary = join(f.root, "filter-canary");
		const script = join(f.root, "filter.sh");
		writeFileSync(script, `#!/bin/sh\ntouch '${canary}'\ncat\n`, {
			mode: 0o755,
		});
		f.write(".gitattributes", "*.txt filter=review\n");
		f.write("tracked.txt", "one\n");
		f.commit("Filtered file");
		for (const kind of ["clean", "smudge", "process"])
			f.git("config", `filter.review.${kind}`, script);
		f.write("tracked.txt", "two\n");
		expect(f.prepare(f.input()).code).toBe(0);
		expect(
			f.hook("stop", { session_id: "s1", stop_hook_active: false }),
		).toEqual({ code: 0, stdout: "", stderr: "" });
		const r = f.run(["recheck", "--manifest", f.manifest, "--json"]);
		expect(JSON.parse(r.stdout).result.scope).toContain("tracked.txt");
		expect(existsSync(canary)).toBe(false);
	});
});

describe("BH-2: a filter listing that fails", () => {
	test("is an inability in every mode", () => {
		f.prepare(f.input());
		const config = join(f.repo, ".git/config");
		writeFileSync(config, `${readFileSync(config, "utf8")}[broken\n`);
		const why = "the git configuration cannot be listed";
		const guard = f.hook("guard", {
			tool_name: "Bash",
			tool_input: { command: "echo ok" },
		});
		expect(guard.code).toBe(2);
		expect(guard.stderr).toContain(why);
		const health = f.hook("health", {
			tool_name: "Edit",
			tool_input: { file_path: join(f.repo, "README.md") },
		});
		expect(health.code).toBe(0);
		expect(
			JSON.parse(health.stdout).hookSpecificOutput.additionalContext,
		).toContain(why);
		const stop = f.hook("stop", { session_id: "s1", stop_hook_active: false });
		expect(stop.code).toBe(2);
		expect(stop.stderr).toContain(why);
		const r = f.run(["recheck", "--manifest", f.manifest, "--json"]);
		expect(r.code).toBe(2);
		expect(JSON.stringify(JSON.parse(r.stdout).findings)).toContain(why);
		f.runDir = join(f.root, "run2");
		const again = f.prepare(f.input());
		expect(again.code).toBe(2);
		expect(again.json.error.message).toContain(why);
	});
});

describe("BH-2: a filter whose name cannot be neutralized", () => {
	test("is an inability in every mode, and never runs", () => {
		const canary = join(f.root, "filter-canary");
		const script = join(f.root, "filter.sh");
		writeFileSync(script, `#!/bin/sh\ntouch '${canary}'\ncat\n`, {
			mode: 0o755,
		});
		f.write(".gitattributes", "*.txt filter=a=b\n");
		f.write("tracked.txt", "one\n");
		f.commit("Filtered file");
		f.git("config", "filter.a=b.clean", script);
		f.write("tracked.txt", "two\n");
		expect(f.prepare(f.input()).code).toBe(2);
		f.git("config", "--unset", "filter.a=b.clean");
		expect(f.prepare(f.input()).code).toBe(0);
		f.git("config", "filter.a=b.clean", script);
		const why = 'the git filter "a=b" cannot be neutralized';
		const stop = f.hook("stop", { session_id: "s1", stop_hook_active: false });
		expect(stop.code).toBe(2);
		expect(stop.stderr).toContain(why);
		const guard = f.hook("guard", {
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		expect(guard.code).toBe(2);
		expect(guard.stderr).toContain(why);
		const health = f.hook("health", {
			tool_name: "Edit",
			tool_input: { file_path: join(f.repo, "tracked.txt") },
		});
		expect(health.code).toBe(0);
		expect(
			JSON.parse(health.stdout).hookSpecificOutput.additionalContext,
		).toContain(why);
		const r = f.run(["recheck", "--manifest", f.manifest, "--json"]);
		expect(r.code).toBe(2);
		expect(JSON.parse(r.stdout).findings).toContainEqual(
			expect.objectContaining({
				code: "check-could-not-run",
				message: `scope: ${why}`,
			}),
		);
		expect(existsSync(canary)).toBe(false);
	});
});

describe("BH-3: preparation boundaries and shared policy", () => {
	test("publishes private files, settings path on stdout, resolved base and exact exclusions", () => {
		const first = f.git("rev-parse", "HEAD");
		f.write("app/a.rb", "a\n");
		f.commit("Second");
		const file = join(f.root, "input.json");
		const input = f.input({
			base: "HEAD~1",
			excluded: ["config/deploy.yml", "app/admin/**"],
		});
		writeFileSync(file, JSON.stringify(input));
		const text = f.run(["prepare", "--input", file, "--run-dir", f.runDir]);
		expect(text.code).toBe(0);
		expect(text.stdout).toBe(
			`${join(f.runDir, "builder-hooks.settings.json")}\n`,
		);
		const manifest = JSON.parse(readFileSync(f.manifest, "utf8"));
		expect(manifest).toEqual({
			role: "builder",
			repo: f.repo,
			base: first,
			history_writes: true,
			excluded: ["config/deploy.yml", "app/admin/**"],
			gates: {},
			contract_tests:
				"from docs/contracts/*.md whose covers intersects the diff",
			health: { stacks: [], recheck: [] },
			log: f.log,
		});
		expect(statSync(f.runDir).mode & 0o777).toBe(0o700);
		for (const name of readdirSync(f.runDir))
			expect({
				name,
				mode: statSync(join(f.runDir, name)).mode & 0o777,
			}).toEqual({
				name,
				mode: name.endsWith(".sh") ? 0o700 : 0o600,
			});
		expect(readdirSync(f.runDir).sort()).toEqual([
			"builder-hooks.settings.json",
			"builder-manifest.json",
			"guard.sh",
			"health.sh",
			"stop.sh",
		]);
	});

	test("JSON reports the same base and exclusions the manifest holds", () => {
		const r = f.prepare(f.input({ excluded: ["db/**"] }));
		const manifest = JSON.parse(readFileSync(f.manifest, "utf8"));
		expect(r.json.result.base).toBe(manifest.base);
		expect(r.json.result.excluded).toEqual(manifest.excluded);
		expect(r.json.result.excluded).toEqual(["db/**"]);
		expect(r.json.result.settings).toBe(
			join(f.runDir, "builder-hooks.settings.json"),
		);
	});

	test("history authority defaults to true and false carries a warning", () => {
		const r = f.prepare(f.input());
		expect(r.json.result.history_writes).toBe(true);
		expect(r.json.result.warnings).toEqual([]);
		const g = new Fixture();
		try {
			const r = g.prepare(g.input({ history_writes: false }));
			expect(r.json.result.history_writes).toBe(false);
			expect(r.json.result.warnings).toEqual([
				'history_writes is false: the brief must say "leave the change uncommitted; the host commits after recheck"',
			]);
		} finally {
			g.cleanup();
		}
	});

	test("refuses invalid fields, other roles, tuning and unknown keys", () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ role: "reviewer" }, 'role is "reviewer"'],
			[{ budget_ms: 5 }, "unknown field: budget_ms"],
			[{ log: "/tmp/x" }, "unknown field: log"],
			[{ history_writes: "yes" }, "history_writes is not true or false"],
			[
				{ contract_tests: "'test/a.rb' 'test/b.rb'" },
				"neither the discovery sentinel nor a list",
			],
			[
				{ contract_tests: ["../x_test.rb"] },
				"is not a repository-relative path",
			],
			[{ contract_tests: ["test/missing_test.rb"] }, "absent at the base"],
			[{ excluded: ["!keep"] }, "is a negation"],
			[
				{
					gates: {
						test: { argv: ["bin/rails", "test"], include: ["test/**"] },
					},
				},
				"needs {files} exactly once",
			],
			[
				{
					gates: {
						lint: { argv: ["sh", "-c", "rubocop {files}"], include: [] },
					},
				},
				"runs sh",
			],
			[
				{
					gates: {
						lint: { argv: ["bin/rubocop", "-a", "{files}"], include: [] },
					},
				},
				"repairs, formats or installs (-a)",
			],
			[
				{
					gates: {
						lint: { argv: ["bin/rubocop", "$(evil)", "{files}"], include: [] },
					},
				},
				"shell syntax",
			],
			[
				{ health: { stacks: [], recheck: [["bundle", "install"]] } },
				"repairs, formats or installs (install)",
			],
			[{ base: "no-such-ref" }, "is not a commit"],
			[{ excluded: ["/etc/hosts"] }, "is not repository-relative"],
		];
		for (const [extra, message] of cases) {
			const g = new Fixture();
			try {
				const r = g.prepare(g.input(extra));
				expect({ extra, code: r.code }).toEqual({ extra, code: 2 });
				expect(r.json.error.message).toContain(message);
				expect(existsSync(join(g.runDir, "builder-hooks.settings.json"))).toBe(
					false,
				);
			} finally {
				g.cleanup();
			}
		}
	});

	test("refuses destinations inside the repository, git directory or harness configuration, and symlink escapes", () => {
		const file = join(f.root, "input.json");
		writeFileSync(file, JSON.stringify(f.input()));
		const tryDir = (dir: string, env: Record<string, string> = {}) =>
			f.run(["prepare", "--input", file, "--run-dir", dir], { env });
		expect(tryDir(join(f.repo, "run")).stderr).toContain(
			"inside the repository",
		);
		expect(tryDir(join(f.repo, ".git/run")).stderr).toContain(
			"inside the repository",
		);
		symlinkSync(f.repo, join(f.root, "alias"));
		expect(tryDir(join(f.root, "alias/run")).stderr).toContain(
			"inside the repository",
		);
		expect(tryDir(join(f.root, "x/.claude/run")).stderr).toContain(
			"harness configuration",
		);
		const home = join(f.root, "home");
		mkdirSync(join(home, "cfg"), { recursive: true });
		expect(
			tryDir(join(home, "cfg/run"), { CLAUDE_CONFIG_DIR: join(home, "cfg") })
				.stderr,
		).toContain("is inside");
		mkdirSync(join(f.root, "full"));
		writeFileSync(join(f.root, "full/x"), "");
		expect(tryDir(join(f.root, "full")).stderr).toContain("is not empty");
		expect(f.git("status", "--porcelain")).toBe("");
	});

	test("an existing run is never overwritten", () => {
		expect(f.prepare(f.input()).code).toBe(0);
		const before = readFileSync(f.manifest, "utf8");
		const again = f.prepare(f.input({ excluded: ["x"] }));
		expect(again.code).toBe(2);
		expect(again.json.error.message).toContain("is not empty");
		expect(readFileSync(f.manifest, "utf8")).toBe(before);
	});

	test("an interrupted preparation leaves no settings", () => {
		const file = join(f.root, "input.json");
		writeFileSync(file, JSON.stringify(f.input()));
		const r = f.run(["prepare", "--input", file, "--run-dir", f.runDir], {
			env: { BUILDER_HOOKS_TEST_INTERRUPT: "before-settings" },
		});
		expect(r.code).not.toBe(0);
		expect(existsSync(f.manifest)).toBe(true);
		expect(existsSync(join(f.runDir, "builder-hooks.settings.json"))).toBe(
			false,
		);
	});
});

describe("BH-4: settings artifacts", () => {
	test("three hooks with their matchers, timeouts, failure policy and hooks enabled", () => {
		f.prepare(f.input());
		const s = settingsOf(f);
		expect(s.disableAllHooks).toBe(false);
		expect(Object.keys(s.hooks)).toEqual(["PreToolUse", "PostToolUse", "Stop"]);
		const [pre] = s.hooks.PreToolUse;
		expect(pre.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
		expect(pre.hooks[0]).toMatchObject({
			type: "command",
			timeout: 2,
			onFailure: "block",
		});
		const [post] = s.hooks.PostToolUse;
		expect(post.matcher).toBe("Edit|Write|MultiEdit");
		expect(post.hooks[0]).toMatchObject({ type: "command", timeout: 3 });
		expect(post.hooks[0].onFailure).toBeUndefined();
		const [stop] = s.hooks.Stop;
		expect(stop.matcher).toBeUndefined();
		expect(stop.hooks[0]).toMatchObject({ type: "command", timeout: 125 });
		expect(stop.hooks[0].onFailure).toBeUndefined();
		expect(stop.hooks[0].command).toBe(`'${join(f.runDir, "stop.sh")}'`);
	});

	test("the settings commands are the three wrapper paths and nothing else", () => {
		f.prepare(f.input());
		const s = settingsOf(f);
		const commands = ["PreToolUse", "PostToolUse", "Stop"].map(
			(event) => s.hooks[event][0].hooks[0].command,
		);
		expect(commands).toEqual(
			["guard.sh", "health.sh", "stop.sh"].map(
				(name) => `'${join(f.runDir, name)}'`,
			),
		);
		for (const name of ["guard.sh", "health.sh", "stop.sh"]) {
			const wrapper = join(f.runDir, name);
			expect(statSync(wrapper).mode & 0o777).toBe(0o700);
			const text = readFileSync(wrapper, "utf8");
			expect(text).toStartWith("#!/bin/sh\n");
			expect(text).toContain(`'${tool}'`);
			expect(text).toContain(`SHEPHERD_HOOK_MANIFEST='${f.manifest}'`);
			expect(text).toContain(`log='${f.log}'`);
		}
	});

	test("with the launcher present each wrapper answers as the launcher does", () => {
		f.prepare(f.input({ history_writes: false }));
		const events = {
			guard: {
				session_id: "s",
				tool_name: "Bash",
				tool_input: { command: "git commit -m x" },
			},
			health: {
				session_id: "s",
				tool_name: "Edit",
				tool_input: { file_path: join(f.repo, "README.md") },
			},
			stop: { session_id: "s", stop_hook_active: false },
		};
		for (const [mode, event] of Object.entries(events)) {
			const wrapped = spawn(
				["/bin/sh", "-c", `'${join(f.runDir, `${mode}.sh`)}'`],
				{
					cwd: f.repo,
					env: f.env(),
					input: JSON.stringify(event),
				},
			);
			expect({ mode, r: wrapped }).toEqual({ mode, r: f.hook(mode, event) });
		}
		expect(
			f
				.logLines()
				.map((l) => l.split(" ").slice(1, 2).concat(l.split(" ").slice(5, 6))),
		).toEqual([
			["guard", "DENY"],
			["guard", "DENY"],
			["health", "CLEAN"],
			["health", "CLEAN"],
			["stop", "PASS"],
			["stop", "PASS"],
		]);
	});

	test("generated commands run with no shepherd on PATH, from a path with hostile characters", () => {
		const g = new Fixture();
		try {
			g.runDir = join(g.root, "it's $(x) `y` run");
			g.prepare(g.input({ history_writes: false }));
			const s = settingsOf(g);
			const guard = s.hooks.PreToolUse[0].hooks[0].command as string;
			const child = spawn(["/bin/sh", "-c", guard], {
				cwd: g.repo,
				env: {
					PATH: `${process.env.PATH}`
						.split(":")
						.filter((p) => !existsSync(join(p, "shepherd")))
						.join(":"),
					HOME: g.root,
				},
				input: JSON.stringify({
					session_id: "s",
					tool_name: "Bash",
					tool_input: { command: "git commit -m x" },
				}),
			});
			expect(child.stderr).toBe("");
			expect(
				JSON.parse(child.stdout).hookSpecificOutput.permissionDecision,
			).toBe("deny");
			expect(existsSync(join(g.root, "x"))).toBe(false);
		} finally {
			g.cleanup();
		}
	});

	test("the guard wrapper refuses when its launcher is missing or not executable", () => {
		const launcher = f.ownPackage();
		f.prepare(f.input());
		const guard = settingsOf(f).hooks.PreToolUse[0].hooks[0].command as string;
		const refused = `Role guard could not run: the launcher ${launcher} is missing or not executable. The call is refused until the host repairs the hooks.\n`;
		chmodSync(launcher, 0o644);
		expect(spawn(["/bin/sh", "-c", guard], { input: "{}" })).toEqual({
			code: 2,
			stdout: "",
			stderr: refused,
		});
		renameSync(launcher, `${launcher}-gone`);
		expect(spawn(["/bin/sh", "-c", guard], { input: "{}" })).toEqual({
			code: 2,
			stdout: "",
			stderr: refused,
		});
	});

	test("the settings hold only the builder's entries, never the project's", () => {
		f.write(
			".claude/settings.json",
			JSON.stringify({
				hooks: { Stop: [{ hooks: [{ type: "command", command: "./x.sh" }] }] },
			}),
		);
		f.commit("Project hooks");
		f.prepare(f.input());
		const s = settingsOf(f);
		expect(s.hooks.Stop).toHaveLength(1);
		expect(s.hooks.Stop[0].hooks[0].command).toEndWith("/stop.sh'");
		expect(f.run(["prepare", "--copy-project-hooks"]).code).toBe(2);
	});

	test("an unreadable input is an environment error", () => {
		const r = f.run([
			"prepare",
			"--input",
			join(f.root, "none.json"),
			"--run-dir",
			f.runDir,
		]);
		expect(r.code).toBe(2);
		chmodSync(f.root, 0o755);
	});
});
