import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	fstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	type Stats,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	LockError,
	LockReleaseError,
	lockFs,
	lockStatus,
	unlockState,
	withStateLock,
	withStateLocks,
} from "./lock";
import { fakeClock, fakeToolEnv, makeTree } from "./test-support";

const cleanups: Array<() => void> = [];
const options = { pid: 101, timeoutMs: 45, pollMs: 5 };
const started = "2026-10-05T12:00:00.000Z";

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
	const tree = makeTree({ ".shepherd/keep": "" });
	cleanups.push(tree.cleanup);
	return {
		state: join(tree.root, ".shepherd"),
		env: fakeToolEnv({ home: tree.root, alivePids: [101, 102, 103] }),
	};
}

function owner(state: string, pid: number, which = "state") {
	const path = join(state, `.${which}.lock`);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "owner"), JSON.stringify({ pid, started }));
}

function noTemporary(state: string) {
	expect(readdirSync(state).filter((name) => name.endsWith(".tmp"))).toEqual(
		[],
	);
}

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function rejection(action: Promise<unknown>): Promise<LockError> {
	try {
		await action;
	} catch (error) {
		expect(error).toBeInstanceOf(LockError);
		return error as LockError;
	}
	throw new Error("expected lock failure");
}

describe("workspace locks", () => {
	test("live contention waits on monotonic time despite an advancing future clock", async () => {
		const { state, env } = fixture();
		const time = fakeClock("2999-01-01T00:00:00Z");
		env.clock = () => {
			time.advance(1_000_000);
			return time.clock();
		};
		owner(state, 102);
		const start = performance.now();
		const error = await rejection(
			withStateLock(
				state,
				env,
				() => {
					throw new Error("entered");
				},
				options,
			),
		);
		expect(performance.now() - start).toBeGreaterThanOrEqual(
			options.timeoutMs - 1,
		);
		expect(error.kind).toBe("alive");
		expect(error.pid).toBe(102);
		expect(error.message).toBe("locked by pid 102 (alive)");
		expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 102 });
		noTemporary(state);
	});

	test("dead owners fail immediately and are never taken by writers", async () => {
		const { state, env } = fixture();
		owner(state, 999);
		let entered = false;
		const error = await rejection(
			withStateLock(
				state,
				env,
				() => {
					entered = true;
				},
				{ ...options, timeoutMs: 10_000 },
			),
		);
		expect(entered).toBe(false);
		expect(error.kind).toBe("stale");
		expect(error.pid).toBe(999);
		expect(error.message).toBe(
			"stale lock `.shepherd/.state.lock` left by pid 999; run `shepherd tool unlock`",
		);
		expect(lockStatus(state, env)).toEqual({ status: "stale", pid: 999 });
		noTemporary(state);
	});

	for (const content of [
		"{broken",
		"null",
		'{"pid":102}',
		'{"pid":0,"started":"2026-10-05"}',
		'{"pid":102,"started":"invalid"}',
	]) {
		test(`malformed owner ${content} is stale with unknown pid`, async () => {
			const { state, env } = fixture();
			owner(state, 102);
			writeFileSync(join(state, ".state.lock/owner"), content);
			expect(lockStatus(state, env)).toEqual({
				status: "stale",
				pid: undefined,
			});
			const error = await rejection(
				withStateLock(state, env, () => {}, options),
			);
			expect(error.message).toBe(
				"stale lock `.shepherd/.state.lock` left by pid unknown; run `shepherd tool unlock`",
			);
			noTemporary(state);
		});
	}

	test("missing owner in a nonempty lock is stale", async () => {
		const { state, env } = fixture();
		mkdirSync(join(state, ".state.lock"));
		writeFileSync(join(state, ".state.lock/other"), "");
		const error = await rejection(withStateLock(state, env, () => {}, options));
		expect(error.pid).toBeUndefined();
		expect(error.kind).toBe("stale");
		expect(error.message).toContain("pid unknown; run `shepherd tool unlock`");
		noTemporary(state);
	});

	test("empty directory left by hand is atomically replaced", async () => {
		const { state, env } = fixture();
		mkdirSync(join(state, ".state.lock"));
		const value = await withStateLock(
			state,
			env,
			() => {
				expect(
					JSON.parse(readFileSync(join(state, ".state.lock/owner"), "utf8")),
				).toEqual({ pid: 101, started });
				return 7;
			},
			options,
		);
		expect(value).toBe(7);
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		noTemporary(state);
	});

	test("owners use the current clock on each acquisition and default to process pid", async () => {
		const { state, env } = fixture();
		const time = fakeClock(started);
		env.clock = time.clock;
		await withStateLock(state, env, () => {
			expect(
				JSON.parse(readFileSync(join(state, ".state.lock/owner"), "utf8")),
			).toEqual({ pid: process.pid, started });
		});
		time.advance(2000);
		await withStateLock(state, env, () => {
			expect(
				JSON.parse(readFileSync(join(state, ".state.lock/owner"), "utf8")),
			).toEqual({ pid: process.pid, started: "2026-10-05T12:00:02.000Z" });
		});
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		noTemporary(state);
	});

	test("same-process writers serialize and the waiter acquires after release", async () => {
		const { state, env } = fixture();
		const entered = deferred();
		const release = deferred();
		const first = withStateLock(
			state,
			env,
			async () => {
				entered.resolve();
				await release.promise;
			},
			options,
		);
		await entered.promise;
		let secondEntered = false;
		const second = withStateLock(
			state,
			env,
			() => {
				secondEntered = true;
				expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 102 });
			},
			{ ...options, pid: 102 },
		);
		expect(secondEntered).toBe(false);
		expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 101 });
		release.resolve();
		await Promise.all([first, second]);
		expect(secondEntered).toBe(true);
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		noTemporary(state);
	});

	test("same-process waiters do not remove each other's temporary directory", async () => {
		const { state, env } = fixture();
		const entered = deferred();
		const release = deferred();
		const holder = withStateLock(
			state,
			env,
			async () => {
				entered.resolve();
				await release.promise;
			},
			options,
		);
		await entered.promise;
		const firstWaiter = rejection(withStateLock(state, env, () => {}, options));
		const secondWaiter = rejection(
			withStateLock(state, env, () => {}, { ...options, timeoutMs: 10 }),
		);
		try {
			expect((await secondWaiter).kind).toBe("alive");
			expect(existsSync(join(state, `.state.lock.${options.pid}.tmp`))).toBe(
				true,
			);
			expect((await firstWaiter).kind).toBe("alive");
			noTemporary(state);
		} finally {
			release.resolve();
			await holder;
		}
	});

	test("release leaves a replacement owner's lock intact", async () => {
		const { state, env } = fixture();
		await withStateLock(
			state,
			env,
			() => {
				owner(state, 102);
			},
			options,
		);
		expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 102 });
		noTemporary(state);
	});

	test("synchronous exceptions release the lock", async () => {
		const { state, env } = fixture();
		await expect(
			withStateLock(
				state,
				env,
				() => {
					throw new Error("failure");
				},
				options,
			),
		).rejects.toThrow("failure");
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		noTemporary(state);
	});

	test("asynchronous exceptions release the lock", async () => {
		const { state, env } = fixture();
		await expect(
			withStateLock(
				state,
				env,
				async () => {
					await Promise.resolve();
					throw new Error("async failure");
				},
				options,
			),
		).rejects.toThrow("async failure");
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		noTemporary(state);
	});

	test("clock failure removes its temporary directory", async () => {
		const { state, env } = fixture();
		env.clock = () => {
			throw new Error("clock failure");
		};
		await expect(withStateLock(state, env, () => {}, options)).rejects.toThrow(
			"clock failure",
		);
		noTemporary(state);
		expect(lockStatus(state, env)).toEqual({ status: "free" });
	});

	test("non-contention rename failure removes its temporary directory", async () => {
		const { state, env } = fixture();
		writeFileSync(join(state, ".state.lock"), "file");
		await expect(
			withStateLock(state, env, () => {}, options),
		).rejects.toThrow();
		noTemporary(state);
		expect(readFileSync(join(state, ".state.lock"), "utf8")).toBe("file");
	});

	test("lockStatus reports free, alive, stale and unlock ownership", () => {
		const { state, env } = fixture();
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		owner(state, 101);
		expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 101 });
		owner(state, 999);
		expect(lockStatus(state, env)).toEqual({ status: "stale", pid: 999 });
		owner(state, 102, "unlock");
		expect(lockStatus(state, env, "unlock")).toEqual({
			status: "alive",
			pid: 102,
		});
	});

	test("fake clock advances independently of now and returned Dates", () => {
		const time = fakeClock(started);
		const env = fakeToolEnv({ home: "/test", clock: time.clock });
		const date = env.clock();
		date.setTime(0);
		time.advance(1000);
		expect(env.clock().toISOString()).toBe("2026-10-05T12:00:01.000Z");
		expect(env.now.toISOString()).toBe(started);
	});
});

describe("unlock", () => {
	test("refuses a live owner", async () => {
		const { state, env } = fixture();
		owner(state, 102);
		expect(await unlockState(state, env, options)).toEqual({
			code: 1,
			outcome: "alive",
			pid: 102,
			text: "lock held by live pid 102",
		});
		expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 102 });
		expect(lockStatus(state, env, "unlock")).toEqual({ status: "free" });
		noTemporary(state);
	});

	test("clears a dead owner", async () => {
		const { state, env } = fixture();
		owner(state, 999);
		expect(await unlockState(state, env, options)).toEqual({
			code: 0,
			outcome: "cleared",
			pid: 999,
			text: "cleared stale lock left by pid 999",
		});
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		expect(lockStatus(state, env, "unlock")).toEqual({ status: "free" });
		noTemporary(state);
	});

	for (const missing of [true, false]) {
		test(`clears ${missing ? "missing" : "malformed"} owner`, async () => {
			const { state, env } = fixture();
			mkdirSync(join(state, ".state.lock"));
			if (!missing) writeFileSync(join(state, ".state.lock/owner"), "bad");
			expect(await unlockState(state, env, options)).toEqual({
				code: 0,
				outcome: "cleared",
				pid: undefined,
				text: "cleared stale lock left by pid unknown",
			});
			expect(lockStatus(state, env)).toEqual({ status: "free" });
			noTemporary(state);
		});
	}

	test("reports nothing to clear", async () => {
		const { state, env } = fixture();
		expect(await unlockState(state, env, options)).toEqual({
			code: 0,
			outcome: "nothing",
			text: "nothing to clear",
		});
		expect(lockStatus(state, env, "unlock")).toEqual({ status: "free" });
		noTemporary(state);
	});

	test("two unlocks serialize around a writer acquiring after the first clears", async () => {
		const { state, env } = fixture();
		owner(state, 999);
		expect(lockStatus(state, env)).toEqual({ status: "stale", pid: 999 });
		const read = deferred();
		const clear = deferred();
		const cleared = deferred();
		const finishUnlock = deferred();
		const finishWriter = deferred();
		const writerEntered = deferred();
		const first = unlockState(state, env, {
			...options,
			afterOwnerRead: async () => {
				read.resolve();
				await clear.promise;
			},
			afterClear: async () => {
				cleared.resolve();
				await finishUnlock.promise;
			},
		});
		await read.promise;
		const second = unlockState(state, env, {
			...options,
			pid: 102,
			timeoutMs: 500,
		});
		expect(lockStatus(state, env)).toEqual({ status: "stale", pid: 999 });
		clear.resolve();
		await cleared.promise;
		const writer = withStateLock(
			state,
			env,
			async () => {
				writerEntered.resolve();
				await finishWriter.promise;
			},
			{ ...options, pid: 103 },
		);
		await writerEntered.promise;
		finishUnlock.resolve();
		try {
			expect((await first).outcome).toBe("cleared");
			expect(await second).toEqual({
				code: 1,
				outcome: "alive",
				pid: 103,
				text: "lock held by live pid 103",
			});
			expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 103 });
		} finally {
			finishWriter.resolve();
			await writer;
		}
		noTemporary(state);
	});

	test("live unlock contention waits then reports another unlock", async () => {
		const { state, env } = fixture();
		owner(state, 102, "unlock");
		const start = performance.now();
		expect(await unlockState(state, env, options)).toEqual({
			code: 1,
			outcome: "busy",
			pid: 102,
			text: "another unlock is running (pid 102)",
		});
		expect(performance.now() - start).toBeGreaterThanOrEqual(
			options.timeoutMs - 1,
		);
		noTemporary(state);
	});

	for (const malformed of [false, true]) {
		test(`stale unlock ${malformed ? "malformed" : "dead"} owner needs human removal`, async () => {
			const { state, env } = fixture();
			owner(state, 999, "unlock");
			if (malformed) {
				rmSync(join(state, ".unlock.lock/owner"));
				writeFileSync(join(state, ".unlock.lock/other"), "");
			}
			const result = await unlockState(state, env, options);
			expect(result.code).toBe(1);
			expect(result.outcome).toBe("stale-unlock");
			expect(result.text).toContain(`pid ${malformed ? "unknown" : 999}`);
			expect(result.text).toContain("no unlock is running");
			expect(result.text).toContain(`rm -r ${join(state, ".unlock.lock")}`);
			expect(existsSync(join(state, ".unlock.lock"))).toBe(true);
			noTemporary(state);
		});
	}

	test("hook exceptions release the unlock lock without clearing state", async () => {
		const { state, env } = fixture();
		owner(state, 999);
		await expect(
			unlockState(state, env, {
				...options,
				afterOwnerRead: () => {
					throw new Error("hook failure");
				},
			}),
		).rejects.toThrow("hook failure");
		expect(lockStatus(state, env, "unlock")).toEqual({ status: "free" });
		expect(lockStatus(state, env)).toEqual({ status: "stale", pid: 999 });
		noTemporary(state);
	});
});

describe("multiple workspace locks", () => {
	function states() {
		const { state, env } = fixture();
		const paths = ["a", "b", "c"].map((name) => join(state, name));
		for (const path of paths) mkdirSync(path);
		return { paths, env };
	}

	test("takes sorted paths", async () => {
		const { paths, env } = states();
		const acquired: string[] = [];
		env.clock = () => {
			acquired.push(
				paths.find((path) =>
					existsSync(join(path, `.state.lock.${options.pid}.tmp`)),
				) ?? "missing",
			);
			return new Date(started);
		};
		await withStateLocks(
			[...paths].reverse(),
			env,
			() => {
				for (const path of paths)
					expect(lockStatus(path, env)).toEqual({ status: "alive", pid: 101 });
			},
			options,
		);
		expect(acquired).toEqual(paths);
		for (const path of paths) {
			expect(lockStatus(path, env)).toEqual({ status: "free" });
			noTemporary(path);
		}
	});

	test("releases in reverse order", async () => {
		const { paths, env } = states();
		const [a, b, c] = paths as [string, string, string];
		await withStateLocks(
			[c, a, b],
			env,
			() => {
				// The middle owner becomes unreadable only after the last lock is released.
				rmSync(join(b, ".state.lock/owner"));
				symlinkSync(join(c, ".state.lock/owner"), join(b, ".state.lock/owner"));
			},
			options,
		);
		expect(lockStatus(a, env)).toEqual({ status: "free" });
		expect(lockStatus(c, env)).toEqual({ status: "free" });
		expect(lockStatus(b, env)).toEqual({ status: "stale", pid: undefined });
		for (const path of paths) noTemporary(path);
	});

	test("partial failure releases every lock already acquired", async () => {
		const { paths, env } = states();
		const [a, b, c] = paths as [string, string, string];
		owner(c, 999);
		let entered = false;
		await rejection(
			withStateLocks(
				[c, b, a],
				env,
				() => {
					entered = true;
				},
				options,
			),
		);
		expect(entered).toBe(false);
		expect(lockStatus(a, env)).toEqual({ status: "free" });
		expect(lockStatus(b, env)).toEqual({ status: "free" });
		expect(lockStatus(c, env)).toEqual({ status: "stale", pid: 999 });
		for (const path of paths) noTemporary(path);
	});

	test("callback failure releases all and duplicate paths are taken once", async () => {
		const { paths, env } = states();
		await expect(
			withStateLocks(
				[...paths, ...paths],
				env,
				() => {
					throw new Error("multi failure");
				},
				options,
			),
		).rejects.toThrow("multi failure");
		for (const path of paths) {
			expect(lockStatus(path, env)).toEqual({ status: "free" });
			noTemporary(path);
		}
	});
});

describe("fix round 1 regressions", () => {
	test("recovers an orphan temp for our pid without touching another pid's temp", async () => {
		const { state, env } = fixture();
		const own = join(state, `.state.lock.${process.pid}.tmp`);
		const other = join(state, `.state.lock.${process.pid + 1}.tmp`);
		for (const path of [own, other]) {
			mkdirSync(path);
			writeFileSync(join(path, "owner"), "crashed");
		}
		await withStateLock(
			state,
			env,
			() => {
				expect(
					JSON.parse(readFileSync(join(state, ".state.lock/owner"), "utf8"))
						.pid,
				).toBe(process.pid);
			},
			{ timeoutMs: 0 },
		);
		expect(existsSync(own)).toBe(false);
		expect(readFileSync(join(other, "owner"), "utf8")).toBe("crashed");
		expect(lockStatus(state, env)).toEqual({ status: "free" });
	});

	test("recovers an orphan unlock temp for our pid", async () => {
		const { state, env } = fixture();
		const temporary = join(state, `.unlock.lock.${process.pid}.tmp`);
		mkdirSync(temporary);
		writeFileSync(join(temporary, "owner"), "crashed");
		expect((await unlockState(state, env, { timeoutMs: 0 })).outcome).toBe(
			"nothing",
		);
		noTemporary(state);
	});

	test("an owner directory is malformed for status, acquisition and unlock", async () => {
		const { state, env } = fixture();
		mkdirSync(join(state, ".state.lock/owner"), { recursive: true });
		expect(lockStatus(state, env)).toEqual({ status: "stale", pid: undefined });
		expect(
			(await rejection(withStateLock(state, env, () => {}, options))).kind,
		).toBe("stale");
		expect((await unlockState(state, env, options)).outcome).toBe("cleared");
		mkdirSync(join(state, ".unlock.lock/owner"), { recursive: true });
		expect(lockStatus(state, env, "unlock")).toEqual({
			status: "stale",
			pid: undefined,
		});
		expect((await unlockState(state, env, options)).outcome).toBe(
			"stale-unlock",
		);
		noTemporary(state);
	});

	test("status rechecks a directory that vanished during the owner probe", () => {
		const { state, env } = fixture();
		owner(state, 102);
		env.pidAlive = () => {
			renameSync(join(state, ".state.lock"), join(state, "retired"));
			return false;
		};
		expect(lockStatus(state, env)).toEqual({ status: "free" });
	});

	test("status retries a directory replaced during the owner probe", () => {
		const { state, env } = fixture();
		owner(state, 102);
		let replaced = false;
		env.pidAlive = (pid) => {
			if (!replaced) {
				replaced = true;
				renameSync(join(state, ".state.lock"), join(state, "retired"));
				owner(state, 103);
			}
			return pid === 103;
		};
		expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 103 });
	});

	function breakOwner(state: string, which = "state") {
		const path = join(state, `.${which}.lock/owner`);
		rmSync(path);
		symlinkSync("owner", path);
	}

	for (const multiple of [false, true]) {
		for (const fails of [false, true]) {
			test(`${multiple ? "multiple locks" : "single lock"} preserve ${fails ? "the callback error" : "the result"} when release fails`, async () => {
				const { state, env } = fixture();
				const second = join(state, "second");
				mkdirSync(second);
				const result = { appended: true };
				const original = new Error("callback failed");
				const fn = () => {
					breakOwner(state);
					if (fails) throw original;
					return result;
				};
				const pending = multiple
					? withStateLocks([second, state], env, fn, options)
					: withStateLock(state, env, fn, options);
				const error = await pending.then(
					() => {
						throw new Error("expected release failure");
					},
					(error: unknown) => error,
				);
				if (fails) {
					expect(error).toBe(original);
				} else {
					expect(error).toBeInstanceOf(LockReleaseError);
					expect((error as LockReleaseError).result).toBe(result);
					expect((error as LockReleaseError).cause).toMatchObject({
						code: "ELOOP",
					});
				}
				expect(existsSync(join(state, ".state.lock"))).toBe(true);
				expect(lockStatus(second, env)).toEqual({ status: "free" });
				noTemporary(state);
				noTemporary(second);
			});
		}
	}

	for (const fails of [false, true]) {
		test(`unlock preserves ${fails ? "the hook error" : "the result"} when release fails`, async () => {
			const { state, env } = fixture();
			owner(state, 999);
			const original = new Error("hook failed");
			const pending = unlockState(state, env, {
				...options,
				afterClear: () => {
					breakOwner(state, "unlock");
					if (fails) throw original;
				},
			});
			const error = await pending.then(
				() => {
					throw new Error("expected release failure");
				},
				(error: unknown) => error,
			);
			if (fails) {
				expect(error).toBe(original);
			} else {
				expect(error).toBeInstanceOf(LockReleaseError);
				expect((error as LockReleaseError).result).toEqual({
					code: 0,
					outcome: "cleared",
					pid: 999,
					text: "cleared stale lock left by pid 999",
				});
				expect((error as LockReleaseError).cause).toMatchObject({
					code: "ELOOP",
				});
			}
			expect(lockStatus(state, env)).toEqual({ status: "free" });
			noTemporary(state);
		});
	}
});

async function multiprocessProbe(withUnlock: boolean) {
	const { state, env } = fixture();
	const script = join(state, "probe.ts");
	writeFileSync(
		script,
		`
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { LockError, unlockState, withStateLock } from ${JSON.stringify(new URL("./lock.ts", import.meta.url).href)};
const [state, mode, id] = process.argv.slice(2);
const pause = () => new Promise((done) => setTimeout(done, 1));
const env = {
	cwd: state, home: state, env: {}, now: new Date(), clock: () => new Date(),
	runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	pidAlive: (pid) => {
		try { process.kill(pid, 0); return true; }
		catch (error) { return error.code === "EPERM"; }
	},
};
const counts = { iterations: 0, overlaps: 0, lostOwners: 0, staleFailures: 0, cleared: 0, errors: [] };
const options = { timeoutMs: 10_000, pollMs: 1 };
const marker = join(state, "holder");
const checkOwner = () => {
	try {
		if (JSON.parse(readFileSync(join(state, ".state.lock/owner"), "utf8")).pid !== process.pid) counts.lostOwners++;
	} catch { counts.lostOwners++; }
};
writeFileSync(join(state, "ready." + id), "");
while (!existsSync(join(state, "go"))) await pause();
if (mode === "writer") {
	for (let i = 0; i < 300; i++) {
		try {
			await withStateLock(state, env, async () => {
				let marked = false;
				try {
					try { writeFileSync(marker, String(process.pid), { flag: "wx" }); marked = true; }
					catch (error) { if (error.code === "EEXIST") counts.overlaps++; else throw error; }
					checkOwner();
					await pause();
					checkOwner();
					counts.iterations++;
				} finally { if (marked) rmSync(marker); }
			}, options);
		} catch (error) {
			if (error instanceof LockError && error.kind === "stale") counts.staleFailures++;
			else counts.errors.push(String(error));
		}
	}
} else {
	while (!existsSync(join(state, "stop"))) {
		try {
			const result = await unlockState(state, env, options);
			if (result.outcome === "cleared") counts.cleared++;
			if (result.outcome === "stale-unlock") counts.staleFailures++;
			counts.iterations++;
		} catch (error) { counts.errors.push(String(error)); }
		await pause();
	}
}
process.stdout.write(JSON.stringify(counts));
`,
	);
	const modes = ["writer", "writer", "writer", "writer"];
	if (withUnlock) modes.push("unlock", "unlock");
	const children = modes.map((mode, index) =>
		Bun.spawn([process.execPath, script, state, mode, String(index)], {
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const outputs = children.map(async (child) => {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, stdout, stderr };
	});
	try {
		const deadline = performance.now() + 5000;
		while (
			!modes.every((_, index) => existsSync(join(state, `ready.${index}`)))
		) {
			if (performance.now() >= deadline)
				throw new Error("child probe startup timed out");
			await new Promise<void>((done) => setTimeout(done, 1));
		}
		writeFileSync(join(state, "go"), "");
		await Promise.all(outputs.slice(0, 4));
		writeFileSync(join(state, "stop"), "");
		for (const [index, output] of (await Promise.all(outputs)).entries()) {
			expect(output.stderr).toBe("");
			expect(output.code).toBe(0);
			const counts = JSON.parse(output.stdout);
			expect(counts.overlaps).toBe(0);
			expect(counts.lostOwners).toBe(0);
			expect(counts.staleFailures).toBe(0);
			expect(counts.cleared).toBe(0);
			expect(counts.errors).toEqual([]);
			if (index < 4) expect(counts.iterations).toBe(300);
			else expect(counts.iterations).toBeGreaterThan(0);
		}
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		expect(lockStatus(state, env, "unlock")).toEqual({ status: "free" });
		expect(existsSync(join(state, "holder"))).toBe(false);
		noTemporary(state);
		expect(readdirSync(state).filter((name) => name.endsWith(".gone"))).toEqual(
			[],
		);
	} finally {
		for (const child of children) {
			if (child.exitCode === null) child.kill();
		}
		await Promise.all(children.map((child) => child.exited));
	}
}

describe("multiprocess locking", () => {
	test("four writers race through 1200 acquisitions without overlap, lost owners or stale failures", async () => {
		await multiprocessProbe(false);
	}, 15_000);

	test("unlock loops beside four writers never clear live locks or throw", async () => {
		await multiprocessProbe(true);
	}, 15_000);
});

describe("fix round 2 regressions", () => {
	test("unlock refuses the writer that replaced an empty stale lock inside its hook", async () => {
		const { state, env } = fixture();
		mkdirSync(join(state, ".state.lock"));
		const entered = deferred();
		const release = deferred();
		let writer: Promise<void> | undefined;
		try {
			const result = await unlockState(state, env, {
				...options,
				afterOwnerRead: async () => {
					writer = withStateLock(
						state,
						env,
						async () => {
							entered.resolve();
							await release.promise;
						},
						{ ...options, pid: 102 },
					);
					await entered.promise;
				},
			});
			expect(result).toEqual({
				code: 1,
				outcome: "alive",
				pid: 102,
				text: "lock held by live pid 102",
			});
			expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 102 });
			expect(lockStatus(state, env, "unlock")).toEqual({ status: "free" });
		} finally {
			release.resolve();
			await writer;
		}
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		noTemporary(state);
	});

	test("unlock reports nothing when an empty stale lock vanishes inside its hook", async () => {
		const { state, env } = fixture();
		mkdirSync(join(state, ".state.lock"));
		expect(
			await unlockState(state, env, {
				...options,
				afterOwnerRead: () => rmdirSync(join(state, ".state.lock")),
			}),
		).toEqual({ code: 0, outcome: "nothing", text: "nothing to clear" });
		expect(lockStatus(state, env, "unlock")).toEqual({ status: "free" });
		noTemporary(state);
	});

	test("unlock still detaches a nonempty stale lock that has no owner", async () => {
		const { state, env } = fixture();
		mkdirSync(join(state, ".state.lock"));
		writeFileSync(join(state, ".state.lock/other"), "left by hand");
		expect(await unlockState(state, env, options)).toEqual({
			code: 0,
			outcome: "cleared",
			pid: undefined,
			text: "cleared stale lock left by pid unknown",
		});
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		noTemporary(state);
		expect(readdirSync(state).filter((name) => name.endsWith(".gone"))).toEqual(
			[],
		);
	});
});

for (const which of ["state", "unlock"] as const) {
	test(`two worker threads keep separate ${which} temps while contending on a live owner`, async () => {
		const { state } = fixture();
		owner(state, process.pid, which);
		const script = join(state, "thread-probe.ts");
		writeFileSync(
			script,
			`
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, threadId, workerData } from "node:worker_threads";
import { LockError, unlockState, withStateLock } from ${JSON.stringify(new URL("./lock.ts", import.meta.url).href)};
const { state, which, ready } = workerData;
const temporary = join(state, "." + which + ".lock." + process.pid + "-t" + threadId + ".tmp");
let announced = false;
const env = {
	cwd: state, home: state, env: {}, now: new Date(), clock: () => new Date(),
	runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	pidAlive: (pid) => {
		let alive;
		try { process.kill(pid, 0); alive = true; }
		catch (error) { alive = error.code === "EPERM"; }
		if (!announced) {
			announced = true;
			writeFileSync(ready, JSON.stringify({ temporary, threadId, pid: process.pid }));
		}
		return alive;
	},
};
try {
	const options = { timeoutMs: 1000, pollMs: 5 };
	const result = which === "state"
		? await withStateLock(state, env, () => "unexpected acquisition", options)
		: await unlockState(state, env, options);
	parentPort.postMessage({ phase: "done", result });
} catch (error) {
	parentPort.postMessage({ phase: "done", result: { name: error.name, kind: error.kind, pid: error.pid, isLockError: error instanceof LockError, code: error.code } });
}
parentPort.close();
`,
		);
		type Waiting = { threadId: number; pid: number; temporary: string };
		const probes: Array<{
			worker: Worker;
			waiting: Promise<Waiting>;
			done: Promise<unknown>;
		}> = [];
		function startWorker() {
			const ready = join(state, `thread-ready.${probes.length}`);
			const worker = new Worker(script, {
				workerData: { state, which, ready },
			});
			const waiting = (async (): Promise<Waiting> => {
				const deadline = performance.now() + 2000;
				while (!existsSync(ready)) {
					if (performance.now() >= deadline)
						throw new Error("worker startup timed out");
					await new Promise<void>((done) => setTimeout(done, 1));
				}
				return JSON.parse(readFileSync(ready, "utf8"));
			})();
			const done = new Promise<unknown>((resolve, reject) => {
				worker.on("message", (message: { phase: string; result: unknown }) => {
					if (message.phase === "done") resolve(message.result);
				});
				worker.on("error", reject);
				worker.on("exit", () =>
					reject(new Error("worker exited before reporting")),
				);
			});
			// Attach a handler immediately, even while another worker is starting.
			done.catch(() => {});
			const probe = { worker, waiting, done };
			probes.push(probe);
			return probe;
		}
		try {
			const first = startWorker();
			const a = await first.waiting;
			const second = startWorker();
			const b = await second.waiting;
			expect(a.pid).toBe(process.pid);
			expect(b.pid).toBe(process.pid);
			expect(a.threadId).toBeGreaterThan(0);
			expect(b.threadId).toBeGreaterThan(0);
			expect(a.threadId).not.toBe(b.threadId);
			expect(a.temporary).not.toBe(b.temporary);
			for (const probe of [a, b]) {
				expect(probe.temporary).toBe(
					join(state, `.${which}.lock.${process.pid}-t${probe.threadId}.tmp`),
				);
				expect(
					JSON.parse(readFileSync(join(probe.temporary, "owner"), "utf8")).pid,
				).toBe(process.pid);
			}
			for (const result of await Promise.all([first.done, second.done])) {
				if (which === "state") {
					expect(result).toMatchObject({
						name: "LockError",
						kind: "alive",
						pid: process.pid,
						isLockError: true,
					});
				} else {
					expect(result).toEqual({
						code: 1,
						outcome: "busy",
						pid: process.pid,
						text: `another unlock is running (pid ${process.pid})`,
					});
				}
			}
			noTemporary(state);
			expect(
				JSON.parse(readFileSync(join(state, `.${which}.lock/owner`), "utf8"))
					.pid,
			).toBe(process.pid);
		} finally {
			for (const probe of probes) probe.worker.terminate();
		}
	}, 5000);
}

describe("inode reuse", () => {
	const real = { ...lockFs };
	afterEach(() => {
		Object.assign(lockFs, real);
	});

	function held(stat: Stats): boolean {
		for (const name of readdirSync("/dev/fd")) {
			try {
				const open = fstatSync(Number(name));
				if (open.dev === stat.dev && open.ino === stat.ino) return true;
			} catch {
				// The descriptor readdir used is already closed.
			}
		}
		return false;
	}

	// ext4 and overlay give a freed inode number to the next directory made,
	// unless a descriptor still holds it. `release` runs once the prober has
	// identified 102's lock; `reacquire` runs at its second probe, which then
	// sees 102's inode number again if nothing holds it. The first lstat stands
	// in for the descriptor when a prober identifies the lock by path alone.
	function reuse(release: () => void, reacquire: () => void) {
		let original: Stats | undefined;
		let pending: (() => void) | undefined = reacquire;
		lockFs.openDirectory = (path) => {
			const fd = real.openDirectory(path);
			if (!original) {
				original = fstatSync(fd);
				release();
			}
			return fd;
		};
		lockFs.lstat = (path) => {
			if (!original) {
				original = real.lstat(path);
				release();
				return original;
			}
			if (pending) {
				pending();
				pending = undefined;
				if (!held(original)) return original;
			}
			return real.lstat(path);
		};
	}

	function releaseHolder(state: string) {
		const gone = join(state, "released");
		renameSync(join(state, ".state.lock"), gone);
		rmSync(gone, { recursive: true });
	}

	test("status retries a live lock that reused the inode of a lock released before the owner probe", () => {
		const { state, env } = fixture();
		owner(state, 102);
		reuse(
			() => releaseHolder(state),
			() => owner(state, 103),
		);
		expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 103 });
	});

	test("status retries a live lock that reused the inode of a holder that released and exited", () => {
		const { state, env } = fixture();
		owner(state, 102);
		env.pidAlive = (pid) => {
			if (pid === 102) releaseHolder(state);
			return pid === 103;
		};
		reuse(
			() => {},
			() => owner(state, 103),
		);
		expect(lockStatus(state, env)).toEqual({ status: "alive", pid: 103 });
	});

	test("status is not stale when a writer took and released a reused inode while the owner was missing", () => {
		const { state, env } = fixture();
		owner(state, 102);
		reuse(
			() => releaseHolder(state),
			() => {
				owner(state, 103);
				releaseHolder(state);
			},
		);
		expect(lockStatus(state, env)).toEqual({ status: "free" });
	});

	test("a contending writer waits on a live lock that reused a released inode instead of failing stale", async () => {
		const { state, env } = fixture();
		owner(state, 102);
		reuse(
			() => releaseHolder(state),
			() => owner(state, 103),
		);
		const error = await rejection(withStateLock(state, env, () => {}, options));
		expect(error.kind).toBe("alive");
		expect(error.pid).toBe(103);
		noTemporary(state);
	});

	test("a contending writer acquires after a reused inode was taken and released while the owner was missing", async () => {
		const { state, env } = fixture();
		owner(state, 102);
		reuse(
			() => releaseHolder(state),
			() => {
				owner(state, 103);
				releaseHolder(state);
			},
		);
		expect(await withStateLock(state, env, () => 7, options)).toBe(7);
		expect(lockStatus(state, env)).toEqual({ status: "free" });
		noTemporary(state);
	});
});
