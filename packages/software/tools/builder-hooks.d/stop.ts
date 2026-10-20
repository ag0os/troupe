// The bounded Stop gate. At most three blocks between passes, counted in
// stop-<session_id> beside the log and persisted before each block. A pass
// prints nothing and removes the counter; after three blocks a continuing
// failure ends the session with GIVE-UP. If the counter or the log cannot be
// written, the gate cannot bound itself, so it does not block.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Check, type Evaluation, evaluate } from "./evaluate";
import { logLine } from "./log";
import type { Manifest } from "./manifest";

export const BLOCKS = 3;
const MARKER = "Reserved decision stop:";
const LAST =
	"This is the last attempt: if it still fails, end with a report that says 'still failing after 3 attempts' and what remains.";

export type StopEvent = {
	session: string;
	active: boolean;
	message: unknown;
};

export type Outcome = { code: number; stdout: string; stderr: string };

/** Whether the final message opens with the marker and names a decision. */
export function reservedStop(message: unknown): boolean {
	if (typeof message !== "string") return false;
	const text = message.trimStart();
	return text.startsWith(MARKER) && text.slice(MARKER.length).trim() !== "";
}

function scopeText(e: Evaluation): string {
	const parts = [
		`Scope: ${e.scope.length} changed paths${e.excluded.length ? ` (excluded: ${e.excluded.join(", ")})` : ""}.`,
	];
	if (e.systemTests.length)
		parts.push(
			`Not run here: ${e.systemTests.join(", ")}; the host runs them at step 6.`,
		);
	return parts.join(" ");
}

function failureText(c: Check, n: number): string {
	const lines = c.lines.length ? c.lines.join("\n") : c.why;
	return c.status === "fail"
		? `Stop gate: ${c.check} fails on the changed scope (attempt ${n} of ${BLOCKS}). ${lines}. Fix it before finishing; if it cannot be fixed inside this build's scope, say so and stop.`
		: `Stop gate: ${c.check} could not run on the changed scope (attempt ${n} of ${BLOCKS}): ${c.why}${c.lines.length ? `\n${c.lines.join("\n")}` : ""}. Fix it before finishing; if it cannot be fixed inside this build's scope, say so and stop.`;
}

function readCount(path: string): number {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return 0;
	}
	// A malformed counter reads as zero and is overwritten on the next block.
	return /^\d+\n?$/.test(text)
		? Math.min(Number.parseInt(text, 10), BLOCKS)
		: 0;
}

export async function stop(
	m: Manifest,
	runDir: string,
	event: StopEvent,
	started: number,
	budgetMs: number,
): Promise<Outcome> {
	const counter = join(runDir, `stop-${event.session}`);
	const ms = () => performance.now() - started;
	const tag = `session=${event.session} active=${event.active}`;
	const nonblocking = (why: string): Outcome => {
		try {
			logLine(
				m.log,
				"stop",
				"gate",
				"-",
				ms(),
				"COULD-NOT-RUN",
				`${why} ${tag}`,
			);
		} catch {
			// The diagnostic below still reaches the host.
		}
		return {
			code: 0,
			stdout: "",
			stderr: `Stop gate could not keep its bound: ${why}. Not blocking; the host will re-check.\n`,
		};
	};
	const pass = (reason: string, e: Evaluation | null): Outcome => {
		try {
			rmSync(counter, { force: true });
		} catch (error) {
			return nonblocking(
				`the counter cannot be removed (${(error as Error).message})`,
			);
		}
		const gaps = e?.systemTests.length
			? ` not run here: ${e.systemTests.join(", ")}`
			: "";
		try {
			logLine(
				m.log,
				"stop",
				"gate",
				`${e?.scope.length ?? 0} paths`,
				ms(),
				"PASS",
				`${reason} ${tag}${gaps}`,
			);
		} catch (error) {
			return nonblocking(
				`the log cannot be written (${(error as Error).message})`,
			);
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	let e: Evaluation;
	let caught = false;
	const reserved = reservedStop(event.message);
	const deadline = Date.now() + budgetMs;
	try {
		// A reserved stop still needs the scope: an empty one needs no
		// exemption.
		e = await evaluate(m, {
			deadline,
			budget: "120 s",
			all: false,
			exhale: false,
			scopeOnly: reserved,
		});
	} catch (error) {
		caught = true;
		e = {
			scope: [],
			excluded: [],
			systemTests: [],
			checks: [],
			failure: {
				check: "scope",
				status: "could-not-run",
				files: [],
				lines: [],
				why: (error as Error).message,
			},
		};
	}
	// No PASS after the budget, whatever the scope.
	const late = Date.now() >= deadline;
	if (late && !e.failure)
		e.failure = {
			check: "scope",
			status: "could-not-run",
			files: [],
			lines: [],
			why: "the evaluation budget was spent before the gate could pass",
		};
	if (!caught && !late && !e.scope.length) return pass("empty-scope", e);
	if (!caught && !late && reserved) return pass("reserved-stop", e);
	try {
		for (const c of e.checks.filter((c) => c.status === "skipped"))
			logLine(
				m.log,
				"stop",
				c.check,
				c.files.join(",") || "scope",
				ms(),
				"COULD-NOT-RUN",
				`${c.why} ${tag}`,
			);
	} catch (error) {
		return nonblocking(
			`the log cannot be written (${(error as Error).message})`,
		);
	}
	if (!e.failure) return pass("checks-pass", e);

	const prior = readCount(counter);
	const c = e.failure;
	if (prior >= BLOCKS) {
		const summary = `${c.check} ${c.status === "fail" ? "fails" : "could not run"}: ${c.why}`;
		try {
			logLine(
				m.log,
				"stop",
				c.check,
				`${e.scope.length} paths`,
				ms(),
				"GIVE-UP",
				`${summary} ${tag}`,
			);
		} catch (error) {
			return nonblocking(
				`the log cannot be written (${(error as Error).message})`,
			);
		}
		return {
			code: 0,
			stdout: "",
			stderr: `Stop gate: still failing after ${BLOCKS} attempts: ${summary}. Ending the session; the host will re-check.\n`,
		};
	}
	const n = prior + 1;
	try {
		writeFileSync(counter, `${n}\n`, { mode: 0o600 });
	} catch (error) {
		return nonblocking(
			`the counter cannot be written (${(error as Error).message})`,
		);
	}
	try {
		logLine(
			m.log,
			"stop",
			c.check,
			`${e.scope.length} paths`,
			ms(),
			c.status === "fail" ? "BLOCK" : "COULD-NOT-RUN",
			`${c.why} ${tag} attempt=${n}`,
		);
	} catch (error) {
		return nonblocking(
			`the log cannot be written (${(error as Error).message})`,
		);
	}
	const text = [
		failureText(c, n),
		scopeText(e),
		...(n === BLOCKS ? [LAST] : []),
	].join("\n");
	return { code: 2, stdout: "", stderr: `${text}\n` };
}
