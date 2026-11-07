import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Builder, gitStamp, versionLine } from "./build-source";
import { exportAttempt, REDACTED, redactText } from "./export";
import {
	defaultLayout,
	type EvalLayout,
	EvalLayoutError,
	evalLayout,
	packagePath,
	redactedRoots,
	repositoryPath,
	requireGitRoot,
	sourceLayout,
} from "./layout";
import {
	buildSubject,
	EVALS_DIR,
	freeze,
	loadPolicy,
	parseOptions,
	prepareRun,
	readVersion,
	recheck,
	snapshotPackages,
} from "./run";
import { git, initShepherdRepo, testGit, writeAt } from "./source-fixture";
import { result } from "./testing";
import { trendLines } from "./trend";
import {
	ciGate,
	newestCommittedResult,
	parseVerifyArgs,
	verifyResults,
} from "./verify";

const PREFIX = "a/b/pkg";
const TOOL = "packages/software/tools/run-check";
const GUIDE = "packages/software/MODULE.md";

let scratch: string;

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-evals-layout-")));
});

afterEach(() => {
	// Snapshots are read only; make them removable first.
	spawnSync("chmod", ["-R", "u+w", scratch]);
	rmSync(scratch, { recursive: true, force: true });
});

/** A repository at `<scratch>/repo` holding the package at `a/b/pkg`. */
function nested(extra: Record<string, string> = {}): EvalLayout {
	const top = join(scratch, "repo");
	mkdirSync(top);
	initShepherdRepo(
		top,
		{
			"evals/shepherd/rubric.json": readFileSync(
				join(EVALS_DIR, "rubric.json"),
				"utf8",
			),
			"evals/shepherd/policy.json": readFileSync(
				join(EVALS_DIR, "policy.json"),
				"utf8",
			),
			[GUIDE]: "# Software\n",
			[TOOL]: "#!/bin/sh\necho checked\n",
			...extra,
		},
		{ prefix: PREFIX },
	);
	chmodSync(join(top, PREFIX, TOOL), 0o755);
	git(top, "add", "-A");
	git(top, "commit", "-q", "-m", "tool mode");
	return evalLayout({ packageRoot: join(top, PREFIX), git: testGit });
}

const commitAll = (layout: EvalLayout, message: string) => {
	git(layout.gitRoot, "add", "-A");
	git(layout.gitRoot, "commit", "-q", "-m", message);
	return git(layout.gitRoot, "rev-parse", "HEAD").trim();
};

/** Writes a binary that prints its build's stamp, as a real build would. */
const stampingBuild =
	(layout: EvalLayout): Builder =>
	async (request) => {
		const line = versionLine(
			await gitStamp(testGit, sourceLayout(layout)).capture(layout.packageRoot),
		);
		writeFileSync(request.outFile, `#!/bin/sh\necho '${line}'\n`);
		chmodSync(request.outFile, 0o755);
	};

async function built(layout: EvalLayout) {
	const run = prepareRun({ root: layout, scratchParent: scratch });
	const subject = await buildSubject({
		root: layout,
		runDir: run.runDir,
		build: stampingBuild(layout),
		stamp: gitStamp(testGit, sourceLayout(layout)),
	});
	return { run, ...subject };
}

describe("the explicit layout (O24b)", () => {
	test("the default is the package holding the evals, in the repository Git names", () => {
		const layout = defaultLayout();
		expect(layout.evalsDir).toBe(EVALS_DIR);
		expect(join(layout.packageRoot, "evals/shepherd")).toBe(EVALS_DIR);
		expect(realpathSync(join(layout.gitRoot, layout.prefix))).toBe(
			realpathSync(layout.packageRoot),
		);
		expect(layout.subject).toBe("");
	});

	test("a nested package gets its prefix, and maps paths both ways", () => {
		const layout = nested();
		expect(layout.prefix).toBe(PREFIX);
		expect(realpathSync(layout.gitRoot)).toBe(join(scratch, "repo"));
		expect(layout.evalsDir).toBe(
			join(scratch, "repo", PREFIX, "evals/shepherd"),
		);
		expect(packagePath(layout, `${PREFIX}/lib/shepherd/tool.ts`)).toBe(
			"lib/shepherd/tool.ts",
		);
		expect(packagePath(layout, "lib/shepherd/tool.ts")).toBeUndefined();
		expect(packagePath(layout, `${PREFIX}-other/x`)).toBeUndefined();
		expect(repositoryPath(layout, "evals/shepherd/results/")).toBe(
			`${PREFIX}/evals/shepherd/results/`,
		);
	});

	test("refuses a package outside its repository and a subject that escapes the run", () => {
		expect(() =>
			evalLayout({ packageRoot: "/srv/pkg", gitRoot: "/srv/repo" }),
		).toThrow(EvalLayoutError);
		for (const subject of ["/abs/install", "../up", "x/../../y"]) {
			expect(() =>
				evalLayout({ packageRoot: "/srv/repo", gitRoot: "/srv/repo", subject }),
			).toThrow(/subject directory/);
		}
		expect(
			evalLayout({
				packageRoot: "/srv/repo",
				gitRoot: "/srv/repo",
				subject: "./install//x/",
			}).subject,
		).toBe("install/x");
	});

	test("checks require a Git root: a clear refusal outside Git", () => {
		const loose = join(scratch, "loose");
		mkdirSync(join(loose, "evals/shepherd"), { recursive: true });
		expect(() => evalLayout({ packageRoot: loose, git: testGit })).toThrow(
			/require a Git root: .* is not inside a Git repository/,
		);
		const given = evalLayout({ packageRoot: loose, gitRoot: loose });
		expect(() => requireGitRoot(given, testGit)).toThrow(/require a Git root/);
		expect(() => trendLines(given, { git: testGit })).toThrow(
			/require a Git root/,
		);
		const verification = verifyResults(given, { git: testGit });
		expect(verification.ok).toBe(false);
		expect(verification.problems.join("\n")).toMatch(/require a Git root/);
		const outcome = ciGate(given, "HEAD", "HEAD", { git: testGit });
		expect(outcome.code).toBe(1);
		expect(outcome.lines.join("\n")).toMatch(/require a Git root/);
	});

	test("the verifier entry refuses a package root outside Git, and keeps its usage exit", () => {
		const loose = join(scratch, "loose");
		mkdirSync(loose);
		const verify = (...args: string[]) =>
			spawnSync("bun", [join(EVALS_DIR, "verify.ts"), ...args], {
				encoding: "utf8",
				timeout: 120_000,
			});
		const refused = verify(
			"--base",
			"x",
			"--head",
			"y",
			"--package-root",
			loose,
		);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toMatch(/require a Git root/);
		expect(verify("--base", "x").status).toBe(2);
		expect(verify("--base", "x", "--head", "y", "extra").status).toBe(2);
	});

	test("command lines take explicit layout flags beside their current ones", () => {
		expect(parseVerifyArgs(["--base", "b", "--head", "h"])).toEqual({
			base: "b",
			head: "h",
			packageRoot: undefined,
			gitRoot: undefined,
		});
		expect(
			parseVerifyArgs([
				"--base",
				"b",
				"--head",
				"h",
				"--package-root",
				"/p",
				"--git-root",
				"/g",
			]),
		).toEqual({ base: "b", head: "h", packageRoot: "/p", gitRoot: "/g" });
		expect(parseVerifyArgs(["--head", "h"])).toBeUndefined();
		expect(
			parseVerifyArgs(["--base", "b", "--head", "h", "--x"]),
		).toBeUndefined();
		expect(parseOptions(["--subject-dir", "install/x"]).layout).toEqual({
			packageRoot: undefined,
			gitRoot: undefined,
			subject: "install/x",
		});
		expect(parseOptions(["--trend", "--package-root", "/p"]).layout).toEqual({
			packageRoot: "/p",
			gitRoot: undefined,
			subject: undefined,
		});
		expect(() => parseOptions(["--trend", "--subject-dir", "x"])).toThrow(
			/no other option/,
		);
	});
});

describe("a nested prefix (O24b)", () => {
	test("the verifier gates only package paths, as package paths, and a missing result stays informational", () => {
		const layout = nested();
		const base = git(layout.gitRoot, "rev-parse", "HEAD").trim();
		writeAt(layout.gitRoot, "OUTSIDE.md", "changed outside\n");
		// The same path as a package source file, but outside the package.
		writeAt(layout.gitRoot, "lib/shepherd/tool.ts", "outside\n");
		const outside = commitAll(layout, "outside only");
		const quiet = ciGate(layout, base, outside, { git: testGit });
		expect(quiet.code).toBe(0);
		expect(quiet.lines.join("\n")).toMatch(/not required: no gated path/);

		writeAt(
			layout.packageRoot,
			"lib/shepherd/tool.ts",
			"export const t = 2;\n",
		);
		const inside = commitAll(layout, "package source");
		const outcome = ciGate(layout, base, inside, { git: testGit });
		expect(outcome.code).toBe(0);
		const text = outcome.lines.join("\n");
		expect(text).toContain("\n  lib/shepherd/tool.ts");
		expect(text).not.toContain(`${PREFIX}/lib/shepherd/tool.ts`);
		expect(text).toMatch(
			/no result for this source; the check is informational/,
		);
		expect(text).toMatch(
			/No result for source sha256:[0-9a-f]{64}: expected evals\/shepherd\/results\//,
		);
		expect(outcome.notice).toMatch(/No result is committed\./);
	});

	test("the newest committed result and the trend read the package's results, not the repository top's", () => {
		const layout = nested();
		const revision = git(layout.gitRoot, "rev-parse", "HEAD").trim();
		const value = result();
		const build = value.evaluation.invocations[0]?.build;
		if (build) build.revision = revision;
		const decoy = `evals/shepherd/results/${"d".repeat(64)}.json`;
		writeAt(layout.gitRoot, decoy, JSON.stringify(value));
		commitAll(layout, "a decoy result at the repository top");
		expect(trendLines(layout, { git: testGit })).toEqual([
			"No result is committed at HEAD.",
		]);
		expect(newestCommittedResult(layout, { git: testGit })).toBe(
			"No result is committed.",
		);
		const own = `evals/shepherd/results/${"a".repeat(64)}.json`;
		writeAt(layout.packageRoot, own, JSON.stringify(value));
		commitAll(layout, "the package's result");
		const lines = trendLines(layout, { git: testGit });
		expect(lines[0]).toMatch(/: 1 evaluations in 1 result files/);
		expect(newestCommittedResult(layout, { git: testGit })).toMatch(
			new RegExp(`^Newest committed result: ${own}, revision ${revision}`),
		);
	});

	test("a nested build freezes and rechecks the package's own source and evaluation identity", async () => {
		const layout = nested();
		const { run, subject, provenance, packages } = await built(layout);
		const { policy, hash } = loadPolicy();
		const config = join(run.runDir, "config.json");
		writeFileSync(config, "{}\n");
		const frozen = freeze({
			root: layout,
			runId: run.runId,
			config,
			subject,
			provenance,
			versionOutput: readVersion(subject),
			policy,
			policyHash: hash,
			packages,
			git: testGit,
		});
		expect(frozen.manifest.entries.map((e) => e.path)).toContain(
			"lib/shepherd/tool.ts",
		);
		expect(recheck(frozen, { root: layout, git: testGit })).toEqual([]);
		writeAt(layout.gitRoot, "OUTSIDE.md", "changed outside\n");
		expect(recheck(frozen, { root: layout, git: testGit })).toEqual([]);
		writeAt(
			layout.packageRoot,
			"lib/shepherd/tool.ts",
			"export const t = 3;\n",
		);
		writeAt(layout.packageRoot, "evals/shepherd/policy.json", "{}\n");
		const reasons = recheck(frozen, { root: layout, git: testGit }).join("\n");
		expect(reasons).toMatch(/source identity changed/);
		expect(reasons).toMatch(/evaluation identity changed/);
	});

	test("refuses a scratch directory inside the repository, even outside the package", () => {
		const layout = nested();
		const inRepo = join(layout.gitRoot, "scratch");
		mkdirSync(inRepo);
		expect(() => prepareRun({ root: layout, scratchParent: inRepo })).toThrow(
			/inside the repository/,
		);
	});
});

describe("a nonstandard subject directory (O24b)", () => {
	test("the subject installs beneath the layout's subject directory, never the package's bin", async () => {
		const layout = { ...nested(), subject: "install/x" };
		const { run, subject, packages } = await built(layout);
		const install = join(realpathSync(run.runDir), "install/x");
		expect(subject).toBe(join(install, "bin/shepherd"));
		expect(packages.dir).toBe(join(install, "packages"));
		expect(readdirSync(run.runDir).sort()).toEqual(["artifacts", "install"]);
		expect(existsSync(join(layout.packageRoot, "bin"))).toBe(false);
		expect(readVersion(subject)).toMatch(/^shepherd revision=/);
	});
});

describe("runtime package snapshots (O30)", () => {
	test("the subject gets the package's runtime packages beside its bin, bytes and executable bits frozen", async () => {
		const layout = nested();
		const { packages } = await built(layout);
		expect(packages.files.map((f) => [f.path, f.executable])).toEqual([
			[GUIDE, false],
			[TOOL, true],
		]);
		const tool = join(packages.dir, TOOL.slice("packages/".length));
		const guide = join(packages.dir, GUIDE.slice("packages/".length));
		expect(readFileSync(tool, "utf8")).toBe("#!/bin/sh\necho checked\n");
		expect(readFileSync(guide, "utf8")).toBe("# Software\n");
		expect(lstatSync(tool).mode & 0o777).toBe(0o555);
		expect(lstatSync(guide).mode & 0o777).toBe(0o444);
		for (const dir of [packages.dir, join(packages.dir, "software/tools")])
			expect(lstatSync(dir).mode & 0o222).toBe(0);
		expect(spawnSync(tool).stdout.toString()).toBe("checked\n");
	});

	test("a source edit after the snapshot never reaches the subject; a tampered snapshot invalidates the run", async () => {
		const layout = nested();
		const { run, subject, provenance, packages } = await built(layout);
		const { policy, hash } = loadPolicy();
		const config = join(run.runDir, "config.json");
		writeFileSync(config, "{}\n");
		const frozen = freeze({
			root: layout,
			runId: run.runId,
			config,
			subject,
			provenance,
			versionOutput: readVersion(subject),
			policy,
			policyHash: hash,
			packages,
			git: testGit,
		});
		const tool = join(packages.dir, TOOL.slice("packages/".length));
		writeAt(layout.packageRoot, TOOL, "#!/bin/sh\necho edited\n");
		expect(readFileSync(tool, "utf8")).toBe("#!/bin/sh\necho checked\n");
		expect(() => writeFileSync(tool, "tampered\n")).toThrow();
		// The source edit itself invalidates the run, through the source identity.
		expect(recheck(frozen, { root: layout, git: testGit }).join("\n")).toMatch(
			/source identity changed/,
		);
		writeAt(layout.packageRoot, TOOL, "#!/bin/sh\necho checked\n");
		expect(recheck(frozen, { root: layout, git: testGit })).toEqual([]);
		chmodSync(tool, 0o644);
		const reasons = recheck(frozen, { root: layout, git: testGit }).join("\n");
		expect(reasons).toMatch(/runtime package snapshot changed/);
		expect(reasons).toMatch(/executable status changed: packages\/software/);
		writeFileSync(tool, "tampered\n");
		expect(recheck(frozen, { root: layout, git: testGit }).join("\n")).toMatch(
			/runtime package bytes changed: packages\/software\/tools\/run-check/,
		);
		chmodSync(join(packages.dir, "software"), 0o755);
		writeFileSync(join(packages.dir, "software/extra.md"), "x\n");
		expect(recheck(frozen, { root: layout, git: testGit }).join("\n")).toMatch(
			/runtime package file added: packages\/software\/extra\.md/,
		);
	});

	test("refuses to snapshot a package file whose bytes changed after the build read them", async () => {
		const layout = nested();
		const { provenance } = await built(layout);
		writeAt(layout.packageRoot, GUIDE, "# Changed\n");
		expect(() =>
			snapshotPackages({
				packageRoot: layout.packageRoot,
				manifest: provenance.manifest,
				into: join(scratch, "again/packages"),
			}),
		).toThrow(
			/changed after the build read it: packages\/software\/MODULE\.md/,
		);
	});
});

describe("redaction from the layout, roots outside HOME (O24b)", () => {
	const SCRATCH = "/tmp/run";

	test("both roots are redacted, a sibling sharing a prefix string is not, and home need not hold them", () => {
		const layout = evalLayout({
			packageRoot: "/srv/repo/a/b/pkg",
			gitRoot: "/srv/repo",
		});
		const context = {
			scratchRoot: SCRATCH,
			home: "/Users/elsewhere",
			...redactedRoots(layout),
		};
		const redact = (text: string) => redactText(text, context).text;
		expect(redact("cat /srv/repo/README.md")).toBe(`cat ${REDACTED}`);
		expect(redact("ls /srv/repo/a/b/pkg/evals")).toBe(`ls ${REDACTED}`);
		expect(redact("ls /srv/repo-old/x /srv/repository")).toBe(
			"ls /srv/repo-old/x /srv/repository",
		);
		expect(redact(`${SCRATCH}/A/workspace`)).toBe(`${SCRATCH}/A/workspace`);
	});

	test("a package root apart from the repository root is redacted on its own", () => {
		const context = {
			scratchRoot: SCRATCH,
			home: "/Users/elsewhere",
			repoRoot: "/srv/repo",
			packageRoot: "/data/pkg",
		};
		const redact = (text: string) => redactText(text, context).text;
		expect(redact("a /data/pkg/agents/shepherd.md b")).toBe(`a ${REDACTED} b`);
		expect(redact("a /srv/repo b")).toBe(`a ${REDACTED} b`);
		expect(redact("a /data/pkg-old/x /data/pkgs b")).toBe(
			"a /data/pkg-old/x /data/pkgs b",
		);
	});

	test("the reverse: roots inside home are redacted too, and the export carries both roots", () => {
		const home = join(scratch, "home");
		const layout = evalLayout({
			packageRoot: join(home, "repo/pkg"),
			gitRoot: join(home, "repo"),
		});
		const from = join(scratch, "raw");
		mkdirSync(from);
		writeFileSync(
			join(from, "notes.txt"),
			`${layout.packageRoot}/x\n${layout.gitRoot}/y\n/srv/kept/z\n`,
		);
		const to = join(scratch, "exported");
		exportAttempt({
			from,
			to,
			scratchRoot: SCRATCH,
			home,
			...redactedRoots(layout),
		});
		expect(readFileSync(join(to, "notes.txt"), "utf8")).toBe(
			`${REDACTED}\n${REDACTED}\n/srv/kept/z\n`,
		);
		const outside = evalLayout({
			packageRoot: "/srv/a/pkg",
			gitRoot: "/srv/a",
		});
		expect(
			redactText("/srv/a/pkg/x and /srv/a/y", {
				scratchRoot: SCRATCH,
				home,
				...redactedRoots(outside),
			}).text,
		).toBe(`${REDACTED} and ${REDACTED}`);
	});
});
