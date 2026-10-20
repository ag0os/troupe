// Post-edit health: one checker on the edited file, two seconds, silent when
// clean or when the stack has no command, context when it has a finding or
// could not run. A stack whose metrics have no committed todo floor is not
// adopted: it runs nothing and logs COULD-NOT-RUN, so absent health is never
// recorded as clean.
import { existsSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative } from "node:path";
import { git } from "../contract.d/repo";
import { logLine } from "./log";
import type { Manifest, Stack } from "./manifest";
import { argPath, resolveOs } from "./paths";
import { runBounded } from "./run";

export type Checked =
	| { kind: "clean" }
	| { kind: "findings"; lines: string[] }
	| { kind: "could-not-run"; why: string }
	| { kind: "timeout" };

export function stackFor(m: Manifest, rel: string): Stack | undefined {
	const ext = extname(rel);
	return m.health.stacks.find((s) => s.extensions.includes(ext));
}

/** Whether the stack's floor is committed at the base and present now. */
export function adopted(m: Manifest, stack: Stack): boolean {
	if (stack.floor === null) return false;
	if (!existsSync(join(m.repo, stack.floor))) return false;
	return git(m.repo, ["cat-file", "-e", `${m.base}:${stack.floor}`]).ok;
}

type Offense = {
	cop_name?: unknown;
	message?: unknown;
	location?: { start_line?: unknown; line?: unknown };
};

function parseRubocop(output: string, rel: string): Checked {
	let data: { files?: { offenses?: Offense[] }[] };
	try {
		data = JSON.parse(output);
	} catch {
		return { kind: "could-not-run", why: "its output is not rubocop JSON" };
	}
	if (!Array.isArray(data?.files))
		return { kind: "could-not-run", why: "its output is not rubocop JSON" };
	const lines: string[] = [];
	for (const file of data.files)
		for (const o of file.offenses ?? []) {
			const values = /\[(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\]/.exec(
				String(o.message ?? ""),
			);
			const line = o.location?.start_line ?? o.location?.line;
			if (typeof o.cop_name !== "string" || !values || typeof line !== "number")
				return {
					kind: "could-not-run",
					why: "a finding without a cop, a value or a line",
				};
			lines.push(
				`Health check on ${rel}: ${o.cop_name} ${values[1]} over the floor ${values[2]} at ${line}. Keep complexity at or below the base: split the logic into small helpers.`,
			);
		}
	return lines.length ? { kind: "findings", lines } : { kind: "clean" };
}

/** Run one stack's checker on one repository-relative file. */
export async function checkFile(
	m: Manifest,
	stack: Stack,
	rel: string,
	deadline: number,
): Promise<Checked> {
	const argv = stack.argv.map((a) => (a === "{file}" ? argPath(rel) : a));
	const ran = await runBounded(argv, m.repo, deadline);
	if (ran.kind === "timeout") return { kind: "timeout" };
	if (ran.kind !== "exited") return { kind: "could-not-run", why: ran.why };
	if (ran.code !== 0 && ran.code !== 1)
		return { kind: "could-not-run", why: `it exited ${ran.code}` };
	return parseRubocop(ran.output, rel);
}

/** The edited file relative to the repository, lexically or through symlinks. */
export function repoRelative(m: Manifest, file: string): string | null {
	const given = isAbsolute(file) ? file : `${m.repo}/${file}`;
	for (const abs of [normalize(given), resolveOs(given)]) {
		const rel = relative(m.repo, abs);
		if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	}
	return null;
}

/** The health hook: returns the additionalContext to emit, or null. */
export async function health(
	m: Manifest,
	file: string,
	session: string,
	started: number,
	deadline: number,
): Promise<string | null> {
	const ms = () => performance.now() - started;
	const log = (
		tool: string,
		status: "CLEAN" | "FINDING" | "COULD-NOT-RUN",
		reason: string,
	) =>
		logLine(
			m.log,
			"health",
			tool,
			file,
			ms(),
			status,
			`${reason} session=${session}`,
		);
	const rel = repoRelative(m, file);
	const stack = rel === null ? undefined : stackFor(m, rel);
	if (rel === null || !stack) {
		log("-", "CLEAN", rel === null ? "outside-repo" : "no-stack-command");
		return null;
	}
	const tool = stack.argv[0] as string;
	if (!adopted(m, stack)) {
		log(tool, "COULD-NOT-RUN", "metrics not adopted: no committed todo floor");
		return null;
	}
	const result = await checkFile(m, stack, rel, deadline);
	if (result.kind === "clean") {
		log(tool, "CLEAN", "no findings");
		return null;
	}
	if (result.kind === "findings") {
		log(tool, "FINDING", `${result.lines.length} findings`);
		return result.lines.join("\n");
	}
	const text =
		result.kind === "timeout"
			? `health check did not finish on ${rel} within 2 s`
			: `health check could not run on ${rel}: ${result.why}`;
	log(tool, "COULD-NOT-RUN", text);
	return text;
}
