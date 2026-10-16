// Runs packages/software/tools/publish-check against throwaway repositories.
// It imports nothing from Troupe: the package carries its own proof.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const packageDir = resolve(import.meta.dir, "..");
const tool = join(packageDir, "tools/publish-check");
// Code points, so this file holds no dash for publish-check to find.
const EM = String.fromCodePoint(0x2014);
const EN = String.fromCodePoint(0x2013);
const account = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();

let root: string;
let home: string;
let config: string;
let repo: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		SHEPHERD_CONFIG_DIR: config,
		GIT_CONFIG_NOSYSTEM: "1",
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
	return child.stdout.toString();
}

function write(path: string, text: string) {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), text);
}

function run(args: string[], cwd = repo) {
	const child = Bun.spawnSync([tool, ...args], {
		cwd,
		env: env(),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: child.exitCode,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

type Report = {
	contract: number;
	tool: string;
	base: string;
	findings: { where: string; kind: string; detail: string }[];
	failing: number;
};

function json(args: string[] = []): { code: number; report: Report } {
	const result = run([...args, "--json"]);
	return { code: result.code, report: JSON.parse(result.stdout) as Report };
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "publish-check-")));
	home = join(root, "home");
	config = join(root, "config");
	repo = join(root, "repo");
	for (const dir of [home, config, repo]) mkdirSync(dir);
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "planted@example.test");
	write("README.md", "Base text.\n");
	git("add", "-A");
	git("commit", "-q", "-m", "Base");
	git("checkout", "-q", "-b", "feature");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function plantEverything() {
	mkdirSync(join(config, "packages/software/publish-check"), {
		recursive: true,
	});
	writeFileSync(
		join(config, "packages/software/publish-check/terms"),
		"# private terms, one per line\n\nProject Nightjar\n",
	);
	write(
		"notes.md",
		[
			"Clean line.",
			`See ${home}/notes for the draft.`,
			`Ask ${account} about it.`,
			"Mail planted@example.test for access.",
			"The Project Nightjar launch.",
			`An em${EM}dash.`,
		].join("\n"),
	);
	git("add", "-A");
	git(
		"commit",
		"-q",
		"-m",
		`Add notes ${EN} first pass\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
	);
	writeFileSync(
		join(root, "body.md"),
		"Summary.\n\nGenerated with Claude Code\n",
	);
}

describe("publish-check (O19, R1 a)", () => {
	test("--help prints usage on stdout and exits 0", () => {
		const result = run(["--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("usage: publish-check");
	});

	test("a clean branch exits 0", () => {
		write("clean.md", "Nothing personal here.\n");
		git("add", "-A");
		git("commit", "-q", "-m", "Add clean notes");
		const result = run([]);
		expect(result).toMatchObject({ code: 0, stderr: "" });
		expect(result.stdout).toContain("clean");
		expect(json()).toEqual({
			code: 0,
			report: {
				contract: 1,
				tool: "publish-check",
				base: "main",
				findings: [],
				failing: 0,
			},
		});
	});

	test("planted values across a diff, a commit message and a body are found, in text and JSON", () => {
		plantEverything();
		const body = join(root, "body.md");
		const text = run(["--body", body]);
		expect(text.code).toBe(1);
		const { code, report } = json(["--body", body]);
		expect(code).toBe(1);
		const kinds = [...new Set(report.findings.map((f) => f.kind))].sort();
		expect(kinds).toEqual([
			"account",
			"attribution",
			"em-dash",
			"email",
			"en-dash",
			"home",
			"term",
		]);
		const where = (kind: string) =>
			report.findings.filter((f) => f.kind === kind).map((f) => f.where);
		expect(where("home")).toContain("notes.md:2");
		expect(where("account")).toContain("notes.md:3");
		expect(where("email")).toContain("notes.md:4");
		expect(where("term")).toEqual(["notes.md:5"]);
		expect(where("em-dash")).toEqual(["notes.md:6"]);
		expect(where("en-dash")[0]).toMatch(/^commit [0-9a-f]+:1$/);
		expect(where("attribution")).toHaveLength(2);
		expect(where("attribution")[1]).toBe("body:3");
		// Attribution is reported, and fails only under --forbid-attribution.
		const personal = report.findings.length - 2;
		expect(report.failing).toBe(personal);
		for (const line of text.stdout.trim().split("\n").slice(0, -1))
			expect(line).toMatch(/^[^:]+(?::\d+)?: [a-z-]+: /);
		// No finding repeats the value it found.
		expect(text.stdout).not.toContain(home);
		expect(text.stdout).not.toContain("planted@example.test");
		expect(text.stdout).not.toContain("Nightjar");
		const forbidden = json(["--body", body, "--forbid-attribution"]);
		expect(forbidden.report.failing).toBe(report.findings.length);
	});

	test("only attribution lines exit 0 unless forbidden", () => {
		write("x.md", "Plain.\n");
		git("add", "-A");
		git(
			"commit",
			"-q",
			"-m",
			"Plain\n\nCo-Authored-By: Codex <codex@example.test>",
		);
		expect(json()).toMatchObject({ code: 0, report: { failing: 0 } });
		expect(json().report.findings.map((f) => f.kind)).toEqual(["attribution"]);
		expect(json(["--forbid-attribution"])).toMatchObject({
			code: 1,
			report: { failing: 1 },
		});
	});

	test("--terms names another terms file; the account name matches whole words only", () => {
		const terms = join(root, "terms.txt");
		writeFileSync(terms, "Codename Heron\n");
		write("y.md", `Codename Heron.\nThe x${account}x word.\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "Terms");
		const { code, report } = json(["--terms", terms]);
		expect(code).toBe(1);
		expect(report.findings.map((f) => `${f.where} ${f.kind}`)).toEqual([
			"y.md:1 term",
		]);
	});

	test("--base names the base", () => {
		write("z.md", `Long${EM}dash.\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "Z");
		git("checkout", "-q", "-b", "next");
		write("w.md", "Clean.\n");
		git("add", "-A");
		git("commit", "-q", "-m", "W");
		expect(json(["--base", "feature"])).toMatchObject({
			code: 0,
			report: { base: "feature", failing: 0 },
		});
		expect(json()).toMatchObject({ code: 1, report: { base: "main" } });
	});

	test("usage and environment errors exit 2", () => {
		for (const args of [
			["--bogus"],
			["--base"],
			["--body", join(root, "missing.md")],
			["stray"],
		]) {
			const result = run(args);
			expect({ args, code: result.code }).toEqual({ args, code: 2 });
			expect(result.stderr).toContain("publish-check:");
		}
		expect(run(["--base", "no-such-ref"]).code).toBe(2);
		const outside = join(root, "outside");
		mkdirSync(outside);
		const result = run([], outside);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("not a git repository");
	});
});

describe("exemptions (O20, D6)", () => {
	test("ignored prefixes skip the dash check only; personal values are never exempt", () => {
		write(".publish-check-ignore", "# dash-matching code\nfixtures/\n");
		write("fixtures/dashes.ts", `const em = "${EM}";\nconst p = "${home}";\n`);
		write("evals/run.json", `"${EN}"\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "Fixtures");
		const { report } = json(["--ignore", "evals/"]);
		expect(report.findings.map((f) => `${f.where} ${f.kind}`)).toEqual([
			"fixtures/dashes.ts:2 home",
		]);
		// Without the flag, only the repository's own prefix applies.
		const unflagged = json();
		expect(
			unflagged.report.findings.map((f) => `${f.where} ${f.kind}`),
		).toEqual(["evals/run.json:1 en-dash", "fixtures/dashes.ts:2 home"]);
	});
});

describe("the package is publishable (O19, Extractable)", () => {
	const files = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? files(path) : [path];
		});

	test("no personal value of this machine appears in the package", () => {
		const values = [
			process.env.HOME,
			Bun.spawnSync(["git", "config", "user.email"]).stdout.toString().trim(),
		].filter((value): value is string => !!value && value !== "/");
		for (const file of files(packageDir)) {
			const text = readFileSync(file, "utf8");
			for (const value of values)
				expect({ file, found: text.includes(value) }).toEqual({
					file,
					found: false,
				});
			expect({
				file,
				found: new RegExp(`\\b${account}\\b`).test(text),
			}).toEqual({ file, found: false });
		}
	});

	test("the tool is POSIX sh and executable", () => {
		expect(readFileSync(tool, "utf8").split("\n")[0]).toBe("#!/bin/sh");
		expect(statSync(tool).mode & 0o111).not.toBe(0);
	});
});
