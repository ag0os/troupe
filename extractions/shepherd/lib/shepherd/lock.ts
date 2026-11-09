import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { threadId } from "node:worker_threads";
import type { ToolEnv } from "./sessions";

/** Reads of a lock that keeps changing before `lockStatus` gives up. */
export const LOCK_REREADS = 1000;

export class LockError extends Error {
	readonly kind: "alive" | "stale" | "unsettled";
	readonly state: string;
	readonly pid?: number;

	constructor(
		kind: "alive" | "stale" | "unsettled",
		pid?: number,
		state: string = "",
		unsettled?: { which: "state" | "unlock"; cause: unknown },
	) {
		super(
			kind === "alive"
				? `locked by pid ${pid} (alive)`
				: kind === "stale"
					? `stale lock \`.shepherd/.state.lock\` left by pid ${pid ?? "unknown"}; run \`shepherd tool unlock\``
					: `lock \`.shepherd/.${unsettled?.which ?? "state"}.lock\` changed on each of ${LOCK_REREADS} reads; last: ${unsettled?.cause instanceof Error ? unsettled.cause.message : "the directory was replaced while it was read"}`,
			{ cause: unsettled?.cause },
		);
		this.name = "LockError";
		this.kind = kind;
		this.state = state;
		this.pid = pid;
	}
}

/** A completed operation whose lock cleanup failed. */
export class LockReleaseError<T = unknown> extends Error {
	readonly result: T;

	constructor(result: T, cause: unknown) {
		super("lock release failed", { cause });
		this.name = "LockReleaseError";
		this.result = result;
	}
}

export type LockOptions = { pid?: number; timeoutMs?: number; pollMs?: number };
export type UnlockHooks = {
	afterOwnerRead?: () => void | Promise<void>;
	afterClear?: () => void | Promise<void>;
};
type LockStatus =
	| { status: "free" }
	| { status: "alive"; pid: number }
	| { status: "stale"; pid?: number };
type UnlockResult = {
	code: 0 | 1;
	outcome: "cleared" | "nothing" | "alive" | "busy" | "stale-unlock";
	pid?: number;
	text: string;
};

const activeTemporaries = new Set<string>();

/** Test seam: tests wrap these to simulate the inode reuse macOS never shows. */
export const lockFs: {
	openDirectory: (path: string) => number;
	lstat: (path: string) => Stats;
} = {
	openDirectory: (path) =>
		openSync(
			path,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		),
	lstat: (path) => lstatSync(path),
};

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException)?.code;
}

function ownerPid(path: string): number | undefined {
	let text: string;
	try {
		text = readFileSync(join(path, "owner"), "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "EISDIR")
			return undefined;
		throw error;
	}
	try {
		const owner = JSON.parse(text);
		if (
			owner &&
			Number.isSafeInteger(owner.pid) &&
			owner.pid > 0 &&
			typeof owner.started === "string" &&
			Number.isFinite(Date.parse(owner.started))
		) {
			return owner.pid;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function statusAt(
	path: string,
	toolEnv: ToolEnv,
): LockStatus | { status: "changed"; cause?: unknown } {
	// Holding the directory open keeps its inode number from going to the next
	// writer's directory, as ext4 and overlay otherwise do at once, so an equal
	// lstat afterwards proves the owner was read from this same directory.
	let fd: number;
	try {
		fd = lockFs.openDirectory(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { status: "free" };
		if (errorCode(error) === "ENOTDIR" || errorCode(error) === "ELOOP")
			return { status: "stale" };
		throw error;
	}
	try {
		let before: Stats;
		try {
			before = fstatSync(fd);
		} catch (error) {
			// The directory is being removed under this descriptor (macOS reports
			// ENOENT during another process's removeLock); reread the path.
			if (errorCode(error) === "ENOENT")
				return { status: "changed", cause: error };
			throw error;
		}
		const pid = ownerPid(path);
		const alive = pid !== undefined && toolEnv.pidAlive(pid);
		try {
			const after = lockFs.lstat(path);
			if (before.dev !== after.dev || before.ino !== after.ino)
				return { status: "changed" };
		} catch (error) {
			if (errorCode(error) === "ENOENT") return { status: "free" };
			throw error;
		}
		return pid !== undefined && alive
			? { status: "alive", pid }
			: { status: "stale", pid };
	} finally {
		closeSync(fd);
	}
}

function removeLock(path: string): void {
	const gone = `${path}.${process.pid}.${randomUUID()}.gone`;
	renameSync(path, gone);
	rmSync(gone, { recursive: true, force: true });
}

/** Reread until a probe settles; a lock that never does is a LockError. */
function settledStatus(
	state: string,
	toolEnv: ToolEnv,
	which: "state" | "unlock",
): LockStatus {
	let cause: unknown;
	for (let read = 0; read < LOCK_REREADS; read++) {
		const status = statusAt(join(state, `.${which}.lock`), toolEnv);
		if (status.status !== "changed") return status;
		cause = status.cause;
	}
	throw new LockError("unsettled", undefined, state, { which, cause });
}

/** Read the current owner without taking either lock. */
export function lockStatus(
	state: string,
	toolEnv: ToolEnv,
	which: "state" | "unlock" = "state",
): LockStatus {
	return settledStatus(state, toolEnv, which);
}

async function acquire(
	state: string,
	toolEnv: ToolEnv,
	which: "state" | "unlock",
	options: LockOptions,
): Promise<() => void> {
	const { pid = process.pid, timeoutMs = 5000, pollMs = 100 } = options;
	const path = join(state, `.${which}.lock`);
	const temporaryOwner = threadId === 0 ? String(pid) : `${pid}-t${threadId}`;
	const temporary = resolve(state, `.${which}.lock.${temporaryOwner}.tmp`);
	const start = performance.now();
	let ownsTemporary = false;
	try {
		// Calls in one thread share a temporary path. Only its creator removes it.
		while (!ownsTemporary) {
			try {
				mkdirSync(temporary);
				ownsTemporary = true;
				activeTemporaries.add(temporary);
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
				if (!activeTemporaries.has(temporary)) {
					rmSync(temporary, { recursive: true, force: true });
					continue;
				}
				const status = statusAt(path, toolEnv);
				if (status.status === "stale")
					throw new LockError("stale", status.pid, state);
				const remaining = timeoutMs - (performance.now() - start);
				if (remaining <= 0) {
					if (status.status === "alive")
						throw new LockError("alive", status.pid, state);
					// Another call in this thread still holds the temporary.
					throw new LockError("alive", pid, state);
				}
				await new Promise<void>((done) =>
					setTimeout(done, Math.min(pollMs, remaining)),
				);
			}
		}
		writeFileSync(
			join(temporary, "owner"),
			JSON.stringify({ pid, started: toolEnv.clock().toISOString() }),
		);
		while (true) {
			try {
				renameSync(temporary, path);
				ownsTemporary = false;
				activeTemporaries.delete(temporary);
				return () => {
					if (ownerPid(path) === pid) removeLock(path);
				};
			} catch (error) {
				if (
					!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(
						errorCode(error) ?? "",
					)
				)
					throw error;
			}
			const status = settledStatus(state, toolEnv, which);
			if (status.status === "free") continue;
			if (status.status === "stale")
				throw new LockError("stale", status.pid, state);
			const remaining = timeoutMs - (performance.now() - start);
			if (remaining <= 0) throw new LockError("alive", status.pid, state);
			await new Promise<void>((done) =>
				setTimeout(done, Math.min(pollMs, remaining)),
			);
		}
	} finally {
		if (ownsTemporary) {
			activeTemporaries.delete(temporary);
			rmSync(temporary, { recursive: true, force: true });
		}
	}
}

/** Run a writer holding the workspace lock, releasing on every exit path. */
export async function withStateLock<T>(
	state: string,
	toolEnv: ToolEnv,
	fn: () => T | Promise<T>,
	options: LockOptions = {},
): Promise<T> {
	const release = await acquire(state, toolEnv, "state", options);
	return runAndRelease(fn, [release]);
}

function releaseAll(releases: Array<() => void>): void {
	let failure: unknown;
	let failed = false;
	for (const release of releases.reverse()) {
		try {
			release();
		} catch (error) {
			if (!failed) failure = error;
			failed = true;
		}
	}
	if (failed) throw failure;
}

async function runAndRelease<T>(
	fn: () => T | Promise<T>,
	releases: Array<() => void>,
): Promise<T> {
	let result: T;
	try {
		result = await fn();
	} catch (error) {
		try {
			releaseAll(releases);
		} catch {
			// The operation's error takes precedence over cleanup errors.
		}
		throw error;
	}
	try {
		releaseAll(releases);
	} catch (error) {
		throw new LockReleaseError(result, error);
	}
	return result;
}

/** Acquire sorted workspace paths and release in reverse, including partial failure. */
export async function withStateLocks<T>(
	states: string[],
	toolEnv: ToolEnv,
	fn: () => T | Promise<T>,
	options: LockOptions = {},
): Promise<T> {
	const releases: Array<() => void> = [];
	try {
		for (const state of [
			...new Set(states.map((state) => resolve(state))),
		].sort()) {
			releases.push(await acquire(state, toolEnv, "state", options));
		}
	} catch (error) {
		try {
			releaseAll(releases);
		} catch {
			// Keep the acquisition failure after attempting every release.
		}
		throw error;
	}
	return runAndRelease(fn, releases);
}

/** Clear a stale writer lock while serializing with other unlocks. */
export async function unlockState(
	state: string,
	toolEnv: ToolEnv,
	options: LockOptions & UnlockHooks = {},
): Promise<UnlockResult> {
	let release: () => void;
	try {
		release = await acquire(state, toolEnv, "unlock", options);
	} catch (error) {
		if (!(error instanceof LockError) || error.kind === "unsettled")
			throw error;
		return error.kind === "alive"
			? {
					code: 1,
					outcome: "busy",
					pid: error.pid,
					text: `another unlock is running (pid ${error.pid})`,
				}
			: {
					code: 1,
					outcome: "stale-unlock",
					pid: error.pid,
					text: `stale unlock lock left by pid ${error.pid ?? "unknown"}; no unlock is running; run \`rm -r ${resolve(state, ".unlock.lock")}\``,
				};
	}
	return runAndRelease<UnlockResult>(async () => {
		let status = lockStatus(state, toolEnv);
		await options.afterOwnerRead?.();
		if (status.status === "stale") {
			try {
				rmdirSync(join(state, ".state.lock"));
			} catch (error) {
				if (errorCode(error) === "ENOENT") {
					status = { status: "free" };
				} else if (
					errorCode(error) === "ENOTEMPTY" ||
					errorCode(error) === "ENOTDIR"
				) {
					status = lockStatus(state, toolEnv);
					if (status.status === "stale") removeLock(join(state, ".state.lock"));
				} else {
					throw error;
				}
			}
			if (status.status === "stale") {
				await options.afterClear?.();
				return {
					code: 0,
					outcome: "cleared",
					pid: status.pid,
					text: `cleared stale lock left by pid ${status.pid ?? "unknown"}`,
				};
			}
		}
		if (status.status === "free")
			return { code: 0, outcome: "nothing", text: "nothing to clear" };
		return {
			code: 1,
			outcome: "alive",
			pid: status.pid,
			text: `lock held by live pid ${status.pid}`,
		};
	}, [release]);
}
