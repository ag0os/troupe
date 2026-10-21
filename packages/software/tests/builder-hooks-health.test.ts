// builder-hooks health (BH-8 to BH-10): one fake checker on the edited file,
// silent when clean or unadopted, context when it finds or cannot run.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	readFileSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Fixture, spawn } from "./builder-hooks-fixture";

// Code points, so this file holds no dash for publish-check to find.
const DASH = String.fromCodePoint(0x2d);

let f: Fixture;
let checker: string;
beforeEach(() => {
	f = new Fixture();
	checker = f.fake("checker");
	f.write(".rubocop_todo.yml", "# floor\n");
	f.write("app/a.rb", "a\n");
	f.commit("Floor");
});
afterEach(() => f.cleanup());

const offense = (cop: string, message: string, line: number) => ({
	cop_name: cop,
	message,
	location: { start_line: line },
});
const rubocop = (...offenses: unknown[]) =>
	JSON.stringify({
		summary: { offense_count: offenses.length, inspected_file_count: 1 },
		files: [{ path: "x", offenses }],
	});

function prepare(floor: string | null = ".rubocop_todo.yml", argv?: string[]) {
	const r = f.prepare(
		f.input({
			health: {
				stacks: [
					{
						extensions: [".rb"],
						argv: argv ?? [checker, `${DASH}${DASH}format`, "json", "{file}"],
						format: "rubocop-json",
						floor,
					},
				],
				recheck: [],
			},
		}),
	);
	expect(r.code).toBe(0);
}

const edited = (file: string) =>
	f.hook("health", {
		session_id: "s1",
		tool_name: "Edit",
		tool_input: { file_path: join(f.repo, file) },
	});
// The mark a wrapper sets on a log it checked; the launcher run directly
// writes a fallback line only with it.
const CHECKED = { BUILDER_HOOKS_LOG_CHECKED: "1" };
const context = (text: string) =>
	`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } })}\n`;

describe("BH-8: health findings and silence", () => {
	test("a finding over the floor becomes the exact context", () => {
		prepare();
		f.set(
			"checker",
			"out",
			rubocop(
				offense(
					"Metrics/MethodLength",
					"Method has too many lines. [12/10]",
					90,
				),
			),
		);
		f.set("checker", "code", "1");
		expect(edited("app/a.rb")).toEqual({
			code: 0,
			stdout: context(
				"Health check on app/a.rb: Metrics/MethodLength 12 over the floor 10 at 90. Keep complexity at or below the base: split the logic into small helpers.",
			),
			stderr: "",
		});
		expect(f.recorded()).toEqual([
			`checker ${DASH}${DASH}format json app/a.rb`,
		]);
		expect(f.logLines().at(-1)).toMatch(
			/ health \S+\/bin\/checker \S+\/repo\/app\/a\.rb \d+ms FINDING 1 findings session=s1$/,
		);
	});

	test("clean output is silent", () => {
		prepare();
		f.set("checker", "out", rubocop());
		expect(edited("app/a.rb")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(f.logLines().at(-1)).toContain(" CLEAN no findings");
	});

	test("a file with no stack command is skipped silently", () => {
		prepare();
		expect(edited("README.md")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(f.recorded()).toEqual([]);
		expect(f.logLines().at(-1)).toContain(" CLEAN no-stack-command");
	});

	test("unadopted metrics run nothing, say nothing and log COULD-NOT-RUN", () => {
		for (const floor of [null, "missing_todo.yml"]) {
			const g = f;
			g.cleanup();
			f = new Fixture();
			checker = f.fake("checker");
			f.write("app/a.rb", "a\n");
			f.commit("Files");
			prepare(floor);
			expect(edited("app/a.rb")).toEqual({ code: 0, stdout: "", stderr: "" });
			expect(f.recorded()).toEqual([]);
			expect(f.logLines().at(-1)).toContain(
				" COULD-NOT-RUN metrics not adopted: no committed todo floor",
			);
		}
	});

	test("a floor present now but not committed at the base is not adopted", () => {
		f.git("rm", "-q", ".rubocop_todo.yml");
		f.commit("Drop floor");
		f.write(".rubocop_todo.yml", "# uncommitted\n");
		prepare();
		expect(edited("app/a.rb").stdout).toBe("");
		expect(f.recorded()).toEqual([]);
	});
});

describe("BH-8: a path through a symlink to the repository", () => {
	test("an Edit through a repository alias checks the file it names", () => {
		prepare();
		symlinkSync(f.repo, join(f.root, "repo-alias"));
		f.set("checker", "out", rubocop());
		f.hook("health", {
			session_id: "s1",
			tool_name: "Edit",
			tool_input: { file_path: join(f.root, "repo-alias/app/a.rb") },
		});
		expect(f.recorded()).toEqual([
			`checker ${DASH}${DASH}format json app/a.rb`,
		]);
	});
});

describe("BH-8: a result that inspected no file", () => {
	test("is silent and logged clean with that reason", () => {
		prepare();
		f.set(
			"checker",
			"out",
			JSON.stringify({
				summary: { offense_count: 0, inspected_file_count: 0 },
				files: [],
			}),
		);
		expect(edited("app/a.rb")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(f.logLines().at(-1)).toContain(" CLEAN no file inspected");
	});
});

describe("BH-9: health inability and budget", () => {
	test("a missing checker", () => {
		prepare(".rubocop_todo.yml", [join(f.root, "bin/none"), "{file}"]);
		expect(edited("app/a.rb")).toEqual({
			code: 0,
			stdout: context(
				`health check could not run on app/a.rb: ${join(f.root, "bin/none")} is not found`,
			),
			stderr: "",
		});
		expect(f.logLines().at(-1)).toContain(
			" COULD-NOT-RUN health check could not run on app/a.rb",
		);
	});

	test("malformed output, a finding without a value, and a failing exit", () => {
		prepare();
		f.set("checker", "out", "not json");
		expect(edited("app/a.rb").stdout).toBe(
			context(
				"health check could not run on app/a.rb: its output is not rubocop JSON",
			),
		);
		f.set("checker", "out", rubocop(offense("Style/X", "no numbers here", 3)));
		f.set("checker", "code", "1");
		expect(edited("app/a.rb").stdout).toBe(
			context(
				"health check could not run on app/a.rb: a finding without a cop, a value or a line",
			),
		);
		f.set("checker", "out", rubocop());
		f.set("checker", "code", "3");
		expect(edited("app/a.rb").stdout).toBe(
			context("health check could not run on app/a.rb: it exited 3"),
		);
		expect(
			f.logLines().filter((l) => l.includes(" COULD-NOT-RUN ")),
		).toHaveLength(3);
	});

	test("a sleeping checker is stopped at the budget with its descendants, and leaves no delayed side effect", async () => {
		const late = join(f.root, "late");
		const sleeper = join(f.root, "bin/sleeper");
		writeFileSync(
			sleeper,
			`#!/bin/sh\n(sleep 3; touch '${late}') &\nsleep 5\n`,
			{ mode: 0o755 },
		);
		prepare(".rubocop_todo.yml", [sleeper, "{file}"]);
		const started = Date.now();
		const r = edited("app/a.rb");
		expect(Date.now() - started).toBeLessThan(4000);
		expect(r).toEqual({
			code: 0,
			stdout: context("health check did not finish on app/a.rb within 2 s"),
			stderr: "",
		});
		await Bun.sleep(2000);
		expect(existsSync(late)).toBe(false);
		expect(f.logLines().at(-1)).toContain(
			" COULD-NOT-RUN health check did not finish on app/a.rb within 2 s",
		);
	});

	test("a result whose shape or exit disagrees with its offenses is an inability", () => {
		prepare();
		const cases: [string, string, string][] = [
			[
				JSON.stringify({ summary: {}, files: [{ path: "x", offenses: [] }] }),
				"1",
				"its exit 1 disagrees with its 0 offenses",
			],
			[
				rubocop(offense("Metrics/AbcSize", "too big [20/17]", 4)),
				"0",
				"its exit 0 disagrees with its 1 offenses",
			],
			[JSON.stringify({ files: [] }), "0", "its output is not rubocop JSON"],
			[
				JSON.stringify({ summary: {}, files: [{ path: "x" }] }),
				"0",
				"its output is not rubocop JSON",
			],
		];
		for (const [out, code, why] of cases) {
			f.set("checker", "out", out);
			f.set("checker", "code", code);
			expect(edited("app/a.rb").stdout).toBe(
				context(`health check could not run on app/a.rb: ${why}`),
			);
		}
	});

	test("an escaped NUL inside a JSON string stays valid", () => {
		prepare();
		f.set("checker", "out", rubocop());
		const event = `{"session_id":"s1","tool_name":"Edit","tool_input":{"file_path":"${join(f.repo, "app/a.rb")}","note":"a\\u0000b"}}`;
		const r = f.run(["health"], {
			stdin: event,
			env: {
				SHEPHERD_HOOK_MANIFEST: f.manifest,
				SHEPHERD_HOOK_LOG: f.log,
				...CHECKED,
			},
		});
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(f.recordedArgv("checker")).toEqual([
			[`${DASH}${DASH}format`, "json", "app/a.rb"],
		]);
	});

	test("an event holding a NUL byte is an inability, said as context", () => {
		prepare();
		const event = `{"session_id":"s1","tool_name":"Edit","tool_input":{"file_path":"${join(f.repo, "app/a.rb")}\u0000x"}}`;
		const r = f.run(["health"], {
			stdin: event,
			env: {
				SHEPHERD_HOOK_MANIFEST: f.manifest,
				SHEPHERD_HOOK_LOG: f.log,
				...CHECKED,
			},
		});
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toEndWith(
			": the event is not valid JSON",
		);
		expect(f.recorded()).toEqual([]);
		expect(f.logLines().at(-1)).toContain(
			" COULD-NOT-RUN the event is not valid JSON",
		);
	});

	test("a missing launcher in the generated wrapper and a runtime that exits silently answer as context", () => {
		const launcher = f.ownPackage();
		prepare();
		const settings = JSON.parse(
			readFileSync(join(f.runDir, "builder-hooks.settings.json"), "utf8"),
		);
		const command = settings.hooks.PostToolUse[0].hooks[0].command as string;
		const event = JSON.stringify({
			tool_name: "Edit",
			tool_input: { file_path: join(f.repo, "app/a.rb") },
		});
		renameSync(launcher, `${launcher}-gone`);
		const moved = spawn(["/bin/sh", "-c", command], {
			input: event,
			env: f.env(),
		});
		renameSync(`${launcher}-gone`, launcher);
		expect(moved).toEqual({
			code: 0,
			stdout: context(
				`health check could not run on the edited file: the launcher ${launcher} is missing or not executable`,
			),
			stderr: "",
		});
		expect(f.logLines().at(-1)).toContain(
			" health launcher - 0ms COULD-NOT-RUN the launcher",
		);
		writeFileSync(join(f.bin, "bun"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
		const silent = f.hook("health", JSON.parse(event), CHECKED);
		expect(silent).toEqual({
			code: 0,
			stdout: context(
				`health check could not run on ${join(f.repo, "app/a.rb")}: the runtime exited 7`,
			),
			stderr: "",
		});
		expect(f.logLines().at(-1)).toContain(
			" health launcher - 0ms COULD-NOT-RUN the runtime exited 7",
		);
	});

	test("an unreadable manifest and a missing runtime still answer as context", () => {
		prepare();
		const event = JSON.stringify({
			tool_name: "Edit",
			tool_input: { file_path: "/x/app/a.rb" },
		});
		const garbled = join(f.root, "garbled.json");
		writeFileSync(garbled, "{");
		const bad = f.run(["health"], {
			stdin: event,
			env: { SHEPHERD_HOOK_MANIFEST: garbled },
		});
		expect(bad.code).toBe(0);
		expect(
			JSON.parse(bad.stdout).hookSpecificOutput.additionalContext,
		).toStartWith(
			"health check could not run on /x/app/a.rb: the manifest cannot be read",
		);
		const nobun = f.run(["health"], {
			stdin: event,
			env: {
				PATH: "/nonexistent",
				SHEPHERD_HOOK_LOG: f.log,
				SHEPHERD_HOOK_MANIFEST: f.manifest,
				...CHECKED,
			},
		});
		expect(nobun).toEqual({
			code: 0,
			stdout: context(
				"health check could not run on /x/app/a.rb: bun is not on PATH; this tool requires bun and git",
			),
			stderr: "",
		});
		expect(readFileSync(f.log, "utf8")).toContain(
			" health launcher - 0ms COULD-NOT-RUN bun is not on PATH",
		);
	});
});

describe("BH-10: checker arguments", () => {
	test.each([
		"app/it's.rb",
		"app/with space.rb",
		"app/$(touch pwned).rb",
		"app/`touch pwned`.rb",
	])("%s reaches the checker as one argument", (name) => {
		prepare();
		f.write(name, "x\n");
		f.set("checker", "out", rubocop());
		expect(edited(name).stdout).toBe("");
		expect(f.recorded()).toEqual([`checker ${DASH}${DASH}format json ${name}`]);
		expect(f.recordedArgv("checker")).toEqual([
			[`${DASH}${DASH}format`, "json", name],
		]);
		expect(existsSync(join(f.repo, "pwned"))).toBe(false);
	});

	test("a leading option character never reads as an option", () => {
		prepare();
		const name = `${DASH}${DASH}auto-correct.rb`;
		f.write(name, "x\n");
		f.set("checker", "out", rubocop());
		edited(name);
		expect(f.recorded()).toEqual([
			`checker ${DASH}${DASH}format json ./${name}`,
		]);
	});

	test("templates that repair, install or use the shell are refused at prepare", () => {
		for (const argv of [
			["bin/rubocop", `${DASH}A`, "{file}"],
			["bin/rubocop", `${DASH}${DASH}autocorrect-all`, "{file}"],
			["bin/rubocop", `${DASH}${DASH}auto-gen-config`, "{file}"],
			["bundle", "install"],
			["bin/rubocop", "*.rb", "{file}"],
			["bash", "-c", "rubocop {file}"],
			["bin/rubocop", "{files}"],
			["{file}"],
			["bin/rubocop", `${DASH}aD`, "{file}"],
			["bin/rubocop", `${DASH}DA`, "{file}"],
			["bin/rubocop", `${DASH}Dx`, "{file}"],
		]) {
			const g = new Fixture();
			try {
				const r = g.prepare(
					g.input({
						health: {
							stacks: [
								{
									extensions: [".rb"],
									argv,
									format: "rubocop-json",
									floor: null,
								},
							],
							recheck: [],
						},
					}),
				);
				expect({ argv, code: r.code }).toEqual({ argv, code: 2 });
			} finally {
				g.cleanup();
			}
		}
	});

	test("an empty selection executes nothing", () => {
		prepare();
		f.hook("health", {
			session_id: "s1",
			tool_name: "Edit",
			tool_input: { file_path: join(f.root, "outside.rb") },
		});
		expect(f.recorded()).toEqual([]);
	});
});
