// Shared fixtures for the builder-hooks tests: one extracted copy of the
// package outside Troupe, throwaway repositories, hook events on stdin and
// fake checkers whose results a fixture file controls. Nothing here reads a
// real repository or starts a model.
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const extracted = realpathSync(
	mkdtempSync(join(tmpdir(), "builder-hooks-pkg-")),
);
cpSync(resolve(import.meta.dir, ".."), join(extracted, "software"), {
	recursive: true,
});
export const tool = join(extracted, "software/tools/builder-hooks");
// One copy for every test file in the run, removed when the run ends.
process.on("exit", () => rmSync(extracted, { recursive: true, force: true }));

export type Run = { code: number; stdout: string; stderr: string };

/** Run argv with `input` on stdin (Bun's spawnSync types take no stdin). */
export function spawn(
	argv: string[],
	options: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): Run {
	const child = spawnSync(argv[0] as string, argv.slice(1), {
		cwd: options.cwd,
		env: options.env,
		input: options.input ?? "",
		encoding: "utf8",
	});
	return {
		code: child.status ?? -1,
		stdout: child.stdout,
		stderr: child.stderr,
	};
}

export class Fixture {
	root: string;
	repo: string;
	runDir: string;
	bin: string;
	record: string;
	control: string;
	launcher = tool;

	constructor() {
		this.root = realpathSync(mkdtempSync(join(tmpdir(), "builder-hooks-")));
		this.repo = join(this.root, "repo");
		this.runDir = join(this.root, "run");
		this.bin = join(this.root, "bin");
		this.record = join(this.root, "record");
		this.control = join(this.root, "control");
		for (const d of [this.repo, this.bin, this.control])
			mkdirSync(d, { recursive: true });
		writeFileSync(this.record, "");
		this.git("init", "-q", "-b", "main");
		this.write("README.md", "fixture\n");
		this.commit("Start");
	}

	cleanup() {
		rmSync(this.root, { recursive: true, force: true });
	}

	/**
	 * Run this fixture through its own copy of the package, so a test can move
	 * or replace that copy's launcher; returns the copy's launcher path.
	 */
	ownPackage(): string {
		cpSync(join(extracted, "software"), join(this.root, "pkg/software"), {
			recursive: true,
		});
		this.launcher = join(this.root, "pkg/software/tools/builder-hooks");
		return this.launcher;
	}

	env(extra: Record<string, string> = {}): Record<string, string> {
		return {
			PATH: `${this.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			HOME: join(this.root, "home"),
			TMPDIR: join(this.root, "tmp"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.test",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.test",
			RECORD: this.record,
			CONTROL: this.control,
			...extra,
		};
	}

	git(...args: string[]): string {
		mkdirSync(join(this.root, "tmp"), { recursive: true });
		const child = Bun.spawnSync(["git", ...args], {
			cwd: this.repo,
			env: this.env(),
			stdout: "pipe",
			stderr: "pipe",
		});
		if (child.exitCode !== 0)
			throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
		return child.stdout.toString().trim();
	}

	write(path: string, text: string) {
		const full = join(this.repo, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}

	commit(message = "Change"): string {
		this.git("add", "-A");
		this.git("commit", "-q", "--allow-empty", "-m", message);
		return this.git("rev-parse", "HEAD");
	}

	/**
	 * A fake command at bin/<name>: appends "<name> <args>" to the record,
	 * prints control/<name>.out, sleeps control/<name>.sleep seconds and
	 * exits with control/<name>.code (default 0).
	 */
	fake(name: string): string {
		const path = join(this.bin, name);
		writeFileSync(
			path,
			`#!/bin/sh
printf '%s\\n' "${name} $*" >> "$RECORD"
printf '%s\\0%s\\0' "${name}" "$#" >> "$RECORD.argv"
for arg in "$@"; do printf '%s\\0' "$arg" >> "$RECORD.argv"; done
[ -f "$CONTROL/${name}.out" ] && cat "$CONTROL/${name}.out"
[ -f "$CONTROL/${name}.sleep" ] && sleep "$(cat "$CONTROL/${name}.sleep")"
exit "$(cat "$CONTROL/${name}.code" 2>/dev/null || echo 0)"
`,
		);
		chmodSync(path, 0o755);
		return path;
	}

	set(name: string, ext: "out" | "code" | "sleep", value: string) {
		writeFileSync(join(this.control, `${name}.${ext}`), value);
	}

	/** Each call of the fake `name`, as its exact argument vector. */
	recordedArgv(name: string): string[][] {
		let parts: string[];
		try {
			parts = readFileSync(`${this.record}.argv`, "utf8").split("\0");
		} catch {
			return [];
		}
		const calls: string[][] = [];
		for (let i = 0; i + 1 < parts.length; ) {
			const who = parts[i] as string;
			const count = Number(parts[i + 1]);
			const args = parts.slice(i + 2, i + 2 + count);
			if (who === name) calls.push(args);
			i += 2 + count;
		}
		return calls;
	}

	recorded(): string[] {
		return readFileSync(this.record, "utf8").split("\n").filter(Boolean);
	}

	input(extra: Record<string, unknown> = {}): Record<string, unknown> {
		return { role: "builder", repo: this.repo, base: "HEAD", ...extra };
	}

	run(
		args: string[],
		options: {
			cwd?: string;
			env?: Record<string, string>;
			stdin?: string;
		} = {},
	): Run {
		mkdirSync(join(this.root, "tmp"), { recursive: true });
		return spawn([this.launcher, ...args], {
			cwd: options.cwd ?? this.root,
			env: this.env(options.env),
			input: options.stdin,
		});
	}

	/** Write the input file and run prepare --json; returns the parsed envelope. */
	prepare(input: Record<string, unknown>, extra: string[] = []) {
		const file = join(this.root, "input.json");
		writeFileSync(file, JSON.stringify(input));
		const r = this.run([
			"prepare",
			"--input",
			file,
			"--run-dir",
			this.runDir,
			"--json",
			...extra,
		]);
		return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
	}

	get manifest(): string {
		return join(this.runDir, "builder-manifest.json");
	}

	get log(): string {
		return join(this.runDir, "hooks.log");
	}

	logLines(): string[] {
		try {
			return readFileSync(this.log, "utf8").split("\n").filter(Boolean);
		} catch {
			return [];
		}
	}

	hook(mode: string, event: unknown, env: Record<string, string> = {}): Run {
		return this.run([mode], {
			stdin: typeof event === "string" ? event : JSON.stringify(event),
			env: {
				SHEPHERD_HOOK_MANIFEST: this.manifest,
				SHEPHERD_HOOK_LOG: this.log,
				...env,
			},
		});
	}
}
