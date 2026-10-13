import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	contentHash,
	type DroppedResult,
	droppedLines,
	readBaseline,
	readDroppedSources,
} from "./current-prev";
import { lockStatus } from "./lock";
import type { ToolEnv } from "./sessions";
import { recordFreshness } from "./status";
import { type ChainEntry, journalChain } from "./text";
import type { Workspace } from "./tree";
import { findEnclosingWorkspace, STATE_DIR } from "./workspace";

export const FIXED_PATHS = [
	"CURRENT.md",
	"MEMORY.md",
	"docs/INDEX.md",
	"pending.md",
	"charter.md",
] as const;
export type Checkpoint = {
	schema: 1;
	revision: number;
	written: string;
	session?: string;
	snapshot: string;
	journal: {
		from: string | null;
		to: string | null;
		count: number;
		day?: string;
		text?: string;
	};
	files: Record<string, string | null>;
	evidence: Record<string, string>;
	evidenceLines?: Record<string, string[]>;
};
export type JournalSection = {
	file: string;
	day: string;
	headingLine: number;
	entries: ChainEntry[];
};
export type Assessment = {
	status: "none" | "invalid" | "ok";
	reason?: string;
	checkpoint?: Checkpoint;
	chain: ChainEntry[];
	unreadable: { file: string; reason: string }[];
	boundary:
		| { state: "found"; position: number; file?: string; line?: number }
		| { state: "lost" }
		| { state: "none" };
	unreviewed: {
		mode: "boundary" | "fallback";
		entries: ChainEntry[];
		sections?: JournalSection[];
	};
	orphans: ChainEntry[];
	uncertified: number;
	changed: (
		| { path: string; kind: "changed" | "appeared" | "removed" }
		| { path: string; kind: "unsafe"; reason: string }
	)[];
	evidenceLost: { path: string; kind: "changed" | "missing" }[];
	dropped?: DroppedResult;
	freshness: string;
	lock: string;
	verdict: "CLEAN" | "RECONCILE";
	reasons: string[];
};
export const CLEAN_WORDS =
	"records certified; check the activity line: work done only in a transcript is not covered";
export const RECONCILE_WORDS =
	"read the unreviewed entries and the changed files before you write CURRENT, STATUS or the checkpoint; if a predecessor's work is not in them, recover it from its session or transcript first";

type CheckpointRead =
	| { status: "none" }
	| { status: "invalid"; reason: string }
	| { status: "ok"; checkpoint: Checkpoint };
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function localPath(value: string): boolean {
	return (
		value.length > 0 &&
		!isAbsolute(value) &&
		!value.includes("..") &&
		!value.includes(":") &&
		!value.includes("\\") &&
		value.split("/").every((part) => part !== "" && part !== ".")
	);
}
function evidencePath(value: string): boolean {
	if (!value.startsWith("enclosing:")) return localPath(value);
	return (
		/^enclosing:shared\/[^/]+\.md$/.test(value) &&
		localPath(value.slice("enclosing:".length))
	);
}
const hashPattern = /^sha256:[a-fA-F0-9]{64}$/;
function validation(value: unknown): string | undefined {
	if (!object(value)) return "checkpoint must be an object";
	if (value.schema !== 1) return "schema must be 1";
	if (!Number.isSafeInteger(value.revision) || (value.revision as number) <= 0)
		return "revision must be a positive integer";
	if (typeof value.written !== "string") return "written must be a string";
	if (value.session !== undefined && typeof value.session !== "string")
		return "session must be a string";
	if (
		typeof value.snapshot !== "string" ||
		!localPath(value.snapshot) ||
		!value.snapshot.startsWith("checkpoints/")
	)
		return "snapshot must be a relative path under checkpoints/";
	if (!object(value.journal)) return "journal must be an object";
	for (const key of ["from", "to"])
		if (value.journal[key] !== null && typeof value.journal[key] !== "string")
			return `journal.${key} must be a string or null`;
	if (
		!Number.isSafeInteger(value.journal.count) ||
		(value.journal.count as number) < 0
	)
		return "journal.count must be a non-negative integer";
	for (const key of ["day", "text"])
		if (
			value.journal[key] !== undefined &&
			typeof value.journal[key] !== "string"
		)
			return `journal.${key} must be a string`;
	if (!object(value.files)) return "files must be an object";
	for (const path of FIXED_PATHS)
		if (!Object.hasOwn(value.files, path)) return `files missing ${path}`;
	for (const [path, hash] of Object.entries(value.files)) {
		if (!localPath(path)) return `invalid files path: ${path}`;
		if (hash !== null && (typeof hash !== "string" || !hashPattern.test(hash)))
			return `invalid files hash: ${path}`;
	}
	if (!object(value.evidence)) return "evidence must be an object";
	for (const [path, hash] of Object.entries(value.evidence)) {
		if (!evidencePath(path)) return `invalid evidence path: ${path}`;
		if (typeof hash !== "string" || !hashPattern.test(hash))
			return `invalid evidence hash: ${path}`;
	}
	if (value.evidenceLines !== undefined) {
		if (!object(value.evidenceLines)) return "evidenceLines must be an object";
		for (const [path, lines] of Object.entries(value.evidenceLines)) {
			if (!evidencePath(path) || !Object.hasOwn(value.evidence, path))
				return `invalid evidenceLines path: ${path}`;
			if (
				!Array.isArray(lines) ||
				!lines.every((line) => typeof line === "string")
			)
				return `invalid evidenceLines text: ${path}`;
		}
	}
}

/** Read and validate the checkpoint without following a checkpoint symlink. */
export function readCheckpoint(state: string): CheckpointRead {
	const path = join(state, "checkpoint.json");
	try {
		if (lstatSync(path).isSymbolicLink())
			return { status: "invalid", reason: "checkpoint.json is a symlink" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { status: "none" };
		return {
			status: "invalid",
			reason: String(error instanceof Error ? error.message : error),
		};
	}
	try {
		return parseCheckpoint(readFileSync(path, "utf8"));
	} catch (error) {
		return {
			status: "invalid",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Validate checkpoint JSON from already held text. */
export function parseCheckpoint(text: string): CheckpointRead {
	try {
		const value: unknown = JSON.parse(text);
		const reason = validation(value);
		return reason
			? { status: "invalid", reason }
			: { status: "ok", checkpoint: value as Checkpoint };
	} catch (error) {
		return {
			status: "invalid",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Fixed records followed by the sorted live item STATUS paths. */
export function coveredPaths(state: string): string[] {
	const statuses: string[] = [];
	for (const bucket of ["todo", "in-progress"]) {
		const dir = join(state, "work", bucket);
		try {
			if (lstatSync(dir).isSymbolicLink()) {
				statuses.push(`work/${bucket}`);
				continue;
			}
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				const path = `work/${bucket}/${entry.name}/STATUS.md`;
				try {
					lstatSync(join(state, path));
					statuses.push(path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT")
						statuses.push(path);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				statuses.push(`work/${bucket}`);
		}
	}
	return [...FIXED_PATHS, ...statuses.sort()];
}

/** Hash record bytes, with null for absence and unsafe:<reason> for inspection failures. */
export function hashPaths(
	workspace: Workspace,
	paths: string[],
): Record<string, string | null> {
	const hashes: Record<string, string | null> = {};
	const enclosing = paths.some((path) => path.startsWith("enclosing:"))
		? findEnclosingWorkspace(workspace.dir)
		: undefined;
	for (const path of paths) {
		hashes[path] = null;
		if (!evidencePath(path)) {
			hashes[path] = "unsafe:invalid path";
			continue;
		}
		const external = path.startsWith("enclosing:");
		if (external && !enclosing) continue;
		let absolute = external
			? join(enclosing as string, STATE_DIR)
			: workspace.state;
		try {
			for (const part of (external
				? path.slice("enclosing:".length)
				: path
			).split("/")) {
				absolute = join(absolute, part);
				if (lstatSync(absolute).isSymbolicLink())
					throw new Error("is a symlink");
			}
			if (!lstatSync(absolute).isFile())
				throw new Error("is not a regular file");
			hashes[path] = contentHash(readFileSync(absolute));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				hashes[path] =
					`unsafe:${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return hashes;
}

/** Carry the text of copies whose held evidence bytes changed. */
export function carriedEvidence(
	checkpoint: Checkpoint,
	hashes: Record<string, string | null>,
): { text: string; from: string }[] {
	return Object.keys(checkpoint.evidence)
		.sort()
		.flatMap((from) => {
			if (hashes[from] === checkpoint.evidence[from]) return [];
			const lines = checkpoint.evidenceLines?.[from];
			return (
				lines?.length
					? lines
					: [
							`${from} held the copy of a dropped CURRENT line; its text was not recorded`,
						]
			).map((text) => ({ text, from }));
		});
}

/** Last two entry-bearing dated sections, oldest first, retaining duplicate headings. */
export function fallbackSections(
	_state: string,
	chain: ChainEntry[],
	_files: string[],
): JournalSection[] {
	const selected: JournalSection[] = [];
	for (let index = chain.length - 1; index >= 0; index--) {
		const entry = chain[index];
		if (!entry || entry.heading === undefined) continue;
		let section = selected.find(
			(section) =>
				section.file === entry.file && section.headingLine === entry.heading,
		);
		if (!section) {
			if (selected.length === 2) break;
			section = {
				file: entry.file,
				day: entry.day ?? "",
				headingLine: entry.heading,
				entries: [],
			};
			selected.push(section);
		}
		section.entries.unshift(entry);
	}
	return selected.reverse();
}

/** Assess certification, journal history, covered records and preservation evidence. */
export function assessCheckpoint(
	workspace: Workspace,
	toolEnv: ToolEnv,
): Assessment {
	let read = readCheckpoint(workspace.state);
	const checkpoint = read.status === "ok" ? read.checkpoint : undefined;
	const baseline = checkpoint
		? readBaseline(
				workspace.state,
				checkpoint.snapshot,
				checkpoint.files["CURRENT.md"] ?? null,
			)
		: { status: "none" as const };
	if (baseline.status === "lost")
		read = { status: "invalid", reason: baseline.reason };
	const { entries: chain, files, unreadable } = journalChain(workspace.state);
	let boundary: Assessment["boundary"] = { state: "none" };
	let fromIndex = 0;
	if (read.status === "ok") {
		const { from, to } = read.checkpoint.journal;
		const toIndex = chain.findIndex((entry) => entry.id === to);
		fromIndex = chain.findIndex((entry) => entry.id === from);
		if (from === null && to === null)
			boundary = { state: "found", position: 0 };
		else if (
			from !== null &&
			to !== null &&
			fromIndex >= 0 &&
			toIndex >= fromIndex
		) {
			const entry = chain[toIndex];
			boundary = {
				state: "found",
				position: toIndex + 1,
				file: entry?.file,
				line: entry?.line,
			};
		} else boundary = { state: "lost" };
	}
	const sections =
		boundary.state === "found"
			? undefined
			: fallbackSections(workspace.state, chain, files);
	const unreviewed: Assessment["unreviewed"] =
		boundary.state === "found"
			? {
					mode: "boundary",
					entries: chain
						.slice(boundary.position)
						.filter((entry) => entry.day !== undefined),
				}
			: {
					mode: "fallback",
					entries: sections?.flatMap((section) => section.entries) ?? [],
					sections,
				};
	const orphans = chain.filter((entry) => entry.day === undefined);
	const uncertified =
		boundary.state === "found"
			? Math.max(0, fromIndex)
			: unreviewed.entries.length
				? chain.indexOf(unreviewed.entries[0] as ChainEntry)
				: chain.length;
	const changed: Assessment["changed"] = [];
	const evidenceLost: Assessment["evidenceLost"] = [];
	let evidenceHashes: Record<string, string | null> = {};
	if (read.status === "ok") {
		const paths = [
			...new Set([
				...Object.keys(read.checkpoint.files),
				...coveredPaths(workspace.state),
			]),
		].sort();
		const hashes = hashPaths(workspace, paths);
		for (const path of paths) {
			const before = read.checkpoint.files[path] ?? null;
			const after = hashes[path] ?? null;
			if (after?.startsWith("unsafe:")) {
				changed.push({
					path,
					kind: "unsafe",
					reason: after.slice("unsafe:".length),
				});
			} else if (before !== after)
				changed.push({
					path,
					kind:
						after === null
							? "removed"
							: before === null
								? "appeared"
								: "changed",
				});
		}
	}
	if (checkpoint) {
		evidenceHashes = hashPaths(workspace, Object.keys(checkpoint.evidence));
		for (const path of Object.keys(checkpoint.evidence).sort())
			if (evidenceHashes[path] !== checkpoint.evidence[path])
				evidenceLost.push({
					path,
					kind:
						evidenceHashes[path] === null ||
						evidenceHashes[path]?.startsWith("unsafe:")
							? "missing"
							: "changed",
				});
	}
	let dropped: DroppedResult | undefined;
	if (baseline.status !== "none") {
		const baselineText = baseline.status === "ok" ? baseline.text : "";
		const path = join(workspace.state, "CURRENT.md");
		try {
			if (
				hashPaths(workspace, ["CURRENT.md"])["CURRENT.md"]?.startsWith(
					"sha256:",
				)
			)
				dropped = droppedLines({
					current: readFileSync(path, "utf8"),
					baseline: baselineText,
					carried: checkpoint
						? carriedEvidence(checkpoint, evidenceHashes)
						: [],
					...readDroppedSources(workspace, baselineText),
				});
		} catch {
			const unsafe = {
				path: "CURRENT.md",
				kind: "unsafe",
				reason: "could not read CURRENT or preservation sources",
			} as const;
			if (!changed.some(({ path }) => path === unsafe.path))
				changed.push(unsafe);
		}
	}
	const reasons: string[] = [];
	if (read.status === "none") reasons.push("no checkpoint");
	if (read.status === "invalid")
		reasons.push(`invalid checkpoint: checkpoint.json: ${read.reason}`);
	if (boundary.state === "lost")
		reasons.push(
			"boundary lost: the journal changed before the certified entry",
		);
	for (const { file, reason } of unreadable)
		reasons.push(`journal unreadable: ${file}: ${reason}`);
	const first = unreviewed.entries[0];
	const last = unreviewed.entries.at(-1);
	if (first && last)
		reasons.push(
			`${unreviewed.entries.length} entries ${unreviewed.mode === "boundary" ? "since the boundary" : "in the fallback"} (${first.file}:${first.line} to ${last.file}:${last.line})`,
		);
	const orphanGroups = new Map<string, ChainEntry[]>();
	for (const entry of orphans) {
		if (boundary.state === "found" && chain.indexOf(entry) < boundary.position)
			continue;
		const group = orphanGroups.get(entry.file) ?? [];
		group.push(entry);
		orphanGroups.set(entry.file, group);
	}
	for (const [file, entries] of orphanGroups)
		reasons.push(
			`${entries.length} entries without a heading (${file}:${entries[0]?.line})`,
		);
	for (const change of changed)
		reasons.push(
			`${change.path} ${change.kind}${change.kind === "unsafe" ? `: ${change.reason}` : ""}`,
		);
	for (const { path } of evidenceLost)
		reasons.push(
			`${path} held the copy of a dropped CURRENT line; check the copy is still there`,
		);
	if (dropped?.unaccounted.length)
		reasons.push(
			`${dropped.unaccounted.length} CURRENT lines dropped and not accounted for`,
		);
	let lock: ReturnType<typeof lockStatus>;
	try {
		lock = lockStatus(workspace.state, toolEnv);
	} catch (error) {
		lock = { status: "stale" };
		reasons.push(
			`lock unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		status: read.status,
		reason: read.status === "invalid" ? read.reason : undefined,
		checkpoint,
		chain,
		unreadable,
		boundary,
		unreviewed,
		orphans,
		uncertified,
		changed,
		evidenceLost,
		dropped,
		freshness: recordFreshness(workspace, toolEnv) ?? "unknown",
		lock:
			lock.status === "free"
				? "free"
				: lock.status === "alive"
					? `held by live pid ${lock.pid}`
					: `stale, left by pid ${lock.pid ?? "unknown"}`,
		verdict: reasons.length ? "RECONCILE" : "CLEAN",
		reasons,
	};
}
