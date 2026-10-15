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

/**
 * The Claude CLI's `--output-format json` reply as `of` read it: `reply` is
 * the scorer's text, its models, session id and cost are the invocation's.
 */
export function scorerOutput(
	reply: string,
	of: ScorerInvocation = invocation(),
): string {
	return `${JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		result: reply,
		session_id: of.sessionId,
		total_cost_usd: of.cost.usd,
		modelUsage: Object.fromEntries(
			of.observedModels.map((model) => [model, { costUSD: of.cost.usd }]),
		),
	})}\n`;
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
			argv: [
				"/tmp/shepherd-evals-x/bin/shepherd",
				"--backend",
				"claude",
				"--model",
				"claude-opus-5-5",
				"--print",
				"You are taking over this workspace. Do the next thing.",
				"--",
				"--effort",
				"high",
				"--session-id",
				"00000000-0000-4000-8000-000000000002",
			],
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
		return { trial, outcome: deriveTrial(list), attempts: list };
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

/**
 * The directory Claude Code names a session's projects directory after its
 * working directory (CLI 2.1.299, `p0`): every UTF-16 code unit outside ASCII
 * letters and digits as a dash, and a slug past 200 units cut to 200 with a
 * base 36 hash of the original path. Only fakes that write a native log use
 * it; the harness and the gate find the log by session id.
 */
export function projectDirName(cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	if (slug.length <= 200) return slug;
	let hash = 0;
	for (let i = 0; i < cwd.length; i++)
		hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
	return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Invented names a CLI request entry can carry, which neither export nor a
 * packet may show: an MCP tool, a plugin skill, an address and a home path.
 */
export const PLANTED = {
	mcp: "mcp__acme-tracker__file_ticket",
	plugin: "widget-forge-plugin:shaper",
	email: "planted.person@example.net",
	home: "/Users/plantedhome",
	slug: "-Users-plantedhome",
};

/**
 * The three request entries CLI 2.1.300 writes into the native log, with
 * its key names and nesting and invented content only.
 */
export function requestEntries(
	sessionId: string,
	timestamp = "2026-10-13T15:11:13.000Z",
): Record<string, unknown>[] {
	const reminder = [
		"<system-reminder>",
		`Skills: ${PLANTED.plugin}: shapes widgets.`,
		`MCP servers: acme-tracker. userEmail: ${PLANTED.email}`,
		`claudeMd: Contents of ${PLANTED.home}/CLAUDE.md`,
		`Project dir ${PLANTED.slug}-Projects-x`,
		"</system-reminder>",
	].join("\n");
	return [
		{
			type: "api-request-blob",
			hash: "b".repeat(64),
			sessionId,
			message: {
				role: "user",
				content: [
					{ type: "text", text: reminder },
					{ type: "text", text: "You are taking over this workspace." },
				],
			},
		},
		{
			type: "api-request-shape",
			sessionId,
			shapeHash: "s".repeat(16),
			timestamp,
			version: "2.1.300",
			shape: {
				system: [
					{ type: "text", text: "You are an invented CLI. SYSTEM-PROMPT-TEXT" },
					{
						type: "text",
						text: `Read ${PLANTED.home}/.claude/CLAUDE.md`,
						cache_control: { type: "ephemeral" },
					},
				],
				tools: [
					{
						name: PLANTED.mcp,
						description: "Files an invented ticket.",
						input_schema: { type: "object", properties: {} },
					},
					{ name: "Skill", description: `- ${PLANTED.plugin}: shapes widgets` },
				],
			},
		},
		{
			type: "api-request",
			id: "req_planted_1",
			sessionId,
			shapeHash: "s".repeat(16),
			requestDigest: "d".repeat(16),
			querySource: "repl_main_thread",
			timestamp,
			version: "2.1.300",
			base: { model: "claude-opus-5-5", max_tokens: 64000 },
			cacheControl: { system: [{ type: "ephemeral" }] },
			keep: [{ hash: "b".repeat(64) }],
			params: { effort: "high", mcp: [PLANTED.mcp] },
			tail: [{ role: "user", content: [{ type: "text", text: reminder }] }],
		},
	];
}
