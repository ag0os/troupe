/**
 * Shared helpers for the extraction continuity scripts
 * (`compare-extraction-slice.ts`, `check-extraction-commits.ts`).
 *
 * The live installation is only read: its `bin/shepherd` is hashed and run
 * for previews, its `packages/` tree is listed. Candidates are built in a
 * disposable clone under the system temporary directory, from committed
 * revisions only, so untracked proof files never alter the legacy stamp.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isWithin } from "./path-within";

export interface Ran {
	argv: string[];
	cwd: string;
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Environment for every child: no inherited Shepherd or project variables. */
export function childEnv(
	extra: Record<string, string> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key.startsWith("SHEPHERD_") || key === "CLAUDE_PROJECT_DIR") continue;
		env[key] = value;
	}
	return { ...env, NO_COLOR: "1", ...extra };
}

export function run(
	argv: string[],
	cwd: string,
	env: Record<string, string> = childEnv(),
): Ran {
	const child = Bun.spawnSync(argv, {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	return {
		argv,
		cwd,
		code: child.exitCode,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

export function must(ran: Ran, what: string): Ran {
	if (ran.code !== 0) {
		throw new Error(
			`${what} failed (exit ${ran.code}): ${ran.argv.join(" ")}\n${ran.stderr}${ran.stdout}`,
		);
	}
	return ran;
}

export interface Args {
	base: string;
	head: string;
	liveRoot: string;
	evidence?: string;
	baseline?: string;
	keep: boolean;
}

export function parseArgs(argv: string[], usage: string): Args {
	const values: Record<string, string> = {};
	let keep = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i] as string;
		if (flag === "--keep") {
			keep = true;
			continue;
		}
		const value = argv[i + 1];
		if (!flag.startsWith("--") || value === undefined) {
			throw new Error(usage);
		}
		values[flag.slice(2)] = value;
		i++;
	}
	const { base, head = "HEAD", "live-root": liveRoot } = values;
	if (!base || !liveRoot) throw new Error(usage);
	return {
		base,
		head,
		liveRoot: resolve(liveRoot),
		evidence: values.evidence ? resolve(values.evidence) : undefined,
		baseline: values.baseline ? resolve(values.baseline) : undefined,
		keep,
	};
}

/** The repository this script runs from. */
export function repoRoot(): string {
	return realpathSync(resolve(import.meta.dir, ".."));
}

/**
 * Refuse to run from the live installation, and require the worktree's
 * hooks to be initialized (`bun install` generates the ignored `.husky/_`).
 */
export function guardWorkspace(repo: string, liveRoot: string): void {
	const live = realpathSync(liveRoot);
	if (isWithin(live, repo)) {
		throw new Error(
			`refusing to run inside the live installation ${live}; use a separate worktree`,
		);
	}
	if (!existsSync(join(repo, ".husky/_"))) {
		throw new Error(
			`${repo} has no .husky/_: run bun install in this worktree first`,
		);
	}
}

/** A scratch directory outside any repository and outside ~/shepherds. */
export function scratchDir(label: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
	const shepherds = join(homedir(), "shepherds");
	if (isWithin(shepherds, dir)) {
		throw new Error(`scratch ${dir} lies under ${shepherds}`);
	}
	if (run(["git", "rev-parse", "--git-dir"], dir).code === 0) {
		throw new Error(`scratch ${dir} lies inside a Git repository`);
	}
	return dir;
}

export interface LiveSnapshot {
	binary: string;
	packages: string[];
}

/** The baseline section a content-bearing `packages/` manifest lives under. */
export const MANIFEST_HEADING =
	"## packages/ manifest (path, bytes, mode, sha256)";

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Hash of `bin/shepherd` and a sorted manifest of `packages/`: a regular file
 * is `<path> <bytes> <mode> <sha256>`, a symlink is `<path> symlink <target>`.
 * Any other kind of entry throws.
 */
export function liveSnapshot(liveRoot: string): LiveSnapshot {
	const packages: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const rel = relative(liveRoot, path);
			const stat = lstatSync(path);
			if (stat.isDirectory()) walk(path);
			else if (stat.isSymbolicLink()) {
				packages.push(`${rel} symlink ${readlinkSync(path)}`);
			} else if (stat.isFile()) {
				packages.push(
					`${rel} ${stat.size} ${(stat.mode & 0o777).toString(8)} ${sha256File(path)}`,
				);
			} else {
				throw new Error(`unexpected entry kind in packages/: ${rel}`);
			}
		}
	};
	walk(join(liveRoot, "packages"));
	packages.sort();
	return {
		binary: sha256File(join(liveRoot, "bin/shepherd")),
		packages,
	};
}

/** The hash and content-bearing manifest recorded in a live baseline. */
export function readBaseline(file: string): LiveSnapshot {
	const text = readFileSync(file, "utf8");
	const binary = /^([0-9a-f]{64}) {2}bin\/shepherd$/m.exec(text)?.[1];
	const start = text.indexOf(`${MANIFEST_HEADING}\n\`\`\`\n`);
	const end =
		start === -1
			? -1
			: text.indexOf("```", start + MANIFEST_HEADING.length + 5);
	if (!binary || start === -1 || end === -1) {
		throw new Error(
			`${file} holds no binary hash or no "${MANIFEST_HEADING}" block`,
		);
	}
	return {
		binary,
		packages: text
			.slice(start + MANIFEST_HEADING.length + 5, end)
			.split("\n")
			.filter((line) => line.length > 0)
			.sort(),
	};
}

export function sameSnapshot(a: LiveSnapshot, b: LiveSnapshot): boolean {
	return (
		a.binary === b.binary &&
		a.packages.length === b.packages.length &&
		a.packages.every((line, i) => line === b.packages[i])
	);
}

export function formatSnapshot(label: string, snapshot: LiveSnapshot): string {
	return `## ${label}\n\n\`\`\`\n${snapshot.binary}  bin/shepherd\n\`\`\`\n\n${MANIFEST_HEADING.replace("## ", "### ")}\n\n\`\`\`\n${snapshot.packages.join("\n")}\n\`\`\`\n`;
}

/**
 * Refuse an evidence directory that lies, or would be created, inside the
 * live root: the nearest existing ancestor's realpath decides, so a symlink
 * into the live root is caught too. Runs before the first snapshot.
 */
export function guardEvidence(evidence: string, liveRoot: string): void {
	const live = realpathSync(liveRoot);
	let probe = resolve(evidence);
	while (!existsSync(probe)) probe = dirname(probe);
	const real = realpathSync(probe);
	if (isWithin(live, real)) {
		throw new Error(
			`refusing evidence directory ${evidence}: it resolves inside the live root ${live}`,
		);
	}
}

/** A clone of the repository's object store, checked out nowhere yet. */
export function cloneSlot(repo: string, slot: string): void {
	mkdirSync(dirname(slot), { recursive: true });
	must(
		run(
			[
				"git",
				"clone",
				"--quiet",
				"--no-hardlinks",
				"--no-checkout",
				repo,
				slot,
			],
			dirname(slot),
		),
		"clone",
	);
}

export interface SlotCheckout {
	commit: string;
	/** The install and `setup:extractions` runs, in order. */
	runs: Ran[];
	/** The step that failed, if any; its run carries the full output. */
	failed?: string;
}

/**
 * Check `rev` out in the slot from a clean state, install dependencies and
 * run `setup:extractions` when the commit defines it.
 */
export function checkoutSlot(slot: string, rev: string): SlotCheckout {
	must(run(["git", "checkout", "--quiet", "--detach", rev], slot), "checkout");
	must(run(["git", "clean", "-fdxq"], slot), "clean");
	must(run(["git", "reset", "--hard", "--quiet"], slot), "reset");
	const commit = must(
		run(["git", "rev-parse", "HEAD"], slot),
		"rev-parse",
	).stdout.trim();
	const pkg = JSON.parse(readFileSync(join(slot, "package.json"), "utf8"));
	const runs: Ran[] = [];
	const install = run([process.execPath, "install", "--frozen-lockfile"], slot);
	runs.push(install);
	if (install.code !== 0) return { commit, runs, failed: "bun install" };
	if (pkg.scripts?.["setup:extractions"]) {
		const setup = run([process.execPath, "run", "setup:extractions"], slot);
		runs.push(setup);
		if (setup.code !== 0) return { commit, runs, failed: "setup:extractions" };
	}
	return { commit, runs };
}

/**
 * The truthful `--version` line for `commit` built in the slot, from the
 * slot's own legacy source module run in a child process, so older commits
 * are driven from outside. The expected line is always the v1 template
 * `shepherd revision=<commit> dirty=false source=<source>`. A commit whose
 * module exports `legacyStampPolicy` (PR 3 on) must produce exactly that
 * template through the policy's `versionLine`; a difference is a problem.
 */
export function expectedVersionLine(
	slot: string,
	commit: string,
): { line?: string; problem?: string; ran: Ran } {
	const module = join(slot, "scripts/shepherd-source.ts");
	const ran = run(
		[
			process.execPath,
			"-e",
			[
				`const m = await import(${JSON.stringify(module)});`,
				`const manifest = m.readCommitSource(${JSON.stringify(slot)}, ${JSON.stringify(commit)});`,
				"console.log(manifest.source);",
				'if (typeof m.legacyStampPolicy === "function") {',
				`\tconsole.log(m.legacyStampPolicy().versionLine("shepherd", { manifest, provenance: { revision: ${JSON.stringify(commit)}, dirty: false, sourceDirty: false } }));`,
				"}",
			].join("\n"),
		],
		slot,
	);
	const [source = "", policyLine] = ran.stdout.trim().split("\n");
	if (ran.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(source)) return { ran };
	const line = `shepherd revision=${commit} dirty=false source=${source}`;
	if (policyLine !== undefined && policyLine !== line) {
		return {
			line,
			problem: `legacyStampPolicy line ${JSON.stringify(policyLine)} is not the v1 template ${JSON.stringify(line)}`,
			ran,
		};
	}
	return { line, ran };
}

/** A problem unless `--version` exited 0 and printed exactly `expected`. */
export function versionProblem(
	version: { code: number | null; stdout: string },
	expected: string | undefined,
): string | undefined {
	if (version.code !== 0) return `--version exit ${version.code}`;
	if (expected === undefined) return "expected --version line unavailable";
	const line = version.stdout.trim();
	return line === expected
		? undefined
		: `--version ${JSON.stringify(line)} is not ${JSON.stringify(expected)}`;
}

export function revParse(repo: string, rev: string): string {
	return must(
		run(["git", "rev-parse", `${rev}^{commit}`], repo),
		"rev-parse",
	).stdout.trim();
}

/** Build Shepherd in the slot's own layout: `bin/shepherd` beside `packages/`. */
export function buildShepherd(slot: string): Ran {
	return run([process.execPath, "scripts/compile.ts", "shepherd"], slot);
}

interface Fixture {
	cwd: string;
	files: Record<string, string>;
	symlinks?: Record<string, string>;
}

/** Materialize every workspace of `agents/__fixtures__/shepherd/workspaces.json`. */
export function buildWorkspaces(
	fixtureFile: string,
	dir: string,
): Map<string, string> {
	const set = JSON.parse(readFileSync(fixtureFile, "utf8")) as Record<
		string,
		Fixture
	>;
	const cwds = new Map<string, string>();
	for (const [name, fixture] of Object.entries(set)) {
		const base = join(dir, name);
		for (const [rel, body] of Object.entries(fixture.files)) {
			mkdirSync(dirname(join(base, rel)), { recursive: true });
			writeFileSync(join(base, rel), body);
		}
		for (const [rel, target] of Object.entries(fixture.symlinks ?? {})) {
			mkdirSync(dirname(join(base, rel)), { recursive: true });
			symlinkSync(join(base, target), join(base, rel));
		}
		mkdirSync(join(base, fixture.cwd), { recursive: true });
		cwds.set(name, join(base, fixture.cwd));
	}
	return cwds;
}

/** Fake `claude` and `codex` from the slot's own testing helper. */
export function installFakes(slot: string, dir: string): string {
	mkdirSync(dir, { recursive: true });
	must(
		run(
			[
				process.execPath,
				"-e",
				`const m = await import(${JSON.stringify(join(slot, "lib/agent-format/fake-cli.ts"))}); m.installFakeClis(${JSON.stringify(dir)});`,
			],
			slot,
		),
		"install fake CLIs",
	);
	return dir;
}

export function writeEvidence(dir: string, name: string, text: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`refusing to write evidence through the symlink ${file}`);
	}
	writeFileSync(file, text);
	return file;
}

export function describeRan(ran: Ran): string {
	return `$ ${ran.argv.join(" ")}\n# cwd ${ran.cwd}\n# exit ${ran.code}\n--- stdout\n${ran.stdout}--- stderr\n${ran.stderr}`;
}
