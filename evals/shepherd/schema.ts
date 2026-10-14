/**
 * The versioned result schema (spec 6.3) and its one strict validator,
 * shared by the wrapper before publication and by the CI verifier. The
 * validator checks shape, identifiers, attempt allowances (5.5, 5.6, R1),
 * scorer retries (4.5), evidence references and timestamp order, and
 * recomputes every derived outcome and the cost total from the attempts.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const RESULT_SCHEMA_VERSION = 1;
export const MUST_IDS = [
	"A.M1",
	"A.M2",
	"D.M1",
	"D.M2",
	"E.M1",
	"G.M1",
	"G.M2",
	"E-neg.M1",
	"E-neg.M2",
	"E-neg.M3",
	"G-neg.M1",
	"G-neg.M2",
	"G-neg.M3",
] as const;
/** The gate's six trials (3.1); never taken from a result's own policy. */
export const GATE_TRIALS = ["A", "D", "E", "G", "E-neg", "G-neg"] as const;
export const MAX_BEHAVIORAL = 2;
export const MAX_EXEMPT_VOIDS = 2;
/** The first scoring round and the one later rescoring round R1 allows. */
export const MAX_SCORING_ROUNDS = 2;
export const MAX_INVOCATIONS_PER_ROUND = 2;

const rubricSchema = z.strictObject({
	rubricVersion: z.literal(1),
	conventions: z.array(z.string()),
	musts: z.array(
		z.strictObject({
			id: z.string(),
			trial: z.string(),
			class: z.enum(["mechanical", "judged"]),
			requirement: z.string(),
		}),
	),
});
export type Rubric = z.infer<typeof rubricSchema>;

export function loadRubric(
	path = join(import.meta.dir, "rubric.json"),
): Rubric {
	const rubric = rubricSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	const trials: readonly string[] = GATE_TRIALS;
	if (
		rubric.musts.map((must) => must.id).join() !== MUST_IDS.join() ||
		rubric.musts.some((must) => !trials.includes(must.trial))
	) {
		throw new Error(
			`${path} must hold exactly the Musts ${MUST_IDS.join(", ")}`,
		);
	}
	return rubric;
}

/** JSON with object keys sorted, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)),
				)
			: item,
	);
}

export function policyHash(policy: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(policy)).digest("hex")}`;
}

const prefixedHash = z
	.string()
	.regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 lowercase hex>");
const hex = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex");
const timestamp = z
	.string()
	.regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
		"expected a UTC ISO timestamp",
	);
const relative = z
	.string()
	.refine(
		(path) =>
			path.length > 0 &&
			!path.startsWith("/") &&
			!path.includes("\\") &&
			!/^[A-Za-z]:/.test(path) &&
			!path.split("/").some((part) => part === ".." || part === ""),
		"expected a relative path without traversal",
	);

const costSchema = z
	.strictObject({
		usd: z.number().nonnegative().nullable(),
		reason: z.string().min(1).nullable(),
		usage: z.record(z.string(), z.unknown()).nullable(),
		source: z.string(),
	})
	.refine((cost) => (cost.usd === null) === (cost.reason !== null), {
		message: "unknown cost needs a reason; known cost has none",
	});
export type Cost = z.infer<typeof costSchema>;

const pointerSchema = z.strictObject({
	artifact: relative,
	line: z.number().int().positive().optional(),
	callId: z.string().optional(),
	timestamp: z.string().optional(),
	path: z.string().optional(),
	lines: z
		.tuple([z.number().int().positive(), z.number().int().positive()])
		.optional(),
	hunk: z.string().optional(),
	quote: z.string().optional(),
});
export type Pointer = z.infer<typeof pointerSchema>;

const mustOutcome = z.enum(["pass", "fail", "inconclusive"]);
export type MustOutcome = z.infer<typeof mustOutcome>;

const mustSchema = z.strictObject({
	id: z.string(),
	class: z.enum(["mechanical", "judged"]),
	outcome: mustOutcome,
	/** Set when the checker decided the outcome. */
	checkerVersion: z.string().nullable(),
	/** Set when the scorer decided it: the scoring invocation's index. */
	scorer: z
		.strictObject({
			sessionId: z.string().nullable(),
			invocation: z.number().int().nonnegative(),
		})
		.nullable(),
	rationale: z.string(),
	evidence: z.array(pointerSchema),
});
export type Must = z.infer<typeof mustSchema>;

const scorerInvocationSchema = z.strictObject({
	round: z.number().int().positive(),
	family: z.literal("claude"),
	requestedModel: z.string(),
	observedModels: z.array(z.string()),
	effort: z.string(),
	cliVersion: z.string(),
	promptSha256: prefixedHash,
	packetSha256: prefixedHash,
	argv: z.array(z.string()),
	/** The effective settings the isolation options give the scorer. */
	settings: z.record(z.string(), z.unknown()),
	sessionId: z.string().nullable(),
	exitStatus: z.number().int().nullable(),
	signal: z.string().nullable(),
	timedOut: z.boolean(),
	/** Infrastructure failure of this invocation; null when it gave a verdict. */
	failure: z.string().nullable(),
	/** The end of the scorer's stderr, bounded. */
	stderr: z.string(),
	/** Why this invocation is a retry: the failure before it. */
	retryReason: z.string().nullable(),
	startedAt: timestamp,
	endedAt: timestamp,
	cost: costSchema,
});
export type ScorerInvocation = z.infer<typeof scorerInvocationSchema>;

const artifactSchema = z.strictObject({
	path: relative,
	sha256: hex,
	bytes: z.number().int().nonnegative(),
	type: z.string(),
	redactions: z.number().int().nonnegative(),
});
export type Artifact = z.infer<typeof artifactSchema>;

/** `pending` is a launched attempt recorded before its outcome (6.4). */
const attemptKind = z.enum(["void", "behavioral", "unscored", "pending"]);
export type AttemptKind = z.infer<typeof attemptKind>;

const attemptSchema = z.strictObject({
	trial: z.string(),
	ordinal: z.number().int().positive(),
	kind: attemptKind,
	behavioralOrdinal: z.number().int().positive().nullable(),
	runId: z.string(),
	sessionId: z.string().nullable(),
	exitCodes: z.array(z.number().int()),
	valid: z.boolean(),
	voidReasons: z.array(z.string()),
	timedOut: z.boolean(),
	interrupted: z.number().int().nullable(),
	binaryEvidence: z.strictObject({
		expected: z.string(),
		callIds: z.array(z.string()),
		unexpected: z.array(
			z.strictObject({ callId: z.string(), binary: z.string() }),
		),
	}),
	subject: z
		.strictObject({
			backend: z.literal("claude"),
			requestedModel: z.string(),
			observedModels: z.array(z.string()),
			effort: z.string(),
			cliVersion: z.string(),
			settingsFingerprint: z.string(),
			argv: z.array(z.string()),
		})
		.nullable(),
	startedAt: timestamp,
	endedAt: timestamp,
	/** Relative to `evals/shepherd/`. */
	artifactDir: relative,
	/** Paths relative to `artifactDir`. */
	artifacts: z.array(artifactSchema),
	musts: z.array(mustSchema),
	scoring: z
		.strictObject({
			packet: relative,
			packetSha256: prefixedHash,
			requested: z.array(z.string()),
			invocations: z.array(scorerInvocationSchema),
		})
		.nullable(),
	cost: z.strictObject({
		subject: costSchema,
		scorer: z.array(costSchema),
	}),
	/** Pending attempts only: where the launch's scratch evidence lives. */
	launch: z
		.strictObject({ scratchRoot: z.string(), scratchDir: z.string() })
		.optional(),
});
export type Attempt = z.infer<typeof attemptSchema>;

const trialOutcome = z.enum([
	"pass",
	"flaky-pass",
	"fail",
	"inconclusive",
	"void",
	"unscored",
	"pending",
]);
export type TrialOutcome = z.infer<typeof trialOutcome>;
const aggregateOutcome = z.enum(["pass", "flaky-pass", "blocked"]);
export type AggregateOutcome = z.infer<typeof aggregateOutcome>;

const evaluationSchema = z.strictObject({
	harnessVersion: z.literal(1),
	hash: prefixedHash,
	rubricSha256: prefixedHash,
	policySha256: prefixedHash,
	/** The complete effective policy and configuration. */
	policy: z.record(z.string(), z.unknown()),
	scorer: z.strictObject({
		family: z.literal("claude"),
		model: z.string(),
		effort: z.string(),
	}),
	outcome: aggregateOutcome,
	invocations: z
		.array(
			z.strictObject({
				runId: z.string(),
				startedAt: timestamp,
				endedAt: timestamp,
				build: z.strictObject({
					revision: z.string().regex(/^[0-9a-f]{40}$/),
					dirty: z.boolean(),
					sourceDirty: z.boolean(),
					version: z.string(),
					binarySha256: hex,
					bunVersion: z.string(),
					platform: z.string(),
					arch: z.string(),
					builtAt: timestamp,
				}),
				recheck: z.strictObject({
					valid: z.boolean(),
					reasons: z.array(z.string()),
				}),
			}),
		)
		.min(1),
	trials: z.array(
		z.strictObject({
			trial: z.string(),
			outcome: trialOutcome,
			attempts: z.array(attemptSchema),
		}),
	),
	startedAt: timestamp,
	endedAt: timestamp,
});
export type Evaluation = z.infer<typeof evaluationSchema>;

const resultSchema = z.strictObject({
	schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
	source: z.strictObject({
		hash: prefixedHash,
		manifest: z.array(
			z.strictObject({
				path: z.string(),
				bytes: z.number().int().nonnegative(),
				sha256: hex,
				untracked: z.boolean(),
			}),
		),
	}),
	evaluation: evaluationSchema,
	/** Earlier evaluation identities of the same source, oldest first. */
	history: z.array(evaluationSchema),
	outcome: aggregateOutcome,
	startedAt: timestamp,
	endedAt: timestamp,
	cost: z.strictObject({
		knownUsd: z.number().nonnegative(),
		unknownComponents: z.number().int().nonnegative(),
	}),
});
export type Result = z.infer<typeof resultSchema>;

/** A behavioural attempt that passed every Must together, in a complete session. */
export function attemptPassed(attempt: Attempt): boolean {
	return (
		attempt.kind === "behavioral" &&
		attempt.valid &&
		!attempt.timedOut &&
		attempt.interrupted === null &&
		attempt.musts.length > 0 &&
		attempt.musts.every((must) => must.outcome === "pass")
	);
}

/** The failure an operator cancellation records; it uses up no scoring round. */
export const CANCELLED = "cancelled";

/** Invocations that count toward scoring rounds and retries. */
function counted(invocations: ScorerInvocation[]): ScorerInvocation[] {
	return invocations.filter((i) => i.failure !== CANCELLED);
}

export function scoringRounds(attempt: Attempt): number {
	return new Set(
		counted(attempt.scoring?.invocations ?? []).map((i) => i.round),
	).size;
}

/** A trial's outcome from its attempts in ordinal order (5.5, 5.6, R1). */
/** An unscored attempt with a scoring round left: no subject launches meanwhile. */
export function awaitingScore(attempt: Attempt): boolean {
	return (
		attempt.kind === "unscored" && scoringRounds(attempt) < MAX_SCORING_ROUNDS
	);
}

/**
 * Voids, plus unscored attempts whose scoring rounds are exhausted: they
 * consumed no behavioural attempt (R1) and count against the same cap.
 */
export function exemptVoids(attempts: Attempt[]): number {
	return attempts.filter(
		(a) => a.kind === "void" || (a.kind === "unscored" && !awaitingScore(a)),
	).length;
}

export function deriveTrial(
	attempts: Attempt[],
	_rubric?: Rubric,
): TrialOutcome {
	const behavioral = attempts.filter((a) => a.kind === "behavioral");
	const passed = behavioral.findIndex(attemptPassed);
	if (passed === 0) return "pass";
	if (passed > 0) return "flaky-pass";
	if (attempts.some((a) => a.kind === "pending")) return "pending";
	if (attempts.some(awaitingScore)) return "pending";
	const exhausted = attempts.filter((a) => a.kind === "unscored").length;
	const final = behavioral.at(-1);
	const blocked =
		behavioral.length >= MAX_BEHAVIORAL ||
		exemptVoids(attempts) >= MAX_EXEMPT_VOIDS;
	if (!blocked) return "pending";
	if (!final) return exhausted > 0 ? "unscored" : "void";
	return final.musts.some((must) => must.outcome === "fail")
		? "fail"
		: "inconclusive";
}

export function deriveAggregate(outcomes: TrialOutcome[]): AggregateOutcome {
	if (outcomes.every((o) => o === "pass")) return "pass";
	if (outcomes.every((o) => o === "pass" || o === "flaky-pass"))
		return "flaky-pass";
	return "blocked";
}

function evaluationCosts(evaluation: Evaluation): Cost[] {
	return evaluation.trials.flatMap((trial) =>
		trial.attempts.flatMap((a) => [a.cost.subject, ...a.cost.scorer]),
	);
}

/** Every subject and scorer cost across all attempts, retries and voids included. */
export function totalCost(
	result: Pick<Result, "evaluation" | "history">,
): Result["cost"] {
	const costs = [result.evaluation, ...result.history].flatMap(evaluationCosts);
	const known = costs.filter((cost) => cost.usd !== null);
	return {
		knownUsd: Number(
			known.reduce((sum, cost) => sum + (cost.usd ?? 0), 0).toFixed(6),
		),
		unknownComponents: costs.length - known.length,
	};
}

function duplicates(values: string[]): string[] {
	return values.filter((value, index) => values.indexOf(value) !== index);
}

function checkScoring(
	attempt: Attempt,
	where: string,
	report: (m: string) => void,
) {
	const scoring = attempt.scoring;
	if (!scoring) {
		if (attempt.kind === "unscored")
			report(`${where}: unscored attempt has no scoring record`);
		return;
	}
	const rounds = [...new Set(counted(scoring.invocations).map((i) => i.round))];
	if (rounds.some((round, index) => round !== index + 1))
		report(`${where}: scoring rounds must run 1, 2 in order`);
	if (rounds.length > MAX_SCORING_ROUNDS)
		report(`${where}: more than ${MAX_SCORING_ROUNDS} scoring rounds`);
	let verdict = false;
	for (const round of rounds) {
		const list = counted(scoring.invocations).filter((i) => i.round === round);
		if (list.length > MAX_INVOCATIONS_PER_ROUND)
			report(
				`${where}: round ${round} has more than ${MAX_INVOCATIONS_PER_ROUND} invocations`,
			);
		list.forEach((invocation, index) => {
			if (verdict)
				report(
					`${where}: a scorer invocation follows a verdict; a verdict is final`,
				);
			if (index === 0 && invocation.retryReason !== null)
				report(
					`${where}: the first invocation of round ${round} is not a retry`,
				);
			const before = list[index - 1];
			if (before && invocation.retryReason !== before.failure)
				report(
					`${where}: retry in round ${round} must name the infrastructure failure before it`,
				);
			if (invocation.failure === null) verdict = true;
			if (invocation.packetSha256 !== scoring.packetSha256)
				report(`${where}: every invocation scores the identical packet`);
		});
	}
	if (attempt.kind === "unscored" && verdict)
		report(`${where}: unscored attempt has a scorer verdict`);
	if (
		attempt.kind === "behavioral" &&
		scoring.requested.length > 0 &&
		!verdict
	) {
		const judged = attempt.musts.filter((m) =>
			scoring.requested.includes(m.id),
		);
		if (judged.some((m) => m.scorer !== null))
			report(`${where}: scorer decisions without a successful invocation`);
	}
	if (attempt.cost.scorer.length !== scoring.invocations.length)
		report(`${where}: one scorer cost per invocation`);
}

function checkAttempt(
	attempt: Attempt,
	trial: string,
	rubric: Rubric,
	where: string,
	report: (m: string) => void,
) {
	if (attempt.trial !== trial)
		report(`${where}: attempt names trial ${attempt.trial}`);
	if (attempt.startedAt > attempt.endedAt) report(`${where}: timestamp order`);
	for (const invocation of attempt.scoring?.invocations ?? []) {
		if (invocation.startedAt > invocation.endedAt)
			report(`${where}: scorer invocation timestamp order`);
	}
	const expected = rubric.musts.filter((must) => must.trial === trial);
	const ids = attempt.musts.map((m) => m.id);
	for (const id of duplicates(ids)) report(`${where}: duplicate Must ${id}`);
	for (const must of attempt.musts) {
		const declared = expected.find((e) => e.id === must.id);
		if (!declared)
			report(`${where}: Must ${must.id} does not belong to trial ${trial}`);
		else if (declared.class !== must.class)
			report(
				`${where}: Must ${must.id} has class ${must.class}, not ${declared.class}`,
			);
		if (must.class === "mechanical" && !must.checkerVersion)
			report(`${where}: mechanical Must ${must.id} names no checker version`);
		if (!must.checkerVersion && !must.scorer)
			report(`${where}: Must ${must.id} names neither checker nor scorer`);
		const invocations = attempt.scoring?.invocations ?? [];
		if (must.scorer && !invocations[must.scorer.invocation])
			report(`${where}: Must ${must.id} cites a missing scorer invocation`);
	}
	const requested = attempt.scoring?.requested ?? [];
	for (const must of attempt.musts.filter((m) => requested.includes(m.id))) {
		const cited = must.scorer
			? attempt.scoring?.invocations[must.scorer.invocation]
			: undefined;
		if (!must.scorer || must.checkerVersion)
			report(
				`${where}: requested Must ${must.id} must carry a scorer decision, not a checker one`,
			);
		else if (!cited || cited.failure !== null)
			report(
				`${where}: Must ${must.id} cites a scorer invocation that gave no verdict`,
			);
	}
	if (attempt.kind === "void") {
		if (attempt.musts.length > 0)
			report(`${where}: void attempts carry no Must verdicts`);
		if (attempt.behavioralOrdinal !== null)
			report(`${where}: void attempts have no behavioural ordinal`);
		if (attempt.voidReasons.length === 0)
			report(`${where}: void attempt without reasons`);
	}
	if (attempt.kind === "behavioral") {
		const missing = expected
			.filter((e) => !ids.includes(e.id))
			.map((e) => e.id);
		if (missing.length > 0)
			report(`${where}: missing Musts ${missing.join(", ")}`);
	}
	if ((attempt.kind === "pending") !== (attempt.launch !== undefined))
		report(
			`${where}: a launch record belongs to pending attempts, and only to them`,
		);
	if (
		attempt.kind === "pending" &&
		(attempt.musts.length > 0 || attempt.behavioralOrdinal !== null)
	)
		report(`${where}: a pending attempt carries no verdicts`);
	if (attempt.kind === "unscored") {
		if (attempt.behavioralOrdinal !== null)
			report(`${where}: unscored attempts have no behavioural ordinal`);
		const requested = attempt.scoring?.requested ?? [];
		if (attempt.musts.some((m) => requested.includes(m.id)))
			report(`${where}: unscored attempt holds verdicts for requested Musts`);
	}
	const artifacts = attempt.artifacts.map((a) => a.path);
	for (const path of duplicates(artifacts))
		report(`${where}: duplicate artifact ${path}`);
	for (const must of attempt.musts) {
		for (const pointer of must.evidence) {
			if (!artifacts.includes(pointer.artifact))
				report(
					`${where}: Must ${must.id} cites ${pointer.artifact}, not an artifact of this attempt`,
				);
			if (pointer.lines && pointer.lines[0] > pointer.lines[1])
				report(`${where}: Must ${must.id} cites lines in reverse order`);
		}
	}
	if (attempt.scoring && !artifacts.includes(attempt.scoring.packet))
		report(`${where}: the scorer packet is not an artifact of this attempt`);
	checkScoring(attempt, where, report);
}

function checkEvaluation(
	evaluation: Evaluation,
	rubric: Rubric,
	where: string,
	report: (m: string) => void,
) {
	const policyTrials: readonly string[] = GATE_TRIALS;
	if (policyHash(evaluation.policy) !== evaluation.policySha256)
		report(`${where}: policySha256 does not match the recorded policy`);
	const trials = evaluation.trials.map((t) => t.trial);
	for (const id of duplicates(trials))
		report(`${where}: duplicate trial ${id}`);
	for (const id of trials)
		if (!policyTrials.includes(id)) report(`${where}: extra trial ${id}`);
	for (const id of policyTrials)
		if (!trials.includes(id)) report(`${where}: missing trial ${id}`);
	if (evaluation.startedAt > evaluation.endedAt)
		report(`${where}: timestamp order`);
	const runs = evaluation.invocations.map((i) => i.runId);
	for (const id of duplicates(runs)) report(`${where}: duplicate run ${id}`);
	for (const invocation of evaluation.invocations) {
		if (invocation.startedAt > invocation.endedAt)
			report(`${where}: invocation ${invocation.runId} timestamp order`);
	}
	for (const trial of evaluation.trials) {
		const at = `${where} trial ${trial.trial}`;
		trial.attempts.forEach((attempt, index) => {
			const before = trial.attempts.slice(0, index);
			const state = deriveTrial(before, rubric);
			if (index > 0 && state !== "pending")
				report(
					`${at}: attempt ${index + 1} recorded after the trial was ${state}`,
				);
			else if (before.some(awaitingScore))
				report(
					`${at}: attempt ${index + 1} launched while an earlier attempt was unscored`,
				);
			if (attempt.ordinal !== index + 1)
				report(`${at}: attempt ordinals must run 1, 2, ... in order`);
			if (!runs.includes(attempt.runId))
				report(`${at}: attempt ${attempt.ordinal} names an unknown run`);
			checkAttempt(
				attempt,
				trial.trial,
				rubric,
				`${at} attempt ${attempt.ordinal}`,
				report,
			);
		});
		const behavioral = trial.attempts.filter((a) => a.kind === "behavioral");
		if (behavioral.length > MAX_BEHAVIORAL)
			report(`${at}: more than ${MAX_BEHAVIORAL} behavioural attempts`);
		behavioral.forEach((a, index) => {
			if (a.behavioralOrdinal !== index + 1)
				report(`${at}: behavioural ordinals must run 1, 2 in order`);
		});
		if (exemptVoids(trial.attempts) > MAX_EXEMPT_VOIDS)
			report(`${at}: more than ${MAX_EXEMPT_VOIDS} exempt void attempts`);
		if (trial.attempts.slice(0, -1).some((a) => a.kind === "pending"))
			report(`${at}: only the last attempt may be pending`);
		const passed = trial.attempts.findIndex(attemptPassed);
		if (passed >= 0 && passed < trial.attempts.length - 1)
			report(`${at}: attempts recorded after a pass`);
		const derived = deriveTrial(trial.attempts, rubric);
		if (derived !== trial.outcome)
			report(
				`${at}: outcome ${trial.outcome} does not match the attempts (${derived})`,
			);
	}
	const aggregate = deriveAggregate(evaluation.trials.map((t) => t.outcome));
	if (aggregate !== evaluation.outcome)
		report(
			`${where}: outcome ${evaluation.outcome} does not match the trials (${aggregate})`,
		);
}

/** Every problem with a result file; empty when it is valid. */
export function validateResult(
	value: unknown,
	rubric = loadRubric(),
): string[] {
	const parsed = resultSchema.safeParse(value);
	if (!parsed.success) {
		return parsed.error.issues.map((issue) => {
			const keys =
				issue.code === "unrecognized_keys" ? ` ${issue.keys.join(", ")}` : "";
			return `${issue.path.join(".") || "(root)"}: ${issue.message}${keys}`;
		});
	}
	const result = parsed.data;
	const problems: string[] = [];
	const report = (message: string) => problems.push(message);
	if (result.startedAt > result.endedAt) report("result: timestamp order");
	checkEvaluation(result.evaluation, rubric, "evaluation", report);
	result.history.forEach((evaluation, index) =>
		checkEvaluation(evaluation, rubric, `history ${index}`, report),
	);
	const hashes = [result.evaluation, ...result.history].map((e) => e.hash);
	for (const hash of duplicates(hashes))
		report(`history: evaluation identity ${hash} appears twice`);
	if (result.outcome !== result.evaluation.outcome)
		report(
			`result: outcome ${result.outcome} does not match the current evaluation`,
		);
	const cost = totalCost(result);
	if (
		Math.abs(cost.knownUsd - result.cost.knownUsd) > 1e-6 ||
		cost.unknownComponents !== result.cost.unknownComponents
	)
		report(`result: cost total does not match the attempts' costs`);
	return problems;
}
