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
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
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

type Meta = { covers?: string[]; depends_on?: string[]; tests?: string[] };

function list(items: string[]): string {
	return items.length ? `\n${items.map((i) => `  - ${i}`).join("\n")}` : " []";
}

function frontMatter(component: string, meta: Meta = {}): string {
	return `---\ncomponent: ${component}\ncovers:${list(meta.covers ?? [])}\ndepends_on:${list(meta.depends_on ?? [])}\ntests:${list(meta.tests ?? [])}\n---\n`;
}

function coverageLine(n: number, t: number, p = 0, m = 0, u = 0): string {
	return `Coverage: ${n} obligations; ${t} proved by test, ${p} by PR evidence, ${m} mixed, ${u} unproved. Suite runs against this implementation.\n`;
}

const WRITING_TEST = "test/contract/writing_contract_test.rb";

function obligation(
	id: string,
	parts: {
		title?: string;
		statement?: string;
		reason?: string | null;
		proof?: string | null;
	} = {},
): string {
	const {
		title = `the ${id} promise`,
		statement = `${id} holds.`,
		reason = "Readers rely on it.",
		proof = `Kind: functional. Proof: test, ${id} in \`${WRITING_TEST}\`.`,
	} = parts;
	return [
		`### ${id} ${title}`,
		"",
		statement,
		"",
		...(reason === null ? [] : [`**Reason.** ${reason}`, ""]),
		...(proof === null ? [] : [proof, ""]),
	].join("\n");
}

/** A canonical writing Contract with every file it names. */
function writing(
	body = `${obligation("WR-1")}\n${obligation("WR-2")}`,
	meta: Meta = {},
	count = (body.match(/^### [A-Z]+-\d+ /gm) ?? []).length,
) {
	write("app/writing/post.rb", "# post\n");
	write(WRITING_TEST, "# test\n");
	write(
		"docs/contracts/writing.md",
		`${frontMatter("writing", { covers: ["app/writing/"], tests: [WRITING_TEST], ...meta })}${coverageLine(count, count)}\n# Contract: writing\n\nHow posts are written.\n\n${body}`,
	);
}

/** `file:line code` for the findings on one file. */
function on(file: string, args: string[] = ["lint"]): string[] {
	return found(args).filter(
		(f) => f.startsWith(`${file}:`) || f.startsWith(`${file} `),
	);
}

describe("lint reports and statuses (CT-2)", () => {
	test("a clean canonical Contract is clean, exit 0", () => {
		writing();
		const text = run(["lint"]);
		expect(text).toEqual({
			code: 0,
			stdout: "contract lint: clean\n",
			stderr: "",
		});
		const { code, report } = json(["lint"]);
		expect(code).toBe(0);
		expect(report).toMatchObject({ status: "clean", findings: [], failing: 0 });
		expect(report.result).toMatchObject({
			files: [
				{
					file: "docs/contracts/writing.md",
					format: "canonical",
					component: "writing",
					complete: true,
				},
			],
		});
	});

	test("warnings alone exit 0 with status warnings; an error finding exits 1 with status findings", () => {
		writing(undefined, { depends_on: ["markdown_renderer"] });
		expect(json(["lint"])).toMatchObject({
			code: 0,
			report: { status: "warnings", failing: 0 },
		});
		expect(run(["lint"]).stdout).toBe(
			"docs/contracts/writing.md:6: dependency-missing: depends on markdown_renderer, which has no Contract file\ncontract lint: 1 findings, 0 failing\n",
		);
		writing(`${obligation("WR-1", { reason: null })}\n${obligation("WR-2")}`);
		const text = run(["lint"]);
		expect(text.code).toBe(1);
		expect(text.stderr).toBe("");
		expect(text.stdout).toContain(
			"docs/contracts/writing.md:15: reason-missing: WR-1 has no reason\n",
		);
		const { code, report } = json(["lint"]);
		expect(code).toBe(1);
		expect(report).toMatchObject({ status: "findings", failing: 1 });
		expect(report.findings.find((f) => f.code === "reason-missing")).toEqual({
			code: "reason-missing",
			severity: "error",
			file: "docs/contracts/writing.md",
			line: 15,
			obligationId: "WR-1",
			message: "WR-1 has no reason",
		});
	});
});

const FIELDS = (rest: string) => `component: writing\n${rest}`;
const ALL = "covers: []\ndepends_on: []\ntests: []\n";

describe("restricted metadata (CT-3)", () => {
	const cases: [string, string, string | null][] = [
		["plain", FIELDS(ALL), null],
		["double-quoted with escapes", `component: "wri\\u0074ing"\n${ALL}`, null],
		[
			"single-quoted with a doubled quote",
			`component: 'writing'\ncovers: ['it''s/x.rb']\ndepends_on: []\ntests: []\n`,
			null,
		],
		[
			"comments and blank lines",
			`# metadata\ncomponent: writing # the slug\n\ncovers: [] # none\ndepends_on: []\ntests: []\n`,
			null,
		],
		[
			"block and flow lists, quoting protecting delimiters",
			FIELDS(
				`covers:\n  - app/writing/\n  - "app/#x, y"\ndepends_on: [renderer_a, "renderer_b"]\ntests: []\n`,
			),
			null,
		],
		[
			"a duplicate key",
			FIELDS(`covers: []\ncovers: []\ndepends_on: []\ntests: []\n`),
			"frontmatter-yaml",
		],
		["an unknown key", FIELDS(`${ALL}owner: me\n`), "frontmatter-fields"],
		[
			"a missing key",
			FIELDS("covers: []\ndepends_on: []\n"),
			"frontmatter-fields",
		],
		[
			"a string where a list belongs",
			FIELDS("covers: app/\ndepends_on: []\ntests: []\n"),
			"frontmatter-fields",
		],
		[
			"a list where the slug belongs",
			`component: [writing]\n${ALL}`,
			"frontmatter-fields",
		],
		[
			"an empty value",
			FIELDS("covers:\ndepends_on: []\ntests: []\n"),
			"frontmatter-fields",
		],
		[
			"a slug that is not the file name",
			`component: reading\n${ALL}`,
			"component-name",
		],
		[
			"a slug outside the grammar",
			`component: Writing\n${ALL}`,
			"component-name",
		],
		[
			"an anchor and alias",
			FIELDS("covers: &a []\ndepends_on: *a\ntests: []\n"),
			"frontmatter-yaml",
		],
		["a merge key", FIELDS(`${ALL}<<: {}\n`), "frontmatter-yaml"],
		["a tag", `component: !!str writing\n${ALL}`, "frontmatter-yaml"],
		["a directive", `%YAML 1.2\n${FIELDS(ALL)}`, "frontmatter-yaml"],
		[
			"a multiline scalar",
			`component: >\n  writing\n${ALL}`,
			"frontmatter-yaml",
		],
		[
			"a nested mapping",
			FIELDS("covers:\n  app: x\ndepends_on: []\ntests: []\n"),
			"frontmatter-yaml",
		],
		[
			"a nested list",
			FIELDS("covers:\n  - - app/\ndepends_on: []\ntests: []\n"),
			"frontmatter-yaml",
		],
		["an extra document", `${FIELDS(ALL)}...\n`, "frontmatter-yaml"],
	];
	test.each(cases)("%s", (_name, yaml, code) => {
		write(WRITING_TEST, "# test\n");
		write("it's/x.rb", "# x\n");
		write("app/#x, y", "# x\n");
		write("app/writing/post.rb", "# post\n");
		write(
			"docs/contracts/writing.md",
			`---\n${yaml}---\n${coverageLine(0, 0)}\n# Contract: writing\n`,
		);
		const { report } = json(["lint"]);
		const codes = report.findings
			.filter((f) => f.severity === "error")
			.map((f) => f.code);
		expect(codes).toEqual(code === null ? [] : [code]);
		if (code === null)
			expect(report.result.files).toMatchObject([
				{ format: "canonical", component: "writing", complete: true },
			]);
	});

	test("quoted values and flow lists keep their text", () => {
		write("app/#x, y", "# x\n");
		write("it's/x.rb", "# x\n");
		write(
			"docs/contracts/writing.md",
			`---\ncomponent: "wri\\u0074ing"\ncovers: ['it''s/x.rb', "app/#x, y"] # two\ndepends_on: [renderer_a, "renderer_b"]\ntests: []\n---\n${coverageLine(0, 0)}`,
		);
		expect(json(["lint"]).report.result.files).toMatchObject([
			{
				component: "writing",
				metadata: {
					covers: ["it's/x.rb", "app/#x, y"],
					depends_on: ["renderer_a", "renderer_b"],
					tests: [],
				},
			},
		]);
	});

	test("an unterminated front matter block is frontmatter-yaml", () => {
		write(
			"docs/contracts/writing.md",
			`---\n${FIELDS(ALL)}\n# Contract: writing\n`,
		);
		expect(on("docs/contracts/writing.md")).toEqual([
			"docs/contracts/writing.md:1 frontmatter-yaml",
		]);
	});
});

describe("obligation parsing (CT-4)", () => {
	test("long statements, grouping headings and shuffled IDs parse; examples in code and comments are not obligations", () => {
		const fence = "```";
		writing(
			[
				"## Safety",
				"",
				"### Notes on the examples",
				"",
				"Grouping prose.",
				"",
				obligation("WR-5", {
					statement:
						"The first sentence.\nIt keeps going.\n\nA second paragraph of the same statement.",
				}),
				fence,
				"### WR-9 an example inside a fence",
				fence,
				"",
				"    ### WR-8 an indented example",
				"",
				"<!--",
				"### WR-7 a commented example",
				"-->",
				"",
				obligation("WR-4"),
			].join("\n"),
			{},
			2,
		);
		const { code, report } = json(["lint"]);
		expect(report.findings).toEqual([]);
		expect(code).toBe(0);
		const [file] = report.result.files as {
			obligations: { id: string; statement: string }[];
		}[];
		expect(file?.obligations.map((o) => o.id)).toEqual(["WR-5", "WR-4"]);
		expect(file?.obligations[0]?.statement).toBe(
			"The first sentence.\nIt keeps going.\n\nA second paragraph of the same statement.",
		);
	});

	test("AC-010 and AC-10 collide; a second prefix and a missing reason are findings", () => {
		writing(
			[
				obligation("WR-010"),
				obligation("WR-10"),
				obligation("XY-1"),
				obligation("WR-2", { reason: null }),
			].join("\n"),
		);
		expect(found(["lint"]).filter((f) => !f.includes("coverage-"))).toEqual([
			"docs/contracts/writing.md:23 obligation-id-duplicate",
			"docs/contracts/writing.md:31 obligation-prefix",
			"docs/contracts/writing.md:39 reason-missing",
		]);
	});

	test("malformed obligation headings are findings, not grouping headings", () => {
		writing(
			[
				obligation("WR-1"),
				"### wr-2 lowercase prefix\n\nX.\n",
				"### WR-0 number zero\n\nX.\n",
				"### WR-3\n\nNo title.\n",
				`### WR-4 ${EM} the old separator\n\nX.\n`,
			].join("\n"),
		);
		expect(
			found(["lint"]).filter((f) => f.endsWith("obligation-heading")),
		).toHaveLength(4);
	});

	test("two components sharing a prefix are prefix-shared on both files, an error while both are canonical (ruling 1)", () => {
		writing();
		write(
			"docs/contracts/reading.md",
			`${frontMatter("reading", { tests: [WRITING_TEST] })}${coverageLine(1, 1)}\n# Contract: reading\n\n${obligation("WR-9")}`,
		);
		const { report } = json(["lint"]);
		expect(
			report.findings
				.filter((f) => f.code === "prefix-shared")
				.map((f) => [f.file, f.severity, f.message]),
		).toEqual([
			[
				"docs/contracts/reading.md",
				"error",
				"prefix WR is also used by docs/contracts/writing.md",
			],
			[
				"docs/contracts/writing.md",
				"error",
				"prefix WR is also used by docs/contracts/reading.md",
			],
		]);
		write(
			"docs/contracts/reading.md",
			`# Contract: reading\n\n**Code it covers.** app/reading/.\n\n### WR-9 ${EM} legacy\n\nX.\n`,
		);
		expect(
			json(["lint"])
				.report.findings.filter((f) => f.code === "prefix-shared")
				.map((f) => f.severity),
		).toEqual(["warning", "warning"]);
	});
});

describe("convention examples (CT-5)", () => {
	const MR_TEST = "test/contract/markdown_renderer_contract_test.rb";
	const LEDGER = "test/contracts/agency_client_port/ledger.yml";

	function mr5(coverage: string) {
		write("app/services/markdown_renderer.rb", "#\n");
		write("app/helpers/markdown_helper.rb", "#\n");
		write(MR_TEST, "#\n");
		write("docs/decisions/markdown_renderer.md", "# D-6\n");
		write(
			"docs/contracts/markdown_renderer.md",
			`${frontMatter("markdown_renderer", { covers: ["app/services/markdown_renderer.rb", "app/helpers/markdown_helper.rb"], tests: [MR_TEST] })}${coverage}\n# Contract: the Markdown renderer\n\n## Safety\n\n### MR-5 a link or image with an unsafe URL loses its URL and keeps its text\n\nA link whose URL uses \`javascript:\` loses its URL and keeps its text.\n\n**Reason.** Those schemes can run script. (D-6)\n\nKind: functional. Proof: test, the five tests named MR-5 in \`${MR_TEST}\`.\n\n## Decisions\n\n- D-6, \`docs/decisions/markdown_renderer.md\` (today \`DECISIONS.md\`): raw HTML is omitted, and unsafe URLs are emptied (MR-4, MR-5).\n`,
		);
	}

	function ac010(decisions: string) {
		write(LEDGER, "cases: []\n");
		write("app/models/agency/client.rb", "#\n");
		write(
			"docs/contracts/agency_client_port.md",
			`${frontMatter("agency_client_port", { covers: ["app/models/agency/"], tests: ["test/contracts/agency_client_port/"] })}Coverage: 1 obligations; 1 proved by test, 0 by PR evidence, 0 unproved. Suite runs against this implementation.\n\n# Contract: agency client port\n\n### AC-010 Vitor safety\n\nRegistered identities make all D11 document fields immutable.\n\n**Reason.** The Vitor push is held. (D11, Proposal 9; INV-009)\n\nKind: functional. Proof: test, the cases whose \`intent\` names AC-010 in \`${LEDGER}\`.\n${decisions}`,
		);
	}

	test("the MR-5 example, completed with its files, is clean", () => {
		mr5(coverageLine(1, 1).replace(" 0 mixed,", ""));
		const { code, report } = json(["lint"]);
		expect({ code, findings: report.findings }).toEqual({
			code: 0,
			findings: [],
		});
		expect(report.result.files).toMatchObject([
			{
				component: "markdown_renderer",
				obligations: [{ id: "MR-5" }],
				complete: true,
			},
		]);
	});

	test("the AC-010 example needs D11 and INV-009 in its index, never Proposal 9; ledger proof is a path", () => {
		write("docs/decisions/d11.md", "#\n");
		write("docs/decisions/inv-009.md", "#\n");
		ac010("");
		expect(found(["lint"])).toEqual([
			"docs/contracts/agency_client_port.md:17 decisions-missing",
		]);
		ac010(
			"\n## Decisions\n\n- D11, `docs/decisions/d11.md`: document fields.\n- INV-009, `docs/decisions/inv-009.md`: the held push.\n",
		);
		expect(found(["lint"])).toEqual([]);
		rmSync(join(repo, LEDGER));
		expect(found(["lint"])).toContain(
			"docs/contracts/agency_client_port.md:19 proof-file-missing",
		);
	});
});

function legacy(file: string, text: string) {
	write(`docs/contracts/${file}.md`, text);
}

describe("migration recognition (CT-6)", () => {
	test("a Code it covers paragraph marks a legacy file: its gaps are warnings", () => {
		legacy(
			"agency_client_port",
			"# Contract: agency client port\n\n**Code it covers.** `app/models/agency/` and `config/routes.rb`.\n\n### AC-001 Vitor link\n\nThe link is kept.\n\n*Because* the push is held.\n\nCovered by the contract suite.\n",
		);
		const { code, report } = json(["lint"]);
		expect(code).toBe(0);
		expect(
			report.findings.map((f) => `${f.line ?? ""} ${f.code} ${f.severity}`),
		).toEqual([
			" coverage-missing warning",
			"1 legacy-format warning",
			"5 legacy-proof-unclassified warning",
		]);
		expect(report.result.files).toMatchObject([
			{ format: "legacy-file", complete: false },
		]);
	});

	test("the old heading separator alone marks a legacy file", () => {
		legacy(
			"admin_vitor",
			`# Contract: admin Vitor\n\n### AV-1 ${EM} the workspace\n\nIt opens.\n\n**Reason:** admins need it.\n`,
		);
		expect(found(["lint"])).toEqual([
			"docs/contracts/admin_vitor.md coverage-missing",
			"docs/contracts/admin_vitor.md:1 legacy-format",
			"docs/contracts/admin_vitor.md:3 legacy-proof-unclassified",
		]);
	});

	test("a bold Proof naming a file is unclassified; a named missing file is still an error", () => {
		write("lib/tasks/rt.rake", "#\n");
		const text = `# Contract: rake tasks\n\n### RT-001 ${EM} tasks run\n\nThey run.\n\n**Reason.** Ops use them.\n\n**Proof:** \`lib/tasks/rt.rake\` is exercised by hand.\n`;
		legacy("rake_tasks", text);
		expect(found(["lint"])).toContain(
			"docs/contracts/rake_tasks.md:3 legacy-proof-unclassified",
		);
		expect(json(["lint"]).code).toBe(0);
		rmSync(join(repo, "lib/tasks/rt.rake"));
		expect(found(["lint"])).toContain(
			"docs/contracts/rake_tasks.md:9 proof-file-missing",
		);
		expect(json(["lint"]).code).toBe(1);
	});

	test("no front matter and no marker is frontmatter-missing, an error", () => {
		legacy("plain", "# Contract: plain\n\n### PL-1 a promise\n\nIt holds.\n");
		expect(found(["lint"])).toContain(
			"docs/contracts/plain.md:1 frontmatter-missing",
		);
		expect(found(["lint"]).some((f) => f.endsWith("legacy-format"))).toBe(
			false,
		);
		expect(json(["lint"]).code).toBe(1);
	});

	test("attempted front matter that is malformed never falls back to legacy", () => {
		legacy(
			"broken",
			"---\ncomponent: [broken\n---\n# Contract: broken\n\n**Code it covers.** `app/`.\n",
		);
		const codes = found(["lint"]);
		expect(codes).toContain("docs/contracts/broken.md:2 frontmatter-yaml");
		expect(codes.some((f) => f.endsWith("legacy-format"))).toBe(false);
	});
});

describe("retirement, static (CT-9)", () => {
	test("valid tombstones with and without a final period; gaps are fine", () => {
		writing(
			[
				obligation("WR-1"),
				"### WR-3 an old promise\n\nRetired 2026-10-01, replaced by WR-7.\n",
				"### WR-4 another\n\nRetired 2026-10-02, no longer wanted\n\nKind: functional.\n",
				obligation("WR-7"),
			].join("\n"),
			{},
			2,
		);
		expect(found(["lint"])).toEqual([]);
		const [file] = json(["lint"]).report.result.files as {
			obligations: { id: string; retired?: { date: string; reason: string } }[];
		}[];
		expect(file?.obligations[1]?.retired).toEqual({
			date: "2026-10-01",
			reason: "replaced by WR-7",
		});
	});

	test("bad dates, missing reasons, proof on a tombstone and a reused ID are findings", () => {
		writing(
			[
				obligation("WR-1"),
				"### WR-2 a\n\nRetired 2026-02-30, no such day.\n",
				"### WR-3 b\n\nRetired 2026-10-01\n",
				`### WR-4 c\n\nRetired 2026-10-01, gone.\n\nKind: functional. Proof: test, WR-4 in \`${WRITING_TEST}\`.\n`,
				"### WR-01 d\n\nRetired 2026-10-01, a reused number.\n",
			].join("\n"),
			{},
			1,
		);
		expect(found(["lint"])).toEqual([
			"docs/contracts/writing.md:23 retired-invalid",
			"docs/contracts/writing.md:27 retired-invalid",
			"docs/contracts/writing.md:31 retired-invalid",
			"docs/contracts/writing.md:37 obligation-id-duplicate",
		]);
	});
});

describe("dash handling (CT-12)", () => {
	test("legacy dash headings and dashes in prose get only their structural findings", () => {
		legacy(
			"admin_vitor",
			`# Contract: admin Vitor${EN}workspace\n\n### AV-1 ${EM} the workspace opens\n\nIt opens ${EM} always ${EN} fast.\n\n**Reason.** Admins${EM}need it.\n`,
		);
		writing(
			`${obligation("WR-1", { statement: `Posts render ${EM} all of them ${EN} quickly.`, reason: `Readers${EN}first.` })}`,
		);
		expect(found(["lint"])).toEqual([
			"docs/contracts/admin_vitor.md coverage-missing",
			"docs/contracts/admin_vitor.md:1 legacy-format",
			"docs/contracts/admin_vitor.md:3 legacy-proof-unclassified",
		]);
		const [, writingFile] = json(["lint"]).report.result.files as {
			obligations: { title: string }[];
		}[];
		expect(writingFile?.obligations[0]?.title).toBe("the WR-1 promise");
		const [admin] = json(["lint"]).report.result.files as {
			obligations: { title: string }[];
		}[];
		expect(admin?.obligations[0]?.title).toBe("the workspace opens");
	});
});

describe("decisions index and cross-references (CT-13)", () => {
	const index = (...entries: string[]) =>
		`\n## Decisions\n\n${entries.join("\n")}\n`;
	const pointed = (reason: string, decisions = "") =>
		writing(
			`${obligation("WR-1", { reason })}\n${obligation("WR-2")}${decisions}`,
		);

	beforeEach(() => {
		write(
			"PRODUCT.md",
			"# Product\n\n## Contract: home page\n\n- **HP-3** the home page lists posts *Because* readers start there.\n",
		);
		write("docs/decisions/writing.md", "# D-6\n");
		write("DECISIONS.md", "# Decisions\n");
	});

	/** The writing file's findings, after checking it parsed with its obligations. */
	const mine = () => {
		const files = json(["lint"]).report.result.files as {
			file: string;
			obligations: unknown[];
		}[];
		expect(
			files.find((f) => f.file === "docs/contracts/writing.md")?.obligations
				.length,
		).toBeGreaterThan(0);
		return on("docs/contracts/writing.md");
	};

	test("own-prefix and discovered-prefix references are not pointers; statements are not scanned", () => {
		writing(
			`${obligation("WR-1", { statement: "It holds (D-9).", reason: "See (WR-3) and (HP-3)." })}\n${obligation("WR-3")}`,
		);
		expect(mine()).toEqual([]);
	});

	test("an empty Decisions section with no pointers is clean (R3)", () => {
		writing(`${obligation("WR-1")}\n## Decisions\n`);
		expect(mine()).toEqual([]);
	});

	test("missing index, malformed entry, unlisted pointer and missing target are separate findings", () => {
		pointed("Held (D-6).");
		expect(mine()).toEqual(["docs/contracts/writing.md:19 decisions-missing"]);
		pointed(
			"Held (D-6).",
			index(
				"- D-6, `docs/decisions/writing.md`: drafts stay hidden.",
				"- D-7 has no path",
			),
		);
		expect(mine()).toEqual([
			"docs/contracts/writing.md:34 decision-entry-invalid",
		]);
		pointed(
			"Held (D-6, D-8; ADR-002).",
			index(
				"- D-6, `docs/decisions/writing.md`: drafts stay hidden.",
				"- ADR-002, `DECISIONS.md`: the root record.",
			),
		);
		expect(mine()).toEqual(["docs/contracts/writing.md:19 decision-unlisted"]);
		pointed("Held (D-6).", index("- D-6, `docs/decisions/missing.md`: gone."));
		expect(mine()).toEqual([
			"docs/contracts/writing.md:33 decision-target-missing",
		]);
	});

	test("an existing root DECISIONS.md target is clean, with no location warning", () => {
		pointed(
			"Held (D6).",
			index("- D6, `DECISIONS.md` (to move): drafts stay hidden."),
		);
		expect(mine()).toEqual([]);
	});

	test("a lowercase token is prose, not a pointer (ruling 2)", () => {
		pointed("Held since (v2).");
		expect(mine()).toEqual([]);
	});
});

describe("path validation in lint (CT-15)", () => {
	const codes = () =>
		on("docs/contracts/writing.md")
			.map((f) => f.split(" ")[1])
			// The counts move with the proofs; drift is CT-14's.
			.filter((c) => c !== "coverage-drift");

	test("missing tests, absolute and escaping paths", () => {
		writing(undefined, {
			tests: [
				WRITING_TEST,
				"test/missing_test.rb",
				"test/missing_dir/",
				"/etc/hosts",
				"../outside/",
			],
		});
		expect(codes()).toEqual([
			"tests-missing",
			"tests-missing",
			"path-invalid",
			"path-invalid",
		]);
		writing(undefined, {
			covers: ["app/writing/", "/etc/", "app/../../x", "app/nothing/"],
		});
		expect(codes()).toEqual([
			"path-invalid",
			"path-invalid",
			"covers-unmatched",
		]);
	});

	test("symlinks in tests, literal covers, globbed covers and proofs", () => {
		write("real/x_test.rb", "#\n");
		write("app/real.rb", "#\n");
		mkdirSync(join(repo, "test/linked"), { recursive: true });
		symlinkSync(
			join(repo, "real/x_test.rb"),
			join(repo, "test/linked/x_test.rb"),
		);
		symlinkSync(join(repo, "real"), join(repo, "linkdir"));
		symlinkSync(join(repo, "app/real.rb"), join(repo, "app/link.rb"));
		writing(
			`${obligation("WR-1", { proof: "Kind: functional. Proof: test, WR-1 in `test/linked/x_test.rb`." })}`,
			{
				tests: [WRITING_TEST, "test/linked/x_test.rb", "linkdir/x_test.rb"],
				covers: ["app/writing/", "linkdir/", "app/*.rb"],
			},
		);
		expect(codes()).toEqual([
			"path-symlink",
			"path-symlink",
			"path-symlink",
			"path-symlink",
			"path-symlink",
		]);
	});

	test("a submodule or nested repository is a boundary", () => {
		write("vendor/lib/x.rb", "#\n");
		git("init", "-q", "vendor/lib");
		writing(undefined, {
			tests: [WRITING_TEST, "vendor/lib/x.rb"],
			covers: ["app/writing/", "vendor/lib/"],
		});
		expect(codes()).toEqual(["path-invalid", "path-invalid"]);
	});

	test("negation, brace expansion and extglobs are refused; positive globs are allowed", () => {
		write("app/a.rb", "#\n");
		write("app/deep/b.rb", "#\n");
		writing(undefined, {
			covers: [
				"app/writing/",
				'"!app/a.rb"',
				"app/{a,b}.rb",
				"app/@(a).rb",
				"app/**/b.rb",
				"app/?.rb",
				"app/[ab].rb",
			],
		});
		expect(codes()).toEqual(["path-invalid", "path-invalid", "path-invalid"]);
	});
});

describe("proof syntax (CT-20, lint)", () => {
	const proofs = (proof: string) => {
		writing(obligation("WR-1", { proof }), {}, 1);
		return (
			on("docs/contracts/writing.md")
				.map((f) => f.split(" ")[1])
				// The counts move with the proofs; drift is CT-14's.
				.filter((c) => c !== "coverage-drift")
		);
	};

	test("every backtick path is checked; a span without a slash is a name", () => {
		write("test/a/ledger.yml", "#\n");
		write("test/b_test.rb", "#\n");
		const proof =
			"Kind: functional. Proof: test, the `intent` cases in `test/a/ledger.yml` and `test/b_test.rb`.";
		expect(proofs(proof)).toEqual([]);
		rmSync(join(repo, "test/b_test.rb"));
		expect(proofs(proof)).toEqual(["proof-file-missing"]);
	});

	test("a separate Test line supplies the reference; Kind and Proof may share or split lines", () => {
		expect(
			proofs(
				`Test: \`${WRITING_TEST}\` ("WR-1 renders").\nKind: functional.\nProof: test.`,
			),
		).toEqual([]);
		expect(
			proofs(
				`Kind: functional. Proof: test, \`${WRITING_TEST}\` ("posts render").`,
			),
		).toEqual([]);
		expect(
			proofs(`Kind: functional. Proof: test, \`${WRITING_TEST}\`.`),
		).toEqual(["proof-invalid"]);
	});

	test("both PR evidence forms, none, and the invalid ones", () => {
		write("docs/records/run.md", "#\n");
		write("record.md", "#\n");
		expect(proofs("Kind: functional. Proof: pr-evidence, #57.")).toEqual([]);
		expect(
			proofs("Kind: functional. Proof: pr-evidence, `docs/records/run.md`."),
		).toEqual([]);
		expect(
			proofs("Kind: non-functional. Proof: pr-evidence, `./record.md`."),
		).toEqual([]);
		expect(proofs("Kind: functional. Proof: none.")).toEqual([]);
		expect(proofs("Kind: functional. Proof: pr-evidence, the PR.")).toEqual([
			"proof-invalid",
		]);
		expect(proofs("Kind: functional. Proof: pr-evidence, #0.")).toEqual([
			"proof-invalid",
		]);
		expect(proofs("Kind: functional. Proof: tested.")).toEqual([
			"proof-invalid",
		]);
		expect(proofs("Kind: fast. Proof: none.")).toEqual(["kind-invalid"]);
		expect(proofs("Proof: none.")).toEqual(["kind-invalid"]);
		expect(proofs("Kind: functional.")).toEqual(["proof-invalid"]);
	});

	test("mixed proof is two clauses and a warning to split", () => {
		expect(
			proofs(
				`Kind: functional. Proof: test, WR-1 in \`${WRITING_TEST}\`; pr-evidence, #57.`,
			),
		).toEqual(["mixed-proof"]);
	});
});

describe("explicit selections (CT-16)", () => {
	beforeEach(() => {
		write(
			"docs/contracts/markdown_renderer.md",
			`${frontMatter("markdown_renderer")}${coverageLine(0, 0)}\n# Contract: renderer\n`,
		);
		writing(undefined, { depends_on: ["markdown_renderer"] });
		write(
			"PRODUCT.md",
			"# Product\n\n## Contract: home page\n\n- **HP-1** lists posts.\n",
		);
		write("outside-not-really.md", "x\n");
		writeFileSync(join(root, "outside.md"), "x\n");
	});

	const files = (args: string[], cwd = repo) =>
		(json(args, cwd).report.result.files as { file: string }[]).map(
			(f) => f.file,
		);

	test("caller-relative selection from a nested directory, deduplicated, with whole-index dependencies", () => {
		const nested = join(repo, "docs/contracts");
		expect(
			files(
				["lint", "writing.md", "./writing.md", "../contracts/writing.md"],
				nested,
			),
		).toEqual(["docs/contracts/writing.md"]);
		expect(found(["lint", "writing.md"], nested)).toEqual([]);
		expect(files(["lint", "PRODUCT.md"])).toEqual(["PRODUCT.md"]);
		expect(files(["lint"])).toEqual([
			"PRODUCT.md",
			"docs/contracts/markdown_renderer.md",
			"docs/contracts/writing.md",
		]);
	});

	test("outside, unrelated, missing and README selections are usage errors", () => {
		for (const arg of [
			"../outside.md",
			"outside-not-really.md",
			"README.md",
			"docs/contracts/none.md",
		]) {
			const { code, report } = json(["lint", arg]);
			expect({ arg, code, error: report.error?.code }).toEqual({
				arg,
				code: 2,
				error: "usage",
			});
		}
		write("docs/contracts/README.md", "# How\n");
		expect(json(["lint", "docs/contracts/README.md"]).code).toBe(2);
	});
});

describe("deterministic output (CT-17)", () => {
	function build(order: "forward" | "reverse") {
		const steps = [
			() =>
				legacy(
					"admin_vitor",
					`# Contract: admin\n\n### AV-1 ${EM} opens\n\nIt opens.\n`,
				),
			() =>
				writing(obligation("WR-1", { reason: null }), {
					depends_on: ["zeta", "alpha"],
				}),
			() =>
				write(
					"docs/contracts/zed.md",
					`${frontMatter("zed")}${coverageLine(1, 0, 0, 0, 1)}\n### ZD-1 z\n\nZ.\n\n**Reason.** Z.\n\nKind: functional. Proof: none.\n`,
				),
		];
		for (const step of order === "forward" ? steps : steps.reverse()) step();
	}

	test("creation order and argument order do not change text or JSON", () => {
		build("forward");
		const args = [
			"docs/contracts/zed.md",
			"docs/contracts/admin_vitor.md",
			"docs/contracts/writing.md",
		];
		const first = run(["lint", ...args]);
		const firstJson = run(["lint", "--json", ...args]);
		const reversed = run(["lint", ...args.reverse()]);
		expect(reversed.stdout).toBe(first.stdout);
		const saved = repo;
		repo = join(root, "repo2");
		mkdirSync(repo);
		git("init", "-q", "-b", "main");
		build("reverse");
		const second = run(["lint", ...args]);
		const secondJson = run(["lint", "--json", ...args]);
		repo = saved;
		expect(second.stdout).toBe(first.stdout);
		expect(JSON.parse(secondJson.stdout)).toEqual(JSON.parse(firstJson.stdout));
		expect(first.stdout.split("\n").length).toBeGreaterThan(4);
	});
});

describe("PRODUCT limits and pointers (CT-18)", () => {
	test("bullet sections give IDs only; a pointer section gives nothing; no per-bullet reason findings", () => {
		writing();
		write(
			"PRODUCT.md",
			"# Product\n\n## Contract: home page\n\nEvery obligation below has a test of the same number.\n\n- **HP-1** the home page lists posts *Because* readers start there.\n- **HP-2** it has a title.\n\n## Contract: writing\n\nMoved to `docs/contracts/writing.md` (WR-1 to WR-2).\n\n## Not a contract\n\n- **NC-1** ignored.\n",
		);
		expect(found(["lint"])).toEqual(["PRODUCT.md:3 legacy-format"]);
		const files = json(["lint"]).report.result.files as Record<
			string,
			unknown
		>[];
		expect(files.find((f) => f.file === "PRODUCT.md")).toEqual({
			file: "PRODUCT.md",
			format: "product",
			sections: [{ name: "home page", line: 3, ids: ["HP-1", "HP-2"] }],
			complete: false,
		});
	});
});

type Component = {
	file: string;
	component: string;
	format: string;
	claimed: Record<string, unknown> | null;
	computed: Record<string, number>;
	complete: boolean;
	computedLine: string | null;
};

const components = (args: string[] = ["coverage"]) =>
	json(args).report.result.components as Component[];

describe("coverage arithmetic (CT-7)", () => {
	const EVIDENCE = "test/contract/evidence_test.rb";
	function mixedFixture(line: string) {
		write(EVIDENCE, "#\n");
		writing(
			[
				obligation("WR-1"),
				obligation("WR-2", {
					proof: "Kind: functional. Proof: pr-evidence, #57.",
				}),
				obligation("WR-3", {
					proof: `Kind: functional. Proof: test, WR-3 in \`${EVIDENCE}\`; pr-evidence, #58.`,
				}),
				obligation("WR-4", { proof: "Kind: non-functional. Proof: none." }),
				"### WR-5 gone\n\nRetired 2026-10-01, folded into WR-1.\n",
			].join("\n"),
		);
		const file = join(repo, "docs/contracts/writing.md");
		write(
			"docs/contracts/writing.md",
			readFileSync(file, "utf8").replace(/^Coverage: .*\n/m, line),
		);
	}

	test("test, evidence, mixed and none are disjoint; retired is apart; mixed counts once", () => {
		mixedFixture(coverageLine(4, 1, 1, 1, 1));
		const { code, report } = json(["coverage"]);
		expect(code).toBe(0);
		expect(report.findings.map((f) => f.code)).toEqual(["mixed-proof"]);
		expect(report.result.components).toEqual([
			{
				file: "docs/contracts/writing.md",
				component: "writing",
				format: "canonical",
				claimed: {
					obligations: 4,
					test: 1,
					prEvidence: 1,
					mixed: 1,
					unproved: 1,
					target: "this implementation",
				},
				computed: {
					obligations: 4,
					test: 1,
					prEvidence: 1,
					mixed: 1,
					unproved: 1,
					retired: 1,
					unclassified: 0,
				},
				complete: true,
				computedLine: coverageLine(4, 1, 1, 1, 1).trim(),
			},
		]);
		expect(report.result.complete).toBe(true);
	});

	test("a mixed proof missing its test file counts unproved and keeps both clauses", () => {
		mixedFixture(coverageLine(4, 1, 1, 1, 1));
		rmSync(join(repo, EVIDENCE));
		const { code, report } = json(["coverage"]);
		expect(code).toBe(1);
		expect(report.findings.map((f) => f.code)).toEqual([
			"coverage-drift",
			"mixed-proof",
			"proof-file-missing",
		]);
		expect(components()[0]?.computed).toMatchObject({ mixed: 0, unproved: 2 });
		const [file] = json(["lint"]).report.result.files as {
			obligations: {
				id: string;
				category: string;
				proof: { clauses: { type: string }[] };
			}[];
		}[];
		const wr3 = file?.obligations.find((o) => o.id === "WR-3");
		expect(wr3?.category).toBe("unproved");
		expect(wr3?.proof.clauses.map((c) => c.type)).toEqual([
			"test",
			"pr-evidence",
		]);
	});

	test("legacy proof is unclassified and PRODUCT proof is unknown, never complete", () => {
		legacy(
			"admin_vitor",
			`# Contract: admin\n\nCoverage: 1 obligations; 1 proved by test, 0 by PR evidence, 0 unproved. Suite runs against this implementation.\n\n### AV-1 ${EM} opens\n\nIt opens.\n\n**Reason.** Admins.\n`,
		);
		write(
			"PRODUCT.md",
			"# Product\n\n## Contract: home page\n\nEvery obligation below has a test of the same number.\n\n- **HP-1** lists posts.\n- **HP-2** has a title.\n",
		);
		const { code, report } = json(["coverage"]);
		expect(code).toBe(0);
		expect(report.findings.map((f) => `${f.file} ${f.code}`)).toContain(
			"docs/contracts/admin_vitor.md coverage-incomplete",
		);
		expect(report.result.components).toMatchObject([
			{
				file: "PRODUCT.md",
				component: "home page",
				format: "product",
				computed: { obligations: 2, unclassified: 2 },
				complete: false,
				computedLine: null,
			},
			{
				file: "docs/contracts/admin_vitor.md",
				format: "legacy-file",
				computed: { obligations: 1, unclassified: 1 },
				complete: false,
				computedLine: null,
			},
		]);
		expect(report.result.complete).toBe(false);
	});
});

describe("coverage syntax and placement (CT-14)", () => {
	const codes = () =>
		on("docs/contracts/writing.md", ["coverage"]).map((f) => f.split(" ")[1]);
	const setLine = (line: string) => {
		writing();
		const file = join(repo, "docs/contracts/writing.md");
		write(
			"docs/contracts/writing.md",
			readFileSync(file, "utf8").replace(/^Coverage: .*\n/m, line),
		);
	};

	test("missing, malformed, misplaced and drifting lines", () => {
		setLine("");
		expect(codes()).toEqual(["coverage-missing"]);
		setLine("Coverage: two obligations, all proved.\n");
		expect(codes()).toEqual(["coverage-format"]);
		writing();
		const file = join(repo, "docs/contracts/writing.md");
		const text = readFileSync(file, "utf8");
		const line = coverageLine(2, 2);
		write(
			"docs/contracts/writing.md",
			text
				.replace(line, "")
				.replace(
					"How posts are written.\n",
					`How posts are written.\n\n${line}`,
				),
		);
		expect(codes()).toEqual(["coverage-position"]);
		setLine(coverageLine(3, 2));
		expect(codes()).toEqual(["coverage-drift"]);
		expect(json(["coverage"]).report.findings[0]?.message).toBe(
			"the coverage line claims 3 obligations, 2 by test, 0 by PR evidence, 0 mixed, 0 unproved; computed 2, 2, 0, 0, 0",
		);
	});

	test("both suite targets and an omitted zero mixed are accepted; the computed line always prints mixed", () => {
		setLine(
			coverageLine(2, 2)
				.replace(" 0 mixed,", "")
				.replace(
					"this implementation",
					"any implementation behind `HTTP on CONTRACT_SERVER_CMD`",
				),
		);
		expect(codes()).toEqual([]);
		expect(components()[0]?.computedLine).toBe(
			"Coverage: 2 obligations; 2 proved by test, 0 by PR evidence, 0 mixed, 0 unproved. Suite runs against any implementation behind `HTTP on CONTRACT_SERVER_CMD`.",
		);
		setLine(
			coverageLine(2, 2).replace(
				"this implementation",
				"any implementation behind ",
			),
		);
		expect(codes()).toEqual(["coverage-format"]);
	});

	test("text output lists each component before the summary", () => {
		writing();
		expect(run(["coverage"]).stdout).toBe(
			"writing (docs/contracts/writing.md): 2 obligations; 2 test, 0 PR evidence, 0 mixed, 0 unproved, 0 retired, 0 unclassified; complete\ncontract coverage: clean\n",
		);
	});
});

describe("pasteable coverage line (CT-19)", () => {
	test("a complete drifting component prints the line and exits 0, in text and JSON, and writes nothing", () => {
		writing(undefined, {}, 5);
		const before = readFileSync(
			join(repo, "docs/contracts/writing.md"),
			"utf8",
		);
		const text = run(["coverage", "docs/contracts/writing.md", "--line"]);
		expect(text.code).toBe(0);
		expect(text.stdout).toBe(coverageLine(2, 2));
		expect(text.stderr).toContain("coverage-drift");
		const { code, report } = json([
			"coverage",
			"--line",
			"docs/contracts/writing.md",
		]);
		expect(code).toBe(0);
		expect(report.failing).toBe(1);
		expect(report.findings.map((f) => f.code)).toEqual(["coverage-drift"]);
		expect(report.result.computedLine).toBe(coverageLine(2, 2).trim());
		expect(readFileSync(join(repo, "docs/contracts/writing.md"), "utf8")).toBe(
			before,
		);
		expect(run(["coverage", "--line"]).code).toBe(0);
	});

	test("an incomplete component prints no line and exits 1; zero or several components exit 2", () => {
		legacy(
			"admin_vitor",
			`# Contract: admin\n\n### AV-1 ${EM} opens\n\nIt opens.\n`,
		);
		const text = run(["coverage", "--line", "docs/contracts/admin_vitor.md"]);
		expect({ code: text.code, stdout: text.stdout }).toEqual({
			code: 1,
			stdout: "",
		});
		expect(
			json(["coverage", "--line", "docs/contracts/admin_vitor.md"]),
		).toMatchObject({
			code: 1,
			report: { result: { computedLine: null } },
		});
		writing();
		expect(run(["coverage", "--line"]).code).toBe(2);
		expect(
			run([
				"coverage",
				"--line",
				"docs/contracts/writing.md",
				"docs/contracts/admin_vitor.md",
			]).code,
		).toBe(2);
		rmSync(join(repo, "docs/contracts"), { recursive: true });
		expect(run(["coverage", "--line"]).code).toBe(2);
	});
});

describe("convention examples keep their excerpt totals (CT-5)", () => {
	test("MR-5 and AC-010 excerpts report drift; completed single-obligation lines pass", () => {
		write("test/contract/markdown_renderer_contract_test.rb", "#\n");
		write("docs/decisions/markdown_renderer.md", "#\n");
		write(
			"docs/contracts/markdown_renderer.md",
			`${frontMatter("markdown_renderer", { tests: ["test/contract/markdown_renderer_contract_test.rb"] })}Coverage: 21 obligations; 21 proved by test, 0 by PR evidence, 0 unproved. Suite runs against this implementation.\n\n### MR-5 unsafe URLs lose their URL\n\nThey do.\n\n**Reason.** Script. (D-6)\n\nKind: functional. Proof: test, the five tests named MR-5 in \`test/contract/markdown_renderer_contract_test.rb\`.\n\n## Decisions\n\n- D-6, \`docs/decisions/markdown_renderer.md\`: unsafe URLs are emptied (MR-5).\n`,
		);
		write("test/contracts/agency_client_port/ledger.yml", "#\n");
		write("docs/decisions/d11.md", "#\n");
		write(
			"docs/contracts/agency_client_port.md",
			`${frontMatter("agency_client_port", { tests: ["test/contracts/agency_client_port/"] })}Coverage: 19 obligations; 14 proved by test, 2 by PR evidence, 3 mixed, 0 unproved. Suite runs against this implementation.\n\n### AC-010 Vitor safety\n\nFields are immutable.\n\n**Reason.** Held. (D11, Proposal 9; INV-009)\n\nKind: functional. Proof: test, the cases whose \`intent\` names AC-010 in \`test/contracts/agency_client_port/ledger.yml\`.\n\n## Decisions\n\n- D11, \`docs/decisions/d11.md\`: fields.\n- INV-009, \`docs/decisions/d11.md\`: the push.\n`,
		);
		expect(found(["coverage"])).toEqual([
			"docs/contracts/agency_client_port.md:8 coverage-drift",
			"docs/contracts/markdown_renderer.md:8 coverage-drift",
		]);
		expect(components().map((c) => c.computedLine)).toEqual([
			coverageLine(1, 1).trim(),
			coverageLine(1, 1).trim(),
		]);
	});
});

describe("map ownership (CT-8)", () => {
	function component(
		name: string,
		prefix: string,
		covers: string[],
		depends_on: string[] = [],
		prose = "",
	) {
		write(
			`docs/contracts/${name}.md`,
			`${frontMatter(name, { covers, depends_on, tests: [WRITING_TEST] })}${coverageLine(1, 1)}\n# Contract: ${name}\n\n${prose}\n\n${obligation(`${prefix}-1`)}`,
		);
	}
	beforeEach(() => {
		write(WRITING_TEST, "#\n");
		for (const f of [
			"app/shared/a.rb",
			"app/shared/held/b.rb",
			"app/models/c.rb",
			"config/routes.rb",
		])
			write(f, "#\n");
	});
	type MapResult = {
		components: { component: string; covers: string[]; tests: string[] }[];
		edges: { from: string; to: string }[];
		unresolvedEdges: { from: string; to: string }[];
		directoryConflicts: {
			kind: string;
			path: string;
			other: string;
			components: string[];
		}[];
		complete: boolean;
	};
	const map = () =>
		json(["map"]) as { code: number; report: Report & { result: MapResult } };

	test("a literal directory claimed twice is directory-duplicate on both files; a shared file is fine", () => {
		component("writing", "WR", ["app/shared/", "config/routes.rb"]);
		component("reading", "RD", ["app/shared", "config/routes.rb"]);
		const { code, report } = map();
		expect(code).toBe(1);
		expect(
			report.findings.map((f) => `${f.file}:${f.line} ${f.code} ${f.severity}`),
		).toEqual([
			"docs/contracts/reading.md:4 directory-duplicate error",
			"docs/contracts/writing.md:4 directory-duplicate error",
		]);
		expect(report.result.directoryConflicts).toEqual([
			{
				kind: "duplicate",
				path: "app/shared",
				other: "app/shared",
				components: ["reading", "writing"],
			},
		]);
		expect(found(["lint", "docs/contracts/writing.md"])).toEqual([
			"docs/contracts/writing.md:4 directory-duplicate",
		]);
	});

	test("a directory matched by a glob collides with a literal claim", () => {
		component("writing", "WR", ["app/*/"]);
		component("reading", "RD", ["app/models/"]);
		expect(found(["map"])).toEqual([
			"docs/contracts/reading.md:4 directory-duplicate",
			"docs/contracts/writing.md:4 directory-duplicate",
		]);
	});

	test("an ancestor and a descendant warn; prose exceptions subtract nothing", () => {
		component(
			"writing",
			"WR",
			["app/shared/"],
			[],
			"Except `app/shared/held/`, which is held.",
		);
		component("held", "HD", ["app/shared/held/"]);
		const { code, report } = map();
		expect(code).toBe(0);
		expect(
			report.findings.map((f) => `${f.file} ${f.code} ${f.severity}`),
		).toEqual([
			"docs/contracts/held.md directory-nested warning",
			"docs/contracts/writing.md directory-nested warning",
		]);
		expect(report.result.directoryConflicts).toEqual([
			{
				kind: "nested",
				path: "app/shared",
				other: "app/shared/held",
				components: ["writing", "held"],
			},
		]);
	});

	test("a dependency on an unmigrated component stays unresolved; PRODUCT makes no node", () => {
		component(
			"writing",
			"WR",
			["app/models/"],
			["markdown_renderer", "reading"],
		);
		component("reading", "RD", ["app/shared/"]);
		write(
			"PRODUCT.md",
			"# Product\n\n## Contract: markdown_renderer\n\n- **MR-1** renders.\n",
		);
		const { code, report } = map();
		expect(code).toBe(0);
		expect(report.findings.map((f) => `${f.file} ${f.code}`)).toEqual([
			"PRODUCT.md legacy-format",
			"docs/contracts/writing.md dependency-missing",
		]);
		expect(report.result.components.map((c) => c.component)).toEqual([
			"reading",
			"writing",
		]);
		expect(report.result.edges).toEqual([{ from: "writing", to: "reading" }]);
		expect(report.result.unresolvedEdges).toEqual([
			{ from: "writing", to: "markdown_renderer" },
		]);
		expect(report.result.components[1]).toMatchObject({
			covers: ["app/models/"],
			tests: [WRITING_TEST],
		});
		expect(report.result.complete).toBe(false);
		expect(run(["map"]).stdout).toBe(
			[
				"reading (docs/contracts/reading.md)",
				"  covers: app/shared/",
				"writing (docs/contracts/writing.md)",
				"  covers: app/models/",
				"  depends on: markdown_renderer (no Contract file), reading",
				'migration gap: PRODUCT.md section "markdown_renderer"',
				'PRODUCT.md:3: legacy-format: section "markdown_renderer" is not yet a Contract file; it is read by name and ID only, and its proof coverage is unknown',
				"docs/contracts/writing.md:6: dependency-missing: depends on markdown_renderer, which has no Contract file",
				"contract map: 2 findings, 0 failing",
				"",
			].join("\n"),
		);
	});
});

type Change = {
	kind: string;
	file: string;
	component?: string;
	section?: string;
	obligationId?: string;
	before: { file: string; line: number } | null;
	after: { file: string; line: number } | null;
	fields?: Record<string, { before: unknown; after: unknown }>;
	obligationKind?: string;
	rewordedLine?: { present: boolean; new: boolean };
};

const changes = (args: string[] = []) => {
	const { code, report } = json(["diff", ...args]);
	expect(code).toBe(0);
	return report.result.changes as Change[];
};
const brief = (list: Change[]) =>
	list.map((c) =>
		[
			c.kind,
			c.obligationId ?? c.section ?? c.component ?? c.file,
			...Object.keys(c.fields ?? {}),
		].join(" "),
	);

describe("bounded diff (CT-10)", () => {
	beforeEach(() => {
		writing();
		commit("Writing");
		git("checkout", "-q", "-b", "feature");
	});

	test("compares head with its merge base, not the base tip; reports refs and commits", () => {
		const fork = git("rev-parse", "HEAD");
		writing(
			`${obligation("WR-1", { title: "posts render fully" })}\n${obligation("WR-2")}`,
		);
		const head = commit("Reword");
		git("checkout", "-q", "main");
		writing(
			`${obligation("WR-1")}\n${obligation("WR-2")}\n${obligation("WR-9")}`,
		);
		const tip = commit("Main moves");
		git("checkout", "-q", "feature");
		const { code, report } = json(["diff"]);
		expect(code).toBe(0);
		expect(report.status).toBe("clean");
		expect(report.result).toMatchObject({
			base: { requested: "main", commit: tip },
			head: { requested: "HEAD", commit: head },
			mergeBase: fork,
			complete: true,
		});
		expect(brief(report.result.changes as Change[])).toEqual([
			"obligation-reworded WR-1 title",
		]);
		const text = run(["diff"]);
		expect(text.stdout).toBe(
			`diff: base main ${tip.slice(0, 12)}, head HEAD ${head.slice(0, 12)}, merge base ${fork.slice(0, 12)}\nobligation-reworded docs/contracts/writing.md WR-1: title\ncontract diff: clean\n`,
		);
	});

	test("base defaults to origin/HEAD when it resolves; --head names another commit", () => {
		const fork = git("rev-parse", "HEAD");
		writing(`${obligation("WR-1")}`, {}, 1);
		const first = commit("Drop WR-2");
		writing(`${obligation("WR-1", { reason: "Changed." })}`, {}, 1);
		commit("Change WR-1");
		git("update-ref", "refs/remotes/origin/main", fork);
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		const { report } = json(["diff", "--head", first]);
		expect(report.result).toMatchObject({
			base: { requested: "origin/HEAD", commit: fork },
			head: { requested: first, commit: first },
		});
		expect(brief(report.result.changes as Change[])).toEqual([
			"coverage-line-changed writing coverage",
			"obligation-removed WR-2",
		]);
		expect(brief(changes())).toEqual([
			"coverage-line-changed writing coverage",
			"obligation-changed WR-1 reason",
			"obligation-removed WR-2",
		]);
	});

	test("the worktree, the index and untracked files change nothing; no lint and no patch", () => {
		writing(`${obligation("WR-1", { reason: null })}\n${obligation("WR-2")}`);
		commit("Drop a reason");
		const committed = run(["diff", "--json"]).stdout;
		writing(`${obligation("WR-7")}`, {}, 1);
		write(
			"docs/contracts/staged.md",
			`${frontMatter("staged")}${coverageLine(0, 0)}`,
		);
		git("add", "docs/contracts/staged.md");
		write(
			"docs/contracts/untracked.md",
			`${frontMatter("untracked")}${coverageLine(0, 0)}`,
		);
		rmSync(join(repo, WRITING_TEST));
		expect(run(["diff", "--json"]).stdout).toBe(committed);
		const report = JSON.parse(committed) as Report;
		expect(report.findings).toEqual([]);
		expect(Object.keys(report.result).sort()).toEqual([
			"base",
			"changes",
			"complete",
			"head",
			"limits",
			"mergeBase",
		]);
		expect(brief(report.result.changes as Change[])).toEqual([
			"obligation-changed WR-1 reason",
		]);
		expect(run(["diff"]).stdout).not.toContain("@@");
	});

	test("hostile git display and driver configuration changes nothing and runs nothing", () => {
		writing(
			`${obligation("WR-1", { title: "renamed" })}\n${obligation("WR-2")}`,
		);
		commit("Rename");
		const plain = run(["diff", "--json"]).stdout;
		expect(
			brief((JSON.parse(plain) as Report).result.changes as Change[]),
		).toEqual(["obligation-reworded WR-1 title"]);
		const sentinel = join(root, "driver-ran");
		const driver = join(root, "driver.sh");
		writeFileSync(driver, `#!/bin/sh\ntouch "${sentinel}"\ncat "$@"\n`, {
			mode: 0o755,
		});
		for (const [key, value] of [
			["color.ui", "always"],
			["core.quotepath", "true"],
			["diff.noprefix", "true"],
			["diff.relative", "true"],
			["log.showSignature", "true"],
			["diff.external", driver],
			["diff.hostile.textconv", driver],
			["core.pager", driver],
			["core.fsmonitor", driver],
		] as const)
			git("config", key, value);
		writeFileSync(join(repo, ".git/info/attributes"), "*.md diff=hostile\n");
		expect(run(["diff", "--json"], join(repo, "app"), {}).stdout).toBe(plain);
		expect(existsSync(sentinel)).toBe(false);
	});

	test("missing objects, unrelated histories and several merge bases exit 2 with complete false", () => {
		writing(
			`${obligation("WR-1", { title: "renamed" })}\n${obligation("WR-2")}`,
		);
		commit("Rename");
		const blob = git("rev-parse", "HEAD:docs/contracts/writing.md");
		const object = join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2));
		const saved = readFileSync(object);
		rmSync(object, { force: true });
		const missing = json(["diff"]);
		expect(missing).toMatchObject({
			code: 2,
			report: {
				status: "error",
				result: { complete: false },
				error: { code: "object-missing" },
			},
		});
		writeFileSync(object, saved);
		git("checkout", "-q", "--orphan", "lonely");
		commit("Lonely");
		expect(json(["diff"])).toMatchObject({
			code: 2,
			report: { error: { code: "unrelated-histories" } },
		});
		git("checkout", "-q", "-f", "main");
		git("checkout", "-q", "-b", "a");
		write("a.txt", "a\n");
		const a1 = commit("a1");
		git("checkout", "-q", "main");
		git("checkout", "-q", "-b", "b");
		write("b.txt", "b\n");
		const b1 = commit("b1");
		git("merge", "-q", "--no-edit", a1);
		git("checkout", "-q", "a");
		git("merge", "-q", "--no-edit", b1);
		const result = json(["diff", "--base", "b"]);
		expect(result).toMatchObject({
			code: 2,
			report: { error: { code: "multiple-merge-bases" } },
		});
		expect(result.report.error?.message).toContain(a1.slice(0, 12));
	});

	test("refs starting with a dash are refs, never options, and nothing is written", () => {
		for (const args of [
			["--base", "--output=written"],
			["--head", "-h"],
			["--base", "--json"],
		]) {
			const result = run(["diff", ...args]);
			expect({ args, code: result.code, stdout: result.stdout }).toEqual({
				args,
				code: 2,
				stdout: "",
			});
			expect(result.stderr).toMatch(/^contract: (base|head) not found: -/);
		}
		expect(existsSync(join(repo, "written"))).toBe(false);
		expect(json(["diff", "--base", "nosuch"])).toMatchObject({
			code: 2,
			report: { error: { code: "ref-missing" } },
		});
	});

	test("an identity ambiguity in a snapshot is a located error, not an empty report", () => {
		writing(`${obligation("WR-1")}\n${obligation("WR-01")}`);
		commit("Duplicate");
		const result = run(["diff"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toBe(
			"contract: docs/contracts/writing.md:23 at head: WR-01 has the identity of WR-1 at line 15\n",
		);
	});

	test("PRODUCT sections compare by name and ID; a move into a file is a removal and an addition", () => {
		git("checkout", "-q", "main");
		write(
			"PRODUCT.md",
			"# Product\n\n## Contract: home page\n\n- **HP-1** lists posts.\n\n## Contract: reading\n\n- **RD-1** reads.\n- **RD-2** pages.\n",
		);
		commit("Product");
		git("checkout", "-q", "-B", "feature");
		write(
			"PRODUCT.md",
			"# Product\n\n## Contract: home page\n\n- **HP-1** lists posts.\n- **HP-2** has a title.\n\n## Contract: reading\n\nMoved to `docs/contracts/reading.md` (RD-1 to RD-2).\n",
		);
		write(
			"docs/contracts/reading.md",
			`${frontMatter("reading", { tests: [WRITING_TEST] })}${coverageLine(2, 2)}\n${obligation("RD-1")}\n${obligation("RD-2")}`,
		);
		commit("Move reading");
		expect(brief(changes())).toEqual([
			"product-id-added HP-2",
			"product-section-removed reading",
			"component-added reading",
			"obligation-added RD-1",
			"obligation-added RD-2",
		]);
		expect(
			changes().find((c) => c.kind === "product-section-removed"),
		).toMatchObject({
			file: "PRODUCT.md",
			before: { file: "PRODUCT.md", line: 7 },
			after: null,
		});
		expect(run(["--help"]).stdout).toContain(
			"a section moved to a file shows as a removal",
		);
	});
});

describe("retirement and identity in diff (CT-9)", () => {
	test("a deleted ID and a retired ID made active again are reported, exit 0", () => {
		writing(
			`${obligation("WR-1")}\n${obligation("WR-2")}\n### WR-3 old\n\nRetired 2026-10-01, folded.\n`,
			{},
			2,
		);
		commit("Base");
		git("checkout", "-q", "-b", "feature");
		writing(`${obligation("WR-1")}\n${obligation("WR-3")}`, {}, 2);
		commit("Delete and resurrect");
		expect(brief(changes())).toEqual([
			"obligation-removed WR-2",
			"obligation-reactivated WR-3 title statement reason kind proof retired",
		]);
		writing(
			`${obligation("WR-1")}\n${obligation("WR-2")}\n### WR-3 old\n\nRetired 2026-10-01, folded.\n### WR-4 next\n\nRetired 2026-10-02, never shipped.\n`,
			{},
			2,
		);
		commit("Retire");
		git("checkout", "-q", "-b", "later");
		writing(
			`${obligation("WR-1")}\n### WR-2 the WR-2 promise\n\nRetired 2026-10-03, superseded.\n\n### WR-3 old\n\nRetired 2026-10-01, folded.\n`,
			{},
			2,
		);
		commit("Retire WR-2");
		expect(brief(changes(["--base", "feature"]))).toEqual([
			"obligation-retired WR-2 statement reason kind proof retired",
			"obligation-removed WR-4",
		]);
	});
});

describe("amendment boundaries in diff (CT-20)", () => {
	test("title and statement are rewordings; reason, kind and proof alone are not; Reworded lines are facts", () => {
		write("test/contract/other_test.rb", "#\n");
		const body = (
			o: Record<string, Parameters<typeof obligation>[1]>,
			extra: Record<string, string> = {},
		) =>
			["WR-1", "WR-2", "WR-3", "WR-4", "WR-5", "WR-6"]
				.map((id) => `${obligation(id, o[id])}${extra[id] ?? ""}`)
				.join("\n");
		writing(
			body({}, { "WR-6": "\nReworded 2026-10-01, by the restyle PR.\n" }),
		);
		commit("Base");
		git("checkout", "-q", "-b", "feature");
		writing(
			body(
				{
					"WR-1": { title: "posts render fully" },
					"WR-2": { statement: "WR-2 holds, always." },
					"WR-3": { reason: "Readers rely on it daily." },
					"WR-4": {
						proof: `Kind: non-functional. Proof: test, WR-4 in \`${WRITING_TEST}\`.`,
					},
					"WR-5": {
						proof:
							"Kind: functional. Proof: test, WR-5 in `test/contract/other_test.rb`.",
					},
					"WR-6": { title: "renamed again" },
				},
				{
					"WR-2": "\nReworded 2026-10-19, a typo.\n",
					"WR-6": "\nReworded 2026-10-01, by the restyle PR.\n",
				},
			),
		);
		write(
			"docs/contracts/extra.md",
			`${frontMatter("extra", { tests: [WRITING_TEST] })}${coverageLine(1, 1)}\n${obligation("EX-1", { proof: `Kind: non-functional. Proof: test, EX-1 in \`${WRITING_TEST}\`.` })}`,
		);
		commit("Edit");
		const list = changes();
		expect(brief(list)).toEqual([
			"component-added extra",
			"obligation-added EX-1",
			"obligation-reworded WR-1 title",
			"obligation-reworded WR-2 statement",
			"obligation-changed WR-3 reason",
			"obligation-changed WR-4 kind",
			"obligation-changed WR-5 proof",
			"obligation-reworded WR-6 title",
		]);
		const by = (id: string) =>
			list.find((c) => c.obligationId === id) as Change;
		expect(by("EX-1").obligationKind).toBe("non-functional");
		expect(by("WR-1")).toMatchObject({
			obligationKind: "functional",
			rewordedLine: { present: false, new: false },
		});
		expect(by("WR-2")).toMatchObject({
			rewordedLine: { present: true, new: true },
		});
		expect(by("WR-6")).toMatchObject({
			rewordedLine: { present: true, new: false },
		});
		expect(by("WR-1").fields).toEqual({
			title: { before: "the WR-1 promise", after: "posts render fully" },
		});
		expect(by("WR-3")).not.toHaveProperty("rewordedLine");
		expect(by("WR-1")).toMatchObject({
			before: { file: "docs/contracts/writing.md", line: 15 },
			after: { file: "docs/contracts/writing.md", line: 15 },
		});
	});
});

describe("discovery boundary and unreadable inputs (fix round 1, findings 1 and 2)", () => {
	const codes = () => {
		const { code, report } = json(["lint"]);
		return {
			code,
			findings: report.findings.map((f) => `${f.file} ${f.code}`),
			files: report.result.files,
		};
	};

	test("a symlinked docs directory is path-symlink, exit 1, and nothing behind it is read", () => {
		writing();
		renameSync(join(repo, "docs"), join(root, "outside-docs"));
		symlinkSync(join(root, "outside-docs"), join(repo, "docs"));
		expect(codes()).toEqual({
			code: 1,
			findings: ["docs/contracts path-symlink"],
			files: [],
		});
		expect(json(["lint", "docs/contracts/writing.md"]).code).toBe(2);
	});

	test("a nested repository at docs is path-invalid, exit 1", () => {
		writing();
		git("init", "-q", "docs");
		expect(codes()).toEqual({
			code: 1,
			findings: ["docs/contracts path-invalid"],
			files: [],
		});
	});

	test("a nested repository inside docs/contracts is path-invalid and not entered", () => {
		writing();
		write("docs/contracts/vendor/inner.md", "# Inner\n");
		git("init", "-q", "docs/contracts/vendor");
		expect(codes().findings).toEqual(["docs/contracts/vendor path-invalid"]);
	});

	test("a symlinked PRODUCT.md is path-symlink and is not read", () => {
		writeFileSync(
			join(root, "PRODUCT.md"),
			"# Product\n\n## Contract: home page\n\n- **HP-1** lists posts.\n",
		);
		symlinkSync(join(root, "PRODUCT.md"), join(repo, "PRODUCT.md"));
		expect(codes()).toEqual({
			code: 1,
			findings: ["PRODUCT.md path-symlink"],
			files: [],
		});
	});

	test("an unreadable docs/contracts or Contract file is an environment error, exit 2, in text and JSON", () => {
		writing();
		const dir = join(repo, "docs/contracts");
		const file = join(dir, "writing.md");
		try {
			for (const target of [dir, file]) {
				chmodSync(target, 0o000);
				const text = run(["lint"]);
				expect({ code: text.code, stdout: text.stdout }).toEqual({
					code: 2,
					stdout: "",
				});
				expect(text.stderr).toMatch(
					/^contract: cannot read docs\/contracts[^\n]*\n$/,
				);
				const { code, report } = json(["coverage"]);
				expect(code).toBe(2);
				expect(report).toMatchObject({
					status: "error",
					error: { code: "unreadable" },
				});
				chmodSync(target, target === dir ? 0o755 : 0o644);
			}
		} finally {
			chmodSync(dir, 0o755);
			chmodSync(file, 0o644);
		}
	});
});

describe("parse structure gates output (fix round 1, findings 3 to 6 and 9)", () => {
	const lower = () =>
		writing(
			`${obligation("WR-1").replace("### WR-1 ", "### wr-1 ")}\n${obligation("WR-2")}`,
			{},
			1,
		);

	test("a heading that fails to parse leaves coverage incomplete: no computed line, exit 1", () => {
		lower();
		const { code, report } = json(["coverage", "--line"]);
		expect(code).toBe(1);
		expect(report.result).toMatchObject({
			computedLine: null,
			complete: false,
			components: [{ complete: false }],
		});
		expect(run(["coverage", "--line"]).stdout).toBe("");
	});

	test("diff refuses a snapshot whose obligation heading fails to parse, located, exit 2", () => {
		writing();
		commit("Base");
		git("checkout", "-q", "-b", "feature");
		lower();
		commit("Lowercase");
		const { code, report } = json(["diff", "--base", "main"]);
		expect({ code, error: report.error?.code }).toEqual({
			code: 2,
			error: "ambiguous",
		});
		expect(report.error?.message).toMatch(
			/^docs\/contracts\/writing\.md:15 at head: /,
		);
		expect(report.result).toEqual({ complete: false });
	});

	test("diff refuses a nested Contract file rather than omit it", () => {
		write(
			"docs/contracts/group/writing.md",
			`${frontMatter("writing")}${coverageLine(0, 0)}`,
		);
		commit("Nested");
		git("checkout", "-q", "-b", "feature");
		write(
			"docs/contracts/group/writing.md",
			`${frontMatter("writing")}${coverageLine(1, 0, 0, 0, 1)}`,
		);
		commit("Change nested");
		const { code, report } = json(["diff", "--base", "main"]);
		expect({ code, error: report.error?.code }).toEqual({
			code: 2,
			error: "unsupported",
		});
		expect(report.error?.message).toContain("docs/contracts/group/writing.md");
	});

	test("a change to a separate Test reference is a proof change, not a rewording", () => {
		write("test/a.rb", "#\n");
		write("test/b.rb", "#\n");
		const proof = (file: string) =>
			`Test: \`${file}\` ("WR-1 renders").\nKind: functional. Proof: test.`;
		writing(obligation("WR-1", { proof: proof("test/a.rb") }), {}, 1);
		commit("Base");
		git("checkout", "-q", "-b", "feature");
		writing(obligation("WR-1", { proof: proof("test/b.rb") }), {}, 1);
		commit("Move the test");
		const list = changes(["--base", "main"]);
		expect(brief(list)).toEqual(["obligation-changed WR-1 proof"]);
		expect(JSON.stringify(list[0]?.fields?.proof)).toContain("test/a.rb");
		expect(JSON.stringify(list[0]?.fields?.proof)).toContain("test/b.rb");
	});

	test("Kind, Proof and Test are read in any order, with or without blank lines", () => {
		const ref = `Test: \`${WRITING_TEST}\` ("WR-1 renders").`;
		for (const proof of [
			`Kind: functional.\nProof: test.\n${ref}`,
			`Kind: functional.\n\nProof: test.\n\n${ref}`,
			`${ref}\n\nKind: functional. Proof: test.`,
			`Proof: test.\n${ref}\nKind: functional.`,
		]) {
			writing(obligation("WR-1", { proof }), {}, 1);
			expect({ proof, found: on("docs/contracts/writing.md") }).toEqual({
				proof,
				found: [],
			});
		}
	});

	test("an empty Reason label is reason-missing, an error in a canonical file and a warning in a legacy one", () => {
		writing(`${obligation("WR-1", { reason: "" })}\n${obligation("WR-2")}`);
		expect(
			json(["lint"]).report.findings.map((f) => `${f.code} ${f.severity}`),
		).toEqual(["reason-missing error"]);
		legacy(
			"admin_vitor",
			`# Contract: admin\n\n### AV-1 ${EM} opens\n\nIt opens.\n\n**Reason.**\n`,
		);
		expect(
			on("docs/contracts/admin_vitor.md").map((f) => f.split(" ")[1]),
		).toContain("reason-missing");
		expect(
			json(["lint"]).report.findings.find(
				(f) =>
					f.file === "docs/contracts/admin_vitor.md" &&
					f.code === "reason-missing",
			)?.severity,
		).toBe("warning");
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
		writing();
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
