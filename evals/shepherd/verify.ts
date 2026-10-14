/**
 * The informational CI check (spec 7, as the on-demand shape amends it). It
 * lists the paths a PR changed since the merge base of its base and head
 * (7.2); when any is gated (7.3), it recomputes the source and evaluation
 * identities of the checked-out PR head and opens only the result for that
 * exact source hash. A missing result is a notice, naming the newest
 * committed result. A stale one, recording another evaluation identity, is
 * a notice too once its record's integrity checks. A current one is
 * verified in full (7.4): schema, identities and manifests, policy,
 * provenance, hash-matching evidence, mechanical checks recomputed from the
 * archived artifacts, and the derived aggregate. Only a result that does
 * not verify, or a check that cannot be decided, fails the job; a verified
 * result's outcome, blocked included, is reported. Revision and both dirty flags are reported, never rejected. It
 * never reads `validation/`, reads other results only to name the newest,
 * runs no model and needs no model credentials.
 *
 *   bun evals/shepherd/verify.ts --base <revision> --head <revision>
 */

import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type GitRunner,
	readWorktreeSource,
	runGit,
	type SourceManifest,
} from "../../scripts/shepherd-source";
import {
	CHECKER_FAILED,
	type ChecksOutput,
	pythonChecks,
	scorerOutputName,
	sessionFacts,
	sessionValidity,
} from "./gate";
import { ADOPTED_GATED_PATHS, isGatedPath } from "./gated-paths";
import {
	EVALUATION_DIR,
	type EvaluationIdentity,
	evaluationIdentity,
} from "./identity";
import {
	type AggregateOutcome,
	type Attempt,
	type AttemptKind,
	deriveAggregate,
	deriveTrial,
	frozenVoid,
	loadRubric,
	policyHash,
	type Result,
	type Rubric,
	type TrialOutcome,
	validateResult,
} from "./schema";
import {
	archivedPacket,
	archivedText,
	type Decision,
	PACKET_FILES,
	readScorerOutput,
} from "./scorer";

/**
 * Files that decide what is gated and how results are identified and
 * verified. A change to any of them always needs a result, whatever the
 * path policy says, so a broken predicate cannot exempt its own change. All
 * four are in the adopted set already. This guards honest mistakes only:
 * the job, the verifier and the policy all run from the PR head.
 */
export const ALWAYS_GATED: readonly string[] = [
	"evals/shepherd/gated-paths.ts",
	"evals/shepherd/identity.ts",
	"evals/shepherd/verify.ts",
	"scripts/shepherd-source.ts",
];

/** Native logs name this pseudo model for local messages; it is no model. */
const SYNTHETIC_MODEL = "<synthetic>";
/** Evidence every attempt that ran the mechanical checks must archive. */
const CHECKED_EVIDENCE = [
	"claude-run.json",
	"claude.jsonl",
	"claude-baseline.json",
	"claude-final.json",
	"must-check.json",
];

export interface ChangedPaths {
	base: string;
	head: string;
	mergeBase: string;
	/** Every changed path, deletions and both sides of renames included. */
	paths: string[];
}

/** A Git failure that leaves the check undecided: it fails closed. */
export class GateError extends Error {
	override name = "GateError";
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function resolveCommit(
	git: GitRunner,
	root: string,
	revision: string,
	what: string,
): string {
	const result = revision.startsWith("-")
		? undefined
		: git(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], root);
	const resolved = result ? decode(result.stdout).trim() : "";
	if (
		!result ||
		result.code !== 0 ||
		!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(resolved)
	) {
		throw new GateError(`cannot resolve the ${what} revision ${revision}`);
	}
	return resolved;
}

/**
 * Paths changed between the merge base of `base` and `head`, and `head`,
 * from a NUL-delimited diff without rename detection, so a rename lists
 * both sides. Any Git failure throws.
 */
export function changedPaths(
	root: string,
	base: string,
	head: string,
	options: { git?: GitRunner } = {},
): ChangedPaths {
	const git = options.git ?? runGit;
	const baseCommit = resolveCommit(git, root, base, "base");
	const headCommit = resolveCommit(git, root, head, "head");
	const merge = git(["merge-base", baseCommit, headCommit], root);
	const mergeBase = decode(merge.stdout).trim();
	if (merge.code !== 0 || mergeBase === "") {
		throw new GateError(
			`no merge base of ${baseCommit} and ${headCommit}: ${merge.stderr.trim()}`,
		);
	}
	const diff = git(
		[
			"diff",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			"--name-only",
			"-z",
			mergeBase,
			headCommit,
			"--",
		],
		root,
	);
	if (diff.code !== 0) {
		throw new GateError(
			`git diff ${mergeBase} ${headCommit} failed: ${diff.stderr.trim()}`,
		);
	}
	let paths: string[];
	try {
		paths = new TextDecoder("utf-8", { fatal: true })
			.decode(diff.stdout)
			.split("\0")
			.filter((path) => path !== "");
	} catch {
		throw new GateError("git diff listed a path that is not UTF-8");
	}
	return {
		base: baseCommit,
		head: headCommit,
		mergeBase,
		paths: [...new Set(paths)].sort(),
	};
}

export interface Verification {
	/** Whether a result for the tree's source hash exists. */
	found: boolean;
	/** Whether that result verifies; its outcome, blocked included, does not matter. */
	ok: boolean;
	problems: string[];
	/** Reported provenance: revisions, dirty flags, untracked entries, outcomes. */
	notes: string[];
	/** The verified result's derived outcome, set only when it verifies. */
	outcome?: VerifiedOutcome;
	/**
	 * Set when the result records another evaluation identity than the tree's.
	 * Only its record's integrity is then checked, and it is not verified;
	 * `note` is the notice that says so.
	 */
	stale?: { recorded: string; current: string; note: string };
}

export interface VerifiedOutcome {
	aggregate: AggregateOutcome;
	trials: {
		trial: string;
		outcome: TrialOutcome;
		attempts: {
			ordinal: number;
			kind: AttemptKind;
			musts: { id: string; outcome: string }[];
		}[];
	}[];
}

export interface VerifyOptions {
	git?: GitRunner;
	/** The mechanical checker; the verified tree's `must-check.py` by default. */
	checks?(trial: string, dir: string): ChecksOutput;
	/** The path policy; `isGatedPath` by default. `ALWAYS_GATED` applies regardless. */
	isGated?(path: string): boolean;
}

const sha256 = (data: Uint8Array) =>
	createHash("sha256").update(data).digest("hex");

/** Differences on path and content SHA-256 only; `untracked` is reported (R3). */
function manifestDifferences(
	recorded: Result["source"]["manifest"],
	current: SourceManifest,
): string[] {
	const now = new Map(
		current.entries.map((entry) => [entry.path, entry.sha256]),
	);
	const then = new Map(recorded.map((entry) => [entry.path, entry.sha256]));
	const differences: string[] = [];
	for (const [path, hash] of then) {
		if (!now.has(path)) differences.push(`${path}: evaluated, absent at head`);
		else if (now.get(path) !== hash)
			differences.push(`${path}: content differs at head`);
	}
	for (const path of now.keys()) {
		if (!then.has(path)) differences.push(`${path}: at head, not evaluated`);
	}
	return differences;
}

/** Whether `path` beneath `dir` is a regular file reached through no symlink. */
function regularFile(dir: string, path: string): boolean {
	const parts = path.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const stat = lstatSync(join(dir, ...parts.slice(0, i)), {
			throwIfNoEntry: false,
		});
		if (!stat || stat.isSymbolicLink()) return false;
		if (i === parts.length) return stat.isFile();
	}
	return false;
}

/**
 * The archived evidence of one attempt: under this source hash's artifact
 * directory, every listed artifact present with its recorded length and
 * SHA-256. Unlisted files and set-aside `.partial` exports are ignored.
 * Evidence outside that directory is none at all.
 */
function checkEvidence(
	evalsDir: string,
	hex: string,
	attempt: Attempt,
	where: string,
	report: (message: string) => void,
): Map<string, Uint8Array> | undefined {
	const verified = new Map<string, Uint8Array>();
	const expected = `artifacts/${hex}/${attempt.runId}/${attempt.trial}/attempt-${attempt.ordinal}`;
	if (attempt.artifactDir !== expected) {
		report(
			`${where}: artifact directory ${attempt.artifactDir} is not ${expected}`,
		);
		return undefined;
	}
	for (const artifact of attempt.artifacts) {
		const path = `${attempt.artifactDir}/${artifact.path}`;
		if (!regularFile(evalsDir, path)) {
			report(`${where}: ${path} is missing or not a regular file`);
			continue;
		}
		const bytes = readFileSync(join(evalsDir, path));
		if (
			bytes.byteLength !== artifact.bytes ||
			sha256(bytes) !== artifact.sha256
		) {
			report(
				`${where}: ${path} does not match its recorded length and SHA-256`,
			);
			continue;
		}
		verified.set(artifact.path, bytes);
	}
	const packet = attempt.scoring;
	if (packet) {
		const archived = attempt.artifacts.find((a) => a.path === packet.packet);
		const hash = archived ? `sha256:${archived.sha256}` : undefined;
		if (
			packet.packetSha256 !== hash ||
			packet.invocations.some((i) => i.packetSha256 !== hash)
		)
			report(`${where}: the scored packet hash is not the archived packet's`);
	}
	return verified;
}

/**
 * Run the checker on a fresh directory holding only the attempt's listed
 * artifacts whose hashes verified, so no unlisted file, symlink or cached
 * bytecode beside the archive can reach it.
 */
function recompute(
	attempt: Attempt,
	verified: Map<string, Uint8Array>,
	checks: NonNullable<VerifyOptions["checks"]>,
): ChecksOutput {
	const dir = mkdtempSync(join(tmpdir(), "shepherd-evals-verify-"));
	try {
		for (const [name, bytes] of verified) writeFileSync(join(dir, name), bytes);
		return checks(attempt.trial, dir);
	} catch (error) {
		return { error: (error as Error).message };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Recompute the mechanical checks from the archived artifacts and compare. */
function checkMechanical(
	attempt: Attempt,
	verified: Map<string, Uint8Array>,
	rechecked: boolean,
	checks: NonNullable<VerifyOptions["checks"]>,
	where: string,
	report: (message: string) => void,
): void {
	const listed = attempt.artifacts.map((a) => a.path);
	if (!listed.includes("must-check.json")) {
		if (attempt.kind === "void") return;
		const interrupted = attempt.musts.every(
			(m) =>
				m.outcome === "inconclusive" && m.checkerVersion === "gate:interrupted",
		);
		if (attempt.kind !== "behavioral" || !interrupted) {
			report(
				`${where}: no archived mechanical checks for a ${attempt.kind} attempt`,
			);
		}
		return;
	}
	// The gate voids a checked attempt only when its run's frozen inputs changed.
	if (attempt.kind === "void") {
		if (rechecked) report(`${where}: a void attempt holds mechanical checks`);
		return;
	}
	for (const name of CHECKED_EVIDENCE) {
		if (!listed.includes(name))
			report(`${where}: evidence ${name} is not archived`);
	}
	const checked = recompute(attempt, verified, checks);
	if ("error" in checked) {
		report(
			`${where}: the mechanical checks fail on the archived evidence: ${checked.error}`,
		);
		return;
	}
	const recorded = new Map(attempt.musts.map((must) => [must.id, must]));
	for (const [id, must] of Object.entries(checked.musts)) {
		const record = recorded.get(id);
		if (must.outcome !== null) {
			if (
				!record ||
				record.outcome !== must.outcome ||
				record.checkerVersion !== checked.checkerVersion
			) {
				report(
					`${where}: ${id} is recorded ${record ? `${record.outcome} by ${record.checkerVersion ?? "the scorer"}` : "nowhere"}, but ${checked.checkerVersion} recomputes ${must.outcome}`,
				);
			}
		} else if (record?.checkerVersion && record.outcome !== "inconclusive") {
			report(
				`${where}: ${id} is recorded ${record.outcome} by the checker, which leaves it to the scorer`,
			);
		}
	}
	for (const id of recorded.keys()) {
		if (!(id in checked.musts))
			report(`${where}: ${id} is recorded but not checked`);
	}
}

interface RunManifest {
	argv?: string[];
	validity?: { valid?: boolean; void_reasons?: string[] };
	provenance?: {
		expected_binary?: string;
		evidence_call_ids?: string[];
		unexpected_binaries?: { call_id: string; binary: string }[];
	}[];
	ended_at?: string | null;
}

/**
 * Validity and binary provenance as the archived `claude-run.json` records
 * them (5.4, 5.6). A record may add void reasons (a checker failure, a
 * changed frozen input) but never drop the harness's, never turn an invalid
 * session valid, and never void a valid session whose evidence checks
 * cleanly in a run whose inputs held.
 */
function checkValidity(
	attempt: Attempt,
	verified: Map<string, Uint8Array>,
	rechecked: boolean,
	checks: NonNullable<VerifyOptions["checks"]>,
	where: string,
	report: (message: string) => void,
): void {
	if (attempt.kind === "void" && attempt.valid)
		report(`${where}: a void attempt is recorded valid`);
	// Only an attempt resolved after an interrupted invocation may hold the
	// session log without the harness's manifest.
	const listed = attempt.artifacts.map((a) => a.path);
	if (
		listed.includes("claude.jsonl") &&
		!listed.includes("claude-run.json") &&
		attempt.interrupted === null
	)
		report(`${where}: claude.jsonl is archived without claude-run.json`);
	const bytes = verified.get("claude-run.json");
	if (!bytes) return;
	let run: RunManifest;
	try {
		run = JSON.parse(archivedText(bytes));
	} catch {
		report(`${where}: the archived claude-run.json is not JSON`);
		return;
	}
	// A harness that never finished left its start placeholder; the gate then
	// judged the session from its native log instead (pending resolution).
	if (!run.ended_at) {
		if (attempt.interrupted === null)
			report(
				`${where}: its archived claude-run.json never finished, but the attempt was not interrupted`,
			);
		return;
	}
	// The record's argv is the manifest's, redacted alike; the policy checks
	// read the record's.
	if (JSON.stringify(run.argv) !== JSON.stringify(attempt.subject?.argv))
		report(
			`${where}: the argv of its archived claude-run.json is not the record's`,
		);
	const valid = run.validity?.valid === true;
	const reasons = run.validity?.void_reasons ?? [];
	if (attempt.valid && !valid)
		report(`${where}: recorded valid, but its archived claude-run.json is not`);
	const missing = reasons.filter((r) => !attempt.voidReasons.includes(r));
	if (missing.length > 0)
		report(
			`${where}: void reasons of its archived claude-run.json are not recorded: ${missing.join("; ")}`,
		);
	const leg = run.provenance?.[0];
	const evidence = {
		expected: leg?.expected_binary ?? "",
		callIds: leg?.evidence_call_ids ?? [],
		unexpected: (leg?.unexpected_binaries ?? []).map((u) => ({
			callId: u.call_id,
			binary: u.binary,
		})),
	};
	if (JSON.stringify(evidence) !== JSON.stringify(attempt.binaryEvidence))
		report(
			`${where}: binary evidence differs from its archived claude-run.json`,
		);
	if (
		attempt.kind === "void" &&
		valid &&
		rechecked &&
		!attempt.voidReasons.some((r) => r.startsWith(CHECKER_FAILED)) &&
		!("error" in recompute(attempt, verified, checks))
	)
		report(
			`${where}: a valid session (per its archived claude-run.json) is recorded void, but its archived evidence checks cleanly`,
		);
}

/** The fixed subject and scorer policy (5.1, 4.1) on every attempt. */
function checkPolicy(
	attempt: Attempt,
	verified: Map<string, Uint8Array>,
	policy: PolicyFile,
	where: string,
	report: (message: string) => void,
): void {
	const subject = attempt.subject;
	if (!subject && attempt.kind !== "void")
		report(`${where}: a ${attempt.kind} attempt names no subject`);
	if (subject) {
		if (
			subject.requestedModel !== policy.model ||
			subject.effort !== policy.effort
		)
			report(
				`${where}: subject requested ${subject.requestedModel} at ${subject.effort}, not the policy's ${policy.model} at ${policy.effort}`,
			);
		const observed = subject.observedModels.filter(
			(m) => m !== SYNTHETIC_MODEL,
		);
		if (
			attempt.valid &&
			(observed.length === 0 || observed.some((m) => m !== policy.model))
		)
			report(
				`${where}: subject observed model ${observed.join(", ") || "none"}, not ${policy.model}`,
			);
	}
	if (subject && attempt.valid) {
		const at = (flag: string, value: string) =>
			subject.argv.some(
				(arg, i) => arg === flag && subject.argv[i + 1] === value,
			);
		if (!at("--model", policy.model) || !at("--effort", policy.effort))
			report(
				`${where}: the subject argv does not request --model ${policy.model} --effort ${policy.effort}`,
			);
	}
	const log = verified.get("claude.jsonl");
	if (subject && attempt.valid && attempt.kind !== "void" && log) {
		// The session facts the record restates, from the archived log itself.
		const facts = sessionFacts(archivedText(log));
		const expected = attempt.binaryEvidence.expected;
		for (const callId of attempt.binaryEvidence.callIds) {
			if (
				!facts.results.some(
					(r) => r.callId === callId && r.markers.includes(expected),
				)
			)
				report(
					`${where}: call ${callId} returns no binary marker for ${expected} in its archived claude.jsonl`,
				);
		}
		const logged = [...facts.models].sort();
		const recorded = [
			...new Set(subject.observedModels.filter((m) => m !== SYNTHETIC_MODEL)),
		].sort();
		if (logged.join(", ") !== recorded.join(", "))
			report(
				`${where}: its archived claude.jsonl observed ${logged.join(", ") || "no model"}, but the record says ${recorded.join(", ") || "none"}`,
			);
	}
	if (attempt.kind === "behavioral" && attempt.valid) {
		const evidence = attempt.binaryEvidence;
		// A session resolved from its log after an interrupted invocation was
		// judged by that log; it carries no call ids and cannot pass. Judge its
		// archived log the same way.
		const resolved =
			attempt.interrupted !== null &&
			attempt.musts.every((m) => m.checkerVersion === "gate:interrupted");
		if (resolved) {
			if (!log)
				report(
					`${where}: a session resolved from its log archives no verified claude.jsonl`,
				);
			else
				for (const problem of sessionValidity(
					archivedText(log),
					evidence.expected,
					policy.model,
				))
					report(`${where}: ${problem}`);
		}
		if (!evidence.expected || (evidence.callIds.length === 0 && !resolved))
			report(`${where}: no in-session binary marker for the evaluated binary`);
		if (evidence.unexpected.length > 0)
			report(
				`${where}: unexpected binary markers ${evidence.unexpected.map((u) => u.binary).join(", ")}`,
			);
	}
	(attempt.scoring?.invocations ?? []).forEach((invocation, index) => {
		if (
			invocation.requestedModel !== policy.scorer.model ||
			invocation.effort !== policy.scorer.effort
		)
			report(
				`${where}: scorer invocation ${index} requested ${invocation.requestedModel} at ${invocation.effort}, not the policy's scorer`,
			);
		if (
			invocation.failure === null &&
			(invocation.observedModels.length === 0 ||
				invocation.observedModels.some((m) => m !== invocation.requestedModel))
		)
			report(
				`${where}: scorer invocation ${index} observed ${invocation.observedModels.join(", ") || "no model"}`,
			);
	});
}

/**
 * The scorer's verdicts re-derived from its archived outputs (4.4, 4.5, 6.3):
 * every invocation's output archived and hash-matching, read as the gate
 * read it against the archived packet, and agreeing with its record on
 * failure or verdict, models, cost and session; and every scored Must
 * exactly the decision its cited verdict gives.
 */
function checkScorer(
	attempt: Attempt,
	verified: Map<string, Uint8Array>,
	policy: PolicyFile,
	where: string,
	report: (message: string) => void,
): void {
	const scoring = attempt.scoring;
	if (!scoring) return;
	const text = (name: string) => {
		const bytes = verified.get(name);
		return bytes && archivedText(bytes);
	};
	const missing = [
		scoring.packet,
		...PACKET_FILES.map(([name]) => name),
	].filter((name) => text(name) === undefined);
	if (missing.length > 0)
		report(
			`${where}: the scored packet's files are not all archived: ${missing.join(", ")}`,
		);
	const packet =
		missing.length === 0
			? archivedPacket((name) => text(name) ?? "", scoring.packet)
			: undefined;
	const verdicts = new Map<number, Decision[]>();
	scoring.invocations.forEach((invocation, index) => {
		const name = scorerOutputName(index, invocation.round);
		const output = text(name);
		const at = `${where}: scorer invocation ${index}`;
		if (output === undefined) {
			report(`${at} has no verified archived output ${name}`);
			return;
		}
		// Read whatever the record says ended the process: the gate takes a
		// complete verdict printed before a timeout, kill or exit as the verdict.
		if (!packet) return;
		const read = readScorerOutput(
			output,
			policy.scorer.model,
			scoring.requested,
			packet,
		);
		if ((read.failure === null) !== (invocation.failure === null))
			report(
				`${at} is recorded ${invocation.failure === null ? "a verdict" : "a failure"}, but its archived output reads ${read.failure ?? "a verdict"}`,
			);
		if (read.observedModels.join(", ") !== invocation.observedModels.join(", "))
			report(
				`${at} is recorded as observing ${invocation.observedModels.join(", ") || "no model"}, but its archived output names ${read.observedModels.join(", ") || "none"}`,
			);
		if (read.usd !== invocation.cost.usd)
			report(
				`${at} is recorded at ${invocation.cost.usd === null ? "an unknown cost" : `$${invocation.cost.usd}`}, but its archived output reports ${read.usd ?? "none"}`,
			);
		if (read.sessionId !== undefined && read.sessionId !== invocation.sessionId)
			report(
				`${at} is recorded as session ${invocation.sessionId}, but its archived output names ${read.sessionId}`,
			);
		if (read.decisions && invocation.failure === null)
			verdicts.set(index, read.decisions);
	});
	for (const must of attempt.musts) {
		if (!must.scorer) continue;
		const cited = scoring.invocations[must.scorer.invocation];
		const decision = verdicts
			.get(must.scorer.invocation)
			?.find((d) => d.id === must.id);
		if (!decision || cited?.sessionId !== must.scorer.sessionId) {
			report(
				`${where}: ${must.id} is recorded ${must.outcome} by the scorer, but no archived verdict decides it`,
			);
			continue;
		}
		const recorded = {
			outcome: must.outcome,
			rationale: must.rationale,
			evidence: must.evidence,
		};
		const derived = JSON.parse(
			JSON.stringify({
				outcome: decision.outcome,
				rationale: decision.rationale,
				evidence: decision.evidence,
			}),
		);
		if (!isDeepStrictEqual(recorded, derived))
			report(
				`${where}: ${must.id} is recorded ${must.outcome}, but its archived scorer output decides ${decision.outcome}${decision.outcome === must.outcome ? " with another rationale or evidence" : ""}`,
			);
	}
}

interface PolicyFile {
	model: string;
	effort: string;
	scorer: { family: string; model: string; effort: string };
}

/** A relative path with no empty, `.` or `..` part, no backslash and no drive. */
const plainRelative = (path: unknown): path is string =>
	typeof path === "string" &&
	path.length > 0 &&
	!path.startsWith("/") &&
	!path.includes("\\") &&
	!/^[A-Za-z]:/.test(path) &&
	!path.split("/").some((part) => part === "" || part === "." || part === "..");

/**
 * The integrity of a stale result this tree's schema cannot read, from its
 * raw JSON: its source hash is the tree's, and every attempt's evidence
 * sits in its own directory under this source hash's artifacts with its
 * recorded length and SHA-256. Anything else in it is unchecked; evidence
 * whose shape cannot be read is a problem.
 */
function checkUnreadable(
	value: unknown,
	current: string,
	evalsDir: string,
	hex: string,
	resultPath: string,
	report: (message: string) => void,
): void {
	type Raw = Record<string, unknown> | undefined;
	const record = value as Raw;
	const recordedSource = (record?.source as Raw)?.hash;
	if (recordedSource !== current)
		report(
			`${resultPath} records source ${String(recordedSource)}, not ${current}`,
		);
	const trials = (record?.evaluation as Raw)?.trials;
	if (!Array.isArray(trials)) {
		report(`${resultPath}: its trials cannot be read to check its evidence`);
		return;
	}
	const dirs = new Set<string>();
	for (const trial of trials as Raw[]) {
		const attempts = trial?.attempts;
		if (typeof trial?.trial !== "string" || !Array.isArray(attempts)) {
			report(`${resultPath}: a trial cannot be read to check its evidence`);
			continue;
		}
		for (const attempt of attempts as Raw[]) {
			const where = `${trial.trial} attempt ${String(attempt?.ordinal)}`;
			const artifacts = attempt?.artifacts;
			if (
				!plainRelative(trial.trial) ||
				!plainRelative(attempt?.runId) ||
				!Number.isInteger(attempt?.ordinal) ||
				!plainRelative(attempt?.artifactDir) ||
				!Array.isArray(artifacts) ||
				!artifacts.every(
					(a: Raw) =>
						plainRelative(a?.path) &&
						typeof a?.sha256 === "string" &&
						typeof a?.bytes === "number",
				)
			) {
				report(`${where}: its evidence cannot be read`);
				continue;
			}
			const dir = attempt?.artifactDir as string;
			if (dirs.has(dir)) report(`${where}: shares artifact directory ${dir}`);
			dirs.add(dir);
			checkEvidence(
				evalsDir,
				hex,
				{ ...attempt, trial: trial.trial, scoring: null } as unknown as Attempt,
				where,
				report,
			);
		}
	}
}

/** Verify the checked-out tree at `root` against its committed result (7.4). */
export function verifyResults(
	root: string,
	options: VerifyOptions = {},
): Verification {
	const git = options.git ?? runGit;
	const evalsDir = join(root, EVALUATION_DIR);
	const checks =
		options.checks ??
		((trial: string, dir: string) =>
			pythonChecks(trial, dir, join(evalsDir, "must-check.py")));
	const problems: string[] = [];
	const notes: string[] = [];
	const report = (message: string) => problems.push(message);
	let found = false;
	let stale: Verification["stale"];
	const done = (): Verification => ({
		found,
		ok: found && !stale && problems.length === 0,
		problems,
		notes,
		...(stale ? { stale } : {}),
	});

	let source: SourceManifest;
	let identity: EvaluationIdentity;
	let rubric: Rubric;
	let policy: PolicyFile;
	try {
		source = readWorktreeSource(root, { git });
		identity = evaluationIdentity(root, { git });
		rubric = loadRubric(join(evalsDir, "rubric.json"));
		policy = JSON.parse(readFileSync(join(evalsDir, "policy.json"), "utf8"));
	} catch (error) {
		report(
			`cannot compute the identities of the checked-out tree: ${(error as Error).message}`,
		);
		return done();
	}
	const hex = source.source.replace(/^sha256:/, "");
	const resultPath = `${EVALUATION_DIR}/results/${hex}.json`;
	notes.push(`Source ${source.source}; evaluation identity ${identity.hash}.`);
	const present = lstatSync(join(root, resultPath), { throwIfNoEntry: false });
	if (!present) {
		notes.push(
			`No result for source ${source.source}: expected ${resultPath}.`,
		);
		return done();
	}
	found = true;
	if (!regularFile(root, resultPath)) {
		report(`${resultPath} is not a regular file reached without symlinks`);
		return done();
	}
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(join(root, resultPath), "utf8"));
	} catch (error) {
		report(`${resultPath} is not JSON: ${(error as Error).message}`);
		return done();
	}
	const invalid = validateResult(value, rubric);
	if (invalid.length > 0) {
		// An honest result an earlier schema wrote is stale, not broken: when
		// it records another identity, only what needs no schema is checked.
		const recorded = (value as { evaluation?: { hash?: unknown } } | null)
			?.evaluation?.hash;
		if (
			typeof recorded === "string" &&
			/^sha256:[0-9a-f]{64}$/.test(recorded) &&
			recorded !== identity.hash
		) {
			checkUnreadable(value, source.source, evalsDir, hex, resultPath, report);
			if (problems.length > 0) return done();
			const note = `Result ${resultPath} is out of date and this tree's schema cannot read it, so it was not verified: it records evaluation identity ${recorded}, and this tree computes ${identity.hash}.`;
			stale = { recorded, current: identity.hash, note };
			notes.push(note);
			return done();
		}
		for (const entry of invalid)
			report(`${resultPath} is not a valid result: ${entry}`);
		return done();
	}
	const result = value as Result;
	const evaluation = result.evaluation;

	if (result.source.hash !== source.source)
		report(
			`${resultPath} records source ${result.source.hash}, not ${source.source}`,
		);
	for (const difference of manifestDifferences(result.source.manifest, source))
		report(`manifest: ${difference}`);
	const untracked = result.source.manifest
		.filter((e) => e.untracked)
		.map((e) => e.path);
	if (untracked.length > 0)
		notes.push(
			`Evaluated with untracked source entries, compared by content: ${untracked.join(", ")}.`,
		);
	if (problems.length > 0) return done();
	// A stale result is out of date, not broken: only checks that need no
	// part of this tree's evaluation implementation run on it (its schema
	// and derived outcomes, manifest, version lines, recheck and void flags,
	// artifact directories and evidence hashes). The rubric, policy, scorer,
	// session, scorer output and mechanical re-derivations would judge it by
	// an implementation it was not evaluated with.
	if (evaluation.hash !== identity.hash) {
		const earlier = result.history.some((e) => e.hash === identity.hash)
			? " This tree's identity is in the result's history."
			: "";
		const note = `Result ${resultPath} is out of date and was not verified: it records evaluation identity ${evaluation.hash}, and this tree computes ${identity.hash}.${earlier} Its recorded outcome is ${result.outcome}.`;
		stale = { recorded: evaluation.hash, current: identity.hash, note };
		notes.push(note);
	} else {
		if (
			evaluation.rubricSha256 !==
			`sha256:${sha256(readFileSync(join(evalsDir, "rubric.json")))}`
		)
			report(
				`the recorded rubric hash ${evaluation.rubricSha256} is not the tree's rubric.json`,
			);
		if (policyHash(evaluation.policy) !== policyHash(policy))
			report("the recorded policy differs from the tree's policy.json");
		const scorer = evaluation.scorer;
		if (
			scorer.family !== policy.scorer.family ||
			scorer.model !== policy.scorer.model ||
			scorer.effort !== policy.scorer.effort
		)
			report(
				`the recorded scorer ${scorer.family} ${scorer.model} ${scorer.effort} is not the policy's`,
			);
	}

	const unrechecked = new Set<string>();
	for (const { runId, build, recheck } of evaluation.invocations) {
		const expected = `shepherd revision=${build.revision} dirty=${build.dirty} source=${result.source.hash}\n`;
		if (build.version !== expected)
			report(
				`run ${runId}: version output ${JSON.stringify(build.version)} does not match its build record and source`,
			);
		if (!recheck.valid) unrechecked.add(runId);
		notes.push(
			`Run ${runId}: revision=${build.revision} dirty=${build.dirty} sourceDirty=${build.sourceDirty} (${build.platform}/${build.arch}, Bun ${build.bunVersion}); provenance, not a condition.`,
		);
	}

	const dirs = new Set<string>();
	for (const trial of evaluation.trials) {
		for (const attempt of trial.attempts) {
			const where = `${trial.trial} attempt ${attempt.ordinal}`;
			const rechecked = !unrechecked.has(attempt.runId);
			if (!rechecked && attempt.kind !== "void")
				report(`${where}: its run failed the frozen-input recheck`);
			if (rechecked && frozenVoid(attempt))
				report(
					`${where}: voided for changed frozen inputs, but run ${attempt.runId} passed its recheck`,
				);
			if (dirs.has(attempt.artifactDir))
				report(`${where}: shares artifact directory ${attempt.artifactDir}`);
			dirs.add(attempt.artifactDir);
			const verified = checkEvidence(evalsDir, hex, attempt, where, report);
			if (stale) continue;
			checkPolicy(attempt, verified ?? new Map(), policy, where, report);
			if (!verified) continue;
			checkValidity(attempt, verified, rechecked, checks, where, report);
			checkScorer(attempt, verified, policy, where, report);
			checkMechanical(attempt, verified, rechecked, checks, where, report);
		}
	}

	// The outcome rules stay the gate's; a blocked result verifies and is reported.
	const trials = evaluation.trials.map((t) => ({
		trial: t.trial,
		outcome: deriveTrial(t.attempts),
		attempts: t.attempts.map((a) => ({
			ordinal: a.ordinal,
			kind: a.kind,
			musts: a.musts.map((m) => ({ id: m.id, outcome: m.outcome })),
		})),
	}));
	const aggregate = deriveAggregate(trials.map((t) => t.outcome));
	if (!stale)
		notes.push(
			`Outcome ${aggregate}: ${trials.map((t) => `${t.trial} ${t.outcome}`).join(", ")}.`,
		);
	const verification = done();
	if (verification.ok) verification.outcome = { aggregate, trials };
	return verification;
}

/** One line per attempt that records Musts: `<trial> attempt <n>: <id> <outcome>, ...`. */
function mustLines(outcome: VerifiedOutcome): string[] {
	return outcome.trials.flatMap((t) =>
		t.attempts
			.filter((a) => a.musts.length > 0)
			.map(
				(a) =>
					`${t.trial} attempt ${a.ordinal}: ${a.musts.map((m) => `${m.id} ${m.outcome}`).join(", ")}`,
			),
	);
}

const RESULT_FILE = new RegExp(
	`^${EVALUATION_DIR}/results/[0-9a-f]{64}\\.json$`,
);

/**
 * The newest committed result at the checked-out `HEAD`: among the result
 * files still present there, the one with the latest commit time over the
 * commits reachable from `HEAD` that added or changed it, ties going to the
 * first in `git log --topo-order`. A merge does not count as touching what
 * it brings in, so a branch's older result merged late is not the newest.
 * Its revision is its last invocation's build revision and its outcome the
 * one it records; neither is verified.
 */
export function newestCommittedResult(
	root: string,
	options: { git?: GitRunner } = {},
): string {
	const git = options.git ?? runGit;
	const log = git(
		[
			"log",
			"--topo-order",
			"--diff-filter=AM",
			"--name-only",
			"--format=%x00%ct",
			"HEAD",
			"--",
			`${EVALUATION_DIR}/results/`,
		],
		root,
	);
	if (log.code !== 0)
		return `The newest committed result cannot be listed: ${printable(log.stderr.trim())}`;
	const latest = new Map<string, number>();
	for (const commit of decode(log.stdout).split("\0").slice(1)) {
		const [time = "", ...paths] = commit.split("\n");
		for (const path of paths) {
			if (!RESULT_FILE.test(path)) continue;
			latest.set(path, Math.max(latest.get(path) ?? 0, Number(time)));
		}
	}
	// Map order is first appearance in topological order; the sort is stable.
	const candidates = [...latest].sort((a, b) => b[1] - a[1]);
	for (const [path] of candidates) {
		const shown = git(["show", `HEAD:${path}`], root);
		if (shown.code !== 0) continue;
		const name = `Newest committed result: ${path}`;
		try {
			const value = JSON.parse(decode(shown.stdout));
			const revision =
				value?.evaluation?.invocations?.at?.(-1)?.build?.revision;
			const outcome = value?.outcome;
			// Printed in CI: only a revision and an outcome of the schema's shape.
			if (
				/^[0-9a-f]{40}$/.test(String(revision)) &&
				["pass", "flaky-pass", "blocked"].includes(outcome)
			)
				return `${name}, revision ${revision}, outcome ${outcome} (recorded, not verified against this tree).`;
		} catch {}
		return `${name}, which cannot be read as a result.`;
	}
	return "No result is committed.";
}

/**
 * `text` with every control character escaped (C0, DEL, C1 and the Unicode
 * line and paragraph separators), so a record string or path name printed
 * in CI stays on its line.
 */
export function printable(text: string): string {
	let out = "";
	for (const c of text) {
		const n = c.codePointAt(0) ?? 0;
		if (c === "\n") out += "\\n";
		else if (c === "\r") out += "\\r";
		else if (c === "\t") out += "\\t";
		else if (
			n < 0x20 ||
			(n >= 0x7f && n <= 0x9f) ||
			n === 0x2028 ||
			n === 0x2029
		)
			out += `\\u${n.toString(16).padStart(4, "0")}`;
		else out += c;
	}
	return out;
}

export interface CheckOutcome {
	code: number;
	/** Printed to stdout. */
	lines: string[];
	/** Markdown for the GitHub job summary. */
	summary: string[];
	/** One line for a GitHub notice when no result was found. */
	notice?: string;
}

/**
 * The outcome of the check: `lines` so far, then the headline and its
 * detail. Every line may hold record strings or path names: each is made
 * printable, and the summary's fence is longer than any backtick run in it.
 */
export function checkOutcome(
	lines: string[],
	code: number,
	headline: string,
	detail: string[],
	notice?: string,
): CheckOutcome {
	const shown = detail.map(printable);
	const longest = Math.max(
		2,
		...shown.flatMap((line) =>
			[...line.matchAll(/`+/g)].map((m) => m[0].length),
		),
	);
	const fence = "`".repeat(longest + 1);
	const summary = ["## Shepherd evals", "", printable(headline)];
	if (shown.length > 0) summary.push("", `${fence}text`, ...shown, fence);
	return {
		code,
		lines: [...lines, headline, ...detail].map(printable),
		summary,
		...(notice ? { notice: printable(notice) } : {}),
	};
}

/**
 * The whole CI step: changed paths, then verification when any is gated.
 * It fails only when the check cannot be decided or a result for the head's
 * source hash does not verify.
 */
export function ciGate(
	root: string,
	base: string,
	head: string,
	options: VerifyOptions = {},
): CheckOutcome {
	const git = options.git ?? runGit;
	const lines: string[] = [];
	const finish = (
		code: number,
		headline: string,
		detail: string[],
		notice?: string,
	): CheckOutcome => checkOutcome(lines, code, headline, detail, notice);
	try {
		const changed = changedPaths(root, base, head, { git });
		const checkedOut = resolveCommit(git, root, "HEAD", "checked-out");
		if (checkedOut !== changed.head) {
			return finish(
				1,
				`Shepherd evals check failed closed: the checkout ${checkedOut} is not the PR head ${changed.head}. Check out the PR head, not a merge checkout.`,
				[],
			);
		}
		const compared = `Compared head ${changed.head} with ${changed.mergeBase}, the merge base with base ${changed.base}.`;
		const isGated = options.isGated ?? isGatedPath;
		const gated = changed.paths.filter(
			(path) => isGated(path) || ALWAYS_GATED.includes(path),
		);
		if (gated.length === 0) {
			return finish(
				0,
				`Shepherd evals not required: no gated path changed (${ADOPTED_GATED_PATHS} policy).`,
				[compared],
			);
		}
		lines.push(
			compared,
			`Gated paths changed (${ADOPTED_GATED_PATHS} policy):`,
			...gated.map((path) => `  ${path}`),
		);
		const verification = verifyResults(root, options);
		if (verification.problems.length > 0) {
			const headline = verification.found
				? "Shepherd evals result does not verify:"
				: "Shepherd evals check failed closed:";
			return finish(1, headline, [
				...verification.notes,
				...verification.problems.map((problem) => `  ${problem}`),
			]);
		}
		if (verification.stale) {
			return finish(
				0,
				"Shepherd evals: the result for this source is out of date and was not verified; the check is informational and the suite runs on demand (docs/SHEPHERD-EVALS.md).",
				verification.notes,
				verification.stale.note,
			);
		}
		if (!verification.outcome) {
			const missing = verification.notes.at(-1) ?? "No result.";
			const newest = newestCommittedResult(root, { git });
			return finish(
				0,
				"Shepherd evals: no result for this source; the check is informational and the suite runs on demand (docs/SHEPHERD-EVALS.md).",
				[...verification.notes, newest],
				`${missing} ${newest}`,
			);
		}
		return finish(
			0,
			`Shepherd evals result verified: outcome ${verification.outcome.aggregate}.`,
			[...verification.notes, ...mustLines(verification.outcome)],
		);
	} catch (error) {
		return finish(
			1,
			`Shepherd evals check failed closed: ${(error as Error).message}`,
			[],
		);
	}
}

/** Escape a GitHub workflow command's message. */
const commandData = (value: string) =>
	value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/**
 * Append the outcome's job summary to `GITHUB_STEP_SUMMARY` when it is set,
 * and return the lines to print. Under Actions they run between
 * `::stop-commands::` and its random token, so no printed line is read as a
 * workflow command, and the notice, when there is one, follows.
 */
export function githubReport(
	outcome: CheckOutcome,
	env: Record<string, string | undefined>,
): string[] {
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(env.GITHUB_STEP_SUMMARY, `${outcome.summary.join("\n")}\n`);
	if (env.GITHUB_ACTIONS !== "true") return outcome.lines;
	const token = randomBytes(16).toString("hex");
	return [
		`::stop-commands::${token}`,
		...outcome.lines,
		`::${token}::`,
		...(outcome.notice
			? [`::notice title=Shepherd evals::${commandData(outcome.notice)}`]
			: []),
	];
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const value = (flag: string) => {
		const at = args.indexOf(flag);
		return at >= 0 ? args[at + 1] : undefined;
	};
	const base = value("--base");
	const head = value("--head");
	if (!base || !head || args.length !== 4) {
		console.error(
			"usage: bun evals/shepherd/verify.ts --base <revision> --head <revision>",
		);
		process.exit(2);
	}
	const outcome = ciGate(resolve(import.meta.dir, "../.."), base, head);
	for (const line of githubReport(outcome, process.env)) console.log(line);
	process.exit(outcome.code);
}
