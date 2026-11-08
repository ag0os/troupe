// The run log: one line per outcome,
// HH:MM:SS <hook> <tool or check> <file or scope> <n>ms <STATUS> <reason>.
// Fields before the reason are percent-encoded where they hold whitespace,
// `%` or control characters; the reason keeps its spaces and has only control
// characters and `%` encoded. Each line is one append, so concurrent hooks
// never interleave within a line. A failed write throws: callers report it.
import { appendFileSync } from "node:fs";

export type Status =
	| "ALLOW"
	| "DENY"
	| "FINDING"
	| "CLEAN"
	| "BLOCK"
	| "GIVE-UP"
	| "PASS"
	| "COULD-NOT-RUN";

/** A field as the log writes it; `spaces` encodes whitespace too. */
export function encode(text: string, spaces: boolean): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) as number;
		const control =
			code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0);
		if (control || ch === "%" || (spaces && /\s/u.test(ch)))
			out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
		else out += ch;
	}
	return out === "" ? "-" : out;
}

function clock(now: Date): string {
	return [now.getHours(), now.getMinutes(), now.getSeconds()]
		.map((n) => String(n).padStart(2, "0"))
		.join(":");
}

export function logLine(
	path: string,
	hook: string,
	tool: string,
	scope: string,
	ms: number,
	status: Status,
	reason: string,
): void {
	const line = [
		clock(new Date()),
		encode(hook, true),
		encode(tool, true),
		encode(scope, true),
		`${Math.max(0, Math.round(ms))}ms`,
		status,
		encode(reason, false),
	].join(" ");
	appendFileSync(path, `${line}\n`, { mode: 0o600 });
}
