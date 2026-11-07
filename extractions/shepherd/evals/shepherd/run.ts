#!/usr/bin/env bun
/**
 * `bun run evals:shepherd`: build the current tree's Shepherd into a retained
 * per-run scratch `bin/shepherd`, freeze the evaluated inputs, and run the
 * gate's trials through the Python harness with an explicit configuration:
 * the resolved subject binary, the run's scratch directory and its artifact
 * root. The repository `bin/`, the live launcher, is never written. Each
 * finished trial becomes an attempt in `results/<source-hash>.json`, with
 * its redacted evidence under `artifacts/` (see `gate.ts`).
 *
 * Usage:
 *   bun run evals:shepherd [--scratch <dir>] [--artifacts <dir>]
 *   bun run evals:shepherd --check [--scratch <dir>]
 *   bun run evals:shepherd --validation --trials D [--scratch <dir>]
 *   bun run evals:shepherd --trend
 *
 * `--check` runs the shell syntax checks, `check-harness.py` against a
 * scratch-compiled subject, including real fixture shapes, and
 * `check-musts.py`. Its session launches are fake, and a stub `claude` sits
 * first on PATH.
 *
 * `--validation --trials` is the lead's regression validation (8.5): only
 * the named trials run, under the gate's policy, and the result, summary
 * and evidence go to `validation/<source-hash>/<run-id>/`, which the CI
 * verifier never reads.
 *
 * `--trend` prints the committed results at `HEAD`, one row per evaluation
 * in commit order (see `trend.ts`); it builds and runs nothing.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	type Builder,
	type BuildProvenance,
	compileAgent,
	entryPackagePath,
	type GitRunner,
	gitStamp,
	readWorktreeSource,
	runGit,
	SHEPHERD_ID,
	type SourceManifest,
	type StampSource,
	sameSource,
	versionLine,
} from "./build-source";
import { runGate, type ScoreJob } from "./gate";
import { type EvaluationIdentity, evaluationIdentity } from "./identity";
import {
	defaultLayout,
	type EvalLayout,
	requireGitRoot,
	sourceLayout,
	toLayout,
} from "./layout";
import { canonicalJson, GATE_TRIALS, loadRubric, policyHash } from "./schema";

export { canonicalJson };

import {
	checkIsolation,
	type ScorerConfig,
	scoreAttempt,
	scorerEnv,
	stopScorers,
} from "./scorer";
import { trendLines } from "./trend";

/** This harness's own directory: its scripts, policy, rubric and prompt. */
export const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
const RUBRIC = join(EVALS_DIR, "rubric.json");

/** The fixed subject and execution policy (spec 5.1), from `policy.json`. */
export interface Policy {
	trials: string[];
	backend: "claude";
	model: string;
	effort: string;
	permissionMode: string;
	disallowedTools: string[];
	maxConcurrentSubjects: number;
	subjectTimeoutSeconds: number;
	toolTimeoutSeconds: number;
	invocationTimeoutSeconds: number;
	/** Written as the scratch `XDG_CONFIG_HOME/shepherd/config.json`. */
	shepherdSettings: Record<string, unknown>;
	/** The judged-Must scorer (4.1, 4.5). */
	scorer: {
		family: "claude";
		model: string;
		effort: string;
		timeoutSeconds: number;
		maxConcurrent: number;
	};
}

export function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function loadPolicy(dir = EVALS_DIR): { policy: Policy; hash: string } {
	const policy = JSON.parse(
		readFileSync(join(dir, "policy.json"), "utf8"),
	) as Policy;
	return { policy, hash: policyHash(policy) };
}

/** Refuse `path` inside the package or the repository that holds it. */
function refuseInside(layout: EvalLayout, path: string, what: string): void {
	for (const root of [layout.gitRoot, layout.packageRoot]) {
		const top = realpathSync(root);
		if (path === top || path.startsWith(top + sep)) {
			throw new Error(`Refusing a ${what} inside the repository: ${path}`);
		}
	}
}

/** Create `dir` if needed; refuse it when it holds anything already. */
export function claimArtifactRoot(dir: string): void {
	mkdirSync(dir, { recursive: true });
	if (readdirSync(dir).length > 0) {
		throw new Error(
			`Artifact root is not empty: ${dir}; preserve or move its contents before another run`,
		);
	}
}

export interface RunPaths {
	runId: string;
	/** Resolved, retained after the run. */
	runDir: string;
	artifactRoot: string;
}

/**
 * The harness's isolation refusal (5.2): not beneath `~/shepherds`, a
 * `.shepherd` ancestor or a Git repository.
 */
export function checkScratch(dir: string): void {
	const child = spawnSync(
		"python3",
		["-I", join(EVALS_DIR, "harness.py"), "scratch", dir],
		{ timeout: 60_000, encoding: "utf8" },
	);
	if (child.status !== 0) {
		throw new Error(child.stderr.trim() || `scratch check failed: ${dir}`);
	}
}

/** A fresh run directory beneath the resolved, isolated scratch parent. */
export function prepareRun(options: {
	/** The layout, or a repository top that is the package. */
	root: string | EvalLayout;
	scratchParent: string;
	artifactRoot?: string;
}): RunPaths {
	const parent = realpathSync(options.scratchParent);
	refuseInside(toLayout(options.root), parent, "scratch directory");
	checkScratch(parent);
	const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
	const runId = `${stamp}-${randomBytes(3).toString("hex")}`;
	const runDir = join(parent, `shepherd-evals-${runId}`);
	const artifactRoot = options.artifactRoot
		? resolve(options.artifactRoot)
		: join(runDir, "artifacts");
	// An explicit artifact root is refused before the run directory exists.
	if (options.artifactRoot) claimArtifactRoot(artifactRoot);
	mkdirSync(runDir);
	claimArtifactRoot(artifactRoot);
	return { runId, runDir, artifactRoot };
}

/** A subject's runtime packages, copied read only beside its `bin/`. */
export interface PackageSnapshot {
	/** Resolved `<subject>/packages`, where the binary reads base packages. */
	dir: string;
	/** Package-relative paths (`packages/...`) with their frozen bytes and modes. */
	files: { path: string; sha256: string; executable: boolean }[];
}

const PACKAGES = "packages";

/** Every file and directory beneath `dir`, directories after their contents. */
function walk(dir: string, prefix = ""): { path: string; dir: boolean }[] {
	const out: { path: string; dir: boolean }[] = [];
	for (const name of readdirSync(dir).sort()) {
		const path = prefix === "" ? name : `${prefix}/${name}`;
		if (lstatSync(join(dir, name)).isDirectory()) {
			out.push(...walk(join(dir, name), path), { path, dir: true });
		} else out.push({ path, dir: false });
	}
	return out;
}

/**
 * Copy the build manifest's `packages/` entries from the package into
 * `into`, refusing any whose bytes changed since the manifest was read, and
 * make the copy read only: files keep their executable status, nothing in
 * the tree stays writable, so a later source edit never reaches the subject.
 */
export function snapshotPackages(options: {
	packageRoot: string;
	manifest: SourceManifest;
	into: string;
}): PackageSnapshot {
	mkdirSync(dirname(options.into), { recursive: true });
	mkdirSync(options.into);
	const files: PackageSnapshot["files"] = [];
	for (const entry of options.manifest.entries) {
		const path = entryPackagePath(entry.path);
		if (path === undefined || !path.startsWith(`${PACKAGES}/`)) continue;
		const bytes = readFileSync(join(options.packageRoot, path));
		if (sha256(bytes) !== entry.sha256) {
			throw new Error(
				`Runtime package file changed after the build read it: ${path}`,
			);
		}
		const executable =
			entry.executable ??
			(lstatSync(join(options.packageRoot, path)).mode & 0o100) !== 0;
		const to = join(options.into, path.slice(PACKAGES.length + 1));
		mkdirSync(dirname(to), { recursive: true });
		writeFileSync(to, bytes, { flag: "wx" });
		chmodSync(to, executable ? 0o555 : 0o444);
		files.push({ path, sha256: entry.sha256, executable });
	}
	for (const item of walk(options.into)) {
		if (item.dir) chmodSync(join(options.into, item.path), 0o555);
	}
	chmodSync(options.into, 0o555);
	return { dir: realpathSync(options.into), files };
}

/** Why a snapshot no longer holds its frozen files, bytes and modes; empty when it does. */
export function snapshotChanges(snapshot: PackageSnapshot): string[] {
	const expected = new Map(snapshot.files.map((file) => [file.path, file]));
	const reasons: string[] = [];
	const seen = new Set<string>();
	for (const item of walk(snapshot.dir)) {
		if (item.dir) continue;
		const path = `${PACKAGES}/${item.path}`;
		seen.add(path);
		const file = expected.get(path);
		const full = join(snapshot.dir, item.path);
		if (!file) reasons.push(`runtime package file added: ${path}`);
		else if (sha256(readFileSync(full)) !== file.sha256)
			reasons.push(`runtime package bytes changed: ${path}`);
		else if (((lstatSync(full).mode & 0o111) !== 0) !== file.executable)
			reasons.push(`runtime package executable status changed: ${path}`);
	}
	for (const path of expected.keys()) {
		if (!seen.has(path)) reasons.push(`runtime package file removed: ${path}`);
	}
	return reasons;
}

/**
 * Build Shepherd into `<runDir>/<subject>/bin/shepherd`, snapshot its
 * runtime packages beside that `bin/`, and return the binary's resolved
 * path, the path every provenance marker must name.
 */
export async function buildSubject(options: {
	/** The layout, or a repository top that is the package. */
	root: string | EvalLayout;
	runDir: string;
	build?: Builder;
	stamp?: StampSource;
	signal?: AbortSignal;
}): Promise<{
	subject: string;
	provenance: BuildProvenance;
	packages: PackageSnapshot;
}> {
	const layout = toLayout(options.root);
	const runDir = realpathSync(options.runDir);
	refuseInside(layout, runDir, "build directory");
	const install = join(runDir, layout.subject);
	const outFile = join(install, "bin", SHEPHERD_ID);
	mkdirSync(dirname(outFile), { recursive: true });
	const built = await compileAgent({
		root: layout.packageRoot,
		file: "agents/shepherd.md",
		outFile,
		build: options.build,
		stamp: options.stamp ?? gitStamp(runGit, sourceLayout(layout)),
		signal: options.signal,
	});
	if (!built.provenance) throw new Error("The Shepherd build has no stamp");
	const packages = snapshotPackages({
		packageRoot: layout.packageRoot,
		manifest: built.provenance.manifest,
		into: join(install, PACKAGES),
	});
	return {
		subject: realpathSync(outFile),
		provenance: built.provenance,
		packages,
	};
}

/** The environment for fixture tools and subjects: the subject first on PATH. */
export function subjectEnv(
	subject: string,
	base: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) env[key] = value;
	}
	env.PATH = `${dirname(subject)}:${env.PATH ?? ""}`;
	return env;
}

export function readVersion(subject: string, timeoutMs = 60_000): string {
	const child = spawnSync(subject, ["--version"], {
		env: subjectEnv(subject),
		timeout: timeoutMs,
	});
	if (child.status !== 0) {
		throw new Error(
			`${subject} --version failed (${child.status ?? child.signal ?? child.error?.message}): ${child.stderr}`,
		);
	}
	return child.stdout.toString();
}

/** Inputs captured before any subject launches (spec 2.5). */
export interface Frozen {
	runId: string;
	subject: string;
	binarySha256: string;
	/** Exact `--version` output. */
	version: string;
	revision: string;
	dirty: boolean;
	sourceDirty: boolean;
	manifest: SourceManifest;
	evaluation: EvaluationIdentity;
	policy: Policy;
	policyHash: string;
	/** The rubric the checks and the scorer use. */
	rubricSha256: string;
	/** The run configuration every harness process reads. */
	config: string;
	configSha256: string;
	/** The subject's runtime package snapshot, when the run built one. */
	packages?: PackageSnapshot;
	frozenAt: string;
}

export function freeze(options: {
	/** The layout, or a repository top that is the package. */
	root: string | EvalLayout;
	runId: string;
	config: string;
	subject: string;
	provenance: BuildProvenance;
	versionOutput: string;
	policy: Policy;
	policyHash: string;
	packages?: PackageSnapshot;
	git?: GitRunner;
	rubric?: string;
}): Frozen {
	const layout = toLayout(options.root);
	const expected = `${versionLine(options.provenance)}\n`;
	if (options.versionOutput !== expected) {
		throw new Error(
			`Version stamp mismatch: ${options.subject} printed ${JSON.stringify(options.versionOutput)}, its build expects ${JSON.stringify(expected)}`,
		);
	}
	return {
		runId: options.runId,
		subject: options.subject,
		binarySha256: sha256(readFileSync(options.subject)),
		version: options.versionOutput,
		revision: options.provenance.revision,
		dirty: options.provenance.dirty,
		sourceDirty: options.provenance.sourceDirty,
		manifest: options.provenance.manifest,
		evaluation: evaluationIdentity(layout.packageRoot, {
			git: options.git,
			layout: sourceLayout(layout),
		}),
		policy: options.policy,
		policyHash: options.policyHash,
		rubricSha256: `sha256:${sha256(readFileSync(options.rubric ?? RUBRIC))}`,
		config: options.config,
		configSha256: sha256(readFileSync(options.config)),
		...(options.packages ? { packages: options.packages } : {}),
		frozenAt: new Date().toISOString(),
	};
}

/** Why the frozen inputs no longer hold; empty when they do. */
export function recheck(
	frozen: Frozen,
	options: { root: string | EvalLayout; git?: GitRunner },
): string[] {
	const git = options.git ?? runGit;
	const layout = toLayout(options.root);
	const at = { git, layout: sourceLayout(layout) };
	const reasons: string[] = [];
	const attempt = (what: string, check: () => string | undefined) => {
		try {
			const reason = check();
			if (reason) reasons.push(reason);
		} catch (error) {
			reasons.push(
				`${what} could not be rechecked: ${(error as Error).message}`,
			);
		}
	};
	attempt("subject binary", () =>
		sha256(readFileSync(frozen.subject)) === frozen.binarySha256
			? undefined
			: `subject binary bytes changed after execution: ${frozen.subject}`,
	);
	attempt("run configuration", () =>
		sha256(readFileSync(frozen.config)) === frozen.configSha256
			? undefined
			: `run configuration changed after freezing: ${frozen.config}`,
	);
	attempt("rubric", () =>
		`sha256:${sha256(readFileSync(RUBRIC))}` === frozen.rubricSha256
			? undefined
			: `rubric changed after freezing: ${RUBRIC}`,
	);
	const packages = frozen.packages;
	if (packages) {
		attempt("runtime packages", () => {
			const changes = snapshotChanges(packages);
			return changes.length === 0
				? undefined
				: `runtime package snapshot changed after freezing: ${changes.join("; ")}`;
		});
	}
	attempt("source identity", () => {
		const now = readWorktreeSource(layout.packageRoot, at);
		return sameSource(now, frozen.manifest)
			? undefined
			: `source identity changed: frozen ${frozen.manifest.source}, now ${now.source}`;
	});
	attempt("evaluation identity", () => {
		const now = evaluationIdentity(layout.packageRoot, at);
		return now.hash === frozen.evaluation.hash
			? undefined
			: `evaluation identity changed: frozen ${frozen.evaluation.hash}, now ${now.hash}`;
	});
	return reasons;
}

export interface TrialOutcome {
	trial: string;
	started: boolean;
	exitCode: number | null;
	signal: string | null;
	/** Stopped by the invocation bound. */
	timedOut: boolean;
	cancelled: boolean;
	startedAt?: number;
	endedAt?: number;
}

/** Process groups of running trials, killed if this process exits. */
const liveGroups = new Set<number>();

export function liveGroupCount(): number {
	return liveGroups.size;
}

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch {
		return false;
	}
}

/** SIGTERM every group that still has members, then SIGKILL after `graceMs`. */
async function sweep(groups: Iterable<number>, graceMs: number): Promise<void> {
	let live = [...groups].filter((pgid) => signalGroup(pgid, "SIGTERM"));
	const deadline = Date.now() + graceMs;
	while (live.length > 0 && Date.now() < deadline) {
		await Bun.sleep(20);
		live = live.filter((pgid) => signalGroup(pgid, 0));
	}
	for (const pgid of live) signalGroup(pgid, "SIGKILL");
}

/**
 * Run one command per trial, at most `maxConcurrent` at once, each in its
 * own process group. When `timeoutMs` passes or `signal` aborts, no further
 * trial starts and every running group gets SIGTERM, then SIGKILL after
 * `graceMs`. Each group is swept again once its leader exits.
 */
export async function runTrials(options: {
	trials: readonly string[];
	command: (trial: string) => string[];
	env: Record<string, string>;
	cwd: string;
	maxConcurrent: number;
	timeoutMs: number;
	graceMs?: number;
	signal?: AbortSignal;
}): Promise<TrialOutcome[]> {
	const graceMs = options.graceMs ?? 5_000;
	const outcomes: TrialOutcome[] = options.trials.map((trial) => ({
		trial,
		started: false,
		exitCode: null,
		signal: null,
		timedOut: false,
		cancelled: false,
	}));
	const groups = new Set<number>();
	const running = new Map<TrialOutcome, Promise<void>>();
	let stopping = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const stop = (reason: "timedOut" | "cancelled") => {
		if (stopping) return;
		stopping = true;
		for (const outcome of running.keys()) outcome[reason] = true;
		for (const pgid of groups) signalGroup(pgid, "SIGTERM");
		killTimer = setTimeout(() => {
			for (const pgid of groups) signalGroup(pgid, "SIGKILL");
		}, graceMs);
	};
	const timer = setTimeout(() => stop("timedOut"), options.timeoutMs);
	const abort = () => stop("cancelled");
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();

	const launch = (outcome: TrialOutcome) =>
		new Promise<number | undefined>((done) => {
			const [file = "", ...args] = options.command(outcome.trial);
			let child: ChildProcess;
			try {
				child = spawn(file, args, {
					cwd: options.cwd,
					env: options.env,
					detached: true,
					stdio: ["ignore", "inherit", "inherit"],
				});
			} catch {
				done(undefined);
				return;
			}
			outcome.started = true;
			outcome.startedAt = Date.now();
			const pgid = child.pid;
			if (pgid !== undefined) {
				groups.add(pgid);
				liveGroups.add(pgid);
			}
			child.once("error", () => {
				outcome.endedAt ??= Date.now();
				done(pgid);
			});
			child.once("exit", (code, signal) => {
				outcome.exitCode = code;
				outcome.signal = signal;
				outcome.endedAt = Date.now();
				done(pgid);
			});
		});

	// Once its leader exits, a trial's group is swept, then forgotten, so a
	// later sweep never signals a reused process group ID.
	const forget = async (pgid: number | undefined) => {
		if (pgid === undefined) return;
		await sweep([pgid], graceMs);
		groups.delete(pgid);
		liveGroups.delete(pgid);
	};
	const pending = [...outcomes];
	if (options.timeoutMs <= 0) stopping = true;
	while (running.size > 0 || (pending.length > 0 && !stopping)) {
		while (!stopping && running.size < options.maxConcurrent) {
			const outcome = pending.shift();
			if (!outcome) break;
			const finished = launch(outcome)
				.then(forget)
				.then(() => {
					running.delete(outcome);
				});
			running.set(outcome, finished);
		}
		if (running.size === 0) break;
		await Promise.race(running.values());
	}
	clearTimeout(timer);
	options.signal?.removeEventListener("abort", abort);
	await sweep(groups, graceMs);
	clearTimeout(killTimer);
	for (const pgid of groups) liveGroups.delete(pgid);
	return outcomes;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, { flag: "wx" });
}

function writeConfig(run: RunPaths, subject: string, policy: Policy): string {
	const path = join(run.runDir, "config.json");
	writeJson(path, {
		runId: run.runId,
		subject,
		comparison: null,
		scratchParent: run.runDir,
		artifactRoot: run.artifactRoot,
		policy,
	});
	return path;
}

/** The gate's scorer: one scoring round per job (4.5), each invocation reported as it ends. */
export function scoreJobs(
	config: ScorerConfig,
	cliVersion: string,
	signal?: AbortSignal,
): (job: ScoreJob) => ReturnType<typeof scoreAttempt> {
	return (job) =>
		scoreAttempt({
			config,
			packet: job.packet,
			requested: job.requested,
			round: job.round,
			cliVersion,
			signal,
			deadline: job.deadline,
			onInvocation: job.onInvocation,
		});
}

/** Fixtures refuse to build after 23:40 local time; so does the wrapper. */
export function lateStart(now: Date): string | undefined {
	return now.getHours() * 60 + now.getMinutes() > 23 * 60 + 40
		? "Refusing to start after 23:40 local time: fixtures cannot be built; try tomorrow"
		: undefined;
}

const USAGE =
	"Usage: bun run evals:shepherd [--check] [--scratch <dir>] [--artifacts <dir>] [layout]\n       bun run evals:shepherd --validation --trials <trial>[,<trial>...] [--scratch <dir>] [layout]\n       bun run evals:shepherd --trend [--package-root <dir>] [--git-root <dir>]\nLayout: [--package-root <dir>] [--git-root <dir>] [--subject-dir <relative dir>]";

async function main(): Promise<number> {
	const startedAt = Date.now();
	let parsed: ReturnType<typeof parseOptions>;
	try {
		parsed = parseOptions(process.argv.slice(2));
	} catch (error) {
		console.error(`${(error as Error).message}\n${USAGE}`);
		return 2;
	}
	const layout = defaultLayout(parsed.layout);
	requireGitRoot(layout);
	if (parsed.trend) {
		for (const line of trendLines(layout)) console.log(line);
		return 0;
	}
	const controller = new AbortController();
	let interrupted = 0;
	for (const [name, code] of [
		["SIGINT", 130],
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const) {
		process.on(name, () => {
			interrupted ||= code;
			controller.abort();
		});
	}
	process.on("exit", () => {
		for (const pgid of liveGroups) signalGroup(pgid, "SIGKILL");
		stopScorers();
	});

	const late = lateStart(new Date());
	if (late) {
		console.error(late);
		return 2;
	}
	const { policy, hash } = loadPolicy();
	const root = layout;
	if (parsed.check) {
		for (const name of ["run-trial.sh", "fixtures.sh"]) {
			const syntax = spawnSync("bash", ["-n", join(EVALS_DIR, name)], {
				stdio: "inherit",
			});
			if (syntax.status !== 0) return 1;
		}
	}
	const run = prepareRun({
		root,
		scratchParent: parsed.scratch,
		artifactRoot: parsed.check ? undefined : parsed.artifacts,
	});
	console.log(`Run directory (retained): ${run.runDir}`);
	checkScratch(run.runDir);
	const { subject, provenance, packages } = await buildSubject({
		root,
		runDir: run.runDir,
		signal: controller.signal,
	});
	const config = writeConfig(run, subject, policy);
	const frozen = freeze({
		root,
		runId: run.runId,
		config,
		subject,
		provenance,
		versionOutput: readVersion(subject),
		policy,
		policyHash: hash,
		packages,
	});
	console.log(`Subject: ${subject}\n${frozen.version.trimEnd()}`);
	const deadline = startedAt + policy.invocationTimeoutSeconds * 1000;

	if (parsed.check) {
		const stubs = join(run.runDir, "stub-bin");
		mkdirSync(stubs);
		writeFileSync(
			join(stubs, "claude"),
			"#!/bin/sh\necho 'stub claude: --check never launches a model' >&2\nexit 97\n",
		);
		chmodSync(join(stubs, "claude"), 0o755);
		const env = subjectEnv(subject);
		env.PATH = `${stubs}:${env.PATH}`;
		const outcomes = await runTrials({
			trials: ["check-harness", "check-musts"],
			command: (name) => [
				"python3",
				"-I",
				join(EVALS_DIR, `${name}.py`),
				...(name === "check-harness" ? ["--config", config] : []),
			],
			env,
			cwd: EVALS_DIR,
			maxConcurrent: 1,
			timeoutMs: deadline - Date.now(),
			signal: controller.signal,
		});
		if (interrupted) return interrupted;
		return outcomes.every((outcome) => outcome.exitCode === 0) ? 0 : 1;
	}

	writeJson(join(run.artifactRoot, "frozen.json"), frozen);
	const scorer: ScorerConfig = {
		claude: "claude",
		model: policy.scorer.model,
		effort: policy.scorer.effort,
		timeoutMs: policy.scorer.timeoutSeconds * 1000,
		workRoot: join(run.runDir, "scorer"),
		env: scorerEnv(),
		prompt: readFileSync(join(EVALS_DIR, "scorer-prompt.md"), "utf8"),
	};
	// Unsupported scorer isolation is an error before any subject launches.
	const { cliVersion } = checkIsolation(scorer);
	const waves: Awaited<ReturnType<typeof runTrials>>[] = [];
	const { result } = await runGate({
		layout,
		validation: parsed.validation ? { trials: parsed.validation } : undefined,
		sourceHash: frozen.manifest.source,
		manifest: frozen.manifest.entries,
		identity: {
			hash: frozen.evaluation.hash,
			rubricSha256: frozen.rubricSha256,
			policySha256: frozen.policyHash,
			policy: { ...policy },
			scorer: {
				family: policy.scorer.family,
				model: policy.scorer.model,
				effort: policy.scorer.effort,
			},
		},
		build: {
			revision: frozen.revision,
			dirty: frozen.dirty,
			sourceDirty: frozen.sourceDirty,
			version: frozen.version,
			binarySha256: frozen.binarySha256,
			bunVersion: Bun.version,
			platform: process.platform,
			arch: process.arch,
			builtAt: frozen.frozenAt,
		},
		runId: run.runId,
		scratchRoot: run.runDir,
		artifactRoot: run.artifactRoot,
		home: homedir(),
		rubric: loadRubric(),
		deadline,
		runWave: async (jobs) => {
			if (controller.signal.aborted) return [];
			const ordinals = new Map(jobs.map((job) => [job.trial, job.ordinal]));
			const outcomes = await runTrials({
				trials: jobs.map((job) => job.trial),
				command: (trial) => [
					"bash",
					join(EVALS_DIR, "run-trial.sh"),
					config,
					trial,
					policy.backend,
					"--attempt",
					String(ordinals.get(trial)),
				],
				env: subjectEnv(subject),
				cwd: run.runDir,
				maxConcurrent: policy.maxConcurrentSubjects,
				timeoutMs: deadline - Date.now(),
				signal: controller.signal,
			});
			waves.push(outcomes);
			return outcomes
				.filter((outcome) => outcome.started)
				.map((outcome) => ({
					trial: outcome.trial,
					ordinal: ordinals.get(outcome.trial) ?? 0,
					exitCode: outcome.exitCode,
				}));
		},
		score: scoreJobs(scorer, cliVersion, controller.signal),
		scorerConcurrency: policy.scorer.maxConcurrent,
		scorerTimeoutMs: scorer.timeoutMs,
		recheck: () => recheck(frozen, { root }),
	});
	const reasons = result.evaluation.invocations.at(-1)?.recheck.reasons ?? [];
	writeJson(join(run.artifactRoot, "invocation.json"), {
		runId: run.runId,
		startedAt: new Date(startedAt).toISOString(),
		endedAt: new Date().toISOString(),
		waves,
		recheck: { valid: reasons.length === 0, reasons },
	});
	for (const trial of result.evaluation.trials) {
		console.log(
			`${trial.trial}: ${trial.outcome} (${trial.attempts.length} attempts)`,
		);
	}
	for (const reason of reasons) console.error(`INVALID: ${reason}`);
	const hex = frozen.manifest.source.replace(/^sha256:/, "");
	console.log(
		`Result: ${result.outcome}, ${
			parsed.validation
				? join(layout.evalsDir, "validation", hex, run.runId, "result.json")
				: join(layout.evalsDir, "results", `${hex}.json`)
		}`,
	);
	if (interrupted) return interrupted;
	if (reasons.length > 0) return 4;
	return result.outcome === "blocked" ? 1 : 0;
}

export function parseOptions(argv: string[]) {
	const { values: raw } = parseArgs({
		args: argv,
		options: {
			check: { type: "boolean", default: false },
			trend: { type: "boolean", default: false },
			scratch: { type: "string" },
			artifacts: { type: "string" },
			"package-root": { type: "string" },
			"git-root": { type: "string" },
			"subject-dir": { type: "string" },
			validation: { type: "boolean", multiple: true },
			trials: { type: "string", multiple: true },
		},
		strict: true,
		allowPositionals: false,
	});
	// A costed validation run must not silently take the last of two values.
	for (const flag of ["validation", "trials"] as const) {
		if ((raw[flag]?.length ?? 0) > 1)
			throw new Error(`--${flag} may be given only once`);
	}
	const values = {
		...raw,
		validation: raw.validation?.[0] ?? false,
		trials: raw.trials?.[0],
	};
	if (
		values.trend &&
		(values.check ||
			values.validation ||
			values.trials !== undefined ||
			values.scratch !== undefined ||
			values.artifacts !== undefined ||
			values["subject-dir"] !== undefined)
	) {
		throw new Error(
			"--trend reads committed results only; it takes no other option, the layout flags --package-root and --git-root aside",
		);
	}
	if (values.check && values.artifacts) {
		throw new Error("--check writes no artifacts; drop --artifacts");
	}
	if (values.trials !== undefined && !values.validation) {
		throw new Error(
			"--trials needs --validation; a full run always runs all six",
		);
	}
	if (values.validation && values.check) {
		throw new Error("--validation runs trials; drop --check");
	}
	if (values.validation && values.trials === undefined) {
		throw new Error("--validation needs --trials, for example --trials D");
	}
	let validation: string[] | undefined;
	if (values.validation) {
		const trials: readonly string[] = GATE_TRIALS;
		validation = (values.trials ?? "").split(",");
		if (
			validation.some((t) => !trials.includes(t)) ||
			new Set(validation).size !== validation.length
		) {
			throw new Error(
				`--trials takes distinct suite trials (${trials.join(", ")}), not "${values.trials}"`,
			);
		}
		if (validation.length === trials.length) {
			throw new Error(
				"--trials may not name all six: validation runs only the relevant trials, and a full run runs all six",
			);
		}
	}
	return {
		check: values.check ?? false,
		trend: values.trend ?? false,
		scratch: values.scratch ?? tmpdir(),
		artifacts: values.artifacts,
		validation,
		layout: {
			packageRoot: values["package-root"],
			gitRoot: values["git-root"],
			subject: values["subject-dir"],
		},
	};
}

if (import.meta.main) {
	try {
		process.exitCode = await main();
	} catch (error) {
		console.error((error as Error).message);
		process.exitCode = 1;
	}
}
