// prepare: check the Shepherd's input, resolve the repository and base once,
// and publish the manifest, then the settings, into a new private run
// directory outside the repository. The settings go last, by link, so an
// interrupted run never leaves settings pointing at missing policy.
import {
	closeSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { hookGit } from "./git";
import { encode } from "./log";
import { checkInput, type Manifest, SENTINEL, ToolError } from "./manifest";
import { resolveDeep } from "./paths";

export const MANIFEST = "builder-manifest.json";
export const SETTINGS = "builder-hooks.settings.json";
export const LOG = "hooks.log";

export type Prepared = {
	settings: string;
	manifest: string;
	log: string;
	runDir: string;
	policy: Manifest;
	warnings: string[];
};

function usage(message: string): never {
	throw new ToolError("environment", message);
}

/** POSIX single quoting: the string is one word, whatever it holds. */
export function shq(text: string): string {
	return `'${text.replace(/'/g, "'\\''")}'`;
}

function inside(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`);
}

function harnessDirs(): string[] {
	const home = homedir();
	return [
		join(home, ".claude"),
		join(home, ".codex"),
		process.env.CLAUDE_CONFIG_DIR,
		process.env.CODEX_HOME,
	].filter((d): d is string => !!d);
}

function checkDestination(runDir: string, repo: string, gitDirs: string[]) {
	const resolved = resolveDeep(runDir);
	for (const form of [runDir, resolved]) {
		if (form.split("/").some((s) => s === ".claude" || s === ".codex"))
			usage(`the run directory ${runDir} is a harness configuration directory`);
		for (const dir of harnessDirs())
			if (inside(form, dir) || inside(form, resolveDeep(dir)))
				usage(`the run directory ${runDir} is inside ${dir}`);
		if (inside(form, repo))
			usage(`the run directory ${runDir} is inside the repository`);
		for (const g of gitDirs)
			if (inside(form, g)) usage(`the run directory ${runDir} is inside ${g}`);
	}
}

/**
 * The fixed wrapper a hook's settings command names: it holds the launcher,
 * manifest and log paths and answers in the hook's own protocol when the
 * launcher is gone, so the command the model sees prefixed to every hook
 * failure is the wrapper's path alone. A fallback line, its own or the
 * launcher's, goes to the log only while the run directory is still the
 * real path prepare made, outside the repository's real path resolved now,
 * and the manifest is byte for byte the one prepare wrote. Only then does
 * the launcher's own fallback write a line. Captured paths keep a trailing
 * newline, and the fixed reasons are encoded as the log encodes them.
 */
function wrapper(
	launcher: string,
	runDir: string,
	repo: string,
	manifest: string,
	mode: "guard" | "health" | "stop",
): string {
	const why = `the launcher ${launcher} is missing or not executable`;
	const logged = (reason: string) =>
		`[ -z "$log" ] || printf '%s ${mode} launcher - 0ms COULD-NOT-RUN %s\\n' "$(date +%H:%M:%S)" ${reason} >>"$log" 2>/dev/null`;
	const head = `#!/bin/sh
# builder-hooks ${mode} hook for this run, written by prepare.
PATH=$PATH:/usr/bin:/bin
nl='
'
log=
checked=
if run=$(cd ${shq(runDir)} 2>/dev/null && pwd -P && echo x) && run=\${run%x} && run=\${run%"$nl"} &&
	[ "$run" = ${shq(runDir)} ] &&
	real=$(cd ${shq(repo)} 2>/dev/null && pwd -P && echo x) && real=\${real%x} && real=\${real%"$nl"}; then
	case "$run/" in
	"$real"/* | ${shq(repo)}/*) ;;
	*) printf '%s' ${shq(manifest)} | cmp -s - "$run/${MANIFEST}" && log=${shq(join(runDir, LOG))} && checked=1 ;;
	esac
fi
export SHEPHERD_HOOK_MANIFEST=${shq(join(runDir, MANIFEST))} SHEPHERD_HOOK_LOG="$log" BUILDER_HOOKS_LOG_CHECKED="$checked"
`;
	const run = `${shq(launcher)} ${mode}`;
	if (mode === "guard") {
		const refused = `Role guard could not run: ${why}. The call is refused until the host repairs the hooks.`;
		return `${head}[ -x ${shq(launcher)} ] || { printf '%s\\n' ${shq(refused)} >&2; exit 2; }\nexec ${run}\n`;
	}
	if (mode === "health") {
		const context = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: `health check could not run on the edited file: ${why}`,
			},
		});
		return `${head}[ -x ${shq(launcher)} ] || {\n\tprintf '%s\\n' ${shq(context)}\n\t${logged(shq(encode(why, false)))}\n\texit 0\n}\nexec ${run}\n`;
	}
	// Stop answers by exit 0 or 2; anything else, or no launcher, ends the
	// gate without blocking and leaves a line for the host.
	return `${head}unable() {
\tprintf 'Stop gate could not run: %s. Not blocking; the host will re-check.\\n' "$1" >&2
\t${logged('"$2"')}
\texit 0
}
[ -x ${shq(launcher)} ] || unable ${shq(why)} ${shq(encode(why, false))}
${run}
code=$?
case $code in
0 | 2) exit "$code" ;;
esac
unable "the runtime exited $code" "the runtime exited $code"
`;
}

type HookEntry = Record<string, unknown>;

/** Write a new private file by temp file and link; never overwrite. */
function publish(path: string, text: string, mode = 0o600) {
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	const fd = openSync(temp, "wx", mode);
	try {
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(temp, path);
	} finally {
		unlinkSync(temp);
	}
}

export function prepare(
	cwd: string,
	inputPath: string,
	runDirArg: string,
	launcher: string,
): Prepared {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(resolve(cwd, inputPath), "utf8"));
	} catch (error) {
		usage(
			`the input cannot be read as JSON (${(error as Error).message.split("\n")[0]})`,
		);
	}
	const input = checkInput(raw);
	const warnings: string[] = [];

	const repoGiven = resolve(cwd, input.repo);
	let repo: string;
	try {
		repo = realpathSync(repoGiven);
	} catch {
		usage(`the repository ${input.repo} does not exist`);
	}
	const top = hookGit(repo, ["rev-parse", "--show-toplevel"]);
	if (!top.ok || realpathSync(top.stdout.trim()) !== repo)
		usage(`${input.repo} is not the top of a git worktree`);
	const gitDirs = ["--absolute-git-dir", "--git-common-dir"].map((flag) => {
		const out = hookGit(repo, ["rev-parse", "--path-format=absolute", flag]);
		if (!out.ok) usage("git cannot name the repository's git directory");
		return resolveDeep(out.stdout.trim());
	});
	const base = hookGit(repo, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${input.base}^{commit}`,
	]);
	if (!base.ok) usage(`the base ${input.base} is not a commit in ${repo}`);
	const sha = base.stdout.trim();

	if (input.contract_tests !== SENTINEL)
		for (const p of input.contract_tests)
			if (!hookGit(repo, ["cat-file", "-e", `${sha}:${p}`]).ok)
				usage(`contract_tests names ${p}, which is absent at the base`);
	if (input.history_writes)
		warnings.push(
			"history_writes is true: the brief must carry the grant that allows it",
		);

	if (runDirArg === "") usage("--run-dir is empty");
	const runDir = resolve(cwd, runDirArg);
	checkDestination(runDir, repo, gitDirs);
	let stat: ReturnType<typeof lstatSync> | undefined;
	try {
		stat = lstatSync(runDir);
	} catch {
		stat = undefined;
	}
	if (stat) {
		if (!stat.isDirectory())
			usage(`the run directory ${runDir} is not a directory`);
		if (readdirSync(runDir).length)
			usage(`the run directory ${runDir} is not empty`);
	} else {
		try {
			mkdirSync(runDir, { mode: 0o700 });
		} catch (error) {
			usage(
				`the run directory ${runDir} cannot be made (${(error as Error).message})`,
			);
		}
	}
	const real = realpathSync(runDir);
	checkDestination(real, repo, gitDirs);
	const manifestPath = join(real, MANIFEST);
	const settingsPath = join(real, SETTINGS);
	const logPath = join(real, LOG);
	const wrappers = {
		guard: join(real, "guard.sh"),
		health: join(real, "health.sh"),
		stop: join(real, "stop.sh"),
	};

	// --settings adds these to the project's, local and user hooks (live
	// check, 2.1.304), so the file holds only the builder's entries; they
	// fire for subagent tool calls too.
	const policy: Manifest = { ...input, repo, base: sha, log: logPath };
	const hooks: Record<string, HookEntry[]> = {};
	const add = (event: string, entry: HookEntry) => {
		hooks[event] = [entry];
	};
	add("PreToolUse", {
		matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash",
		hooks: [
			{
				type: "command",
				command: shq(wrappers.guard),
				timeout: 2,
				onFailure: "block",
			},
		],
	});
	add("PostToolUse", {
		matcher: "Edit|Write|MultiEdit",
		hooks: [
			{
				type: "command",
				command: shq(wrappers.health),
				timeout: 3,
			},
		],
	});
	add("Stop", {
		hooks: [
			{
				type: "command",
				command: shq(wrappers.stop),
				timeout: 125,
			},
		],
	});

	const manifestText = `${JSON.stringify(policy, null, 2)}\n`;
	publish(manifestPath, manifestText);
	for (const mode of ["guard", "health", "stop"] as const)
		publish(
			wrappers[mode],
			wrapper(launcher, real, repo, manifestText, mode),
			0o700,
		);
	if (process.env.BUILDER_HOOKS_TEST_INTERRUPT === "before-settings")
		process.kill(process.pid, "SIGKILL");
	publish(
		settingsPath,
		`${JSON.stringify({ disableAllHooks: false, hooks }, null, 2)}\n`,
	);
	return {
		settings: settingsPath,
		manifest: manifestPath,
		log: logPath,
		runDir: real,
		policy,
		warnings,
	};
}
