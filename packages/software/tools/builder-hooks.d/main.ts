// builder-hooks: the software package's builder hooks. Run by
// ../builder-hooks, which records the caller's directory in
// BUILDER_HOOKS_TARGET_CWD. `prepare` and `recheck` speak contract 1; the
// hook modes speak Claude's hook protocol and read their policy only from
// the manifest SHEPHERD_HOOK_MANIFEST names.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { neutralizers } from "./git";
import { answer, CannotCheck, decide } from "./guard";
import { health } from "./health";
import { logLine } from "./log";
import { loadManifest, type Manifest, ToolError } from "./manifest";
import { prepare } from "./prepare";
import { recheck } from "./recheck";
import { stop } from "./stop";

const USAGE = `usage: builder-hooks <mode> [options]

  builder-hooks prepare --input <file> --run-dir <directory> [--json]
  builder-hooks guard
  builder-hooks health
  builder-hooks stop
  builder-hooks recheck --manifest <file> [--json]
  builder-hooks --help

prepare   check the Shepherd's policy file, resolve the repository and base,
          and write builder-manifest.json and builder-hooks.settings.json
          into a new or empty run directory outside the repository; prints
          the settings path to pass to claude --settings, which adds
          these hooks to the project's own
guard     PreToolUse hook: deny history writes and excluded edits;
          refuse what it cannot check
health    PostToolUse hook: one checker on the edited file; anything it
          cannot do is said as context
stop      Stop hook: the changed scope's gates, at most three blocks
          between passes
recheck   the Stop evaluator after a session, with no counter or exemption,
          plus exhale and a check that no checker changed the worktree

Hook modes read one JSON event on stdin and the manifest named by
SHEPHERD_HOOK_MANIFEST, take no arguments and speak Claude's hook protocol.

Run as shepherd tool software builder-hooks, the tool needs a Shepherd
workspace: SHEPHERD_WORKSPACE, which a Shepherd session sets, or a
.shepherd/ above the working directory; outside any workspace it fails
with no workspace for package "software". prepare --json reports the
resolved base, exclusions, gates and health argv and warnings.

An input file, for a Rails repository:

  {
    "role": "builder",
    "repo": "/path/to/worktree",
    "base": "origin/main",
    "history_writes": false,
    "excluded": ["bin/ci", "config/ci.rb", "app/controllers/admin/base_controller.rb"],
    "gates": {
      "test": { "argv": ["bin/rails", "test", "{files}"],
                "include": ["test/**/*_test.rb"], "system": ["test/system/"] },
      "lint": { "argv": ["bin/rubocop", "--force-exclusion", "--cache", "false", "{files}"],
                "include": ["**/*.rb", "**/*.rake", "Gemfile"] }
    },
    "contract_tests": ["test/integration/admin_test.rb"],
    "health": {
      "stacks": [{ "extensions": [".rb"], "format": "rubocop-json", "floor": null,
                   "argv": ["bin/rubocop", "--format", "json", "--only",
                            "Metrics/MethodLength,Metrics/AbcSize", "{file}"] }],
      "recheck": [["bin/exhale", "dry", "--base", "{base}", "--introduced-only"],
                  ["bin/exhale", "complexity", "--base", "{base}"]]
    }
  }

The runbook:

  1. Prepare through the installed binary into the item's runs/<run>/
     directory; do not reinstall while the builder runs.
  2. Copy the resolved base and exclusions from prepare --json into the
     brief, with history authority, attribution, the reserved-stop line and
     the third-block reporting instruction.
  3. Launch with --settings <path>; a one-shot builder runs claude -p with a
     finite --max-turns.
  4. After the first guarded tool call, confirm an ALLOW or DENY line in
     hooks.log; none means the run is unguarded: stop it.
  5. Always run recheck when the session ends; read excluded first.

Exit (prepare, recheck): 0 complete, 1 findings, 2 usage, environment, a
check that could not run, or, when no check failed, a changed excluded
path or a changed system test; a failed check takes exit 1 with every
finding reported. A fallback log line, when the runtime or launcher cannot
start, is written only where a safe destination exists, which the hook's
wrapper checks; run directly, outside a wrapper, the launcher writes none.
Production calls always go through a wrapper.
A recheck that exits 2 without an error reports status "warnings" and
result.complete false.
`;

const BUDGET_MS = { guard: 200, health: 2000, stop: 120_000, recheck: 120_000 };
/** Tests only: a shorter budget. The generated settings never set it. */
function budget(mode: keyof typeof BUDGET_MS): number {
	const test = Number(process.env.BUILDER_HOOKS_TEST_BUDGET_MS);
	return Number.isFinite(test) && test > 0 ? test : BUDGET_MS[mode];
}

const started = performance.now();
const elapsed = () => performance.now() - started;

/**
 * The log an early failure may write: only a validated manifest's, so a run
 * directory redirected into the repository never gets one, and an absent
 * or unreadable manifest gets no line at all.
 */
function fallbackLog(): string | null {
	try {
		return loadManifest(process.env.SHEPHERD_HOOK_MANIFEST).manifest.log;
	} catch {
		return null;
	}
}

function tryLog(log: string | null, hook: string, reason: string) {
	if (!log) return;
	try {
		logLine(log, hook, "-", "-", elapsed(), "COULD-NOT-RUN", reason);
	} catch {
		// The caller reports the failure on stderr.
	}
}

async function readEvent(): Promise<Record<string, unknown>> {
	const text = await Bun.stdin.text();
	let event: unknown;
	try {
		event = JSON.parse(text);
	} catch {
		throw new CannotCheck("the event on stdin is not JSON");
	}
	if (typeof event !== "object" || event === null || Array.isArray(event))
		throw new CannotCheck("the event on stdin is not an object");
	return event as Record<string, unknown>;
}

function session(event: Record<string, unknown>): string {
	const id = event.session_id;
	return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : "-";
}

function load(): { manifest: Manifest; runDir: string } {
	try {
		return loadManifest(process.env.SHEPHERD_HOOK_MANIFEST);
	} catch (error) {
		throw new CannotCheck((error as Error).message);
	}
}

async function guardMode(args: string[]): Promise<number> {
	const refuse = (why: string): number => {
		tryLog(fallbackLog(), "guard", why);
		process.stderr.write(
			`Role guard could not run: ${why}. The call is refused until the host repairs the hooks.\n`,
		);
		return 2;
	};
	const timer = setTimeout(
		() => {
			process.exit(
				refuse(`the guard did not finish within ${budget("guard")} ms`),
			);
		},
		Math.max(0, budget("guard") - elapsed()),
	);
	try {
		if (args.length) return refuse(`the guard takes no arguments (${args[0]})`);
		const event = await readEvent();
		const { manifest, runDir } = load();
		try {
			neutralizers(manifest.repo);
		} catch (error) {
			throw new CannotCheck((error as Error).message);
		}
		const decision = decide(manifest, runDir, event);
		if (elapsed() > budget("guard"))
			return refuse(`the guard did not finish within ${budget("guard")} ms`);
		let out: string;
		try {
			out = answer(manifest, decision, session(event), elapsed());
		} catch (error) {
			return refuse(
				`the hook log cannot be written (${(error as Error).message})`,
			);
		}
		process.stdout.write(out);
		return 0;
	} catch (error) {
		return refuse(
			error instanceof CannotCheck
				? error.message
				: `an internal error (${(error as Error).message})`,
		);
	} finally {
		clearTimeout(timer);
	}
}

// Health is loud through context: whatever stops it is said to the model as
// additionalContext with exit 0, never an exit the model does not see.
async function healthMode(args: string[]): Promise<number> {
	let file = "the edited file";
	const unable = (why: string): number => {
		tryLog(fallbackLog(), "health", why);
		context(`health check could not run on ${file}: ${why}`);
		return 0;
	};
	const timer = setTimeout(
		() => {
			tryLog(fallbackLog(), "health", "the 2 s budget passed");
			context(`health check did not finish on ${file} within 2 s`);
			process.exit(0);
		},
		Math.max(0, budget("health") + 200 - elapsed()),
	);
	try {
		if (args.length) return unable(`it takes no arguments (${args[0]})`);
		let event: Record<string, unknown>;
		try {
			event = await readEvent();
		} catch (error) {
			return unable((error as Error).message);
		}
		const input = event.tool_input as Record<string, unknown> | undefined;
		if (typeof input?.file_path !== "string" || input.file_path === "")
			return unable("the event names no file");
		file = input.file_path;
		let loaded: { manifest: Manifest };
		try {
			loaded = load();
		} catch (error) {
			return unable((error as Error).message);
		}
		try {
			neutralizers(loaded.manifest.repo);
			const text = await health(
				loaded.manifest,
				file,
				session(event),
				started,
				Date.now() + budget("health"),
			);
			if (text) context(text);
		} catch (error) {
			return unable((error as Error).message);
		}
		return 0;
	} finally {
		clearTimeout(timer);
	}
}

function context(text: string) {
	process.stdout.write(
		`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } })}\n`,
	);
}

async function stopMode(args: string[]): Promise<number> {
	const nonblocking = (why: string): number => {
		tryLog(fallbackLog(), "stop", why);
		process.stderr.write(
			`Stop gate could not run: ${why}. Not blocking; the host will re-check.\n`,
		);
		return 0;
	};
	if (args.length)
		return nonblocking(`the stop gate takes no arguments (${args[0]})`);
	let event: Record<string, unknown>;
	let loaded: { manifest: Manifest; runDir: string };
	try {
		event = await readEvent();
		loaded = load();
	} catch (error) {
		return nonblocking((error as Error).message);
	}
	const id = event.session_id;
	if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
		return nonblocking(
			"the event's session_id is missing or not a plain identifier",
		);
	const outcome = await stop(
		loaded.manifest,
		loaded.runDir,
		{
			session: id,
			active: event.stop_hook_active === true,
			message: event.last_assistant_message,
		},
		started,
		budget("stop"),
	);
	process.stdout.write(outcome.stdout);
	process.stderr.write(outcome.stderr);
	return outcome.code;
}

type Envelope = { command: string | null; json: boolean };

function emit(
	env: Envelope,
	status: string,
	findings: unknown[],
	failing: number,
	result: Record<string, unknown>,
	text: string,
) {
	if (env.json)
		process.stdout.write(
			`${JSON.stringify({ contract: 1, tool: "builder-hooks", command: env.command, status, findings, failing, result })}\n`,
		);
	else process.stdout.write(text);
}

function fail(env: Envelope, error: ToolError): number {
	if (env.json)
		process.stdout.write(
			`${JSON.stringify({
				contract: 1,
				tool: "builder-hooks",
				command: env.command,
				status: "error",
				findings: [],
				failing: 0,
				result: { complete: false },
				error: { code: error.code, message: error.message },
			})}\n`,
		);
	else process.stderr.write(`builder-hooks: ${error.message}\n`);
	return 2;
}

function options(
	args: string[],
	valued: string[],
	flags: string[],
): Record<string, string | true> {
	const out: Record<string, string | true> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (valued.includes(arg)) {
			const value = args[++i];
			if (value === undefined)
				throw new ToolError("usage", `${arg} needs a value; see --help`);
			out[arg] = value;
		} else if (flags.includes(arg)) out[arg] = true;
		else throw new ToolError("usage", `unknown argument: ${arg}; see --help`);
	}
	return out;
}

const launcher = (() => {
	const path = resolve(import.meta.dir, "../builder-hooks");
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
})();

async function tool(command: string, args: string[]): Promise<number> {
	const env: Envelope = { command, json: args.includes("--json") };
	const cwd = process.env.BUILDER_HOOKS_TARGET_CWD || process.cwd();
	try {
		if (command === "prepare") {
			const o = options(args, ["--input", "--run-dir"], ["--json"]);
			if (typeof o["--input"] !== "string")
				throw new ToolError("usage", "prepare needs --input; see --help");
			if (typeof o["--run-dir"] !== "string")
				throw new ToolError("usage", "prepare needs --run-dir; see --help");
			const p = prepare(cwd, o["--input"], o["--run-dir"], launcher);
			const { log: _log, ...policy } = p.policy;
			emit(
				env,
				"clean",
				[],
				0,
				{
					complete: true,
					settings: p.settings,
					manifest: p.manifest,
					log: p.log,
					runDir: p.runDir,
					...policy,
					warnings: p.warnings,
				},
				`${p.settings}\n`,
			);
			for (const w of env.json ? [] : p.warnings)
				process.stderr.write(`builder-hooks: warning: ${w}\n`);
			return 0;
		}
		const o = options(args, ["--manifest"], ["--json"]);
		if (typeof o["--manifest"] !== "string")
			throw new ToolError("usage", "recheck needs --manifest; see --help");
		const { manifest } = loadManifest(
			realpathOr(resolve(cwd, o["--manifest"])),
		);
		const r = await recheck(manifest, budget("recheck"));
		const failing = r.findings.filter((f) => f.severity === "error").length;
		emit(
			env,
			r.exit === 0 ? "clean" : r.exit === 1 ? "findings" : "warnings",
			r.findings,
			failing,
			r.result,
			r.text,
		);
		return r.exit;
	} catch (error) {
		if (error instanceof ToolError) return fail(env, error);
		return fail(env, new ToolError("internal", (error as Error).message));
	}
}

function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

async function main(argv: string[]): Promise<number> {
	const [mode, ...rest] = argv;
	if (mode === "--help" || mode === "-h") {
		process.stdout.write(USAGE);
		return 0;
	}
	if (mode === "guard") return guardMode(rest);
	if (mode === "health") return healthMode(rest);
	if (mode === "stop") return stopMode(rest);
	if (mode === "prepare" || mode === "recheck") {
		if (rest.includes("--help") || rest.includes("-h")) {
			process.stdout.write(USAGE);
			return 0;
		}
		return tool(mode, rest);
	}
	return fail(
		{ command: null, json: argv.includes("--json") },
		new ToolError(
			"usage",
			mode === undefined
				? "a mode is needed; see --help"
				: `unknown mode: ${mode}; see --help`,
		),
	);
}

process.exitCode = await main(Bun.argv.slice(2));
