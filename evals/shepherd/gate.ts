/**
 * One gate invocation over the result file of a source hash: rescore
 * archived unscored attempts once (R1), run subject waves while trials have
 * allowances left (5.5, 5.6), turn each finished trial into an attempt
 * record (export and redact, mechanical checks on the exported bytes, blind
 * scoring), and publish the validated result with its summary (6.4, 6.5).
 * Wave execution and scoring are injected, so tests run without a model.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	exportAttempt,
	homeSlugs,
	REDACTED,
	type RedactionContext,
	redactText,
	SLUG_MARKER,
	setAsidePartial,
	writeArtifact,
} from "./export";
import {
	type Artifact,
	type Attempt,
	awaitingScore,
	type Cost,
	deriveAggregate,
	deriveTrial,
	type Evaluation,
	FROZEN_CHANGED,
	GATE_TRIALS,
	loadRubric,
	type Must,
	type Pointer,
	type Result,
	type Rubric,
	type ScorerInvocation,
	scoringRounds,
	totalCost,
	validateResult,
} from "./schema";
import {
	archivedText,
	buildPacket,
	type Decision,
	loadPacket,
	type Packet,
	readScorerOutput,
	scoreAll,
} from "./scorer";

const CODE_DIR = import.meta.dir;
/**
 * The void reason prefix for a local checker failure, so CI can tell it from
 * a relabelled valid session when its own recomputation succeeds.
 */
export const CHECKER_FAILED = "mechanical checks failed: ";
const MISSING_PROVENANCE = /no tool-result binary evidence/;

export interface ScoreJob {
	trial: string;
	packet: Packet;
	requested: string[];
	round: number;
	/** Epoch milliseconds; no invocation starts that could not finish by then. */
	deadline: number;
	/**
	 * Records an invocation as it ends and publishes it, before any retry
	 * starts. Invocations returned and never reported are recorded afterwards.
	 */
	onInvocation?(
		invocation: ScorerInvocation,
		output: string,
		decisions?: Decision[],
	): void;
}

export interface Scored {
	invocations: ScorerInvocation[];
	decisions?: Decision[];
	outputs: string[];
}

export interface GateOptions {
	/** Holds `results/` and `artifacts/`: `evals/shepherd/` in the repository. */
	evalsDir: string;
	/**
	 * Regression validation (8.5): run only these gate trials and keep the
	 * result, summary and evidence under `validation/<source-hash>/<run-id>/`,
	 * never in `results/` or `artifacts/`. Every other policy is the gate's.
	 */
	validation?: { trials: string[] };
	sourceHash: string;
	manifest: Result["source"]["manifest"];
	identity: Omit<
		Evaluation,
		| "outcome"
		| "invocations"
		| "trials"
		| "startedAt"
		| "endedAt"
		| "harnessVersion"
	>;
	build: Evaluation["invocations"][number]["build"];
	runId: string;
	/** The run's scratch directory; its paths survive redaction. */
	scratchRoot: string;
	/** Where the harness writes `<trial>/attempt-<n>/`. */
	artifactRoot: string;
	/** The user's home directory, redacted from committed evidence. */
	home: string;
	rubric: Rubric;
	/** Epoch milliseconds after which no wave starts. */
	deadline: number;
	runWave(
		jobs: { trial: string; ordinal: number }[],
	): Promise<{ trial: string; ordinal: number; exitCode: number | null }[]>;
	score(job: ScoreJob): Promise<Scored>;
	/** Scorer processes at once (4.5); 2 when unset. */
	scorerConcurrency?: number;
	/** One scorer invocation's bound; no round starts that could not finish by the deadline. */
	scorerTimeoutMs?: number;
	/** Frozen-input recheck after execution (2.5): reasons, empty when unchanged. */
	recheck(): string[];
	checks?(trial: string, dir: string): ChecksOutput;
	subjectCost?(log: string): Cost;
	now?(): Date;
}

interface CheckedMust {
	class: "mechanical" | "judged";
	outcome: "pass" | "fail" | "inconclusive" | null;
	rationale: string;
	evidence: Pointer[];
}

export type ChecksOutput =
	| {
			checkerVersion: string;
			trial: string;
			musts: Record<string, CheckedMust>;
	  }
	| { error: string };

/** `must-check.py` on an exported attempt; exit 3 means corrupted evidence. */
export function pythonChecks(
	trial: string,
	dir: string,
	checker = join(CODE_DIR, "must-check.py"),
): ChecksOutput {
	// A fresh bytecode cache, so no committed or stale `__pycache__` beside
	// the checker can stand in for its source.
	const cache = mkdtempSync(join(tmpdir(), "shepherd-evals-pycache-"));
	try {
		const child = spawnSync(
			"python3",
			["-I", "-X", `pycache_prefix=${cache}`, checker, trial, dir],
			{ encoding: "utf8", timeout: 60_000 },
		);
		if (child.status !== 0) {
			return {
				error: child.stderr.trim() || `must-check exited ${child.status}`,
			};
		}
		return JSON.parse(child.stdout);
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
}

/** `cost.py` on an exported native log. */
export function pythonCost(log: string): Cost {
	const child = spawnSync("python3", ["-I", join(CODE_DIR, "cost.py"), log], {
		encoding: "utf8",
		timeout: 60_000,
	});
	if (child.status !== 0) {
		return {
			usd: null,
			reason: `cost.py failed: ${child.stderr.trim()}`,
			usage: null,
			source: "cost.py",
		};
	}
	return JSON.parse(child.stdout);
}

/**
 * A session's native log, found by its id in every projects directory:
 * Claude Code names the directory after the working directory, cut and
 * hashed past 200 characters, so the gate never derives the name. Two
 * distinct files refuse, naming both; one reached through a symlink counts
 * once. An unlistable projects directory refuses too.
 */
export function findNativeLog(
	home: string,
	session: string,
): string | undefined {
	const projects = join(home, ".claude/projects");
	if (!existsSync(projects)) return undefined;
	let names: string[];
	try {
		names = readdirSync(projects);
	} catch (error) {
		const { code, message } = error as NodeJS.ErrnoException;
		throw new Error(
			`Refusing: cannot list the projects directory ${projects}: ${code ?? message}`,
		);
	}
	const byFile = new Map<string, string>();
	for (const name of names.sort()) {
		const path = join(projects, name, `${session}.jsonl`);
		if (!existsSync(path)) continue;
		const real = realpathSync(path);
		if (!byFile.has(real)) byFile.set(real, path);
	}
	const found = [...byFile.values()];
	if (found.length > 1)
		throw new Error(
			`Refusing: session ${session} has more than one native log: ${found.join(", ")}`,
		);
	return found[0];
}

const iso = (date: Date) => date.toISOString();

function resultPaths(
	evalsDir: string,
	sourceHash: string,
	validationRun?: string,
) {
	const hex = sourceHash.replace(/^sha256:/, "");
	if (validationRun) {
		const dir = `validation/${hex}/${validationRun}`;
		return {
			hex,
			json: join(evalsDir, dir, "result.json"),
			md: join(evalsDir, dir, "result.md"),
		};
	}
	return {
		hex,
		json: join(evalsDir, "results", `${hex}.json`),
		md: join(evalsDir, "results", `${hex}.md`),
	};
}

/** The result files and this run's evidence directory, both relative to `evalsDir`. */
function gatePaths(options: GateOptions) {
	const paths = resultPaths(
		options.evalsDir,
		options.sourceHash,
		options.validation ? options.runId : undefined,
	);
	const root = options.validation ? "validation" : "artifacts";
	return { ...paths, evidence: `${root}/${paths.hex}/${options.runId}` };
}

function readExisting(path: string, rubric: Rubric): Result | undefined {
	if (!existsSync(path)) return undefined;
	const value = JSON.parse(readFileSync(path, "utf8"));
	const problems = validateResult(value, rubric);
	if (problems.length > 0) {
		throw new Error(
			`Refusing to continue from an invalid existing result ${path}:\n${problems.join("\n")}`,
		);
	}
	return value as Result;
}

/**
 * The result to continue: the evaluation of the current identity, restored
 * from history when it was evaluated before, with every other one kept.
 */
function open(
	existing: Result | undefined,
	options: GateOptions,
	now: string,
): Result {
	const fresh: Evaluation = {
		harnessVersion: 1,
		...options.identity,
		outcome: "blocked",
		invocations: [],
		trials: (options.identity.policy.trials as string[]).map((trial) => ({
			trial,
			outcome: "pending",
			attempts: [],
		})),
		startedAt: now,
		endedAt: now,
	};
	if (!existing) {
		return {
			schemaVersion: 1,
			source: { hash: options.sourceHash, manifest: options.manifest },
			evaluation: fresh,
			history: [],
			outcome: "blocked",
			startedAt: now,
			endedAt: now,
			cost: { knownUsd: 0, unknownComponents: 0 },
		};
	}
	const all = [...existing.history, existing.evaluation];
	const current = all.find((e) => e.hash === options.identity.hash) ?? fresh;
	return {
		...existing,
		source: { hash: options.sourceHash, manifest: options.manifest },
		evaluation: current,
		history: all.filter((e) => e !== current),
	};
}

function finalize(result: Result, now: string): Result {
	const evaluation = result.evaluation;
	for (const trial of evaluation.trials)
		trial.outcome = deriveTrial(trial.attempts);
	evaluation.outcome = deriveAggregate(evaluation.trials.map((t) => t.outcome));
	evaluation.endedAt = now;
	result.outcome = result.evaluation.outcome;
	result.endedAt = now;
	result.cost = totalCost(result);
	return result;
}

/** Validate, then replace the JSON result and its Markdown summary. */
export function publishResult(
	evalsDir: string,
	result: Result,
	rubric: Rubric,
	paths: { json: string; md: string } = resultPaths(
		evalsDir,
		result.source.hash,
	),
): void {
	const problems = validateResult(result, rubric);
	if (problems.length > 0) {
		throw new Error(
			`Refusing to publish an invalid result:\n${problems.join("\n")}`,
		);
	}
	mkdirSync(dirname(paths.json), { recursive: true });
	// Both are written to temporary files first. The summary is renamed into
	// place first and the JSON last, so a reader never sees a new JSON beside
	// an older summary; the JSON is the record, the summary is derived.
	const json = `${paths.json}.tmp-${process.pid}`;
	const md = `${paths.md}.tmp-${process.pid}`;
	writeFileSync(json, `${JSON.stringify(result, null, "\t")}\n`);
	writeFileSync(
		md,
		summary(result, relative(evalsDir, dirname(paths.md)), rubric),
	);
	renameSync(md, paths.md);
	renameSync(json, paths.json);
}

function sha256Json(value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(value ?? null))
		.digest("hex")}`;
}

interface RunManifest {
	workspace?: string;
	argv?: string[];
	cli_version?: string | null;
	backend_settings?: unknown;
	observed_models?: string[];
	exit_codes?: number[];
	timed_out?: boolean;
	interrupted?: number | null;
	provenance?: {
		expected_binary: string;
		evidence_call_ids?: string[];
		unexpected_binaries?: { call_id: string; binary: string }[];
	}[];
	validity?: { valid: boolean; void_reasons: string[] };
	started_at?: string;
	ended_at?: string | null;
}

interface Pending {
	trial: string;
	attempt: Attempt;
	dir: string;
	requested: string[];
	/** The attempt's email numbering, when this invocation exported it. */
	emails?: Map<string, number>;
}

function mustFromCheck(
	id: string,
	checked: CheckedMust,
	version: string,
): Must {
	return {
		id,
		class: checked.class,
		outcome: checked.outcome ?? "inconclusive",
		checkerVersion: version,
		scorer: null,
		rationale: checked.rationale,
		evidence: checked.evidence,
	};
}

/** The archived output of an attempt's scorer invocation at `index`. */
export const scorerOutputName = (index: number, round: number) =>
	`scorer-${index + 1}-r${round}.json`;

/**
 * Record one scorer invocation of an attempt as it ends (4.4, 4.5, R1). The
 * verdict recorded is what its archived, redacted output reads against the
 * archived packet, so CI derives the same decisions from the same bytes.
 */
function applyInvocation(
	pending: Pending,
	ended: ScorerInvocation,
	output: string,
	decisions: Decision[] | undefined,
	packet: Packet,
	context: RedactionContext,
): void {
	const { attempt, dir } = pending;
	const scoring = attempt.scoring;
	if (!scoring) throw new Error("scoring without a packet");
	const index = scoring.invocations.length;
	const name = scorerOutputName(index, ended.round);
	if (!attempt.artifacts.some((a) => a.path === name))
		setAsideOrphan(join(dir, name));
	attempt.artifacts.push(writeArtifact(dir, name, output, context));
	// A copy: the scorer's own record of the invocation decides its retry.
	const invocation = { ...ended };
	let verdict: Decision[] | undefined;
	if (decisions) {
		const archived = readScorerOutput(
			archivedText(readFileSync(join(dir, name))),
			invocation.requestedModel,
			pending.requested,
			packet,
		);
		verdict = archived.decisions;
		if (!verdict)
			invocation.failure = `the archived output reads no verdict: ${archived.failure ?? "no decisions"}`;
	}
	scoring.invocations.push(redactStrings(invocation, context));
	attempt.cost.scorer.push(invocation.cost);
	if (!verdict) {
		attempt.kind = "unscored";
		attempt.behavioralOrdinal = null;
		return;
	}
	for (const decision of verdict) {
		attempt.musts.push({
			id: decision.id,
			class: "judged",
			outcome: decision.outcome,
			checkerVersion: null,
			scorer: {
				sessionId: scoring.invocations[index]?.sessionId ?? null,
				invocation: index,
			},
			rationale: decision.rationale,
			evidence: decision.evidence,
		});
	}
	attempt.kind = "behavioral";
}

/**
 * Move aside a scorer output that an invocation wrote but never recorded,
 * renamed `.orphan`, so it never stops a later invocation writing its own.
 */
function setAsideOrphan(path: string): void {
	if (!existsSync(path)) return;
	let target = `${path}.orphan`;
	for (let n = 2; existsSync(target); n++) target = `${path}.orphan-${n}`;
	renameSync(path, target);
}

/** Whether a process with this pid exists; one owned by another user does too. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Run IDs whose gate lock this process holds. */
const heldRuns = new Set<string>();

/**
 * The holder a lock names, refusing a lock that names none or whose holder
 * lives. A lock naming this process is stale unless this process holds its
 * run: its pid was a killed holder's.
 */
function staleHolder(path: string, held: string): void {
	let holder: { pid?: unknown; runId?: unknown } | undefined;
	try {
		holder = JSON.parse(held);
	} catch {
		// Refused below as naming no holder.
	}
	const pid = holder?.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
		throw new Error(
			`Refusing: the gate lock ${path} names no holder; remove it if no gate invocation is running`,
		);
	const ours = pid === process.pid;
	if (ours ? heldRuns.has(String(holder?.runId)) : alive(pid))
		throw new Error(
			`Refusing: another gate invocation (pid ${pid}, run ${String(holder?.runId)}) holds ${path}; if that pid is no gate invocation, remove the lock`,
		);
}

/**
 * Hold `<result>.lock` for one invocation, so a second invocation for the
 * same result refuses, naming the holder, instead of merging into it (5.6
 * across invocations). The lock names the holder's pid and run. A lock
 * whose pid is gone, as after a kill, is taken over under `<lock>.takeover`,
 * so only one taker replaces it; a reused pid keeps a dead holder's lock
 * until it is removed by hand. Returns the release, which never throws.
 * `hooks` is for tests: `takingOver` runs while the takeover is guarded.
 */
export function holdLock(
	json: string,
	runId: string,
	hooks: { takingOver?(): void } = {},
): () => void {
	const path = `${json}.lock`;
	const mine = `${JSON.stringify({ pid: process.pid, runId })}\n`;
	const read = () => {
		try {
			return readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	};
	mkdirSync(dirname(path), { recursive: true });
	// Written whole, then linked into place: a lock is never seen half written.
	const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	writeFileSync(temp, mine);
	const take = () => {
		try {
			linkSync(temp, path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	};
	const tookOver = () =>
		new Error(`Refusing: another gate invocation took the gate lock ${path}`);
	try {
		if (!take()) {
			const first = read();
			if (first !== undefined) staleHolder(path, first);
			const guard = `${path}.takeover`;
			try {
				writeFileSync(guard, `${JSON.stringify({ pid: process.pid })}\n`, {
					flag: "wx",
				});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				throw new Error(
					`Refusing: another gate invocation is taking over the gate lock ${path} (${guard}); it is stale if no gate invocation runs and its pid is gone, and may then be removed`,
				);
			}
			try {
				hooks.takingOver?.();
				// Under the guard, the lock is read again: a taker that went
				// first may hold it by now.
				const held = read();
				if (held !== undefined) {
					staleHolder(path, held);
					rmSync(path, { force: true });
				}
				if (!take()) throw tookOver();
			} finally {
				rmSync(guard, { force: true });
			}
		}
	} finally {
		rmSync(temp, { force: true });
	}
	heldRuns.add(runId);
	return () => {
		heldRuns.delete(runId);
		try {
			if (read() === mine) rmSync(path, { force: true });
		} catch {
			// Best effort: the invocation's own outcome stands.
		}
	};
}

/** Refuse validation trials that are not distinct gate trials, fewer than all six. */
function checkValidation(only: string[] | undefined): void {
	const trials: readonly string[] = GATE_TRIALS;
	if (
		only &&
		(only.length === 0 ||
			new Set(only).size !== only.length ||
			only.some((t) => !trials.includes(t)) ||
			only.length === trials.length)
	) {
		throw new Error(
			`validation needs distinct gate trials (${trials.join(", ")}), fewer than all six, not "${only.join(",")}"`,
		);
	}
}

export async function runGate(
	options: GateOptions,
): Promise<{ result: Result }> {
	checkValidation(options.validation?.trials);
	const release = holdLock(gatePaths(options).json, options.runId);
	try {
		return await runLocked(options);
	} finally {
		release();
	}
}

async function runLocked(options: GateOptions): Promise<{ result: Result }> {
	const now = () => iso(options.now?.() ?? new Date());
	const checks = options.checks ?? pythonChecks;
	const subjectCost = options.subjectCost ?? pythonCost;
	const context: RedactionContext = {
		scratchRoot: options.scratchRoot,
		home: options.home,
		repoRoot: resolve(options.evalsDir, "../.."),
	};
	const only = options.validation?.trials;
	const paths = gatePaths(options);
	let existing: Result | undefined;
	try {
		existing = readExisting(paths.json, options.rubric);
	} catch (error) {
		throw new Error(`existing result: ${(error as Error).message}`);
	}
	const startedAt = now();
	const result = open(existing, options, startedAt);
	const evaluation = result.evaluation;
	const invocation = {
		runId: options.runId,
		startedAt,
		endedAt: startedAt,
		build: options.build,
		recheck: { valid: true, reasons: [] as string[] },
	};
	evaluation.invocations.push(invocation);
	const record = (trial: string) => {
		const found = evaluation.trials.find((t) => t.trial === trial);
		if (!found) throw new Error(`trial ${trial} is not in the policy`);
		return found;
	};
	const created: Attempt[] = [];
	const drop = (trial: string, attempt: Attempt) => {
		const list = record(trial).attempts;
		list.splice(list.indexOf(attempt), 1);
	};

	const concurrency = options.scorerConcurrency ?? 2;
	const scorerTimeout = options.scorerTimeoutMs ?? 300_000;
	// Every recorded attempt is published at once, so a crash or kill later in
	// the invocation cannot lose it or give its trial fresh allowances (6.4).
	// What was last published, so a failure to publish the in-memory result
	// can still record this run's recheck on it.
	let published: Result | undefined;
	const persist = () => {
		invocation.endedAt = now();
		finalize(result, invocation.endedAt);
		publishResult(options.evalsDir, result, options.rubric, paths);
		published = structuredClone(result);
	};
	// Unscored attempts leave the behavioural sequence; number the rest in order.
	const renumber = () => {
		for (const trial of evaluation.trials) {
			let n = 0;
			for (const attempt of trial.attempts) {
				attempt.behavioralOrdinal = attempt.kind === "behavioral" ? ++n : null;
			}
		}
	};
	// A scoring round starts only when it can finish before the deadline (5.1).
	const scoreBatch = async (batch: Pending[]) => {
		await scoreAll(
			batch.map((pending) => async () => {
				if (Date.now() + scorerTimeout > options.deadline) return;
				const packet = loadPacket({
					dir: pending.dir,
					packet: pending.attempt.scoring?.packet ?? "packet.md",
				});
				if (packet.sha256 !== pending.attempt.scoring?.packetSha256) {
					throw new Error(
						`archived packet of ${pending.trial} attempt ${pending.attempt.ordinal} changed`,
					);
				}
				// The output is redacted as its packet was: with the scratch root
				// of the run that exported the attempt, so a quote of a kept path
				// still reads as the packet shows it.
				const own =
					pending.attempt.runId === options.runId
						? context.scratchRoot
						: runScratchRoot(pending.attempt);
				const at = {
					...context,
					scratchRoot: own ?? context.scratchRoot,
					emails: pending.emails ?? new Map(),
				};
				// Each invocation is published as it ends, so a kill or crash
				// later loses no verdict and no spend (6.4).
				let recorded = 0;
				const onInvocation = (
					invocation: ScorerInvocation,
					output: string,
					decisions?: Decision[],
				) => {
					applyInvocation(pending, invocation, output, decisions, packet, at);
					recorded++;
					renumber();
					persist();
				};
				const scored = await options.score({
					trial: pending.trial,
					packet,
					requested: pending.requested,
					round: scoringRounds(pending.attempt) + 1,
					deadline: options.deadline,
					onInvocation,
				});
				const last = scored.invocations.length - 1;
				for (let n = recorded; n <= last; n++) {
					const invocation = scored.invocations[n];
					if (invocation)
						onInvocation(
							invocation,
							scored.outputs[n] ?? "",
							n === last ? scored.decisions : undefined,
						);
				}
			}),
			concurrency,
		);
		renumber();
	};

	// Export a finished attempt and build its record; unscored until its verdicts arrive.
	const recordFinished = (
		trial: string,
		ordinal: number,
		exitCode: number | null,
		from: string,
		artifactDir: string,
		context: RedactionContext,
	) => {
		// One email numbering for everything written for this attempt.
		const at = { ...context, emails: context.emails ?? new Map() };
		const dir = join(options.evalsDir, artifactDir);
		let artifacts: Artifact[] = [];
		if (existsSync(from)) artifacts = exportAttempt({ from, to: dir, ...at });
		else mkdirSync(dir, { recursive: true });
		const attempt = redactStrings(
			buildAttempt({
				trial,
				ordinal,
				exitCode,
				dir,
				artifactDir,
				artifacts,
				options,
				checks,
				subjectCost,
				context: at,
				now: now(),
			}),
			at,
		);
		const requested = attempt.scoring?.requested ?? [];
		if (requested.length > 0) attempt.kind = "unscored";
		return { attempt, dir, requested, emails: at.emails };
	};

	/**
	 * A pending attempt left by an invocation that ended without recording it
	 * (6.4). A leftover export is set aside first. If the harness finished,
	 * the attempt is recorded as finished; otherwise it is interrupted, and the
	 * session's own log decides validity as for any attempt (5.4): a valid
	 * session is a behavioural attempt with every Must inconclusive, anything
	 * else an exempt void.
	 */
	const resolvePending = (pending: Attempt): Attempt => {
		const launch = pending.launch;
		const dir = join(options.evalsDir, pending.artifactDir);
		setAsidePartial(dir);
		const at: RedactionContext = {
			scratchRoot: launch?.scratchRoot ?? options.scratchRoot,
			home: options.home,
			repoRoot: resolve(options.evalsDir, "../.."),
			emails: new Map(),
		};
		// The recorded directory may hold the home slug's marker; this machine's
		// home gives it back.
		const scratch = launch?.scratchDir.includes(REDACTED)
			? undefined
			: [
					launch?.scratchDir ?? "",
					...homeSlugs(options.home).map((slug) =>
						(launch?.scratchDir ?? "").replaceAll(SLUG_MARKER, slug),
					),
				].find((dir) => dir && existsSync(dir));
		const runPath = scratch ? join(scratch, "claude-run.json") : undefined;
		const run: RunManifest =
			runPath && existsSync(runPath)
				? JSON.parse(readFileSync(runPath, "utf8"))
				: {};
		if (scratch && run.ended_at) {
			const { attempt } = recordFinished(
				pending.trial,
				pending.ordinal,
				null,
				scratch,
				pending.artifactDir,
				at,
			);
			return { ...attempt, runId: pending.runId };
		}
		const argv = run.argv ?? [];
		const sessionAt = argv.indexOf("--session-id");
		const session = sessionAt >= 0 ? argv[sessionAt + 1] : undefined;
		// Found before anything is written, so a refusal leaves no export.
		const native =
			session && !(scratch && existsSync(join(scratch, "claude.jsonl")))
				? findNativeLog(options.home, session)
				: undefined;
		let artifacts: Artifact[] = [];
		if (scratch) artifacts = exportAttempt({ from: scratch, to: dir, ...at });
		else mkdirSync(dir, { recursive: true });
		if (native)
			artifacts.push(
				writeArtifact(dir, "claude.jsonl", readFileSync(native), at),
			);
		const interrupted =
			"interrupted: the invocation ended before the attempt was recorded";
		const { launch: _launch, ...rest } = pending;
		const base: Attempt = {
			...rest,
			sessionId: session ?? null,
			endedAt: now(),
			artifacts,
			interrupted: 0,
			binaryEvidence: { expected: argv[0] ?? "", callIds: [], unexpected: [] },
		};
		if (!artifacts.some((a) => a.path === "claude.jsonl")) {
			return redactStrings(
				{
					...base,
					kind: "void",
					voidReasons: [
						"interrupted: the invocation ended before a valid session started",
					],
					cost: {
						subject: {
							usd: null,
							reason: "no session log",
							usage: null,
							source: "none",
						},
						scorer: [],
					},
				},
				at,
			);
		}
		const policy = options.identity.policy as {
			model?: string;
			effort?: string;
		};
		const log = readFileSync(join(dir, "claude.jsonl"), "utf8");
		// The log is exported; compare it with the binary's exported spelling.
		const problems = sessionValidity(
			log,
			redactText(argv[0] ?? "", at).text,
			policy.model ?? "",
		);
		const cost = {
			subject: subjectCost(join(dir, "claude.jsonl")),
			scorer: [],
		};
		if (problems.length > 0) {
			return redactStrings(
				{
					...base,
					kind: "void",
					voidReasons: [...problems, interrupted],
					cost,
				},
				at,
			);
		}
		return redactStrings(
			{
				...base,
				kind: "behavioral",
				valid: true,
				voidReasons: [],
				// The log proved the requested model, so it is the one observed.
				subject: {
					backend: "claude",
					requestedModel: policy.model ?? "",
					observedModels: [policy.model ?? ""],
					effort: policy.effort ?? "",
					cliVersion: run.cli_version ?? "unknown",
					settingsFingerprint: sha256Json(run.backend_settings),
					argv,
				},
				musts: options.rubric.musts
					.filter((must) => must.trial === pending.trial)
					.map((must) => ({
						id: must.id,
						class: must.class,
						outcome: "inconclusive" as const,
						checkerVersion: "gate:interrupted",
						scorer: null,
						rationale: interrupted,
						evidence: [],
					})),
				cost,
			},
			at,
		);
	};

	/**
	 * The frozen-input recheck after execution (2.5), recorded and published
	 * however the invocation ends, so no later invocation builds a result on
	 * attempts whose inputs changed. A recheck that cannot run counts as
	 * failed. A failed one is published first with the attempts as they are,
	 * then this run's attempts are voided and published again. When the
	 * in-memory result cannot be published, the recheck is recorded on the
	 * last published one instead. `error` is the invocation's own, which is
	 * thrown whatever happens here; a recheck that cannot be published at
	 * all is named beside it.
	 */
	const settle = (error?: unknown) => {
		let reasons: string[];
		try {
			reasons = options.recheck();
		} catch (failure) {
			reasons = [`the recheck could not run: ${(failure as Error).message}`];
		}
		reasons = reasons.map((reason) => redactText(reason, context).text);
		const recheck = { valid: reasons.length === 0, reasons };
		invocation.recheck = recheck;
		try {
			if (reasons.length > 0) {
				persist();
				for (const attempt of created) voidFrozen(attempt, reasons);
			}
			persist();
		} catch (failure) {
			const first = error ?? failure;
			try {
				publishStanding(recheck);
			} catch (fallback) {
				const standing = published?.evaluation.invocations.find(
					(i) => i.runId === options.runId,
				);
				const lost = recheck.valid
					? ""
					: `\nThe frozen-input recheck failed (${reasons.join("; ")})${standing?.recheck.valid ? ", but the last published result still reads it valid: do not trust that result." : "."}`;
				throw new Error(
					`${(first as Error).message}\nThe recheck could not be recorded on the last published result either: ${(fallback as Error).message}${lost}`,
					{ cause: first },
				);
			}
			throw first;
		}
		if (error !== undefined) throw error;
	};
	// The last published result with this run's recheck, its attempts voided
	// when it failed; failing that, with the recheck alone.
	const publishStanding = (recheck: { valid: boolean; reasons: string[] }) => {
		const record = (relabel: boolean) => {
			if (!published) return;
			const standing: Result = structuredClone(published);
			const run = standing.evaluation.invocations.find(
				(i) => i.runId === options.runId,
			);
			if (!run) return;
			run.recheck = recheck;
			if (relabel && !recheck.valid)
				for (const trial of standing.evaluation.trials)
					for (const attempt of trial.attempts)
						if (attempt.runId === options.runId && attempt.kind !== "pending")
							voidFrozen(attempt, recheck.reasons);
			publishResult(
				options.evalsDir,
				finalize(standing, now()),
				options.rubric,
				paths,
			);
		};
		try {
			record(true);
		} catch {
			record(false);
		}
	};

	try {
		// Attempts an earlier invocation launched but never recorded (6.4).
		// One launched by a run whose recheck failed is void, as that run's
		// recorded attempts are.
		const failed = new Map(
			evaluation.invocations
				.filter((i) => !i.recheck.valid)
				.map((i) => [i.runId, i.recheck.reasons]),
		);
		let stale = false;
		for (const trial of evaluation.trials) {
			trial.attempts = trial.attempts.map((attempt) => {
				if (attempt.kind !== "pending") return attempt;
				stale = true;
				const resolved = resolvePending(attempt);
				const reasons = failed.get(resolved.runId);
				if (reasons) voidFrozen(resolved, reasons);
				return resolved;
			});
		}
		if (stale) {
			renumber();
			persist();
		}
		// Archived unscored packets from earlier invocations score once more (R1).
		const rescoring: Pending[] = [];
		for (const trial of evaluation.trials) {
			if (deriveTrial(trial.attempts) !== "pending") continue;
			for (const attempt of trial.attempts) {
				if (attempt.kind !== "unscored" || !attempt.scoring) continue;
				if (scoringRounds(attempt) >= 2) continue;
				rescoring.push({
					trial: trial.trial,
					attempt,
					dir: join(options.evalsDir, attempt.artifactDir),
					requested: attempt.scoring.requested,
				});
			}
		}
		if (rescoring.length > 0) {
			await scoreBatch(rescoring);
			persist();
		}

		const refused = new Set<string>();
		for (;;) {
			const jobs = evaluation.trials
				.filter(
					(t) => !refused.has(t.trial) && deriveTrial(t.attempts) === "pending",
				)
				.filter((t) => !t.attempts.some(awaitingScore))
				.filter((t) => !only || only.includes(t.trial))
				.map((t) => ({ trial: t.trial, ordinal: t.attempts.length + 1 }));
			if (jobs.length === 0 || Date.now() >= options.deadline) break;
			// Each launch is on record before it starts, so a kill mid-wave
			// leaves an attempt the next invocation resolves (6.4).
			const launched = new Map(
				jobs.map(({ trial, ordinal }) => {
					const pending = redactStrings(
						pendingAttempt(trial, ordinal, options, now()),
						context,
					);
					record(trial).attempts.push(pending);
					return [trial, pending] as const;
				}),
			);
			persist();
			const finished = await options.runWave(jobs);
			// Launches that never started leave no attempt.
			const started = new Set(finished.map((f) => f.trial));
			for (const [trial, pending] of launched) {
				if (!started.has(trial)) drop(trial, pending);
			}
			// Nothing started: cancelled or out of time. Keep what was recorded.
			if (finished.length === 0) {
				persist();
				break;
			}
			const toScore: Pending[] = [];
			for (const { trial, ordinal, exitCode } of finished) {
				const pending = launched.get(trial);
				const from = join(options.artifactRoot, trial, `attempt-${ordinal}`);
				if (!existsSync(join(from, "claude-run.json"))) {
					if (exitCode === 2 || exitCode === null) {
						// The harness refused (or never started): no attempt is recorded.
						if (pending) drop(trial, pending);
						refused.add(trial);
						continue;
					}
				}
				// The pending entry stays published until the attempt is fully built.
				const { attempt, dir, requested, emails } = recordFinished(
					trial,
					ordinal,
					exitCode,
					from,
					`${paths.evidence}/${trial}/attempt-${ordinal}`,
					context,
				);
				const list = record(trial).attempts;
				const at = pending ? list.indexOf(pending) : -1;
				if (at >= 0) list[at] = attempt;
				else list.push(attempt);
				created.push(attempt);
				if (requested.length > 0)
					toScore.push({ trial, attempt, dir, requested, emails });
			}
			renumber();
			persist();
			await scoreBatch(toScore);
			persist();
		}
	} catch (error) {
		settle(error);
		throw error;
	}
	settle();
	return { result };
}

/** Void an attempt whose run's frozen inputs changed (2.5). */
function voidFrozen(attempt: Attempt, reasons: string[]): void {
	attempt.kind = "void";
	attempt.valid = false;
	attempt.behavioralOrdinal = null;
	attempt.musts = [];
	attempt.voidReasons.push(...reasons.map((r) => `${FROZEN_CHANGED}${r}`));
}

/** A launched attempt, recorded before its outcome is known. */
function pendingAttempt(
	trial: string,
	ordinal: number,
	options: GateOptions,
	now: string,
): Attempt {
	return {
		trial,
		ordinal,
		kind: "pending",
		behavioralOrdinal: null,
		runId: options.runId,
		sessionId: null,
		exitCodes: [],
		valid: false,
		voidReasons: [],
		timedOut: false,
		interrupted: null,
		binaryEvidence: { expected: "", callIds: [], unexpected: [] },
		subject: null,
		startedAt: now,
		endedAt: now,
		artifactDir: `${gatePaths(options).evidence}/${trial}/attempt-${ordinal}`,
		artifacts: [],
		musts: [],
		scoring: null,
		cost: {
			subject: {
				usd: null,
				reason: "the attempt is still running",
				usage: null,
				source: "none",
			},
			scorer: [],
		},
		launch: {
			scratchRoot: options.scratchRoot,
			scratchDir: join(options.artifactRoot, trial, `attempt-${ordinal}`),
		},
	};
}

/**
 * The scratch root of the run that exported an attempt: the directory its
 * subject binary was built in, `<root>/bin/shepherd`.
 */
function runScratchRoot(attempt: Attempt): string | undefined {
	const bin = dirname(attempt.binaryEvidence.expected);
	return basename(bin) === "bin" ? dirname(bin) : undefined;
}

/** A value as Python's `json` decodes it; a `Map` keeps an object's key order. */
type PyValue = string | number | boolean | null | PyValue[] | PyObject;
interface PyObject extends Map<string, PyValue> {}

class JSONDecodeError extends Error {}

/** `fn`'s value, or undefined where Python's `json` raises `JSONDecodeError`. */
function decodes<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch (error) {
		if (error instanceof JSONDecodeError) return undefined;
		throw error;
	}
}

const PY_ESCAPES = new Map(
	Object.entries({
		'"': '"',
		"\\": "\\",
		"/": "/",
		b: "\b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
	}),
);
const PY_CONSTANTS: [string, PyValue][] = [
	["null", null],
	["true", true],
	["false", false],
	["NaN", Number.NaN],
	["Infinity", Number.POSITIVE_INFINITY],
	["-Infinity", Number.NEGATIVE_INFINITY],
];
const PY_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/y;

function skipWhitespace(s: string, at: number): number {
	while (/[ \t\n\r]/.test(s.charAt(at))) at++;
	return at;
}

/** CPython's `scanstring` (strict): the string after the quote at `at - 1`. */
function scanString(s: string, at: number): [string, number] {
	let chunks = "";
	for (;;) {
		const c = s[at++];
		if (c === undefined) throw new JSONDecodeError("Unterminated string");
		if (c === '"') return [chunks, at];
		if (c < " ") throw new JSONDecodeError("Invalid control character");
		if (c !== "\\") {
			chunks += c;
			continue;
		}
		const escaped = s[at] ?? "";
		if (escaped === "u") {
			const hex = s.slice(at + 1, at + 5);
			if (!/^[0-9a-fA-F]{4}$/.test(hex))
				throw new JSONDecodeError("Invalid \\uXXXX escape");
			chunks += String.fromCharCode(Number.parseInt(hex, 16));
			at += 5;
		} else {
			const decoded = PY_ESCAPES.get(escaped);
			if (decoded === undefined) throw new JSONDecodeError("Invalid \\escape");
			chunks += decoded;
			at++;
		}
	}
}

/** CPython's `scan_once`: the value starting exactly at `at`, and its end. */
function scanOnce(s: string, at: number): [PyValue, number] {
	const c = s[at];
	if (c === '"') return scanString(s, at + 1);
	if (c === "{") return parseObject(s, at + 1);
	if (c === "[") return parseArray(s, at + 1);
	for (const [word, value] of PY_CONSTANTS)
		if (s.startsWith(word, at)) return [value, at + word.length];
	PY_NUMBER.lastIndex = at;
	const number = PY_NUMBER.exec(s);
	if (!number) throw new JSONDecodeError("Expecting value");
	return [Number(number[0]), PY_NUMBER.lastIndex];
}

function parseObject(s: string, at: number): [PyObject, number] {
	const pairs: PyObject = new Map();
	at = skipWhitespace(s, at);
	if (s[at] === "}") return [pairs, at + 1];
	for (;;) {
		if (s[at] !== '"')
			throw new JSONDecodeError(
				"Expecting property name enclosed in double quotes",
			);
		const [key, afterKey] = scanString(s, at + 1);
		at = skipWhitespace(s, afterKey);
		if (s[at] !== ":") throw new JSONDecodeError("Expecting ':' delimiter");
		const [value, afterValue] = scanOnce(s, skipWhitespace(s, at + 1));
		// A repeated key keeps its first place and takes its last value, as a dict does.
		pairs.set(key, value);
		at = skipWhitespace(s, afterValue);
		if (s[at] === "}") return [pairs, at + 1];
		if (s[at] !== ",") throw new JSONDecodeError("Expecting ',' delimiter");
		at = skipWhitespace(s, at + 1);
	}
}

function parseArray(s: string, at: number): [PyValue[], number] {
	const values: PyValue[] = [];
	at = skipWhitespace(s, at);
	if (s[at] === "]") return [values, at + 1];
	for (;;) {
		const [value, end] = scanOnce(s, at);
		values.push(value);
		at = skipWhitespace(s, end);
		if (s[at] === "]") return [values, at + 1];
		if (s[at] !== ",") throw new JSONDecodeError("Expecting ',' delimiter");
		at = skipWhitespace(s, at + 1);
	}
}

/** Python's `json.loads` for a string. */
function jsonLoads(s: string): PyValue {
	const [value, end] = scanOnce(s, skipWhitespace(s, 0));
	if (skipWhitespace(s, end) !== s.length)
		throw new JSONDecodeError("Extra data");
	return value;
}

/** Python's `(?m)^[ \t]*binary:[ \t]+(.+?)[ \t]*$`: lines end at `\n` alone. */
const MARKER_LINE = /(?:^|(?<=\n))[ \t]*binary:[ \t]+([^\n]+?)[ \t]*(?=\n|$)/g;

/**
 * A port of the harness's `binary_values` (harness.py): every binary marker
 * a tool result holds, in its order. Its JSON decoding follows CPython's
 * `json` (the C scanner), `NaN`, `Infinity`, repeated keys and lone
 * surrogates included. The differences that remain:
 * - Deep nesting: this port throws a `RangeError` past about 10,000 levels
 *   (Bun 1.2), so the verifier, or the gate resolving an interrupted
 *   session, fails closed. Python's scanner decodes far deeper, while
 *   `binary_values` itself raises `RecursionError` past about 1,000 decoded
 *   levels, which voids the attempt in the harness.
 * - An integer of more than 4,300 digits: Python raises `ValueError` and the
 *   harness voids the attempt, so it cites no call id to verify; this port
 *   reads it as a number and goes on.
 * - Surrogates: strings here are UTF-16, so surrogate halves that Python
 *   keeps as two code points (one raw, one escaped) join into one character,
 *   in values and in object keys alike, where a joined key can then merge
 *   with another.
 */
export function binaryValues(result: PyValue): string[] {
	if (result instanceof Map) {
		const binary = result.get("binary");
		const paths = typeof binary === "string" ? [binary] : [];
		for (const value of result.values()) paths.push(...binaryValues(value));
		return paths;
	}
	if (Array.isArray(result))
		return result.flatMap((value) => binaryValues(value));
	if (typeof result !== "string") return [];
	const decoded = decodes(() => jsonLoads(result));
	if (decoded !== undefined && decoded !== null && decoded !== result)
		return binaryValues(decoded);
	const occurrences: [number, string[]][] = [];
	for (const match of result.matchAll(MARKER_LINE)) {
		let path: PyValue | undefined = match[1] ?? "";
		if (path.startsWith('"')) {
			const quoted = path;
			path = decodes(() => jsonLoads(quoted));
			if (typeof path !== "string") continue;
		} else if (path.startsWith("'")) {
			if (!path.endsWith("'") || path.length < 2) continue;
			path = path.slice(1, -1);
		}
		occurrences.push([match.index, [path]]);
	}
	// Output may mix prose, headers and several JSON objects: decode each
	// complete fragment, as the harness does.
	const fragment = /[[{]/g;
	let position = 0;
	while (position < result.length) {
		fragment.lastIndex = position;
		const match = fragment.exec(result);
		if (!match) break;
		position = match.index;
		const decoded = decodes(() => scanOnce(result, position));
		if (!decoded) position += 1;
		else {
			occurrences.push([position, binaryValues(decoded[0])]);
			position = decoded[1];
		}
	}
	return occurrences
		.sort((a, b) => a[0] - b[0])
		.flatMap(([, values]) => values);
}

/**
 * A port of `content_text` (transcript.py): a tool result's text as the
 * harness reads it. Where `json.dumps` and `JSON.stringify` spell a value
 * differently (a float such as `1.0`, integer-like keys put first, a lone
 * surrogate escaped), the JSON fragment `binaryValues` decodes from it holds
 * the same strings, so the markers read are the same.
 */
export function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(contentText).join("\n");
	if (typeof value === "object" && value !== null)
		for (const key of ["text", "content"])
			if (key in value)
				return contentText((value as Record<string, unknown>)[key]);
	return JSON.stringify(value, null, 2);
}

/**
 * What a native log shows: the models of its user and assistant messages,
 * as the harness reads them, without Claude's `<synthetic>` notices, and
 * each tool result's text and the binary markers it returns, read by the
 * ports of the harness's `content_text` and `binary_values`.
 */
export function sessionFacts(log: string): {
	models: Set<string>;
	results: { callId: string; text: string; markers: string[] }[];
} {
	const models = new Set<string>();
	const results: { callId: string; text: string; markers: string[] }[] = [];
	for (const line of log.split("\n")) {
		let event:
			| { type?: unknown; message?: { model?: unknown; content?: unknown } }
			| undefined;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event?.type !== "user" && event?.type !== "assistant") continue;
		const message = event.message;
		if (typeof message?.model === "string" && message.model !== "<synthetic>")
			models.add(message.model);
		for (const part of Array.isArray(message?.content) ? message.content : []) {
			if (part?.type !== "tool_result") continue;
			const output = contentText("content" in part ? part.content : "");
			const markers = binaryValues(output);
			results.push({
				callId: String(part.tool_use_id ?? ""),
				text: output,
				markers,
			});
		}
	}
	return { models, results };
}

/** In-session provenance and model problems in a recovered native log (5.4). */
export function sessionValidity(
	log: string,
	expected: string,
	model: string,
): string[] {
	const { models, results } = sessionFacts(log);
	const markers = results.flatMap((result) => result.markers);
	const problems: string[] = [];
	if (!markers.includes(expected))
		problems.push(`session: no tool-result binary evidence proves ${expected}`);
	for (const marker of new Set(markers.filter((m) => m !== expected)))
		problems.push(`session: a tool result names unexpected binary ${marker}`);
	if (models.size === 0) problems.push("no observed model in the session log");
	for (const observed of models)
		if (observed !== model)
			problems.push(
				`observed model ${observed} does not match requested ${model}`,
			);
	return problems;
}

function buildAttempt(input: {
	trial: string;
	ordinal: number;
	exitCode: number | null;
	dir: string;
	artifactDir: string;
	artifacts: Artifact[];
	options: GateOptions;
	checks: NonNullable<GateOptions["checks"]>;
	subjectCost: NonNullable<GateOptions["subjectCost"]>;
	context: RedactionContext;
	now: string;
}): Attempt {
	const { trial, dir, options } = input;
	const has = (name: string) => input.artifacts.some((a) => a.path === name);
	const run: RunManifest = has("claude-run.json")
		? JSON.parse(readFileSync(join(dir, "claude-run.json"), "utf8"))
		: {};
	const leg = run.provenance?.[0];
	const policy = options.identity.policy as { model?: string; effort?: string };
	const argv = run.argv ?? [];
	const sessionAt = argv.indexOf("--session-id");
	const voidReasons = [...(run.validity?.void_reasons ?? [])];
	if (!has("claude-run.json"))
		voidReasons.push(`the harness recorded no run (exit ${input.exitCode})`);
	const attempt: Attempt = {
		trial,
		ordinal: input.ordinal,
		kind: "void",
		behavioralOrdinal: null,
		runId: options.runId,
		sessionId: sessionAt >= 0 ? (argv[sessionAt + 1] ?? null) : null,
		exitCodes:
			run.exit_codes ?? (input.exitCode === null ? [] : [input.exitCode]),
		valid: run.validity?.valid === true,
		voidReasons,
		timedOut: run.timed_out === true,
		interrupted: run.interrupted ?? null,
		binaryEvidence: {
			expected: leg?.expected_binary ?? "",
			callIds: leg?.evidence_call_ids ?? [],
			unexpected: (leg?.unexpected_binaries ?? []).map((u) => ({
				callId: u.call_id,
				binary: u.binary,
			})),
		},
		subject: has("claude-run.json")
			? {
					backend: "claude",
					requestedModel: policy.model ?? "",
					observedModels: run.observed_models ?? [],
					effort: policy.effort ?? "",
					cliVersion: run.cli_version ?? "unknown",
					settingsFingerprint: sha256Json(run.backend_settings),
					argv,
				}
			: null,
		startedAt: run.started_at ?? input.now,
		endedAt: run.ended_at ?? input.now,
		artifactDir: input.artifactDir,
		artifacts: input.artifacts,
		musts: [],
		scoring: null,
		cost: {
			subject: has("claude.jsonl")
				? input.subjectCost(join(dir, "claude.jsonl"))
				: { usd: null, reason: "no session log", usage: null, source: "none" },
			scorer: [],
		},
	};
	// A session that writes the workspace without ever running start has no
	// marker, but its A.M1 failure is observed behaviour, not infrastructure.
	const onlyMissingProvenance =
		trial === "A" &&
		voidReasons.length > 0 &&
		voidReasons.every((reason) => MISSING_PROVENANCE.test(reason)) &&
		attempt.binaryEvidence.unexpected.length === 0;
	const evidence = [
		"claude.jsonl",
		"claude-baseline.json",
		"claude-final.json",
	].every(has);
	if (!evidence && attempt.valid) {
		attempt.valid = false;
		attempt.voidReasons.push(
			"corrupted required evidence: the session log or a snapshot is missing",
		);
	}
	if (!evidence || !(attempt.valid || onlyMissingProvenance)) return attempt;
	const checked = input.checks(trial, dir);
	if ("error" in checked) {
		if (attempt.valid)
			attempt.voidReasons.push(`${CHECKER_FAILED}${checked.error}`);
		attempt.valid = false;
		return attempt;
	}
	const observedFailure =
		!attempt.valid && checked.musts["A.M1"]?.outcome === "fail";
	if (!attempt.valid && !observedFailure) return attempt;
	attempt.artifacts.push(
		writeArtifact(
			dir,
			"must-check.json",
			`${JSON.stringify(checked, null, 2)}\n`,
			input.context,
		),
	);
	attempt.kind = "behavioral";
	const requested: string[] = [];
	for (const [id, must] of Object.entries(checked.musts)) {
		if (must.outcome !== null) {
			attempt.musts.push(mustFromCheck(id, must, checked.checkerVersion));
			continue;
		}
		const unscorable = observedFailure
			? "not scored: the session has no in-session provenance"
			: attempt.timedOut
				? "not scored: the session timed out"
				: attempt.interrupted !== null
					? "not scored: the session was interrupted"
					: undefined;
		if (unscorable) {
			attempt.musts.push({
				...mustFromCheck(id, must, checked.checkerVersion),
				outcome: "inconclusive",
				rationale: unscorable,
			});
		} else {
			requested.push(id);
		}
	}
	if (requested.length > 0) {
		const packet = buildPacket({
			trial,
			dir,
			requested,
			rubric: options.rubric,
			redact: (text) => redactText(text, input.context).text,
		});
		const stored = writeArtifact(dir, "packet.md", packet.text, input.context);
		if (`sha256:${stored.sha256}` !== packet.sha256) {
			throw new Error(
				`${trial}: the stored packet differs from the scored one`,
			);
		}
		attempt.artifacts.push(stored);
		attempt.scoring = {
			packet: "packet.md",
			packetSha256: packet.sha256,
			requested,
			invocations: [],
		};
	}
	return attempt;
}

/** Committed records get the export redaction too (6.1). */
function redactStrings<T>(value: T, context: RedactionContext): T {
	if (typeof value === "string") return redactText(value, context).text as T;
	if (Array.isArray(value))
		return value.map((item) => redactStrings(item, context)) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				redactStrings(item, context),
			]),
		) as T;
	}
	return value;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/**
 * The Markdown summary (6.5), every count derived from the JSON. `dir` is
 * the summary's own directory relative to the evals directory, which its
 * evidence links resolve from.
 */
export function summary(
	result: Result,
	dir: string,
	rubric = loadRubric(),
): string {
	const evaluation = result.evaluation;
	const attempts = evaluation.trials.flatMap((t) => t.attempts);
	const invocations = attempts.flatMap((a) => a.scoring?.invocations ?? []);
	const latest = evaluation.invocations.at(-1);
	const build = latest?.build;
	const elapsed =
		(Date.parse(result.endedAt) - Date.parse(result.startedAt)) / 60_000;
	const lines = [
		`# Shepherd evals: ${result.outcome}`,
		"",
		"## Provenance",
		"",
		`- Source: ${result.source.hash} (${result.source.manifest.length} files)`,
		`- Build: revision ${build?.revision}, dirty=${build?.dirty}, sourceDirty=${build?.sourceDirty}`,
		`- Version: \`${build?.version.trimEnd()}\``,
		`- Binary: sha256:${build?.binarySha256}, Bun ${build?.bunVersion}, ${build?.platform}/${build?.arch}`,
		`- Evaluation: ${evaluation.hash} (harness ${evaluation.harnessVersion}), rubric ${evaluation.rubricSha256}`,
		`- Policy: ${evaluation.policySha256}`,
		`- Scorer: ${evaluation.scorer.family} ${evaluation.scorer.model}, effort ${evaluation.scorer.effort}`,
		`- Invocations: ${evaluation.invocations.map((i) => `${i.runId}${i.recheck.valid ? "" : " (recheck failed)"}`).join(", ")}`,
		`- Earlier evaluation identities kept: ${result.history.length}`,
		"",
		"## Configuration",
		"",
		"```json",
		JSON.stringify(evaluation.policy, null, 2),
		"```",
		"",
		"## Trials",
		"",
		"| Trial | Outcome | Attempts | Behavioural | Voids | Unscored |",
		"|---|---|---|---|---|---|",
		...evaluation.trials.map((t) => {
			const count = (kind: string) =>
				t.attempts.filter((a) => a.kind === kind).length;
			return `| ${t.trial} | ${t.outcome} | ${t.attempts.length} | ${count("behavioral")} | ${count("void")} | ${count("unscored")} |`;
		}),
		"",
		"## Musts",
		"",
		"| Must | Class | Outcomes by attempt | Evidence |",
		"|---|---|---|---|",
		...evaluation.trials.flatMap((t) => {
			const musts = rubric.musts.filter((must) => must.trial === t.trial);
			return musts.map(({ id, class: kind }) => {
				const decided = t.attempts.flatMap((a) =>
					a.musts.filter((m) => m.id === id).map((m) => ({ a, m })),
				);
				const outcomes = decided
					.map(({ a, m }) => `${a.ordinal}: ${m.outcome}`)
					.join(", ");
				const links = decided
					.map(({ a }) => `[${a.ordinal}](${relative(dir, a.artifactDir)}/)`)
					.join(" ");
				const none = t.attempts.length === 0 ? "not run" : "none yet";
				return `| ${id} | ${kind} | ${outcomes || none} | ${links} |`;
			});
		}),
		"",
		"## Retries and voids",
		"",
		`- Voids: ${attempts.filter((a) => a.kind === "void").length}`,
		`- Unscored attempts: ${attempts.filter((a) => a.kind === "unscored").length}`,
		`- Pending attempts (launched, outcome not yet recorded): ${attempts.filter((a) => a.kind === "pending").length}`,
		`- Scorer invocations: ${invocations.length}`,
		`- Scorer retries: ${invocations.filter((i) => i.retryReason !== null).length}`,
		...attempts
			.filter((a) => a.kind === "void")
			.map(
				(a) =>
					`- ${a.trial} attempt ${a.ordinal} void: ${a.voidReasons.join("; ")}`,
			),
		"",
		"## Time and cost",
		"",
		`- Elapsed: ${elapsed.toFixed(1)} minutes`,
		`- Cost: ${money(result.cost.knownUsd)} known` +
			(result.cost.unknownComponents > 0
				? `, plus ${result.cost.unknownComponents} component(s) of unknown cost`
				: ", no unknown components"),
		"",
		"## Limitations",
		"",
		"- Single-turn synthetic Claude sessions, one sample per attempt; no executed delegates and no production workspace.",
		"- Scratch placement and permission flags do not enforce host read isolation.",
		"- Judged Musts rest on one Claude scorer; mechanical checks decide only what their evidence establishes.",
		"",
	];
	return lines.join("\n");
}
