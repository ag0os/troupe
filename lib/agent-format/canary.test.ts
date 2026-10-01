import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendArgvProblems,
	CANARY_USER_PROMPT,
	canaryAgent,
	canaryArgv,
	canaryProblems,
	canaryText,
	findCodex,
	type PromptText,
	promptInputs,
	runCanary,
} from "./canary";
import { type FakeScenario, installFakeClis, readRecords } from "./fake-cli";

/** The real Codex on the test's PATH; the canary skips only when it is absent. */
const realCodex = findCodex(process.env.PATH);
if (realCodex === null) {
	console.warn(
		"codex is not on PATH: skipping the real Codex developer-message canary (B-010)",
	);
}

let root: string;
let workspace: string;
let home: string;
let bin: string;
let recordFile: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agent-canary-")));
	workspace = join(root, "workspace");
	home = join(root, "home");
	bin = join(root, "bin");
	for (const dir of [workspace, home, bin]) mkdirSync(dir);
	installFakeClis(bin);
	recordFile = join(root, "records.jsonl");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * A hermetic environment: an empty CODEX_HOME and HOME keep the user's
 * config, skills and AGENTS.md out of the rendered input and keep Codex
 * from writing into the real home.
 */
function codexEnv(extra: Record<string, string> = {}) {
	return {
		PATH: process.env.PATH,
		HOME: home,
		CODEX_HOME: home,
		...extra,
	};
}

function fakeOptions(scenario: FakeScenario) {
	return {
		codex: join(bin, "codex"),
		cwd: workspace,
		env: codexEnv({ FAKE_SCENARIO: scenario, FAKE_RECORD: recordFile }),
	};
}

describe("the canary argv comes from the Codex adapter (B-010; D-003, D-021)", () => {
	test("explicit --backend codex previews developer_instructions and the prompt after --, never base_instructions", async () => {
		const spec = canaryAgent(canaryText("argv"));
		expect(spec.backends[0]).toBe("claude");
		const argv = await canaryArgv(spec, workspace);
		expect(argv).toEqual([
			"-c",
			`developer_instructions=${JSON.stringify(spec.systemPrompt)}`,
			"--",
			CANARY_USER_PROMPT,
		]);
		expect(argv.join(" ")).not.toContain("base_instructions");
	});
});

describe("canary checks the developer channel, not prompt text (B-010; Quality Contract)", () => {
	const canary = canaryText("unit");
	const base: PromptText = { role: "developer", text: "<base>" };
	const prompt: PromptText = { role: "user", text: CANARY_USER_PROMPT };
	const good = [{ role: "developer", text: canary }, base, prompt];

	test("a whole developer item with the base kept passes", () => {
		expect(canaryProblems(good, [base], canary)).toEqual([]);
	});

	test("a canary that is only a substring of a larger developer text fails", () => {
		const run = [{ role: "developer", text: `before ${canary} after` }, base];
		expect(canaryProblems([...run, prompt], [base], canary)).toContain(
			"expected the canary as exactly one developer item, found 0",
		);
	});

	test("a canary in a user message fails even when the developer item is there", () => {
		const run = [...good, { role: "user", text: `${canary}\n\nhello` }];
		expect(canaryProblems(run, [base], canary)).toEqual([
			"the canary also appears in a user item",
		]);
	});

	test("a canary also embedded in another developer item fails", () => {
		const run = [...good, { role: "developer", text: `<x>${canary}</x>` }];
		expect(canaryProblems(run, [base], canary)).toEqual([
			"the canary also appears in a developer item",
		]);
	});

	test("two whole developer copies of the canary fail", () => {
		const run = [...good, { role: "developer", text: canary }];
		expect(canaryProblems(run, [base], canary)).toEqual([
			"expected the canary as exactly one developer item, found 2",
			"the canary also appears in a developer item",
		]);
	});

	test("a canary that replaced the base developer items fails", () => {
		const run = [{ role: "developer", text: canary }, prompt];
		expect(canaryProblems(run, [base], canary)).toEqual([
			'1 base developer item(s) are missing: "<base>"',
		]);
	});

	test("a baseline without developer items cannot vouch for the base", () => {
		expect(canaryProblems(good, [prompt], canary)).toContain(
			"the baseline run has no developer items to preserve",
		);
	});
});

describe("the append argv guard (D-003; prompt-input cannot see the base)", () => {
	const developer = ["-c", 'developer_instructions="DEV"'];

	test("developer_instructions alone passes", () => {
		expect(appendArgvProblems([...developer, "--", "hi"])).toEqual([]);
	});

	test("an argv that also replaces the base, in either form, fails", () => {
		const argv = [
			...developer,
			"-c",
			'model_instructions_file="/tmp/mi.md"',
			"-c",
			'base_instructions="BASE"',
			"--",
			"hi",
		];
		expect(appendArgvProblems(argv)).toEqual([
			"the codex argv sets model_instructions_file",
			"the codex argv sets base_instructions",
		]);
	});

	test("an argv without developer_instructions fails", () => {
		expect(
			appendArgvProblems(["-c", 'experimental_instructions_file="/x"']),
		).toEqual([
			"the codex argv has no developer_instructions",
			"the codex argv sets experimental_instructions_file",
		]);
	});
});

describe("skip only when Codex is absent; fail when installed and wrong (B-010)", () => {
	test("a PATH without codex finds nothing, so the canary skips", () => {
		expect(findCodex(join(root, "empty"))).toBeNull();
		expect(findCodex(undefined)).toBeNull();
	});

	test("a PATH with codex finds it, so the canary runs", () => {
		expect(findCodex(bin)).toBe(join(bin, "codex"));
	});

	test("an installed Codex that delivers correctly passes, through the adapter argv", async () => {
		const result = await runCanary(fakeOptions("ok"));
		expect(result.items[0]).toEqual({ role: "developer", text: result.canary });
		const launches = readRecords(recordFile).map((record) => record.argv);
		expect(launches).toContainEqual(["debug", "prompt-input", ...result.argv]);
	});

	for (const [scenario, problem] of [
		["misdeliver", "the canary also appears in a user item"],
		["replace-base", "1 base developer item(s) are missing"],
		["fail", "codex debug prompt-input exited 3: backend exploded"],
	] as const) {
		test(`an installed Codex that fails the canary (${scenario}) throws`, async () => {
			await expect(runCanary(fakeOptions(scenario))).rejects.toThrow(problem);
		});
	}
});

describe("real codex debug prompt-input (B-010; ACC-003)", () => {
	test.skipIf(realCodex === null)(
		"the canary is a developer message and the base developer items remain",
		async () => {
			const options = {
				codex: realCodex ?? "codex",
				cwd: workspace,
				env: codexEnv(),
			};
			const result = await runCanary(options);
			const developer = result.items.filter(
				(item) => item.role === "developer",
			);
			expect(developer.map((item) => item.text)).toContain(result.canary);
			expect(developer.length).toBeGreaterThan(1);
		},
		60_000,
	);

	test.skipIf(realCodex === null)(
		"a canary sent as user prompt text is not a developer item",
		async () => {
			const options = {
				codex: realCodex ?? "codex",
				cwd: workspace,
				env: codexEnv(),
			};
			const canary = canaryText("mutant");
			const [baseline = [], viaPrompt = []] = await promptInputs(
				[
					["--", CANARY_USER_PROMPT],
					["--", `${canary}\n\n${CANARY_USER_PROMPT}`],
				],
				options,
			);
			expect(canaryProblems(viaPrompt, baseline, canary)).toEqual([
				"expected the canary as exactly one developer item, found 0",
				"the canary also appears in a user item",
				"the initial prompt did not arrive as a user item",
			]);
		},
		60_000,
	);

	test.skipIf(realCodex === null)(
		"prompt-input cannot show a replaced base, so only the argv guard catches it",
		async () => {
			const options = {
				codex: realCodex ?? "codex",
				cwd: workspace,
				env: codexEnv(),
			};
			const canary = canaryText("replace");
			const file = join(root, "model-instructions.md");
			writeFileSync(file, "REPLACED BASE");
			const append = ["-c", `developer_instructions=${JSON.stringify(canary)}`];
			const replacing = [
				...append,
				"-c",
				`model_instructions_file=${JSON.stringify(file)}`,
				"-c",
				`base_instructions=${JSON.stringify("REPLACED BASE")}`,
			];
			const [baseline = [], plain = [], replaced = []] = await promptInputs(
				[
					["--", CANARY_USER_PROMPT],
					[...append, "--", CANARY_USER_PROMPT],
					[...replacing, "--", CANARY_USER_PROMPT],
				],
				options,
			);
			expect(replaced).toEqual(plain);
			expect(canaryProblems(replaced, baseline, canary)).toEqual([]);
			expect(appendArgvProblems(replacing)).toEqual([
				"the codex argv sets model_instructions_file",
				"the codex argv sets base_instructions",
			]);
		},
		60_000,
	);

	// Evidence: missions/plans/agent-format/evidence/backend-matrix.md §2.1,
	// "User developer_instructions are replaced". If Codex starts merging the
	// two, this fails and the limitation can be dropped.
	test.skipIf(realCodex === null)(
		"known limitation: a user's config developer_instructions is replaced, not appended to",
		async () => {
			const codexHome = join(root, "codex-home");
			mkdirSync(codexHome);
			const userText = `USER-DEV-${crypto.randomUUID()}`;
			writeFileSync(
				join(codexHome, "config.toml"),
				`developer_instructions = ${JSON.stringify(userText)}\n`,
			);
			const options = {
				codex: realCodex ?? "codex",
				cwd: workspace,
				env: codexEnv({ CODEX_HOME: codexHome }),
			};
			const spec = canaryAgent(canaryText("user-config"));
			const argv = await canaryArgv(spec, workspace);
			const [baseline = [], run = []] = await promptInputs(
				[["--", CANARY_USER_PROMPT], argv],
				options,
			);
			const developer = (items: PromptText[]) =>
				items
					.filter((item) => item.role === "developer")
					.map((item) => item.text);
			expect(developer(baseline)[0]).toBe(userText);
			expect(developer(run)[0]).toBe(spec.systemPrompt);
			expect(run.some((item) => item.text.includes(userText))).toBe(false);
		},
		60_000,
	);
});

describe("fake CLIs on PATH record argv and env (AC #5; Design §9)", () => {
	for (const name of ["claude", "codex"] as const) {
		test(`the fake ${name} records argv, cwd, TMPDIR and TROUPE_* env only`, () => {
			const tmp = join(root, "tmp");
			mkdirSync(tmp);
			const child = Bun.spawnSync([name, "--model", "m", "--", "hi there"], {
				cwd: workspace,
				env: {
					PATH: `${bin}:${process.env.PATH}`,
					TMPDIR: tmp,
					TROUPE_PROBE: "yes",
					OTHER_SECRET: "no",
					FAKE_RECORD: recordFile,
				},
			});
			expect(child.exitCode).toBe(0);
			expect(readRecords(recordFile)).toEqual([
				{
					name,
					argv: ["--model", "m", "--", "hi there"],
					cwd: workspace,
					tmpdir: tmp,
					tmpdirEntries: [],
					troupeEnv: { TROUPE_PROBE: "yes" },
				},
			]);
		});
	}

	test("the fake Claude on PATH rejects --print --output-format stream-json without --verbose", () => {
		const env = { PATH: `${bin}:${process.env.PATH}` };
		const argv = ["claude", "--print", "--output-format", "stream-json"];
		const without = Bun.spawnSync(argv, { env });
		expect(without.exitCode).toBe(1);
		expect(String(without.stderr)).toContain("requires --verbose");
		expect(Bun.spawnSync([...argv, "--verbose"], { env }).exitCode).toBe(0);
	});
});
