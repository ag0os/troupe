// One checker process under a deadline: argv only, never a shell, in its own
// process group so a timeout kills its descendants too. Output past a fixed
// byte cap is drained and dropped, so a chatty child never blocks on a full
// pipe and the report stays bounded.
import { spawn } from "node:child_process";

export const OUTPUT_CAP = 16 * 1024;

export type Ran =
	| { kind: "exited"; code: number; output: string }
	| { kind: "missing"; why: string }
	| { kind: "failed"; why: string }
	| { kind: "timeout"; output: string };

function killGroup(pid: number | undefined) {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The group is already gone.
	}
}

export function runBounded(
	argv: string[],
	cwd: string,
	deadline: number,
	env: Record<string, string | undefined> = process.env,
): Promise<Ran> {
	return new Promise((resolve) => {
		let output = "";
		let bytes = 0;
		let settled = false;
		const take = (chunk: Buffer) => {
			if (bytes >= OUTPUT_CAP) return;
			const room = OUTPUT_CAP - bytes;
			const part = chunk.subarray(0, room);
			bytes += part.length;
			output += part.toString("utf8");
		};
		const finish = (ran: Ran) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(ran);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(argv[0] as string, argv.slice(1), {
				cwd,
				env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({ kind: "failed", why: (error as Error).message });
			return;
		}
		const timer = setTimeout(
			() => {
				killGroup(child.pid);
				finish({ kind: "timeout", output });
			},
			Math.max(0, deadline - Date.now()),
		);
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		child.on("error", (error: NodeJS.ErrnoException) => {
			killGroup(child.pid);
			finish(
				error.code === "ENOENT"
					? { kind: "missing", why: `${argv[0]} is not found` }
					: error.code === "EACCES"
						? { kind: "missing", why: `${argv[0]} is not executable` }
						: { kind: "failed", why: error.message },
			);
		});
		child.on("exit", (code, signal) => {
			// Whatever the checker left running goes with it.
			killGroup(child.pid);
			const done = () =>
				finish(
					code === null
						? { kind: "failed", why: `killed by ${signal}` }
						: { kind: "exited", code, output },
				);
			// Let the pipes flush, but never wait on a descendant holding them.
			let closed = false;
			child.on("close", () => {
				closed = true;
				done();
			});
			setTimeout(() => {
				if (!closed) done();
			}, 50);
		});
	});
}

/** The first `n` nonblank lines of captured output. */
export function firstLines(output: string, n = 20): string[] {
	return output
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter((l) => l.trim() !== "")
		.slice(0, n);
}
