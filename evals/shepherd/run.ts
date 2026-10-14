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
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
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
import { type Builder, compileAgent } from "../../scripts/agent-compiler";
import {
	type BuildProvenance,
	type GitRunner,
	readWorktreeSource,
	runGit,
	SHEPHERD_ID,
	type SourceManifest,
	type StampSource,
	sameSource,
	versionLine,
} from "../../scripts/shepherd-source";
import { runGate, type ScoreJob } from "./gate";
import { type EvaluationIdentity, evaluationIdentity } from "./identity";
import { canonicalJson, GATE_TRIALS, loadRubric, policyHash } from "./schema";

export { canonicalJson };

import {
	checkIsolation,
	type ScorerConfig,
	scoreAttempt,
	scorerEnv,
	stopScorers,
} from "./scorer";

export const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(EVALS_DIR, "../..");
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

function refuseInside(root: string, path: string, what: string): void {
	const top = realpathSync(root);
	if (path === top || path.startsWith(top + sep)) {
		throw new Error(`Refusing a ${what} inside the repository: ${path}`);
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
	root: string;
	scratchParent: string;
	artifactRoot?: string;
}): RunPaths {
	const parent = realpathSync(options.scratchParent);
	refuseInside(options.root, parent, "scratch directory");
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

/**
 * Build Shepherd into `<runDir>/bin/shepherd` and return its resolved path,
 * the path every provenance marker must name.
 */
export async function buildSubject(options: {
	root: string;
	runDir: string;
	build?: Builder;
	stamp?: StampSource;
	signal?: AbortSignal;
}): Promise<{ subject: string; provenance: BuildProvenance }> {
	const runDir = realpathSync(options.runDir);
	refuseInside(options.root, runDir, "build directory");
	const outFile = join(runDir, "bin", SHEPHERD_ID);
	mkdirSync(dirname(outFile));
	const built = await compileAgent({
		root: options.root,
		file: "agents/shepherd.md",
		outFile,
		build: options.build,
		stamp: options.stamp,
		signal: options.signal,
	});
	if (!built.provenance) throw new Error("The Shepherd build has no stamp");
	return { subject: realpathSync(outFile), provenance: built.provenance };
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
	frozenAt: string;
}

export function freeze(options: {
	root: string;
	runId: string;
	config: string;
	subject: string;
	provenance: BuildProvenance;
	versionOutput: string;
	policy: Policy;
	policyHash: string;
	git?: GitRunner;
	rubric?: string;
}): Frozen {
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
		evaluation: evaluationIdentity(options.root, { git: options.git }),
		policy: options.policy,
		policyHash: options.policyHash,
		rubricSha256: `sha256:${sha256(readFileSync(options.rubric ?? RUBRIC))}`,
		config: options.config,
		configSha256: sha256(readFileSync(options.config)),
		frozenAt: new Date().toISOString(),
	};
}

/** Why the frozen inputs no longer hold; empty when they do. */
export function recheck(
	frozen: Frozen,
	options: { root: string; git?: GitRunner },
): string[] {
	const git = options.git ?? runGit;
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
	attempt("source identity", () => {
		const now = readWorktreeSource(options.root, { git });
		return sameSource(now, frozen.manifest)
			? undefined
			: `source identity changed: frozen ${frozen.manifest.source}, now ${now.source}`;
	});
	attempt("evaluation identity", () => {
		const now = evaluationIdentity(options.root, { git });
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
	"Usage: bun run evals:shepherd [--check] [--scratch <dir>] [--artifacts <dir>]\n       bun run evals:shepherd --validation --trials <trial>[,<trial>...] [--scratch <dir>]";

async function main(): Promise<number> {
	const startedAt = Date.now();
	let parsed: ReturnType<typeof parseOptions>;
	try {
		parsed = parseOptions(process.argv.slice(2));
	} catch (error) {
		console.error(`${(error as Error).message}\n${USAGE}`);
		return 2;
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
	const root = REPO_ROOT;
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
	const { subject, provenance } = await buildSubject({
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
		evalsDir: EVALS_DIR,
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
				? join(EVALS_DIR, "validation", hex, run.runId, "result.json")
				: join(EVALS_DIR, "results", `${hex}.json`)
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
			scratch: { type: "string", default: tmpdir() },
			artifacts: { type: "string" },
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
	if (values.check && values.artifacts) {
		throw new Error("--check writes no artifacts; drop --artifacts");
	}
	if (values.trials !== undefined && !values.validation) {
		throw new Error(
			"--trials needs --validation; the gate always runs all six",
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
				`--trials takes distinct gate trials (${trials.join(", ")}), not "${values.trials}"`,
			);
		}
		if (validation.length === trials.length) {
			throw new Error(
				"--trials may not name all six: validation runs only the relevant trials, and the gate runs all six",
			);
		}
	}
	return {
		check: values.check ?? false,
		scratch: values.scratch ?? tmpdir(),
		artifacts: values.artifacts,
		validation,
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
