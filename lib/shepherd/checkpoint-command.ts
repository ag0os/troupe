import {
	checkpointBoundary,
	classifyChanges,
	fallbackSections,
	readCheckpoint,
} from "./checkpoint";
import {
	captureState,
	checkpointToken,
	commitCheckpoint,
	type HeldState,
	nextCheckpoint,
} from "./checkpoint-write";
import { localTimestamp } from "./dates";
import { appendEntries } from "./journal";
import {
	LockError,
	type LockOptions,
	LockReleaseError,
	lockStatus,
	withStateLock,
} from "./lock";
import type { ToolEnv } from "./sessions";
import { type ChainEntry, journalChain, words } from "./text";
import type { Workspace } from "./tree";

export type CheckpointOptions = {
	apply: boolean;
	token?: string;
	session?: string;
	acceptDropped?: string;
	json: boolean;
};
export type CheckpointHooks = {
	afterLock?: () => void | Promise<void>;
	afterValidate?: () => void | Promise<void>;
	afterAppend?: (index: number) => void | Promise<void>;
	lock?: LockOptions;
	commit?: { afterSnapshot?: () => void; afterRename?: () => void };
};
type Result = { code: 0 | 1 | 2; text: string; stream: "stdout" | "stderr" };

function failure(text: string): Result {
	return { code: 1, text, stream: "stderr" };
}
function appendRefusal(
	count: number,
	error?: unknown,
	appendPending = false,
): Result {
	const detail =
		error === undefined
			? ""
			: `\n${error instanceof Error ? error.message : String(error)}`;
	return failure(
		`journal changed during the apply; ${appendPending ? `${count} accepted lines appended; the append of line ${count + 1} failed and may or may not be in the journal: read it. The accepted lines already appended stay.` : `your ${count} accepted lines are appended and stay.`} Run the dry run again. Re-running --accept-dropped would journal them again. Restore or move the line instead, or accept it again knowing it will be journaled twice.${detail}`,
	);
}
function displayTime(written: string): string {
	return written.slice(0, 16).replace("T", " ");
}
function location(entry: ChainEntry): string {
	return entry.file === "journal.md"
		? String(entry.line)
		: `${entry.file}:${entry.line}`;
}
function boundary(entry?: ChainEntry): string {
	return entry ? `${location(entry)} ${JSON.stringify(entry.text)}` : "none";
}
function droppedText(held: HeldState): string[] {
	const lines = [
		`dropped from CURRENT, found elsewhere (exact text, live file): ${held.dropped?.accounted.length ?? 0}`,
		`dropped from CURRENT, NOT accounted for: ${held.dropped?.unaccounted.length ?? 0}`,
	];
	for (const line of held.dropped?.unaccounted ?? []) {
		lines.push(
			`  - ${line.text}${line.carriedFrom ? ` (copy was in ${line.carriedFrom})` : ""}`,
		);
		lines.push(
			line.nearest
				? `    nearest: ${line.nearest.path}:${line.nearest.line} (${line.nearest.percent} percent of words; not a match)`
				: "    nearest: none",
		);
	}
	return lines;
}
function unsafeReason(held: HeldState): string | undefined {
	if (held.reason === "checkpoint.json is a symlink") return held.reason;
	const unreadable = held.unreadable[0];
	if (unreadable)
		return `journal unreadable: ${unreadable.file}: ${unreadable.reason}`;
	const unsafe = held.unsafe[0];
	if (unsafe) return `unsafe file: ${unsafe.path}: ${unsafe.reason}`;
	return undefined;
}
function refusedRange(held: HeldState): {
	entries: ChainEntry[];
	uncertified: number;
	fromReset: boolean;
} {
	const from = held.chain.findIndex(
		(entry) => entry.id === held.checkpoint?.journal.from,
	);
	const position =
		held.status === "ok" && held.checkpoint
			? checkpointBoundary(held.chain, held.checkpoint.journal).position
			: null;
	const found = position !== null;
	const first = fallbackSections("", held.chain, [])[0]?.entries[0];
	const start =
		position !== null ? position : first ? held.chain.indexOf(first) : 0;
	return {
		entries: held.chain.slice(start),
		uncertified: found ? Math.max(0, from) : start,
		fromReset: !found,
	};
}
function dryRun(workspace: Workspace, toolEnv: ToolEnv, json: boolean): Result {
	const held = captureState(workspace, toolEnv);
	const before = held.status === "ok" ? (held.checkpoint?.files ?? {}) : {};
	const after = Object.fromEntries(
		Object.entries(held.files).map(([path, file]) => [path, file.hash]),
	);
	const changed = classifyChanges(before, after).map((change) => {
		const bytes = held.files[change.path]?.bytes;
		const text =
			bytes == null ? undefined : Buffer.from(bytes).toString("utf8");
		return {
			path: change.path,
			kind: change.kind,
			words: text === undefined ? 0 : words(text),
			...(text === undefined ? {} : { text }),
		};
	});
	const status = lockStatus(workspace.state, toolEnv);
	const lock =
		status.status === "free"
			? "free"
			: status.status === "alive"
				? `held by live pid ${status.pid}`
				: `stale, left by pid ${status.pid ?? "unknown"}`;
	const refused = !held.range.ok ? held.range.message : unsafeReason(held);
	const selected = held.range.ok ? held.range : refusedRange(held);
	const range = selected.entries;
	const apply = `shepherd tool checkpoint --apply --token ${held.token} --session <your session name>${held.dropped?.unaccounted.length ? ' --accept-dropped "<why each line may go>"' : ""}`;
	const facts = {
		revision: held.revision,
		nextRevision: held.revision + 1,
		status: held.status,
		...(held.reason ? { reason: held.reason } : {}),
		...(held.checkpoint ? { checkpoint: held.checkpoint } : {}),
		range,
		boundary: range.at(-1) ?? held.chain.at(-1) ?? null,
		uncertified: selected.uncertified,
		changed,
		dropped: held.dropped ?? { candidates: [], accounted: [], unaccounted: [] },
		lock,
		...(refused ? { refused } : { token: held.token, apply }),
	};
	if (json)
		return {
			code: refused ? 1 : 0,
			text: JSON.stringify(facts),
			stream: "stdout",
		};
	const checkpoint =
		held.status === "invalid"
			? `invalid checkpoint: ${held.reason}`
			: held.checkpoint
				? `revision ${held.revision} by ${held.checkpoint.session ?? "unknown"}, ${displayTime(held.checkpoint.written)}`
				: "no checkpoint";
	const first = range[0];
	const last = range.at(-1);
	const span =
		first && last
			? `, ${first.file}:${first.line} to ${first.file === last.file ? last.line : `${last.file}:${last.line}`} (all shown below)`
			: "";
	const lines = [
		`checkpoint: ${checkpoint} -> would write revision ${held.revision + 1}`,
		`journal: ${range.length} entries ${!selected.fromReset ? "since the boundary" : "in the fallback range"}${span}`,
		...range.map((entry) => `  - ${location(entry)} ${entry.text}`),
		`new boundary: ${boundary(last ?? held.chain.at(-1))}`,
		`uncertified history before the range: ${facts.uncertified} entries`,
		`changed: ${changed.map((file) => `${file.path} (${file.kind}, ${file.words} words)`).join("; ") || "none"}`,
	];
	for (const file of changed)
		if (file.text !== undefined)
			lines.push(`--- ${file.path} ---`, file.text.replace(/\n$/, ""));
	lines.push(...droppedText(held), `lock: ${lock}`);
	if (refused) lines.push(refused);
	else
		lines.push(
			`token: ${held.token}`,
			`Read every entry and changed file above, then: ${apply}`,
		);
	return { code: refused ? 1 : 0, text: lines.join("\n"), stream: "stdout" };
}

/** Show the full certification state or commit exactly the validated held bytes. */
export async function runCheckpoint(
	workspace: Workspace,
	toolEnv: ToolEnv,
	options: CheckpointOptions,
	hooks: CheckpointHooks = {},
): Promise<Result> {
	if (
		options.apply !== (options.token !== undefined) ||
		(options.apply && !/^r\d+-[a-f0-9]{12}$/.test(options.token ?? ""))
	)
		return {
			code: 2,
			text: "usage: shepherd tool checkpoint [--apply --token <token>] [--session <session>] [--accept-dropped <reason>] [--json]",
			stream: "stderr",
		};
	if (!options.apply) return dryRun(workspace, toolEnv, options.json);
	for (const [flag, value] of [
		["session", options.session],
		["accept-dropped", options.acceptDropped],
	]) {
		if (value === undefined) continue;
		const trimmed = value.trim();
		if (
			!trimmed ||
			trimmed === "YOUR_SESSION_NAME" ||
			trimmed === "REASON" ||
			(trimmed.startsWith("<") && trimmed.endsWith(">"))
		)
			return failure(`replace the placeholder in --${flag} with a real value`);
	}

	try {
		return await withStateLock(
			workspace.state,
			toolEnv,
			async (): Promise<Result> => {
				await hooks.afterLock?.();
				const read = readCheckpoint(workspace.state);
				if (
					read.status === "invalid" &&
					read.reason === "checkpoint.json is a symlink"
				)
					return failure(read.reason);
				if (
					read.status === "invalid" &&
					Number(options.token?.match(/^r(\d+)-/)?.[1]) !== 0
				)
					return failure(
						`checkpoint is now invalid: ${read.reason}; run the dry run again`,
					);
				const revision = read.status === "ok" ? read.checkpoint.revision : 0;
				if (revision !== Number(options.token?.match(/^r(\d+)-/)?.[1]))
					return failure(
						`checkpoint advanced to revision ${revision} by ${read.status === "ok" ? (read.checkpoint.session ?? "unknown") : "unknown"} at ${read.status === "ok" ? displayTime(read.checkpoint.written) : "unknown"}; run \`shepherd tool start\` again`,
					);
				const held = captureState(workspace, toolEnv);
				if (held.files["CURRENT.md"]?.bytes == null)
					return failure("nothing to certify without CURRENT.md");
				if (checkpointToken(held) !== options.token)
					return failure(
						"state changed since the dry run; run the dry run again",
					);
				await hooks.afterValidate?.();
				if (!held.range.ok) return failure(held.range.message);
				const unsafe = unsafeReason(held);
				if (unsafe) return failure(unsafe);
				const unaccounted = held.dropped?.unaccounted ?? [];
				if (unaccounted.length && options.acceptDropped === undefined)
					return failure(droppedText(held).join("\n"));
				let appended: ChainEntry[] = [];
				if (unaccounted.length) {
					const expected: string[] = [];
					let appendPending = false;
					try {
						for (const [index, line] of unaccounted.entries()) {
							appendPending = true;
							const [entry] = await appendEntries(
								workspace.state,
								[
									`dropped from CURRENT (${options.acceptDropped}): ${line.text}`,
								],
								toolEnv,
								{ locked: true },
							);
							if (!entry) throw new Error("accepted line not appended");
							expected.push(entry.text);
							appendPending = false;
							await hooks.afterAppend?.(index);
						}
					} catch (error) {
						return appendRefusal(expected.length, error, appendPending);
					}
					const chain = journalChain(workspace.state);
					appended = chain.entries.slice(held.chain.length);
					if (
						chain.unreadable.length ||
						chain.entries.length !== held.chain.length + expected.length ||
						held.chain.some(
							(entry, index) => chain.entries[index]?.id !== entry.id,
						) ||
						appended.some((entry, index) => entry.text !== expected[index])
					)
						return appendRefusal(unaccounted.length);
				}
				const next = nextCheckpoint(held, {
					written: localTimestamp(toolEnv.clock()),
					session: options.session,
					appended,
				});
				commitCheckpoint(workspace.state, held, next, hooks.commit);
				return {
					code: 0,
					text: options.json
						? JSON.stringify({ ...next, applied: true })
						: `checkpoint: wrote revision ${next.revision}\nnew boundary: ${boundary(appended.at(-1) ?? held.chain.at(-1))}`,
					stream: "stdout",
				};
			},
			hooks.lock,
		);
	} catch (error) {
		if (error instanceof LockReleaseError) {
			const result = error.result as Result;
			return failure(
				options.json && result.code === 0
					? JSON.stringify({ ...JSON.parse(result.text), error: error.message })
					: `${result.text}\n${error.message}`,
			);
		}
		if (error instanceof LockError) return failure(error.message);
		throw error;
	}
}
