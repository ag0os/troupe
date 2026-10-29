// Runs packages/software/tools/install-skills under a throwaway home. It
// imports nothing from Troupe: the package carries its own proof.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
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
import { dirname, join, relative, resolve } from "node:path";

const packageDir = resolve(import.meta.dir, "..");
const tool = join(packageDir, "tools/install-skills");
const skillsDir = join(packageDir, "skills");

let root: string;
let home: string;

function env(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		...extra,
	};
}

function run(args: string[], extra: Record<string, string> = {}, cwd = root) {
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

type Destination = {
	harness: string;
	skill: string;
	path: string;
	status: string;
	added: string[];
	updated: string[];
	removed: string[];
};

function report(args: string[], extra: Record<string, string> = {}) {
	const result = run([...args, "--json"], extra);
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	return JSON.parse(result.stdout) as {
		contract: number;
		tool: string;
		status: string;
		skills: string[];
		destinations: Destination[];
	};
}

/** Every file below dir, relative, with its bytes and modification time. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const visit = (at: string) => {
		for (const name of readdirSync(at)) {
			const path = join(at, name);
			if (statSync(path).isDirectory()) visit(path);
			else
				out[relative(dir, path)] =
					`${statSync(path).mtimeMs} ${readFileSync(path, "base64")}`;
		}
	};
	if (existsSync(dir)) visit(dir);
	return out;
}

/** The fake home's entries, without the `.bun` directory bun itself may create there. */
function homeEntries(): string[] {
	return readdirSync(home).filter((name) => name !== ".bun");
}

function sourceFiles(skill: string): string[] {
	return Object.keys(snapshot(join(skillsDir, skill))).sort();
}

function expectInstalled(dir: string, skill: string) {
	const files = sourceFiles(skill);
	expect(Object.keys(snapshot(dir)).sort()).toEqual(files);
	for (const file of files)
		expect(
			readFileSync(join(dir, file)).equals(
				readFileSync(join(skillsDir, skill, file)),
			),
		).toBe(true);
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "install-skills-")));
	home = join(root, "home");
	mkdirSync(home);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("package integration (IS-1)", () => {
	test("the launcher is POSIX sh, executable, and resolves its TypeScript from $0", () => {
		expect(readFileSync(tool, "utf8").split("\n")[0]).toBe("#!/bin/sh");
		expect(statSync(tool).mode & 0o111).not.toBe(0);
		expect(
			statSync(join(dirname(tool), "install-skills.d/main.ts")).isFile(),
		).toBe(true);
		const result = run(["--help"]);
		expect(result).toMatchObject({ code: 0, stderr: "" });
		expect(result.stdout).toContain("usage: install-skills");
		expect(existsSync(join(home, ".claude"))).toBe(false);
	});

	test("the package carries imp-feature with its two references", () => {
		expect(readdirSync(skillsDir)).toContain("imp-feature");
		expect(sourceFiles("imp-feature")).toEqual([
			"SKILL.md",
			"references/agents-paragraph.md",
			"references/contract-file.md",
		]);
	});

	test("bun absent from PATH: exit 2, one stderr line", () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		const result = run([], { PATH: bin });
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
		expect(result.stderr).toMatch(/^install-skills: .*bun/);
	});

	test("usage errors exit 2 and write nothing", () => {
		for (const args of [["--bogus"], ["--repo"], ["extra"]]) {
			const result = run(args);
			expect(result.code).toBe(2);
			expect(result.stderr).toMatch(/^install-skills: /);
			const json = run([...args, "--json"]);
			expect(json.code).toBe(2);
			expect(JSON.parse(json.stdout)).toMatchObject({
				contract: 1,
				tool: "install-skills",
				status: "error",
			});
		}
		expect(homeEntries()).toEqual([]);
	});
});

describe("user level destinations (IS-2)", () => {
	test("every skill lands byte identical for Claude Code and Codex", () => {
		const out = report([]);
		expect(out).toMatchObject({
			contract: 1,
			tool: "install-skills",
			status: "changed",
		});
		expect(out.skills).toEqual(readdirSync(skillsDir).sort());
		expect(out.destinations).toHaveLength(2 * out.skills.length);
		for (const skill of out.skills) {
			const claude = join(home, ".claude/skills", skill);
			const codex = join(home, ".codex/skills", skill);
			expectInstalled(claude, skill);
			expectInstalled(codex, skill);
			expect(out.destinations).toContainEqual({
				harness: "claude",
				skill,
				path: claude,
				status: "changed",
				added: sourceFiles(skill),
				updated: [],
				removed: [],
			});
			expect(
				out.destinations.find((d) => d.harness === "codex" && d.skill === skill)
					?.path,
			).toBe(codex);
		}
	});

	test("the text report names each destination and its files", () => {
		const result = run([]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			`claude imp-feature: ${join(home, ".claude/skills/imp-feature")} changed: added SKILL.md, references/agents-paragraph.md, references/contract-file.md`,
		);
		expect(result.stdout).toContain(
			`codex imp-feature: ${join(home, ".codex/skills/imp-feature")} changed: added`,
		);
	});
});

describe("the Codex root (IS-3)", () => {
	const codexPath = (out: ReturnType<typeof report>) =>
		out.destinations.find((d) => d.harness === "codex")?.path;

	test("CODEX_HOME wins over ~/.codex-active", () => {
		const codexHome = join(root, "codex-home");
		writeFileSync(join(home, ".codex-active"), `${join(root, "active")}\n`);
		const out = report([], { CODEX_HOME: codexHome });
		expect(codexPath(out)).toBe(join(codexHome, "skills/imp-feature"));
		expectInstalled(join(codexHome, "skills/imp-feature"), "imp-feature");
		expect(existsSync(join(root, "active"))).toBe(false);
		expect(existsSync(join(home, ".codex"))).toBe(false);
	});

	test("without CODEX_HOME, the path ~/.codex-active holds", () => {
		const active = join(root, "active");
		writeFileSync(join(home, ".codex-active"), `${active}\n`);
		const out = report([]);
		expect(codexPath(out)).toBe(join(active, "skills/imp-feature"));
		expectInstalled(join(active, "skills/imp-feature"), "imp-feature");
		expect(existsSync(join(home, ".codex"))).toBe(false);
	});

	test("without either, ~/.codex", () => {
		const out = report([]);
		expect(codexPath(out)).toBe(join(home, ".codex/skills/imp-feature"));
	});

	test("a relative CODEX_HOME or .codex-active path is refused before any write", () => {
		expect(run([], { CODEX_HOME: "relative" }).code).toBe(2);
		writeFileSync(join(home, ".codex-active"), "relative\n");
		const result = run([]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(".codex-active");
		expect(homeEntries()).toEqual([".codex-active"]);
	});
});

describe("the repo argument (IS-4)", () => {
	test("installs into the repository's .claude/skills and .agents/skills only", () => {
		const repo = join(root, "repo");
		mkdirSync(repo);
		const out = report(["--repo", "repo"]);
		expect(out.destinations.map((d) => d.path)).toEqual([
			join(repo, ".claude/skills/imp-feature"),
			join(repo, ".agents/skills/imp-feature"),
		]);
		expectInstalled(join(repo, ".claude/skills/imp-feature"), "imp-feature");
		expectInstalled(join(repo, ".agents/skills/imp-feature"), "imp-feature");
		expect(homeEntries()).toEqual([]);
	});

	test("a missing repository is refused", () => {
		const result = run(["--repo", "missing"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("is not a directory");
	});
});

describe("each install replaces its skill directory only (IS-5)", () => {
	test("a stale file goes, a changed file is rewritten, a sibling skill stays", () => {
		const skill = join(home, ".claude/skills/imp-feature");
		const sibling = join(home, ".claude/skills/other");
		mkdirSync(join(skill, "references"), { recursive: true });
		mkdirSync(join(skill, "old"), { recursive: true });
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "an older revision\n");
		writeFileSync(join(skill, "references/stale.md"), "stale\n");
		writeFileSync(join(skill, "old/notes.md"), "stale\n");
		writeFileSync(join(sibling, "SKILL.md"), "sibling\n");
		writeFileSync(join(home, ".claude/skills/loose.md"), "loose\n");
		const siblingBefore = snapshot(sibling);
		const out = report([]);
		expect(out.destinations[0]).toMatchObject({
			harness: "claude",
			status: "changed",
			added: ["references/agents-paragraph.md", "references/contract-file.md"],
			updated: ["SKILL.md"],
			removed: ["old/notes.md", "references/stale.md"],
		});
		expectInstalled(skill, "imp-feature");
		expect(snapshot(sibling)).toEqual(siblingBefore);
		expect(readFileSync(join(home, ".claude/skills/loose.md"), "utf8")).toBe(
			"loose\n",
		);
	});

	test("a symlink in the skill directory is removed, not followed", () => {
		const skill = join(home, ".codex/skills/imp-feature");
		const outside = join(root, "outside.md");
		writeFileSync(outside, "outside\n");
		mkdirSync(skill, { recursive: true });
		symlinkSync(outside, join(skill, "SKILL.md"));
		symlinkSync(outside, join(skill, "extra.md"));
		const out = report([]);
		expect(out.destinations[1]).toMatchObject({
			updated: ["SKILL.md"],
			removed: ["extra.md"],
		});
		expectInstalled(skill, "imp-feature");
		expect(readFileSync(outside, "utf8")).toBe("outside\n");
	});

	test("a destination that is not a directory is refused before any write", () => {
		mkdirSync(join(home, ".codex/skills"), { recursive: true });
		writeFileSync(join(home, ".codex/skills/imp-feature"), "a file\n");
		const result = run([]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("is not a directory");
		expect(existsSync(join(home, ".claude"))).toBe(false);
	});
});

describe("a second run (IS-6)", () => {
	test("reports current at every destination and changes nothing", () => {
		report([]);
		const before = snapshot(home);
		const out = report([]);
		expect(out.status).toBe("current");
		for (const d of out.destinations)
			expect(d).toMatchObject({
				status: "current",
				added: [],
				updated: [],
				removed: [],
			});
		expect(snapshot(home)).toEqual(before);
		const text = run([]);
		expect(text.stdout.trim().split("\n")).toEqual([
			`claude imp-feature: ${join(home, ".claude/skills/imp-feature")} current`,
			`codex imp-feature: ${join(home, ".codex/skills/imp-feature")} current`,
		]);
		expect(snapshot(home)).toEqual(before);
	});
});
