/**
 * Fake `claude` and `codex` executables for runner tests (Design §9). They
 * record what they were launched with and play a scenario chosen by
 * `FAKE_SCENARIO`; no real backend ever runs.
 *
 * Both enforce what the real CLIs enforce and the runner must get right:
 * the fake Claude rejects `--print --output-format stream-json` without
 * `--verbose`, and the fake Codex rejects `exec` outside a Git worktree
 * without `--skip-git-repo-check`.
 *
 * The fake Codex also answers `debug prompt-input`, so the canary harness
 * can be shown to fail when delivery is wrong (B-010).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeScenario =
	/** Print: one result line. Stream: a few decodable events. */
	| "ok"
	/** Partial stdout, a stderr line, exit 3. */
	| "fail"
	/** One valid stream line, one that is not JSON, then stay alive. */
	| "malformed"
	/** One valid stream line, then a truncated one with no newline. */
	| "incomplete"
	/** One valid stream line, then a valid one with no newline. */
	| "incomplete-valid"
	/** Stay alive until signalled. */
	| "hang"
	/** Stay alive and ignore SIGTERM; only SIGKILL ends it. */
	| "ignore-term"
	/** `debug prompt-input`: developer instructions land in a user message. */
	| "misdeliver"
	/** `debug prompt-input`: developer instructions replace the base ones. */
	| "replace-base";

/** One launch as the fake saw it. */
export interface FakeRecord {
	name: "claude" | "codex";
	argv: string[];
	cwd: string;
	/** `TMPDIR` in the child's environment. */
	tmpdir: string | null;
	/** Entries of `TMPDIR` at launch, or null when it does not exist. */
	tmpdirEntries: string[] | null;
	/** Codex `model_instructions_file` as found at launch. */
	promptFile?: { path: string; mode: number; content: string };
	/** `TROUPE_*` variables in the child's environment. */
	troupeEnv: Record<string, string>;
	/** `CLAUDE_PROJECT_DIR` in the child's environment; absent when unset. */
	claudeProjectDir?: string;
	/** `CODEX_HOME` in the child's environment; absent when unset. */
	codexHome?: string;
}

function fakeSource(name: "claude" | "codex"): string {
	return `#!${process.execPath}
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
const name = ${JSON.stringify(name)};
const argv = process.argv.slice(2);
const env = process.env;
// Ignore SIGTERM before announcing the pid, so a test never signals too early.
if (env.FAKE_SCENARIO === "ignore-term") process.on("SIGTERM", () => {});
if (env.FAKE_PID_FILE) writeFileSync(env.FAKE_PID_FILE, String(process.pid));
const tmp = env.TMPDIR ?? null;
const record = {
	name,
	argv,
	cwd: process.cwd(),
	tmpdir: tmp,
	tmpdirEntries: tmp && existsSync(tmp) ? readdirSync(tmp) : null,
	troupeEnv: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("TROUPE_"))),
	...(env.CLAUDE_PROJECT_DIR === undefined ? {} : { claudeProjectDir: env.CLAUDE_PROJECT_DIR }),
	...(env.CODEX_HOME === undefined ? {} : { codexHome: env.CODEX_HOME }),
};
const configs = argv.filter((_, i) => argv[i - 1] === "-c");
const promptConfig = configs.find((value) => value.startsWith("model_instructions_file="));
if (promptConfig) {
	const path = JSON.parse(promptConfig.slice("model_instructions_file=".length));
	record.promptFile = { path, mode: statSync(path).mode & 0o777, content: readFileSync(path, "utf8") };
}
if (env.FAKE_RECORD) appendFileSync(env.FAKE_RECORD, JSON.stringify(record) + "\\n");

const out = (text) => Bun.write(Bun.stdout, text);
const fail = async (message, code = 1) => {
	await Bun.write(Bun.stderr, message + "\\n");
	process.exit(code);
};
const hang = () => setInterval(() => {}, 1000);

// A stand-in for \`codex debug prompt-input\`: developer_instructions become
// the first developer item, ahead of a fixed base, unless a scenario breaks it.
if (name === "codex" && argv[0] === "debug" && argv[1] === "prompt-input") {
	const scenario = env.FAKE_SCENARIO ?? "ok";
	if (scenario === "fail") await fail("backend exploded", 3);
	const config = configs.find((value) => value.startsWith("developer_instructions="));
	const developer = config ? JSON.parse(config.slice("developer_instructions=".length)) : null;
	const text = (value) => ({ type: "input_text", text: value });
	const developerItems = scenario === "replace-base" && developer !== null
		? []
		: [text("<permissions instructions>fake base</permissions instructions>")];
	const userItems = [text("<environment_context>fake</environment_context>")];
	if (developer !== null) {
		(scenario === "misdeliver" ? userItems : developerItems).unshift(text(developer));
	}
	const items = [
		{ type: "message", role: "developer", content: developerItems },
		{ type: "message", role: "user", content: userItems },
	];
	const separator = argv.indexOf("--");
	if (separator !== -1) items.push({ type: "message", role: "user", content: [text(argv[separator + 1])] });
	await out(JSON.stringify(items, null, 2) + "\\n");
	process.exit(0);
}

const outputFormat = argv[argv.indexOf("--output-format") + 1];
const stream = name === "claude"
	? argv.includes("--output-format") && outputFormat === "stream-json"
	: argv[0] === "exec" && argv.includes("--json");
const print = name === "claude" ? argv.includes("--print") : argv[0] === "exec";
if (name === "claude" && stream && argv.includes("--print") && !argv.includes("--verbose")) {
	await fail("Error: When using --print, --output-format=stream-json requires --verbose");
}
if (name === "codex" && argv[0] === "exec" && !argv.includes("--skip-git-repo-check")) {
	const probe = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { stderr: "ignore" });
	if (probe.exitCode !== 0) {
		await fail("Not inside a trusted directory and --skip-git-repo-check was not specified.");
	}
}

const events = name === "claude"
	? [
		{ type: "system", subtype: "init" },
		{ type: "assistant", message: { content: [{ type: "text", text: "hello from claude" }] } },
		{ type: "result", subtype: "success" },
	]
	: [
		{ type: "thread.started" },
		{ type: "item.completed", item: { type: "agent_message", text: "hello from codex" } },
		{ type: "turn.completed" },
	];
const line = (event) => JSON.stringify(event) + "\\n";

switch (env.FAKE_SCENARIO ?? "ok") {
	case "ok":
		if (stream) await out(events.map(line).join(""));
		else if (print) await out(name + " result\\n");
		break;
	case "fail":
		await out("partial output\\n");
		await fail("backend exploded", 3);
		break;
	case "malformed":
		await out(line(events[0]) + "this is not json\\n");
		hang();
		break;
	case "incomplete":
		await out(line(events[0]) + '{"type":"assist');
		break;
	case "incomplete-valid":
		await out(line(events[0]) + JSON.stringify(events[1]));
		break;
	case "hang":
		hang();
		break;
	case "ignore-term":
		hang();
		break;
}
`;
}

/** A child that writes its pid to its first argument, then waits to be killed. */
const SLEEPER = `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`;

/**
 * Write `claude`, `codex` and `fake-sleeper` into `dir` and return it, for
 * use at the front of a test's `PATH`.
 */
export function installFakeClis(dir: string): string {
	for (const [file, source] of [
		["claude", fakeSource("claude")],
		["codex", fakeSource("codex")],
		["fake-sleeper", SLEEPER],
	] as const) {
		const path = join(dir, file);
		writeFileSync(path, source);
		chmodSync(path, 0o755);
	}
	return dir;
}

export function readRecords(file: string): FakeRecord[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as FakeRecord);
}

/** Resolve once `path` exists; used to signal a child only after it started. */
export async function waitForFile(
	path: string,
	options: {
		timeoutMs?: number;
		/** Why the child never got there, e.g. its exit code and stderr. */
		diagnose?: () => string | Promise<string>;
	} = {},
) {
	const deadline = Date.now() + (options.timeoutMs ?? 10_000);
	while (!existsSync(path) || readFileSync(path, "utf8").length === 0) {
		if (Date.now() > deadline) {
			const detail = options.diagnose ? `: ${await options.diagnose()}` : "";
			throw new Error(`timed out waiting for ${path}${detail}`);
		}
		await Bun.sleep(10);
	}
	return Number(readFileSync(path, "utf8"));
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
