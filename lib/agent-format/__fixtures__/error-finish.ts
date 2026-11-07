/**
 * A framework-local finish hook for runner tests: a print agent whose stdout
 * contract is the payload or a single `ERROR: <reason>` line. It stands in for
 * a real tool agent so framework tests load without any agent tree.
 */
import type { FinishResult, RunResult } from "../types";

const ERROR_PREFIX = "ERROR: ";

function startsWithError(stdout: string | undefined): boolean {
	return stdout?.trimStart().startsWith(ERROR_PREFIX) === true;
}

function firstNonEmptyLine(value: string | undefined): string | undefined {
	return value
		?.split(/\r?\n/u)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}

function errorLine(reason: string): string {
	const line = firstNonEmptyLine(reason)
		?.replace(/^ERROR:\s*/u, "")
		.trim();
	return `${ERROR_PREFIX}${line && line.length > 0 ? line : "run failed"}\n`;
}

/** Keep a clean payload; turn any failure into one stdout ERROR: line. */
export function errorLineFinish(result: RunResult): FinishResult {
	if (result.exitCode === 0) {
		if (startsWithError(result.stdout)) {
			return { stdout: result.stdout, exitCode: 1 };
		}
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	}
	if (startsWithError(result.stdout)) {
		return { stdout: result.stdout, exitCode: result.exitCode || 1 };
	}
	const reason =
		firstNonEmptyLine(result.stderr) ??
		firstNonEmptyLine(result.stdout) ??
		`run failed with exit code ${result.exitCode}`;
	return { stdout: errorLine(reason), exitCode: result.exitCode || 1 };
}
