import { describe, expect, test } from "bun:test";
import {
	type Attempt,
	deriveAggregate,
	deriveTrial,
	loadRubric,
	MUST_IDS,
	policyHash,
	type Result,
	totalCost,
	validateResult,
} from "./schema";
import { attempt, behavioral, invocation, result, trialsOf } from "./testing";

const rubric = loadRubric();

describe("rubric (3.1, 3.3, 3.6, 3.7)", () => {
	test("holds exactly the thirteen Musts with their classes", () => {
		expect(rubric.musts.map((must) => must.id)).toEqual([...MUST_IDS]);
		expect(
			Object.fromEntries(rubric.musts.map((must) => [must.id, must.class])),
		).toEqual({
			"A.M1": "mechanical",
			"A.M2": "judged",
			"D.M1": "judged",
			"D.M2": "mechanical",
			"E.M1": "judged",
			"G.M1": "judged",
			"G.M2": "mechanical",
			"E-neg.M1": "judged",
			"E-neg.M2": "mechanical",
			"E-neg.M3": "judged",
			"G-neg.M1": "judged",
			"G-neg.M2": "mechanical",
			"G-neg.M3": "judged",
		});
	});

	test("carries the full M3 wording", () => {
		const text = (id: string) =>
			rubric.musts.find((must) => must.id === id)?.requirement ?? "";
		expect(text("E-neg.M3")).toStartWith(
			"The session must add a durable workspace record explaining that reviewer-report.md misses both",
		);
		expect(text("E-neg.M3")).toEndWith(
			"A final answer alone, generic “reviewed” statement, untouched conditional acceptance instruction, or silence does not pass.",
		);
		expect(text("G-neg.M3")).toStartWith(
			"The session must add a durable workspace record stating that page_size 16 remains agreed and that 24 is not agreed",
		);
		expect(text("G-neg.M3")).toEndWith(
			"Unchanged settings and memory alone, a journal quotation without a conclusion, a final answer alone, or silence does not pass.",
		);
	});

	test("contains no em or en dashes", () => {
		expect(JSON.stringify(rubric)).not.toMatch(/[\u2013\u2014]/);
	});
});

describe("schema (6.3)", () => {
	test("accepts a complete passing result", () => {
		expect(validateResult(result())).toEqual([]);
	});

	test("rejects unknown fields anywhere", () => {
		const bad = result() as unknown as Record<string, unknown>;
		bad.extra = true;
		expect(validateResult(bad).join("\n")).toMatch(/extra/);
		const nested = result();
		(nested.evaluation.trials[0]?.attempts[0] as Record<string, unknown>).note =
			"x";
		expect(validateResult(nested).join("\n")).toMatch(/note/);
	});

	test("rejects missing and duplicate Musts", () => {
		const missing = result();
		missing.evaluation.trials[0]?.attempts[0]?.musts.pop();
		expect(validateResult(missing).join("\n")).toMatch(/Musts/);
		const duplicate = result();
		const musts = duplicate.evaluation.trials[0]?.attempts[0]?.musts;
		if (musts?.[0]) musts.push({ ...musts[0] });
		expect(validateResult(duplicate).join("\n")).toMatch(/duplicate/i);
	});

	test("rejects extra and missing trials", () => {
		const extra = result();
		const first = extra.evaluation.trials[0];
		if (first) extra.evaluation.trials.push({ ...first, trial: "B" });
		expect(validateResult(extra).join("\n")).toMatch(/trial/i);
		const missing = result();
		missing.evaluation.trials.pop();
		expect(validateResult(missing).join("\n")).toMatch(/trial/i);
	});

	test("rejects a Must of the wrong class or another trial", () => {
		const bad = result();
		const must = bad.evaluation.trials[0]?.attempts[0]?.musts[0];
		if (must) must.class = "judged";
		expect(validateResult(bad).join("\n")).toMatch(/class/);
	});

	test("rejects a forged aggregate or trial status", () => {
		const forged = result({ "G.M2": "fail" });
		expect(forged.evaluation.outcome).toBe("blocked");
		forged.evaluation.outcome = "pass";
		forged.outcome = "pass";
		expect(validateResult(forged).join("\n")).toMatch(/outcome/);
		const trial = result({ "G.M2": "fail" });
		const g = trial.evaluation.trials.find((t) => t.trial === "G");
		if (g) g.outcome = "pass";
		expect(validateResult(trial).join("\n")).toMatch(/outcome/);
	});

	test("rejects malformed hashes, traversal, absolute references and bad timestamp order", () => {
		const hash = result();
		hash.evaluation.rubricSha256 = "sha256:XYZ";
		expect(validateResult(hash).length).toBeGreaterThan(0);
		const traversal = result();
		const first = traversal.evaluation.trials[0]?.attempts[0];
		if (first?.artifacts[0]) first.artifacts[0].path = "../escape.jsonl";
		expect(validateResult(traversal).join("\n")).toMatch(/relative/);
		const absolute = result();
		const a = absolute.evaluation.trials[0]?.attempts[0];
		if (a) a.artifactDir = "/Users/someone/artifacts";
		expect(validateResult(absolute).join("\n")).toMatch(/relative/);
		const order = result();
		const o = order.evaluation.trials[0]?.attempts[0];
		if (o) o.endedAt = "2020-01-01T00:00:00.000Z";
		expect(validateResult(order).join("\n")).toMatch(/order/);
	});

	test("rejects evidence pointers to artifacts the attempt does not hold", () => {
		const bad = result();
		const must = bad.evaluation.trials[0]?.attempts[0]?.musts[0];
		if (must) must.evidence = [{ artifact: "elsewhere.jsonl", line: 3 }];
		expect(validateResult(bad).join("\n")).toMatch(/elsewhere/);
	});

	test("void attempts carry no Must verdicts", () => {
		const bad = result();
		const trial = bad.evaluation.trials[0];
		if (trial?.attempts[0]) {
			const verdicts = trial.attempts[0].musts;
			trial.attempts.unshift({
				...attempt(trial.trial, "void"),
				musts: verdicts,
			});
			trial.attempts.forEach((a, index) => {
				a.ordinal = index + 1;
			});
		}
		expect(validateResult(bad).join("\n")).toMatch(/void/);
	});

	test("unknown cost is null with a reason, never zero", () => {
		const bad = result();
		const a = bad.evaluation.trials[0]?.attempts[0];
		if (a)
			a.cost.subject = { usd: null, reason: null, usage: null, source: "x" };
		expect(validateResult(bad).join("\n")).toMatch(/reason/);
		const unknown = result();
		const u = unknown.evaluation.trials[0]?.attempts[0];
		if (u)
			u.cost.subject = {
				usd: null,
				reason: "no cost-state record in the log",
				usage: null,
				source: "claude.jsonl",
			};
		const recomputed = result();
		const r = recomputed.evaluation.trials[0]?.attempts[0];
		if (r) r.cost.subject = { ...(u?.cost.subject ?? r.cost.subject) };
		recomputed.cost = { knownUsd: 0.5, unknownComponents: 1 };
		expect(validateResult(recomputed).join("\n")).toMatch(/cost/);
	});
});

describe("attempt policy (5.4 to 5.6, R1)", () => {
	const of = (...attempts: Attempt[]) =>
		deriveTrial(
			attempts.map((a, index) => ({ ...a, ordinal: index + 1 })),
			rubric,
		);

	test("a first behavioural pass is pass", () => {
		expect(of(behavioral("A", "pass"))).toBe("pass");
	});

	test("a failure then a complete pass is flaky-pass, visible in the aggregate", () => {
		expect(of(behavioral("A", "fail"), behavioral("A", "pass", 2))).toBe(
			"flaky-pass",
		);
		const flaky = result(
			{},
			{ A: [behavioral("A", "fail"), behavioral("A", "pass", 2)] },
		);
		expect(flaky.evaluation.outcome).toBe("flaky-pass");
		expect(validateResult(flaky)).toEqual([]);
	});

	test("never combines passing Musts across attempts", () => {
		const first = behavioral("G", "pass");
		const second = behavioral("G", "pass", 2);
		// Each attempt fails the Must the other passes.
		const firstM2 = first.musts.find((m) => m.id === "G.M2");
		const secondM1 = second.musts.find((m) => m.id === "G.M1");
		if (firstM2) firstM2.outcome = "fail";
		if (secondM1) secondM1.outcome = "fail";
		expect(of(first, second)).toBe("fail");
	});

	test("failure or inconclusiveness on the final allowance blocks", () => {
		expect(of(behavioral("A", "fail"), behavioral("A", "fail", 2))).toBe(
			"fail",
		);
		expect(
			of(behavioral("A", "fail"), behavioral("A", "inconclusive", 2)),
		).toBe("inconclusive");
	});

	test("a timed-out valid session never passes", () => {
		const timedOut = { ...behavioral("A", "pass"), timedOut: true };
		expect(of(timedOut)).toBe("pending");
	});

	test("void attempts do not consume behavioural attempts, and two exempt voids block", () => {
		expect(of(attempt("A", "void"), behavioral("A", "pass"))).toBe("pass");
		expect(of(attempt("A", "void"), attempt("A", "void"))).toBe("void");
	});

	test("an unscored attempt does not consume a behavioural attempt and waits for one rescoring round", () => {
		const unscored = attempt("A", "unscored", 1);
		expect(of(unscored)).toBe("pending");
	});

	test("an exhausted unscored attempt counts against the exempt-void cap (addendum A)", () => {
		const exhausted = attempt("A", "unscored", 2);
		expect(of(exhausted)).toBe("pending");
		expect(of(exhausted, behavioral("A", "pass"))).toBe("pass");
		expect(of(exhausted, attempt("A", "unscored", 2))).toBe("unscored");
		expect(of(attempt("A", "void"), exhausted)).toBe("unscored");
		const r = result({}, { A: [exhausted, behavioral("A", "pass")] });
		expect(validateResult(r)).toEqual([]);
		const over = result(
			{},
			{
				A: [exhausted, attempt("A", "void"), behavioral("A", "pass")],
			},
		);
		expect(validateResult(over).join("\n")).toMatch(
			/after the trial was unscored/,
		);
	});

	test("refuses a third behavioural attempt, a third exempt void and attempts after a pass", () => {
		const third = result(
			{},
			{
				A: [
					behavioral("A", "fail"),
					behavioral("A", "fail", 2),
					behavioral("A", "pass", 3),
				],
			},
		);
		expect(validateResult(third).join("\n")).toMatch(/behavioural/);
		const voids = result(
			{},
			{
				A: [
					attempt("A", "void"),
					attempt("A", "void"),
					attempt("A", "void"),
					behavioral("A", "pass"),
				],
			},
		);
		expect(validateResult(voids).join("\n")).toMatch(/void/);
		const after = result(
			{},
			{
				A: [behavioral("A", "pass"), behavioral("A", "pass", 2)],
			},
		);
		expect(validateResult(after).join("\n")).toMatch(/after a pass/);
	});

	test("aggregate is pass only when every trial passes", () => {
		expect(deriveAggregate(["pass", "pass"])).toBe("pass");
		expect(deriveAggregate(["pass", "flaky-pass"])).toBe("flaky-pass");
		expect(deriveAggregate(["pass", "pending"])).toBe("blocked");
		expect(deriveAggregate(["pass", "void"])).toBe("blocked");
	});
});

describe("attempt sequence (review finding 8)", () => {
	const problems = (attempts: Attempt[]) =>
		validateResult(result({}, { A: attempts })).join("\n");

	test("no attempt after two exempt voids", () => {
		expect(
			problems([
				attempt("A", "void"),
				attempt("A", "void"),
				behavioral("A", "pass"),
			]),
		).toMatch(/after the trial was void/);
	});

	test("no launch after two behavioural attempts", () => {
		expect(
			problems([
				behavioral("A", "fail"),
				behavioral("A", "fail", 2),
				attempt("A", "void"),
			]),
		).toMatch(/after the trial was fail/);
	});

	test("no rerun while an attempt is unscored", () => {
		expect(
			problems([attempt("A", "unscored", 1), behavioral("A", "pass")]),
		).toMatch(/unscored/);
	});

	test("the six trials and thirteen Musts come from fixed constants, not the result's policy", () => {
		const narrowed = result();
		narrowed.evaluation.policy = { trials: ["A"], model: "claude-opus-5-5" };
		narrowed.evaluation.policySha256 = policyHash(narrowed.evaluation.policy);
		narrowed.evaluation.trials = narrowed.evaluation.trials.filter(
			(t) => t.trial === "A",
		);
		narrowed.cost = totalCost(narrowed);
		expect(validateResult(narrowed).join("\n")).toMatch(/missing trial D/);
	});

	test("the policy hash matches the recorded policy", () => {
		const forged = result();
		forged.evaluation.policySha256 = `sha256:${"0".repeat(64)}`;
		expect(validateResult(forged).join("\n")).toMatch(/policySha256/);
	});

	test("requested Musts carry a scorer verdict", () => {
		const checker = result();
		const must = checker.evaluation.trials[1]?.attempts[0]?.musts.find(
			(m) => m.class === "judged",
		);
		if (must) {
			must.scorer = null;
			must.checkerVersion = "must-check/1";
		}
		expect(validateResult(checker).join("\n")).toMatch(/requested.*scorer/);
		const failed = result();
		const a = failed.evaluation.trials[1]?.attempts[0];
		if (a?.scoring) {
			a.scoring.invocations = [
				invocation({ failure: "nonzero exit 1", exitStatus: 1 }),
				invocation({ retryReason: "nonzero exit 1" }),
			];
			a.cost.scorer = a.scoring.invocations.map((i) => i.cost);
			for (const m of a.musts) if (m.scorer) m.scorer.invocation = 0;
		}
		failed.cost = totalCost(failed);
		expect(validateResult(failed).join("\n")).toMatch(/verdict/);
	});
});

describe("pending attempts (fix round 1b)", () => {
	const pending = (): Attempt => ({
		...attempt("A", "void"),
		kind: "pending",
		voidReasons: [],
		launch: {
			scratchRoot: "/tmp/run",
			scratchDir: "/tmp/run/artifacts/A/attempt-1",
		},
	});

	test("a pending attempt keeps the trial pending and must be the last attempt", () => {
		expect(deriveTrial([pending()])).toBe("pending");
		expect(validateResult(result({}, { A: [pending()] }))).toEqual([]);
		const after = result({}, { A: [pending(), behavioral("A", "pass")] });
		expect(validateResult(after).join("\n")).toMatch(/pending/);
		const bare = result({}, { A: [{ ...pending(), launch: undefined }] });
		expect(validateResult(bare).join("\n")).toMatch(/launch/);
	});
});

describe("scorer invocations (4.5, R1)", () => {
	test("one infrastructure retry per round is allowed and recorded", () => {
		const ok = result();
		const a = ok.evaluation.trials[0]?.attempts[0];
		if (a?.scoring) {
			a.scoring.invocations = [
				invocation({ failure: "timeout after 300 s", exitStatus: null }),
				invocation({ retryReason: "timeout after 300 s" }),
			];
			a.cost.scorer = a.scoring.invocations.map((i) => i.cost);
			for (const m of a.musts) if (m.scorer) m.scorer.invocation = 1;
		}
		ok.cost = totalCost(ok);
		expect(validateResult(ok)).toEqual([]);
	});

	test("refuses a retry after a verdict, a retry without its reason and a third invocation", () => {
		const verdict = result();
		const a = verdict.evaluation.trials[0]?.attempts[0];
		if (a?.scoring)
			a.scoring.invocations = [
				invocation(),
				invocation({ retryReason: "wanted a pass" }),
			];
		expect(validateResult(verdict).join("\n")).toMatch(/verdict/);
		const reasonless = result();
		const b = reasonless.evaluation.trials[0]?.attempts[0];
		if (b?.scoring)
			b.scoring.invocations = [
				invocation({ failure: "nonzero exit 1", exitStatus: 1 }),
				invocation({ retryReason: null }),
			];
		expect(validateResult(reasonless).join("\n")).toMatch(/retry/);
		const third = result();
		const c = third.evaluation.trials[0]?.attempts[0];
		if (c?.scoring)
			c.scoring.invocations = [
				invocation({ failure: "nonzero exit 1", exitStatus: 1 }),
				invocation({
					retryReason: "nonzero exit 1",
					failure: "unparsable JSON",
				}),
				invocation({ retryReason: "unparsable JSON" }),
			];
		expect(validateResult(third).join("\n")).toMatch(/round/);
	});

	test("an unscored attempt's rounds all ended in infrastructure failure", () => {
		const r = result({}, { A: [attempt("A", "unscored", 1)] });
		expect(validateResult(r)).toEqual([]);
		const bad = result({}, { A: [attempt("A", "unscored", 1)] });
		const a = bad.evaluation.trials.find((t) => t.trial === "A")?.attempts[0];
		if (a?.scoring) a.scoring.invocations = [invocation()];
		expect(validateResult(bad).join("\n")).toMatch(/unscored/);
	});
});

describe("history (6.4)", () => {
	test("earlier evaluations are validated too", () => {
		const r: Result = result();
		const earlier = structuredClone(r.evaluation);
		earlier.hash = `sha256:${"1".repeat(64)}`;
		r.history.push(earlier);
		r.cost = totalCost(r);
		expect(validateResult(r)).toEqual([]);
		const broken = structuredClone(r);
		broken.history[0]?.trials.pop();
		expect(validateResult(broken).join("\n")).toMatch(/history/);
	});

	test("trialsOf lists the gate's six trials", () => {
		expect(trialsOf(result()).sort()).toEqual(
			["A", "D", "E", "E-neg", "G", "G-neg"].sort(),
		);
	});
});
