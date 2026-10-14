/**
 * Handmade result records for the schema, results and scorer tests. Nothing
 * here runs a model or reads a real workspace.
 */

import {
	type Attempt,
	type AttemptKind,
	type Cost,
	deriveAggregate,
	deriveTrial,
	type Evaluation,
	loadRubric,
	type MustOutcome,
	policyHash,
	type Result,
	type ScorerInvocation,
	totalCost,
} from "./schema";

const rubric = loadRubric();
export const TRIALS = ["A", "D", "E", "G", "E-neg", "G-neg"];
const HASH = (digit: string) => `sha256:${digit.repeat(64)}`;
const HEX = "a".repeat(64);
const T0 = "2026-10-13T15:00:00.000Z";
const T1 = "2026-10-13T15:10:00.000Z";
export const RUN_ID = "20261013T150000Z-abc123";

export const knownCost = (usd = 0.5): Cost => ({
	usd,
	reason: null,
	usage: null,
	source: "claude.jsonl cost-state line 9",
});

export function invocation(
	changes: Partial<ScorerInvocation> = {},
): ScorerInvocation {
	return {
		round: 1,
		family: "claude",
		requestedModel: "claude-opus-5-5",
		observedModels: ["claude-opus-5-5"],
		effort: "high",
		cliVersion: "2.1.296 (Claude Code)",
		promptSha256: HASH("2"),
		packetSha256: HASH("3"),
		argv: ["claude", "--print"],
		settings: { settingSources: [] },
		sessionId: "00000000-0000-4000-8000-000000000001",
		exitStatus: 0,
		signal: null,
		timedOut: false,
		failure: null,
		stderr: "",
		retryReason: null,
		startedAt: T0,
		endedAt: T1,
		cost: knownCost(0.2),
		...changes,
	};
}

export function attempt(trial: string, kind: AttemptKind, rounds = 1): Attempt {
	const artifactDir = `artifacts/${HEX}/${RUN_ID}/${trial}/attempt-1`;
	const base: Attempt = {
		trial,
		ordinal: 1,
		kind,
		behavioralOrdinal: null,
		runId: RUN_ID,
		sessionId: "00000000-0000-4000-8000-000000000002",
		exitCodes: [kind === "void" ? 3 : 0],
		valid: kind !== "void",
		voidReasons:
			kind === "void" ? ["session: no tool-result binary evidence"] : [],
		timedOut: false,
		interrupted: null,
		binaryEvidence: {
			expected: "/tmp/shepherd-evals-x/bin/shepherd",
			callIds: kind === "void" ? [] : ["toolu_start"],
			unexpected: [],
		},
		subject: {
			backend: "claude",
			requestedModel: "claude-opus-5-5",
			observedModels: ["claude-opus-5-5"],
			effort: "high",
			cliVersion: "2.1.296 (Claude Code)",
			settingsFingerprint: HASH("4"),
			argv: ["/tmp/shepherd-evals-x/bin/shepherd", "--backend", "claude"],
		},
		startedAt: T0,
		endedAt: T1,
		artifactDir,
		artifacts: [
			{
				path: "claude.jsonl",
				sha256: HEX,
				bytes: 10,
				type: "native-log",
				redactions: 0,
			},
			{
				path: "claude-final.json",
				sha256: HEX,
				bytes: 10,
				type: "snapshot",
				redactions: 0,
			},
			{
				path: "packet.md",
				sha256: HEX,
				bytes: 10,
				type: "scorer-packet",
				redactions: 0,
			},
		],
		musts: [],
		scoring: null,
		cost: { subject: knownCost(), scorer: [] },
	};
	if (kind === "unscored") {
		const invocations: ScorerInvocation[] = [];
		for (let round = 1; round <= rounds; round++) {
			invocations.push(
				invocation({ round, failure: "nonzero exit 1", exitStatus: 1 }),
				invocation({
					round,
					retryReason: "nonzero exit 1",
					failure: "unparsable JSON",
				}),
			);
		}
		base.scoring = {
			packet: "packet.md",
			packetSha256: HASH("3"),
			requested: judgedIds(trial),
			invocations,
		};
		base.cost.scorer = invocations.map((i) => i.cost);
		base.musts = mechanical(trial, "pass");
	}
	return base;
}

const judgedIds = (trial: string) =>
	rubric.musts
		.filter((must) => must.trial === trial && must.class === "judged")
		.map((must) => must.id);

function mechanical(trial: string, outcome: MustOutcome) {
	return rubric.musts
		.filter((must) => must.trial === trial && must.class === "mechanical")
		.map((must) => ({
			id: must.id,
			class: must.class,
			outcome,
			checkerVersion: "must-check/1",
			scorer: null,
			rationale: "handmade",
			evidence: [{ artifact: "claude.jsonl", line: 1, callId: "toolu_start" }],
		}));
}

export function behavioral(
	trial: string,
	outcome: MustOutcome,
	behavioralOrdinal = 1,
	overrides: Record<string, MustOutcome> = {},
): Attempt {
	const a = attempt(trial, "behavioral");
	a.behavioralOrdinal = behavioralOrdinal;
	a.ordinal = behavioralOrdinal;
	a.artifactDir = a.artifactDir.replace(
		/attempt-1$/,
		`attempt-${behavioralOrdinal}`,
	);
	const judged = judgedIds(trial);
	a.musts = rubric.musts
		.filter((must) => must.trial === trial)
		.map((must) => ({
			id: must.id,
			class: must.class,
			outcome: overrides[must.id] ?? outcome,
			checkerVersion: must.class === "mechanical" ? "must-check/1" : null,
			scorer:
				must.class === "judged"
					? { sessionId: "00000000-0000-4000-8000-000000000001", invocation: 0 }
					: null,
			rationale: "handmade",
			evidence: [
				{
					artifact: "claude-final.json",
					path: ".shepherd/CURRENT.md",
					lines: [1, 2] as [number, number],
				},
			],
		}));
	if (judged.length > 0) {
		a.scoring = {
			packet: "packet.md",
			packetSha256: HASH("3"),
			requested: judged,
			invocations: [invocation()],
		};
		a.cost.scorer = [invocation().cost];
	}
	return a;
}

/** A consistent result; `overrides` set Must outcomes in each trial's one attempt. */
export function result(
	overrides: Record<string, MustOutcome> = {},
	attempts: Record<string, Attempt[]> = {},
): Result {
	const trials = TRIALS.map((trial) => {
		const list = (
			attempts[trial] ?? [behavioral(trial, "pass", 1, overrides)]
		).map((a, index) => ({ ...a, ordinal: index + 1 }));
		return { trial, outcome: deriveTrial(list, rubric), attempts: list };
	});
	const evaluation: Evaluation = {
		harnessVersion: 1,
		hash: HASH("5"),
		rubricSha256: HASH("6"),
		policySha256: policyHash({ trials: TRIALS, model: "claude-opus-5-5" }),
		policy: { trials: TRIALS, model: "claude-opus-5-5" },
		scorer: { family: "claude", model: "claude-opus-5-5", effort: "high" },
		outcome: deriveAggregate(trials.map((t) => t.outcome)),
		invocations: [
			{
				runId: RUN_ID,
				startedAt: T0,
				endedAt: T1,
				build: {
					revision: "b".repeat(40),
					dirty: true,
					sourceDirty: false,
					version: `shepherd revision=${"b".repeat(40)} dirty=true source=${HASH("8")}\n`,
					binarySha256: HEX,
					bunVersion: "1.3.0",
					platform: "darwin",
					arch: "arm64",
					builtAt: T0,
				},
				recheck: { valid: true, reasons: [] },
			},
		],
		trials,
		startedAt: T0,
		endedAt: T1,
	};
	const value: Result = {
		schemaVersion: 1,
		source: {
			hash: HASH("8"),
			manifest: [
				{ path: "agents/shepherd.md", bytes: 3, sha256: HEX, untracked: false },
			],
		},
		evaluation,
		history: [],
		outcome: evaluation.outcome,
		startedAt: T0,
		endedAt: T1,
		cost: { knownUsd: 0, unknownComponents: 0 },
	};
	value.cost = totalCost(value);
	return value;
}

export function trialsOf(value: Result): string[] {
	return value.evaluation.trials.map((t) => t.trial);
}
