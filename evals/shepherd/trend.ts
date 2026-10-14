/**
 * `bun run evals:shepherd --trend`: where the suite stands across runs. It
 * reads the result files committed at `HEAD` and prints one row per
 * evaluation, each result's current one and every one in its history: the
 * revision its last invocation built, the day it started (UTC), its
 * outcome, its cost and each Must's outcome per attempt. Rows are in commit
 * order, the order of `git rev-list --date-order --reverse HEAD` (parents
 * before children, branches interleaved by commit time, so a merged branch
 * sits where its commits happened), then by start time; a revision not in
 * `HEAD`'s history comes after the rest, by start time. Only the fields shown are read, so a result an earlier schema
 * wrote still shows; a file that cannot be read is named below the table.
 * Nothing is verified (`verify.ts` does that), written or run.
 */

import { z } from "zod";
import { type GitRunner, runGit } from "../../scripts/shepherd-source";
import { EVALUATION_DIR } from "./identity";
import { MUST_IDS } from "./schema";
import { RESULT_FILE } from "./verify";

const cost = z.object({ usd: z.number().nonnegative().nullable() });
const evaluation = z.object({
	outcome: z.enum(["pass", "flaky-pass", "blocked"]),
	invocations: z
		.array(
			z.object({
				build: z.object({
					revision: z.string().regex(/^[0-9a-f]{40}$/),
					sourceDirty: z.boolean(),
				}),
			}),
		)
		.min(1),
	trials: z.array(
		z.object({
			attempts: z.array(
				z.object({
					musts: z.array(
						z.object({
							id: z.string().regex(/^[A-Za-z0-9.-]+$/),
							outcome: z.enum(["pass", "fail", "inconclusive"]),
						}),
					),
					cost: z.object({ subject: cost, scorer: z.array(cost) }),
				}),
			),
		}),
	),
	startedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T/),
});
const record = z.object({ evaluation, history: z.array(evaluation) });
type Evaluation = z.infer<typeof evaluation>;

const LETTER = { pass: "p", fail: "F", inconclusive: "?" } as const;

interface Row {
	evaluation: Evaluation;
	revision: string;
	earlier: boolean;
	/** Index in commit order; undefined when not in `HEAD`'s history. */
	position?: number;
}

function cells(row: Row, musts: string[]): string[] {
	const { evaluation: e } = row;
	const attempts = e.trials.flatMap((t) => t.attempts);
	const costs = attempts.flatMap((a) => [a.cost.subject, ...a.cost.scorer]);
	const known = costs.reduce((sum, c) => sum + (c.usd ?? 0), 0);
	const unknown = costs.filter((c) => c.usd === null).length;
	const notes = [
		row.earlier && "earlier evaluation identity",
		row.position === undefined && "not in HEAD's history",
		e.invocations.at(-1)?.build.sourceDirty && "dirty source",
	].filter(Boolean);
	return [
		row.revision.slice(0, 12),
		e.startedAt.slice(0, 10),
		e.outcome,
		`$${known.toFixed(2)}${unknown > 0 ? `+${unknown}?` : ""}`,
		...musts.map(
			(id) =>
				attempts
					.flatMap((a) => a.musts.filter((m) => m.id === id))
					.map((m) => LETTER[m.outcome])
					.join("") || "-",
		),
		notes.join(", "),
	];
}

/** The trend at `HEAD` of the repository at `root`; throws when Git fails. */
export function trendLines(
	root: string,
	options: { git?: GitRunner } = {},
): string[] {
	const git = options.git ?? runGit;
	const run = (...args: string[]) => {
		const out = git(args, root);
		if (out.code !== 0)
			throw new Error(`git ${args[0]} failed: ${out.stderr.trim()}`);
		return new TextDecoder().decode(out.stdout);
	};
	const files = run(
		"ls-tree",
		"-z",
		"--name-only",
		"HEAD",
		"--",
		`${EVALUATION_DIR}/results/`,
	)
		.split("\0")
		.filter((path) => RESULT_FILE.test(path));
	if (files.length === 0) return ["No result is committed at HEAD."];
	const history = run("rev-list", "--date-order", "--reverse", "HEAD")
		.split("\n")
		.filter(Boolean);
	const order = new Map(history.map((revision, index) => [revision, index]));
	const rows: Row[] = [];
	const unreadable: string[] = [];
	for (const path of files) {
		let parsed: ReturnType<typeof record.safeParse> | undefined;
		try {
			parsed = record.safeParse(JSON.parse(run("show", `HEAD:${path}`)));
		} catch {}
		if (!parsed?.success) {
			unreadable.push(path);
			continue;
		}
		const { evaluation: current, history: earlier } = parsed.data;
		for (const e of [current, ...earlier]) {
			const revision = e.invocations.at(-1)?.build.revision ?? "";
			rows.push({
				evaluation: e,
				revision,
				earlier: e !== current,
				position: order.get(revision),
			});
		}
	}
	rows.sort(
		(a, b) =>
			(a.position ?? history.length) - (b.position ?? history.length) ||
			a.evaluation.startedAt.localeCompare(b.evaluation.startedAt),
	);
	const seen = new Set(
		rows.flatMap((r) =>
			r.evaluation.trials.flatMap((t) =>
				t.attempts.flatMap((a) => a.musts.map((m) => m.id)),
			),
		),
	);
	const known: readonly string[] = MUST_IDS;
	const musts = [
		...known.filter((id) => seen.has(id)),
		...[...seen].filter((id) => !known.includes(id)).sort(),
	];
	const table = [
		["revision", "date", "outcome", "cost", ...musts, "note"],
		...rows.map((row) => cells(row, musts)),
	];
	const widths = table[0]?.map((_, i) =>
		Math.max(...table.map((line) => line[i]?.length ?? 0)),
	);
	return [
		`Shepherd evals trend at ${history.at(-1)?.slice(0, 12)}: ${rows.length} evaluations in ${files.length} result files, oldest revision first.`,
		...table.map((line) =>
			line
				.map((cell, i) => cell.padEnd(widths?.[i] ?? 0))
				.join("  ")
				.trimEnd(),
		),
		"Must cells: one letter per attempt that scored the Must, in order: p pass, F fail, ? inconclusive, - none. Cost: known USD, then +<n>? for components of unknown cost.",
		...unreadable.map((path) => `Unreadable, not shown: ${path}`),
	];
}
