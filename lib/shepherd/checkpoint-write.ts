import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import {
	type Checkpoint,
	coveredPaths,
	FIXED_PATHS,
	fallbackSections,
	parseCheckpoint,
} from "./checkpoint";
import {
	contentHash,
	type DroppedResult,
	droppedDigest,
	droppedLines,
	type ItemState,
	itemPathKind,
	readItemStates,
} from "./current-prev";
import type { ToolEnv } from "./sessions";
import { type ChainEntry, journalEntries } from "./text";
import type { Workspace } from "./tree";
import { findEnclosingWorkspace, STATE_DIR } from "./workspace";

export type HeldState = {
	revision: number;
	checkpoint?: Checkpoint;
	status: "none" | "invalid" | "ok";
	reason?: string;
	chain: ChainEntry[];
	unreadable: { file: string; reason: string }[];
	files: Record<string, { bytes: Uint8Array | null; hash: string | null }>;
	unsafe: { path: string; reason: string }[];
	baseline?: { text: string; hash: string };
	destinations: Record<string, string>;
	destinationBytes: Record<string, Uint8Array>;
	items: Record<string, ItemState>;
	dropped?: DroppedResult;
	range: CheckpointRange;
	token: string;
};
export type CheckpointRange =
	| {
			ok: true;
			entries: ChainEntry[];
			start: number;
			fromReset: boolean;
			uncertified: number;
	  }
	| { ok: false; message: string; orphans: ChainEntry[] };

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function absent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function directory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}
function children(path: string): string[] {
	try {
		if (!directory(path)) return [];
		return readdirSync(path).sort();
	} catch {
		return [];
	}
}

/** Capture certification inputs once, sharing held bytes across overlapping sources. */
export function captureState(
	workspace: Workspace,
	_toolEnv: ToolEnv,
): HeldState {
	const cache = new Map<string, HeldState["files"][string]>();
	const enclosing = findEnclosingWorkspace(workspace.dir);
	function read(path: string): HeldState["files"][string] {
		const absolute = resolve(path);
		const prior = cache.get(absolute);
		if (prior) return prior;
		let result: HeldState["files"][string];
		try {
			const base = absolute.startsWith(`${resolve(workspace.state)}/`)
				? resolve(workspace.state)
				: resolve(enclosing ?? workspace.dir, STATE_DIR);
			let component = base;
			for (const part of relative(base, absolute).split("/").filter(Boolean)) {
				component = join(component, part);
				if (lstatSync(component).isSymbolicLink())
					throw new Error("is a symlink");
			}
			if (!lstatSync(absolute).isFile())
				throw new Error("is not a regular file");
			const bytes = readFileSync(absolute);
			result = { bytes, hash: contentHash(bytes) };
		} catch (error) {
			result = {
				bytes: null,
				hash: absent(error) ? null : `unsafe:${message(error)}`,
			};
		}
		cache.set(absolute, result);
		return result;
	}
	const state = workspace.state;
	const checkpointFile = read(join(state, "checkpoint.json"));
	let checkpointRead: ReturnType<typeof parseCheckpoint> =
		checkpointFile.bytes !== null
			? parseCheckpoint(Buffer.from(checkpointFile.bytes).toString("utf8"))
			: checkpointFile.hash === null
				? { status: "none" }
				: {
						status: "invalid",
						reason:
							checkpointFile.hash === "unsafe:is a symlink"
								? "checkpoint.json is a symlink"
								: checkpointFile.hash.slice(7),
					};
	const parsed =
		checkpointRead.status === "ok" ? checkpointRead.checkpoint : undefined;
	const expected = parsed?.files["CURRENT.md"] ?? null;
	const snapshot =
		parsed && expected !== null
			? read(join(state, parsed.snapshot))
			: undefined;
	const baselineRead =
		snapshot &&
		snapshot.bytes !== null &&
		snapshot.hash !== null &&
		snapshot.hash === expected
			? {
					status: "ok" as const,
					text: Buffer.from(snapshot.bytes).toString("utf8"),
					hash: snapshot.hash,
				}
			: expected === null
				? { status: "none" as const }
				: {
						status: "lost" as const,
						reason: "snapshot missing or does not match",
					};
	if (baselineRead.status === "lost")
		checkpointRead = { status: "invalid", reason: baselineRead.reason };
	const checkpoint = parsed;
	const files: HeldState["files"] = {};
	const unsafe: HeldState["unsafe"] = [];
	for (const path of [
		...new Set([
			...coveredPaths(state),
			...Object.keys(checkpoint?.files ?? {}),
		]),
	].sort()) {
		files[path] = read(join(state, path));
		const hash = files[path]?.hash;
		if (hash?.startsWith("unsafe:"))
			unsafe.push({ path, reason: hash.slice(7) });
	}
	const chain: ChainEntry[] = [];
	const unreadable: HeldState["unreadable"] = [];
	const archive = join(state, "archive/journal");
	let archives: string[] = [];
	try {
		if (lstatSync(archive).isSymbolicLink()) throw new Error("is a symlink");
		archives = readdirSync(archive)
			.filter((file) => file.endsWith(".md"))
			.sort()
			.map((file) => `archive/journal/${file}`);
	} catch (error) {
		if (!absent(error))
			unreadable.push({ file: "archive/journal", reason: message(error) });
	}
	let previousId = "root";
	for (const file of [...archives, "journal.md"]) {
		const held = read(join(state, file));
		if (held.bytes === null) {
			if (held.hash !== null || file !== "journal.md")
				unreadable.push({ file, reason: held.hash?.slice(7) ?? "is missing" });
			continue;
		}
		const text = Buffer.from(held.bytes).toString("utf8");
		const entries = journalEntries(text, previousId).map((entry) => ({
			...entry,
			file,
		}));

		chain.push(...entries);
		previousId = entries.at(-1)?.id ?? previousId;
	}
	const destinationBytes: HeldState["destinationBytes"] = {};
	const destinations: HeldState["destinations"] = {};
	function destination(key: string, path = join(state, key)) {
		const held = read(path);
		if (held.bytes !== null) {
			destinationBytes[key] = held.bytes;
			destinations[key] = Buffer.from(held.bytes).toString("utf8");
		}
	}
	function markdown(dir: string, recursive: boolean, prefix: string) {
		for (const name of children(dir)) {
			const path = join(dir, name);
			const key = `${prefix}/${name}`;
			if (recursive && directory(path)) markdown(path, true, key);
			else if (name.endsWith(".md")) destination(key, path);
		}
	}
	markdown(join(state, "docs"), true, "docs");
	for (const dir of ["memories", "integrations", "outbox"])
		markdown(join(state, dir), false, dir);
	function statuses(path: string, prefix: string) {
		for (const name of children(path)) {
			if (directory(join(path, name)))
				statuses(join(path, name), `${prefix}/${name}`);
			else if (name === "STATUS.md") destination(`${prefix}/${name}`);
		}
	}
	for (const bucket of ["todo", "in-progress"])
		statuses(join(state, "work", bucket), `work/${bucket}`);
	const items = readItemStates(
		baselineRead.status === "ok" ? baselineRead.text : "",
		{
			read: (path) => {
				const held = read(join(state, path));
				return held.bytes === null
					? undefined
					: Buffer.from(held.bytes).toString("utf8");
			},
			kind: (path) => itemPathKind(state, path),
			list: (path) => children(join(state, path)),
		},
	);
	for (const path of ["pending.md", "charter.md", "journal.md"])
		destination(path);
	if (enclosing)
		for (const name of children(join(enclosing, STATE_DIR, "shared")))
			if (name.endsWith(".md"))
				destination(
					`enclosing:shared/${name}`,
					join(enclosing, STATE_DIR, "shared", name),
				);
	const held: Omit<HeldState, "range" | "token"> = {
		revision: checkpoint?.revision ?? 0,
		checkpoint,
		status: checkpointRead.status,
		reason:
			checkpointRead.status === "invalid" ? checkpointRead.reason : undefined,
		chain,
		unreadable,
		files,
		unsafe,
		destinations,
		destinationBytes,
		items,
		baseline:
			baselineRead.status === "ok"
				? { text: baselineRead.text, hash: baselineRead.hash }
				: undefined,
	};
	const current = files["CURRENT.md"]?.bytes;
	if (held.baseline && current != null)
		held.dropped = droppedLines({
			current: Buffer.from(current).toString("utf8"),
			baseline: held.baseline.text,
			items,
			destinations,
		});
	const ranged = { ...held, range: certifyRange(held) };
	const result = { ...ranged, token: checkpointToken(ranged) };
	return result;
}

/** Select the contiguous certification tail, refusing orphans inside it. */
export function certifyRange(
	held: Omit<HeldState, "range" | "token">,
): CheckpointRange {
	const { chain, checkpoint } = held;
	const from = chain.findIndex(
		(entry) => entry.id === checkpoint?.journal.from,
	);
	const to = chain.findIndex((entry) => entry.id === checkpoint?.journal.to);
	const found =
		held.status === "ok" &&
		checkpoint !== undefined &&
		((checkpoint.journal.from === null && checkpoint.journal.to === null) ||
			(from >= 0 && to >= from));
	const sections = fallbackSections("", chain, []);
	const first = sections[0]?.entries[0];
	const start = found ? to + 1 : first ? chain.indexOf(first) : chain.length;
	const orphans = chain.filter(
		(entry, index) =>
			entry.day === undefined && (index >= start || sections.length === 0),
	);
	if (orphans.length) {
		const first = orphans[0];
		return {
			ok: false,
			orphans,
			message: `${orphans.length} entries without a heading at ${first?.file}:${first?.line} sit inside the range; put a \`## YYYY-MM-DD\` heading (their day, or today's) above the first of them, which changes no id, then run the dry run again`,
		};
	}
	return {
		ok: true,
		entries: chain.slice(start),
		start,
		fromReset: !found,
		uncertified: found ? Math.max(0, from) : start,
	};
}

/** Bind the held range, chain, union hashes, baseline and dropped dispositions. */
export function checkpointToken(held: Omit<HeldState, "token">): string {
	const entries = held.range.ok ? held.range.entries : [];
	const lines = [
		`range ${entries[0]?.id ?? "none"} ${entries.at(-1)?.id ?? "none"}`,
		`chain ${held.chain.at(-1)?.id ?? "none"} ${held.chain.length}`,
		...Object.keys(held.files)
			.sort()
			.map((path) => `file ${path} ${held.files[path]?.hash ?? "null"}`),
		`baseline ${held.baseline?.hash ?? "none"}`,
		`digest ${held.dropped ? droppedDigest(held.dropped) : "none"}`,
	];
	return `r${held.revision}-${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12)}`;
}

/** Build the next manifest using only captured bytes and verified appends. */
export function nextCheckpoint(
	held: HeldState,
	options: { written: string; session?: string; appended?: ChainEntry[] },
): Checkpoint {
	for (const [path, file] of Object.entries(held.files))
		if (file.hash?.startsWith("unsafe:"))
			throw new Error(`unsafe file: ${path}: ${file.hash.slice(7)}`);
	if (held.files["CURRENT.md"]?.bytes == null)
		throw new Error("nothing to certify without CURRENT.md");
	if (!held.range.ok) throw new Error(held.range.message);
	const appended = options.appended ?? [];
	const last = appended.at(-1) ?? held.chain.at(-1);
	const first = held.range.entries[0] ?? appended[0];
	const from = held.range.fromReset
		? (first?.id ?? null)
		: (held.checkpoint?.journal.from ?? first?.id ?? null);
	const files: Checkpoint["files"] = {};
	for (const path of [
		...FIXED_PATHS,
		...Object.keys(held.files)
			.filter(
				(path) =>
					/^work\/(todo|in-progress)\/[^/]+\/STATUS\.md$/.test(path) &&
					held.files[path]?.hash !== null,
			)
			.sort(),
	])
		files[path] = held.files[path]?.hash ?? null;
	const evidence: Checkpoint["evidence"] = {};
	for (const line of held.dropped?.accounted ?? []) {
		const bytes = held.destinationBytes[line.foundIn];
		if (bytes === undefined)
			throw new Error(`missing held evidence: ${line.foundIn}`);
		evidence[line.foundIn] = contentHash(bytes);
	}
	const revision = held.revision + 1;
	return {
		schema: 1,
		revision,
		written: options.written,
		...(options.session === undefined ? {} : { session: options.session }),
		snapshot: `checkpoints/CURRENT.r${revision}`,
		journal: {
			from: last ? from : null,
			to: last?.id ?? null,
			count: held.chain.length + appended.length,
			...(last ? { day: last.day, text: last.text.slice(0, 80) } : {}),
		},
		files,
		evidence,
	};
}

/** Commit snapshot before manifest rename, then prune only older snapshots. */
export function commitCheckpoint(
	state: string,
	held: HeldState,
	next: Checkpoint,
	hooks?: { afterSnapshot?: () => void; afterRename?: () => void },
): void {
	for (const file of [
		"checkpoint.json",
		"checkpoint.json.tmp",
		"checkpoints",
	]) {
		try {
			if (lstatSync(join(state, file)).isSymbolicLink())
				throw new Error(`unsafe file: ${file}: is a symlink`);
		} catch (error) {
			if (!absent(error)) throw error;
		}
	}
	if (
		next.revision !== held.revision + 1 ||
		next.snapshot !== `checkpoints/CURRENT.r${next.revision}`
	)
		throw new Error("invalid next checkpoint revision or snapshot");
	const bytes = held.files["CURRENT.md"]?.bytes;
	if (bytes == null) throw new Error("nothing to certify without CURRENT.md");
	const committed = held.checkpoint;
	const committedRevision = committed?.revision ?? 0;
	if (committed?.snapshot === next.snapshot)
		throw new Error("snapshot is referenced by checkpoint.json");
	mkdirSync(join(state, "checkpoints"), { recursive: true });
	const snapshot = join(state, next.snapshot);
	if (committed) {
		let referenced: ReturnType<typeof lstatSync> | undefined;
		let target: ReturnType<typeof lstatSync> | undefined;
		for (const [path, kind] of [
			[join(state, committed.snapshot), "referenced"],
			[snapshot, "target"],
		] as const) {
			try {
				const stat = lstatSync(path);
				if (kind === "referenced") referenced = stat;
				else target = stat;
			} catch (error) {
				if (!absent(error)) throw error;
			}
		}
		if (
			referenced &&
			target &&
			referenced.dev === target.dev &&
			referenced.ino === target.ino
		)
			throw new Error("snapshot is referenced by checkpoint.json");
	}
	if (next.revision > committedRevision) rmSync(snapshot, { force: true });
	writeFileSync(snapshot, bytes, { flag: "wx" });
	hooks?.afterSnapshot?.();
	writeFileSync(
		join(state, "checkpoint.json.tmp"),
		`${JSON.stringify(next, null, 2)}\n`,
	);
	renameSync(
		join(state, "checkpoint.json.tmp"),
		join(state, "checkpoint.json"),
	);
	hooks?.afterRename?.();
	for (const file of readdirSync(join(state, "checkpoints"))) {
		const revision = file.match(/^CURRENT\.r(\d+)$/)?.[1];
		if (revision !== undefined && Number(revision) < next.revision)
			rmSync(join(state, "checkpoints", file));
	}
}
