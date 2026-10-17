// Runs packages/software/tools/publish-check against throwaway repositories.
// It imports nothing from Troupe: the package carries its own proof.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
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
// A fake id first on PATH plants this account, so no test depends on the
// account of the machine it runs on.
const account = "plantedacct";

// The tool compares $HOME as text, and git needs no home with repo-local
// config, so the fixture home is a fixed string that names no account.
const home = "/nonexistent/publish-check-home";
let root: string;
let config: string;
let repo: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
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

function json(
	args: string[] = [],
	cwd = repo,
): { code: number; report: Report } {
	const result = run([...args, "--json"], cwd);
	return { code: result.code, report: JSON.parse(result.stdout) as Report };
}

beforeEach(() => {
	// Named after the account, so a report that echoes or scans an
	// absolute fixture path fails the exact finding lists.
	root = realpathSync(mkdtempSync(join(tmpdir(), `${account}-`)));
	config = join(root, "config");
	repo = join(root, "repo");
	for (const dir of [config, repo, join(root, "bin")]) mkdirSync(dir);
	writeFileSync(join(root, "bin/id"), `#!/bin/sh\necho ${account}\n`, {
		mode: 0o755,
	});
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

describe("what the scan reads", () => {
	const found = (args: string[] = []) =>
		json(args).report.findings.map((f) => `${f.where} ${f.kind}`);

	test("the account name at column 1 is found (S1)", () => {
		write("a.md", `${account} wrote this.\nAsk ${account} here.\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "A");
		expect(found()).toEqual(["a.md:1 account", "a.md:2 account"]);
	});

	test("an added line starting with ++ is a line, not a file header (F1, S2)", () => {
		write("b.md", "keep\n-- old line\n");
		git("add", "-A");
		git("commit", "-q", "-m", "B");
		git("tag", "start");
		write("b.md", `keep\n++ new ${home}/x\n`);
		git("commit", "-q", "-am", "Replace");
		expect(found(["--base", "start"])).toEqual(["b.md:2 home"]);
	});

	test("a path holding a space keeps its line number (F2)", () => {
		write("dir with space/a.md", `${home}/x\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "Space");
		expect(found()).toEqual(["dir with space/a.md:1 home"]);
	});

	test("file names are scanned, renames included, and never repeated (F3)", () => {
		const terms = join(root, "terms.txt");
		writeFileSync(terms, "nightjar\n");
		write("plain.md", "Plain text.\n");
		git("add", "-A");
		git("commit", "-q", "-m", "Plain");
		git("tag", "start");
		write(`${account}.md`, "Clean text.\n");
		git("mv", "plain.md", "nightjar-notes.md");
		git("add", "-A");
		git("commit", "-q", "-m", "Names");
		const { code, report } = json(["--base", "start", "--terms", terms]);
		expect(code).toBe(1);
		expect(report.findings.map((f) => f.kind).sort()).toEqual([
			"account",
			"term",
		]);
		for (const { where } of report.findings)
			expect(where).toMatch(/^path \d+$/);
		const text = run(["--base", "start", "--terms", terms]).stdout;
		expect(text).not.toContain("nightjar");
		expect(text).not.toMatch(new RegExp(`\\b${account}\\b`));
	});

	test("a line in a file whose name holds a personal value is placed by the name's number", () => {
		write(`notes-${account}.md`, `Clean.\nAn em${EM}dash.\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "Named notes");
		expect(found()).toEqual(["path 1 account", "path 1:2 em-dash"]);
	});

	test("the caller's diff.noprefix changes no where (A1)", () => {
		git("config", "diff.noprefix", "true");
		write(`b/${account}.md`, `${home}/x\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "Prefix");
		expect(found()).toEqual(["path 1 account", "path 1:1 home"]);
	});

	test("the caller's diff.relative does not narrow the scan to a subdirectory (A1)", () => {
		git("config", "diff.relative", "true");
		write("sub/in.md", "Clean.\n");
		write(`out/${account}.md`, `${home}/x\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "Relative");
		const { code, report } = json([], join(repo, "sub"));
		expect(code).toBe(1);
		expect(report.findings.map((f) => `${f.where} ${f.kind}`)).toEqual([
			"path 1 account",
			"path 1:1 home",
		]);
	});

	test("a line of a C-quoted, personally named file is placed by the name's number (B4)", () => {
		write(`q"${account}.md`, `Clean.\nAn em${EM}dash.\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "Quoted name");
		expect(found()).toEqual(["path 1 account", "path 1:2 em-dash"]);
	});

	test("a dash in an ignored file name is exempt, as in its lines (F3, D6)", () => {
		write(`fixtures/a${EM}b.md`, "Clean.\n");
		write(`notes/a${EN}b.md`, "Clean.\n");
		git("add", "-A");
		git("commit", "-q", "-m", "Dashed names");
		expect(found(["--ignore", "fixtures/"])).toEqual(["path 2 en-dash"]);
	});

	test("a branch with no merge base is an error, not clean (F5, S3)", () => {
		git("checkout", "-q", "--orphan", "lonely");
		write("c.md", "Alone.\n");
		git("add", "-A");
		git("commit", "-q", "-m", "Lonely");
		const result = run([]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("no merge base between main and HEAD");
		expect(result.stdout).toBe("");
	});

	test("a relative --body shaped like an awk assignment is read as a file (F10)", () => {
		writeFileSync(join(repo, "x=1"), `${home}/body\n`);
		expect(found(["--body", "x=1"])).toEqual(["body:1 home"]);
	});
});

describe("the package is publishable (O19, Extractable)", () => {
	test("the tool is POSIX sh and executable", () => {
		expect(readFileSync(tool, "utf8").split("\n")[0]).toBe("#!/bin/sh");
		expect(statSync(tool).mode & 0o111).not.toBe(0);
	});
});
