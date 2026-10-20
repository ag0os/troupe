// builder-hooks stop and recheck (BH-11 to BH-17): the changed scope, the
// ordered gates, the reserved stop, the bounded counter, the messages, the
// recheck and the evidence, with fake gates a fixture file controls.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Fixture, tool } from "./builder-hooks-fixture";

const LAST =
	"This is the last attempt: if it still fails, end with a report that says 'still failing after 3 attempts' and what remains.";
const FIX =
	"Fix it before finishing; if it cannot be fixed inside this build's scope, say so and stop.";

let f: Fixture;
let gates: { tests: string; lint: string; exhale: string };

const CONTRACT = `---
component: writing
covers: [app/posts/]
depends_on: []
tests: [test/contract/writing_test.rb]
---
# Contract: writing
`;

beforeEach(() => {
	f = new Fixture();
	gates = {
		tests: f.fake("tests"),
		lint: f.fake("lint"),
		exhale: f.fake("exhale"),
	};
	f.write(".gitignore", "log/\n");
	f.write("app/posts/show.rb", "show\n");
	f.write("app/other.rb", "other\n");
	f.write("test/models/a_test.rb", "a\n");
	f.write("test/system/flow_test.rb", "flow\n");
	f.write("test/contract/writing_test.rb", "w\n");
	f.write("test/extra_test.rb", "e\n");
	f.write("Gemfile.lock", "lock\n");
	f.write("docs/contracts/writing.md", CONTRACT);
	f.commit("Files");
});
afterEach(() => f.cleanup());

function prepare(extra: Record<string, unknown> = {}) {
	const r = f.prepare(
		f.input({
			gates: {
				test: {
					argv: [gates.tests, "{files}"],
					include: ["test/**/*_test.rb"],
					system: ["test/system/"],
				},
				lint: { argv: [gates.lint, "{files}"], include: ["**/*.rb"] },
			},
			health: {
				stacks: [],
				recheck: [[gates.exhale, "--base", "{base}", "--cache", "{cache}"]],
			},
			...extra,
		}),
	);
	expect(r.code).toBe(0);
}

const stopHook = (
	extra: Record<string, unknown> = {},
	env: Record<string, string> = {},
) =>
	f.hook(
		"stop",
		{
			session_id: "s1",
			stop_hook_active: false,
			transcript_path: "/nonexistent/t.jsonl",
			...extra,
		},
		env,
	);
const recheck = (env: Record<string, string> = {}) => {
	const r = f.run(["recheck", "--manifest", f.manifest, "--json"], { env });
	return { ...r, json: JSON.parse(r.stdout) };
};
const counter = (id = "s1") => join(f.runDir, `stop-${id}`);
const ran = (name: string) =>
	f.recorded().filter((l) => l.startsWith(`${name} `));

describe("BH-11: diff and Contract selection", () => {
	test("staged, unstaged, deleted, renamed and untracked paths are in scope; ignored ones are not", () => {
		prepare();
		f.write("app/other.rb", "unstaged\n");
		f.write("app/staged.rb", "staged\n");
		f.git("add", "app/staged.rb");
		f.git("rm", "-q", "test/extra_test.rb");
		f.git("mv", "app/posts/show.rb", "app/posts/renamed.rb");
		f.write("notes/new.txt", "untracked\n");
		f.write("log/test.log", "ignored\n");
		expect(recheck().json.result.scope).toEqual([
			"app/other.rb",
			"app/posts/renamed.rb",
			"app/posts/show.rb",
			"app/staged.rb",
			"notes/new.txt",
			"test/extra_test.rb",
		]);
	});

	test("a change under a component's covers selects its tests", () => {
		prepare();
		f.write("app/posts/show.rb", "changed\n");
		expect(stopHook().code).toBe(0);
		expect(ran("tests")).toEqual(["tests test/contract/writing_test.rb"]);
	});

	test("coverage is the union of base and worktree covers; deletions count", () => {
		prepare();
		f.write(
			"docs/contracts/writing.md",
			CONTRACT.replace("covers: [app/posts/]", "covers: [app/elsewhere.rb]"),
		);
		f.git("rm", "-q", "app/posts/show.rb");
		stopHook();
		expect(ran("tests")).toEqual(["tests test/contract/writing_test.rb"]);
	});

	test("fallback paths join discovery, deduplicated", () => {
		prepare({
			contract_tests: ["test/contract/writing_test.rb", "test/extra_test.rb"],
		});
		f.write("app/posts/show.rb", "changed\n");
		stopHook();
		expect(ran("tests")).toEqual([
			"tests test/contract/writing_test.rb test/extra_test.rb",
		]);
	});

	test("a missing selected test is a named inability", () => {
		prepare();
		f.git("rm", "-q", "test/contract/writing_test.rb");
		f.write("app/posts/show.rb", "changed\n");
		const r = stopHook();
		expect(r.code).toBe(2);
		expect(r.stderr).toStartWith(
			"Stop gate: contracts could not run on the changed scope (attempt 1 of 3): selected tests are missing: test/contract/writing_test.rb.",
		);
	});

	test("an empty scope passes silently and runs nothing", () => {
		prepare();
		expect(stopHook()).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(f.recorded()).toEqual([]);
		expect(f.logLines().at(-1)).toMatch(
			/ stop gate 0%20paths \d+ PASS empty-scope session=s1 active=false$/,
		);
	});
});

describe("BH-12: ordered evaluation and gaps", () => {
	test("changed tests, then lint, then Contract tests", () => {
		prepare();
		f.write("test/models/a_test.rb", "changed\n");
		f.write("app/posts/show.rb", "changed\n");
		expect(stopHook().code).toBe(0);
		expect(f.recorded()).toEqual([
			"tests test/models/a_test.rb",
			"lint app/posts/show.rb test/models/a_test.rb",
			"tests test/contract/writing_test.rb",
		]);
	});

	test("the first failure stops the evaluation", () => {
		prepare();
		f.write("test/models/a_test.rb", "changed\n");
		f.set("tests", "code", "1");
		expect(stopHook().code).toBe(2);
		expect(f.recorded()).toEqual(["tests test/models/a_test.rb"]);
	});

	test("an empty selection skips its gate", () => {
		prepare();
		f.write("notes.txt", "x\n");
		expect(stopHook().code).toBe(0);
		expect(f.recorded()).toEqual([]);
	});

	test("a changed system test is named, never run and never blocks by itself", () => {
		prepare();
		f.write("test/system/flow_test.rb", "changed\n");
		expect(stopHook()).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(f.recorded()).toEqual(["lint test/system/flow_test.rb"]);
		expect(f.logLines().at(-1)).toMatch(
			/ PASS checks-pass session=s1 active=false not run here: test\/system\/flow_test\.rb$/,
		);
		f.write("app/other.rb", "changed\n");
		f.set("lint", "code", "1");
		expect(stopHook().stderr).toContain(
			"Not run here: test/system/flow_test.rb; the host runs them at step 6.",
		);
	});

	test("exhale is a logged deferral in Stop and never starts there", () => {
		prepare();
		f.write("app/other.rb", "changed\n");
		stopHook();
		expect(ran("exhale")).toEqual([]);
		expect(
			f
				.logLines()
				.some((l) =>
					/ stop exhale scope \d+ COULD-NOT-RUN exhale deferred to step 6 session=s1/.test(
						l,
					),
				),
		).toBe(true);
	});
});

describe("BH-13: reserved stop field", () => {
	beforeEach(() => {
		prepare();
		f.write("app/other.rb", "changed\n");
		f.set("lint", "code", "1");
	});

	test("the leading marker with a decision exempts a nonempty scope, silently", () => {
		for (const message of [
			"Reserved decision stop: D1, the run directory. The ruling decides the guard's shape.",
			"  \nReserved decision stop: D2. Needs the user.",
		])
			expect(stopHook({ last_assistant_message: message })).toEqual({
				code: 0,
				stdout: "",
				stderr: "",
			});
		expect(f.logLines().at(-1)).toMatch(/ PASS reserved-stop session=s1 /);
		expect(f.recorded()).toEqual([]);
	});

	test("a reserved stop names a changed system test in its PASS line", () => {
		f.write("test/system/flow_test.rb", "changed\n");
		stopHook({
			last_assistant_message: "Reserved decision stop: D1. Needs a ruling.",
		});
		expect(f.logLines().at(-1)).toMatch(
			/ PASS reserved-stop session=s1 active=false not run here: test\/system\/flow_test\.rb$/,
		);
	});

	test("missing, empty, non-string, quoted, embedded, bare and other markers do not", () => {
		for (const message of [
			undefined,
			"",
			42,
			'"Reserved decision stop: D1. quoted"',
			"Done. Reserved decision stop: D1. embedded",
			"Reserved decision stop:   ",
			"Authority stop: push needs a grant.",
		]) {
			rmSync(counter(), { force: true });
			expect({
				message,
				code: stopHook({ last_assistant_message: message }).code,
			}).toEqual({ message, code: 2 });
		}
	});
});

describe("BH-14: bounded state", () => {
	beforeEach(() => {
		prepare();
		f.write("app/other.rb", "changed\n");
		f.set("lint", "code", "1");
	});

	test("three blocks, then GIVE-UP; a pass resets the count", () => {
		expect(
			[1, 2, 3].map((n) => stopHook({ stop_hook_active: n > 1 }).code),
		).toEqual([2, 2, 2]);
		expect(readFileSync(counter(), "utf8")).toBe("3\n");
		const give = stopHook({ stop_hook_active: true });
		expect(give.code).toBe(0);
		expect(give.stdout).toBe("");
		expect(f.logLines().at(-1)).toContain(" GIVE-UP ");
		f.set("lint", "code", "0");
		expect(stopHook()).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(existsSync(counter())).toBe(false);
		f.set("lint", "code", "1");
		expect(stopHook().stderr).toContain("(attempt 1 of 3)");
	});

	test("stop_hook_active does not change the count", () => {
		expect(stopHook({ stop_hook_active: true }).stderr).toContain(
			"(attempt 1 of 3)",
		);
		expect(stopHook({ stop_hook_active: false }).stderr).toContain(
			"(attempt 2 of 3)",
		);
	});

	test("sessions count separately", () => {
		stopHook();
		stopHook();
		expect(stopHook({ session_id: "s2" }).stderr).toContain("(attempt 1 of 3)");
		expect(stopHook().stderr).toContain("(attempt 3 of 3)");
	});

	test("a malformed counter reads as zero and is overwritten", () => {
		writeFileSync(counter(), "garbage");
		expect(stopHook().stderr).toContain("(attempt 1 of 3)");
		expect(readFileSync(counter(), "utf8")).toBe("1\n");
	});

	test("a counter that cannot be written does not block and never logs PASS", () => {
		mkdirSync(counter());
		const r = stopHook();
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toStartWith(
			"Stop gate could not keep its bound: the counter cannot be written",
		);
		expect(f.logLines().at(-1)).toContain(
			" COULD-NOT-RUN the counter cannot be written",
		);
		expect(f.logLines().some((l) => l.includes(" PASS "))).toBe(false);
	});

	test("a log that cannot be written does not block", () => {
		rmSync(f.log, { force: true });
		mkdirSync(f.log);
		const r = stopHook();
		expect(r.code).toBe(0);
		expect(r.stderr).toStartWith(
			"Stop gate could not keep its bound: the log cannot be written",
		);
	});

	test("an unsafe session id is refused before any path is made", () => {
		const r = stopHook({ session_id: "../escape" });
		expect(r.code).toBe(0);
		expect(r.stderr).toContain(
			"session_id is missing or not a plain identifier",
		);
		expect(existsSync(join(f.root, "escape"))).toBe(false);
	});
});

describe("BH-15: Stop messages and deadline", () => {
	test("an ordinary block, then the third with the last-attempt sentence, then the cap diagnostic", () => {
		prepare();
		f.write("app/other.rb", "changed\n");
		f.set("lint", "code", "1");
		f.set("lint", "out", "app/other.rb:1: offense\n");
		const scope = "Scope: 1 changed paths.";
		expect(stopHook()).toEqual({
			code: 2,
			stdout: "",
			stderr: `Stop gate: lint fails on the changed scope (attempt 1 of 3). app/other.rb:1: offense. ${FIX}\n${scope}\n`,
		});
		stopHook();
		expect(stopHook().stderr).toBe(
			`Stop gate: lint fails on the changed scope (attempt 3 of 3). app/other.rb:1: offense. ${FIX}\n${scope}\n${LAST}\n`,
		);
		expect(stopHook()).toEqual({
			code: 0,
			stdout: "",
			stderr: `Stop gate: still failing after 3 attempts: lint fails: ${gates.lint} exited 1. Ending the session; the host will re-check.\n`,
		});
	});

	test("an inability uses its own prefix and names excluded paths in scope", () => {
		prepare({
			excluded: ["app/other.rb"],
			gates: {
				lint: {
					argv: [join(f.root, "bin/none"), "{files}"],
					include: ["**/*.rb"],
				},
			},
		});
		f.write("app/other.rb", "changed\n");
		expect(stopHook().stderr).toBe(
			`Stop gate: lint could not run on the changed scope (attempt 1 of 3): ${join(f.root, "bin/none")} is not found. ${FIX}\nScope: 1 changed paths (excluded: app/other.rb).\n`,
		);
	});

	test("output is capped at twenty lines and a missing-file phrase is still a block", () => {
		prepare();
		f.write("app/other.rb", "changed\n");
		f.set("lint", "code", "1");
		f.set(
			"lint",
			"out",
			`${Array.from({ length: 100 }, (_, i) => `line ${i}: No such file or directory`).join("\n")}\n`,
		);
		const r = stopHook();
		expect(r.code).toBe(2);
		expect(r.stderr).toStartWith("Stop gate: lint fails");
		expect(r.stderr).toContain("line 19: No such file");
		expect(r.stderr).not.toContain("line 20:");
	});

	test("the evaluation budget kills a sleeping gate and its descendants, consumes one attempt and never passes", async () => {
		prepare();
		const late = join(f.root, "late");
		writeFileSync(
			gates.lint,
			`#!/bin/sh\n(sleep 2; touch '${late}') &\nsleep 10\n`,
			{ mode: 0o755 },
		);
		f.write("app/other.rb", "changed\n");
		const r = stopHook({}, { BUILDER_HOOKS_TEST_BUDGET_MS: "700" });
		expect(r.code).toBe(2);
		expect(r.stderr).toStartWith(
			`Stop gate: lint could not run on the changed scope (attempt 1 of 3): ${gates.lint} did not finish within the 120 s budget`,
		);
		expect(readFileSync(counter(), "utf8")).toBe("1\n");
		await Bun.sleep(2500);
		expect(existsSync(late)).toBe(false);
		expect(f.logLines().some((l) => l.includes(" PASS "))).toBe(false);
	});

	test("a budget spent before a phase starts is an inability, never PASS", () => {
		prepare();
		f.write("notes.txt", "x\n");
		const slow = join(f.root, "slow-bin");
		mkdirSync(slow);
		const real = Bun.which("git") as string;
		writeFileSync(
			join(slow, "git"),
			`#!/bin/sh\nsleep 0.2\nexec '${real}' "$@"\n`,
			{ mode: 0o755 },
		);
		const r = stopHook(
			{},
			{
				BUILDER_HOOKS_TEST_BUDGET_MS: "50",
				PATH: `${slow}:${process.env.PATH}`,
			},
		);
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(
			/^Stop gate: \S+ could not run on the changed scope \(attempt 1 of 3\): the evaluation budget was spent before \S+ started/,
		);
		expect(f.logLines().some((l) => l.includes(" PASS "))).toBe(false);
	});

	test("production budgets are fixed in the tool, not the manifest or settings", () => {
		prepare();
		const settings = readFileSync(
			join(f.runDir, "builder-hooks.settings.json"),
			"utf8",
		);
		expect(settings).not.toContain("BUILDER_HOOKS_TEST_BUDGET_MS");
		const main = readFileSync(join(tool, "../builder-hooks.d/main.ts"), "utf8");
		expect(main).toContain("guard: 200, health: 2000, stop: 120_000");
	});
});

describe("BH-16: recheck independence", () => {
	test("finds failures after the cap and an exemption, then succeeds after correction", () => {
		prepare();
		f.write("app/other.rb", "changed\n");
		f.set("lint", "code", "1");
		for (let i = 0; i < 4; i++) stopHook();
		stopHook({
			last_assistant_message: "Reserved decision stop: D1. Needs a ruling.",
		});
		const failing = recheck();
		expect(failing.code).toBe(1);
		expect(failing.json).toMatchObject({
			status: "findings",
			failing: 1,
			findings: [{ code: "check-failed" }],
		});
		f.set("lint", "code", "0");
		const passing = recheck();
		expect(passing.code).toBe(0);
		expect(
			passing.json.result.checks.map((c: { check: string }) => c.check),
		).toEqual(["lint", "exhale"]);
	});

	test("exhale runs in recheck with the base and a cache outside the worktree", () => {
		prepare();
		f.write("app/other.rb", "changed\n");
		recheck();
		const [line] = ran("exhale");
		const base = f.git("rev-parse", "HEAD");
		const cache = line?.split(" ").at(-1) as string;
		expect(line).toStartWith(`exhale --base ${base} --cache `);
		expect(cache.startsWith(f.repo)).toBe(false);
		expect(cache.startsWith(join(f.root, "tmp"))).toBe(true);
	});

	test("a changed system test makes recheck exit 2 with the gap named", () => {
		prepare();
		f.write("test/system/flow_test.rb", "changed\n");
		const r = recheck();
		expect(r.code).toBe(2);
		expect(r.json.result.gaps).toContain(
			"not run here: test/system/flow_test.rb; the host runs them at step 6",
		);
		expect(r.json.findings).toContainEqual({
			code: "system-test-not-run",
			severity: "warning",
			file: "test/system/flow_test.rb",
			message: "not run here; the host runs it at step 6",
		});
	});

	test("an unavailable exhale is an inability, exit 2", () => {
		prepare({
			health: { stacks: [], recheck: [[join(f.root, "bin/none"), "{base}"]] },
		});
		f.write("app/other.rb", "changed\n");
		const r = recheck();
		expect(r.code).toBe(2);
		expect(r.json.findings).toContainEqual(
			expect.objectContaining({ code: "check-could-not-run" }),
		);
	});

	test("an empty scope runs no exhale and lists the skip", () => {
		prepare();
		const r = recheck();
		expect(r.code).toBe(0);
		expect(ran("exhale")).toEqual([]);
		expect(r.json.result.checks).toContainEqual({
			check: "exhale",
			status: "skipped",
			files: [],
			why: "empty scope",
		});
	});

	test("a changed excluded path is a warning finding and exits 2", () => {
		prepare({ excluded: ["bin/ci"] });
		f.write("bin/ci", "changed\n");
		const r = recheck();
		expect(r.code).toBe(2);
		expect(r.json.status).toBe("warnings");
		expect(r.json.result.excluded).toEqual(["bin/ci"]);
		expect(r.json.findings).toContainEqual({
			code: "excluded-path-changed",
			severity: "warning",
			file: "bin/ci",
			message: "an excluded path changed; the PR is outside the grant",
		});
	});

	test("text output lists checks and gaps", () => {
		prepare();
		f.write("app/other.rb", "changed\n");
		const r = f.run(["recheck", "--manifest", f.manifest]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("lint: pass");
		expect(r.stdout).toContain("exhale: pass");
	});
});

describe("BH-17: mutation and evidence", () => {
	const state = () =>
		[
			f.git("status", "--porcelain", "--untracked-files=all"),
			f.git("ls-files", "-s"),
			f.git("for-each-ref"),
			readFileSync(join(f.repo, "app/other.rb"), "utf8"),
		].join("\n");

	test("no mode changes tracked content, the index, refs or nonignored files", () => {
		prepare();
		f.write("app/other.rb", "changed\n");
		const before = state();
		f.hook("guard", {
			session_id: "s1",
			tool_name: "Bash",
			tool_input: { command: "git commit" },
		});
		f.hook("health", {
			session_id: "s1",
			tool_name: "Edit",
			tool_input: { file_path: join(f.repo, "app/other.rb") },
		});
		stopHook();
		recheck();
		expect(state()).toBe(before);
	});

	test("ignored checker artifacts are allowed; a checker changing a clean or already-dirty lockfile is caught", () => {
		prepare();
		f.write("app/other.rb", "changed\n");
		writeFileSync(
			gates.lint,
			`#!/bin/sh\nmkdir -p log && echo x >> log/test.log\n`,
			{ mode: 0o755 },
		);
		expect(recheck().code).toBe(0);
		writeFileSync(gates.lint, `#!/bin/sh\necho more >> Gemfile.lock\n`, {
			mode: 0o755,
		});
		const clean = recheck();
		expect(clean.code).toBe(1);
		expect(clean.json.findings).toContainEqual(
			expect.objectContaining({ code: "worktree-changed" }),
		);
		const dirty = recheck();
		expect(dirty.code).toBe(1);
		expect(dirty.json.findings).toContainEqual(
			expect.objectContaining({ code: "worktree-changed" }),
		);
	});

	test("every log line has the fixed shape; control characters are escaped", () => {
		prepare();
		f.write("app/other.rb", "changed\n");
		f.hook("guard", {
			session_id: "s1",
			tool_name: "Write",
			tool_input: { file_path: "app/new\nline.rb" },
		});
		f.set("lint", "code", "1");
		stopHook();
		stopHook();
		stopHook();
		stopHook();
		f.set("lint", "code", "0");
		stopHook();
		recheck();
		const lines = f.logLines();
		for (const line of lines)
			expect(line).toMatch(
				/^\d\d:\d\d:\d\d \S+ \S+ \S+ \d+ (ALLOW|DENY|FINDING|CLEAN|BLOCK|GIVE-UP|PASS|COULD-NOT-RUN) \S/,
			);
		expect(lines.some((l) => l.includes("app/new%0Aline.rb"))).toBe(true);
		for (const status of ["BLOCK", "GIVE-UP", "PASS"])
			expect(
				lines
					.filter((l) => l.includes(` ${status} `))
					.every((l) => l.includes("session=s1")),
			).toBe(true);
		expect(
			lines
				.filter((l) => l.includes(" BLOCK "))
				.map((l) => l.match(/attempt=\d/)?.[0]),
		).toEqual(["attempt=1", "attempt=2", "attempt=3"]);
	});

	test("concurrent hooks append whole lines", async () => {
		prepare();
		const event = JSON.stringify({
			session_id: "s1",
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		await Promise.all(
			Array.from({ length: 12 }, async () => {
				const child = Bun.spawn([tool, "guard"], {
					stdin: new Blob([event]),
					env: f.env({
						SHEPHERD_HOOK_MANIFEST: f.manifest,
						SHEPHERD_HOOK_LOG: f.log,
					}),
				});
				await child.exited;
			}),
		);
		const lines = f.logLines();
		expect(lines).toHaveLength(12);
		for (const l of lines)
			expect(l).toMatch(
				/ guard Bash bash \d+ ALLOW no history write session=s1$/,
			);
	});
});
