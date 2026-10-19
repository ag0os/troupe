// Runs packages/software/tools/contract, from a copy of the package outside
// Troupe, against throwaway repositories. It imports nothing from Troupe:
// the package carries its own proof.
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	cpSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Code points, so this file holds no dash for publish-check to find.
const EM = String.fromCodePoint(0x2014);
const EN = String.fromCodePoint(0x2013);

// One extracted copy for the whole file: every run proves the package works
// outside Troupe, with no SHEPHERD_PACKAGE_DIR.
const extracted = realpathSync(mkdtempSync(join(tmpdir(), "contract-pkg-")));
cpSync(resolve(import.meta.dir, ".."), join(extracted, "software"), {
	recursive: true,
});
const tool = join(extracted, "software/tools/contract");
afterAll(() => rmSync(extracted, { recursive: true, force: true }));

let root: string;
let repo: string;
let temp: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: "/nonexistent/contract-home",
		TMPDIR: temp,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.test",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.test",
		GIT_AUTHOR_DATE: "2026-10-15T12:00:00",
		GIT_COMMITTER_DATE: "2026-10-15T12:00:00",
		...extra,
	};
}

function git(...args: string[]) {
	const child = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		env: env(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
	return child.stdout.toString().trim();
}

function write(path: string, text: string) {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), text);
}

function commit(message = "Change") {
	git("add", "-A");
	git("commit", "-q", "--allow-empty", "-m", message);
	return git("rev-parse", "HEAD");
}

type Run = { code: number; stdout: string; stderr: string };

function run(
	args: string[],
	cwd = repo,
	extra: Record<string, string> = {},
): Run {
	const child = Bun.spawnSync([tool, ...args], {
		cwd,
		env: env(extra),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: child.exitCode,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

type Finding = {
	code: string;
	severity: "error" | "warning";
	file: string;
	line?: number;
	obligationId?: string;
	message: string;
};

type Report = {
	contract: number;
	tool: string;
	command: string;
	status: "clean" | "warnings" | "findings" | "error";
	findings: Finding[];
	failing: number;
	result: Record<string, unknown>;
	error?: { code: string; message: string };
};

function json(args: string[], cwd = repo): { code: number; report: Report } {
	const result = run([...args, "--json"], cwd);
	expect(result.stderr).toBe("");
	return { code: result.code, report: JSON.parse(result.stdout) as Report };
}

/** `file:line code` (or `file code`) for each finding, in report order. */
function found(args: string[], cwd = repo): string[] {
	return json(args, cwd).report.findings.map(
		(f) => `${f.file}${f.line ? `:${f.line}` : ""} ${f.code}`,
	);
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "contract-test-")));
	repo = join(root, "repo");
	temp = join(root, "tmp");
	mkdirSync(repo);
	mkdirSync(temp);
	git("init", "-q", "-b", "main");
	write("README.md", "Fixture.\n");
	commit("Base");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("package integration (CT-1)", () => {
	test("the launcher is POSIX sh, executable, and resolves its TypeScript from $0", () => {
		expect(readFileSync(tool, "utf8").split("\n")[0]).toBe("#!/bin/sh");
		expect(statSync(tool).mode & 0o111).not.toBe(0);
		expect(statSync(join(dirname(tool), "contract.d/main.ts")).isFile()).toBe(
			true,
		);
		const result = run(["--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("usage: contract");
		for (const command of ["lint", "coverage", "map", "diff"])
			expect(result.stdout).toContain(`contract ${command}`);
	});

	test("help needs no repository and no Shepherd environment", () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		const result = run(["--help"], outside);
		expect(result).toMatchObject({ code: 0, stderr: "" });
		expect(run(["lint", "--help"], outside).code).toBe(0);
	});

	test("bun absent from PATH: exit 2, one stderr line, no JSON", () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		symlinkSync(Bun.which("git") ?? "/usr/bin/git", join(bin, "git"));
		const result = run(["lint", "--json"], repo, { PATH: bin });
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
		expect(result.stderr).toMatch(/^contract: .*bun/);
	});
});

describe("reporting protocol (CT-2)", () => {
	test("usage errors exit 2 with a contract: line, or one JSON error object", () => {
		for (const args of [
			[],
			["bogus"],
			["lint", "--bogus"],
			["lint", "--line"],
			["map", "docs/contracts/x.md"],
			["map", "--line"],
			["diff", "--base"],
			["diff", "--head"],
			["diff", "docs/contracts/x.md"],
			["coverage", "--base", "main"],
		]) {
			const text = run(args);
			expect({ args, code: text.code, stdout: text.stdout }).toEqual({
				args,
				code: 2,
				stdout: "",
			});
			expect(text.stderr).toMatch(/^contract: /);
			// --json before the rest, so it is never read as --base's value.
			const [command, ...rest] = args;
			const report = run(
				command === undefined ? ["--json"] : [command, "--json", ...rest],
			);
			expect({ args, code: report.code, stderr: report.stderr }).toEqual({
				args,
				code: 2,
				stderr: "",
			});
			const parsed = JSON.parse(report.stdout) as Report;
			expect(parsed).toMatchObject({
				contract: 1,
				tool: "contract",
				status: "error",
				error: { code: "usage" },
			});
		}
	});

	test("a directory that is not a repository is an environment error", () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		for (const command of ["lint", "coverage", "map", "diff"]) {
			const text = run([command], outside);
			expect({ command, code: text.code, stdout: text.stdout }).toEqual({
				command,
				code: 2,
				stdout: "",
			});
			expect(text.stderr).toContain("not a git repository");
			const { code, report } = json([command], outside);
			expect(code).toBe(2);
			expect(report).toMatchObject({
				command,
				status: "error",
				error: { code: "not-a-repository" },
			});
		}
	});

	test("a repository with no docs/contracts/ and no PRODUCT sections warns contracts-absent and exits 0", () => {
		write("PRODUCT.md", "# Product\n\n## Overview\n\nNo contracts here.\n");
		commit();
		const text = run(["lint"]);
		expect(text.code).toBe(0);
		expect(text.stdout).toBe(
			"docs/contracts: contracts-absent: no docs/contracts/ and no PRODUCT.md Contract sections\ncontract lint: 1 findings, 0 failing\n",
		);
		const { code, report } = json(["lint"]);
		expect(code).toBe(0);
		expect(report).toMatchObject({
			contract: 1,
			tool: "contract",
			command: "lint",
			status: "warnings",
			failing: 0,
			findings: [
				{
					code: "contracts-absent",
					severity: "warning",
					file: "docs/contracts",
					message: "no docs/contracts/ and no PRODUCT.md Contract sections",
				},
			],
		});
		expect(report.result).toMatchObject({ complete: false });
	});
});

/** Every file under the repository, with its content, for a before/after check. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (path: string) => {
		for (const name of readdirSync(path).sort()) {
			const full = join(path, name);
			const stat = lstatSync(full);
			if (stat.isDirectory()) walk(full);
			else
				out[full.slice(dir.length + 1)] = stat.isSymbolicLink()
					? `link ${full}`
					: `${stat.mtimeMs} ${readFileSync(full, "base64")}`;
		}
	};
	walk(dir);
	return out;
}

/** The modes CT-11 runs; later slices add theirs. */
const MODES: string[][] = [["--help"], ["lint"], ["lint", "--json"]];

describe("isolated, read-only extraction (CT-11)", () => {
	test("cwd bunfig preloads, .env files and git drivers stay inert, from root and nested cwd", () => {
		const sentinel = join(root, "sentinels");
		mkdirSync(sentinel);
		const nested = join(repo, "app/deep");
		mkdirSync(nested, { recursive: true });
		for (const dir of [repo, nested, join(repo, "app")]) {
			const mark = join(sentinel, dir.slice(repo.length).replace(/\//g, "_"));
			writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
			writeFileSync(
				join(dir, "preload.ts"),
				`require("node:fs").writeFileSync(${JSON.stringify(`${mark}-preload`)}, "ran");\n`,
			);
			// Loaded, it would point every git query at nothing.
			writeFileSync(join(dir, ".env"), "GIT_DIR=/nonexistent/contract-env\n");
		}
		const driver = join(root, "driver.sh");
		writeFileSync(driver, `#!/bin/sh\ntouch "${sentinel}/driver"\n`, {
			mode: 0o755,
		});
		commit("Sentinels");
		// Set after the fixture's own commits, which would run them.
		for (const [key, value] of [
			["core.fsmonitor", driver],
			["core.pager", driver],
			["diff.external", driver],
			["core.sshCommand", driver],
		] as const)
			git("config", key, value);
		const before = snapshot(repo);
		for (const cwd of [repo, nested])
			for (const args of MODES) {
				// An environment error (2) is what a loaded .env would cause.
				const { code } = run(args, cwd);
				expect({ args, cwd, ran: code === 0 || code === 1 }).toEqual({
					args,
					cwd,
					ran: true,
				});
			}
		expect(readdirSync(sentinel)).toEqual([]);
		expect(snapshot(repo)).toEqual(before);
		expect(readdirSync(temp)).toEqual([]);
	});
});
