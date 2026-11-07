import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
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

// O26: the extracted package is a complete, checked copy of the original
// layout. Both trees are listed by Git (tracked plus untracked nonignored
// files, so each tree's own ignore rules apply), every mapped file must
// match in presence, bytes and executable status after only the rewrites
// ADAPTATIONS.json records, and every other package file must be listed as
// extraction-only.

interface Adaptations {
	mappings: { from: string; to: string }[];
	rewrites: { file: string; from: string; to: string; count: number }[];
	extractionOnly: string[];
	excluded: { path: string; reason: string }[];
}

const repo = resolve(import.meta.dir, "..");
const PACKAGE = "extractions/shepherd";

/** Files Git lists under `path` (all of `cwd` when omitted), relative to `cwd`. */
function listed(cwd: string, path?: string): string[] {
	const result = spawnSync(
		"git",
		[
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			"-z",
			...(path ? ["--", path] : []),
		],
		{ cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
	);
	if (result.status !== 0) throw new Error(result.stderr.toString());
	return result.stdout
		.toString()
		.split("\0")
		.filter((entry) => entry !== "" && existsSync(join(cwd, entry)));
}

const under = (path: string, entry: string) =>
	entry.endsWith("/") ? path.startsWith(entry) : path === entry;

const executable = (file: string) => (statSync(file).mode & 0o111) !== 0;

/** Every difference between the two trees that the adaptations do not permit. */
export function copyProblems(
	sourceRoot: string,
	packageRoot: string,
	adaptations: Adaptations,
): string[] {
	const problems: string[] = [];
	const excluded = (path: string) =>
		adaptations.excluded.some((entry) => under(path, entry.path));
	/** Destination path to source path, for every mapped file. */
	const expected = new Map<string, string>();
	for (const mapping of adaptations.mappings) {
		if (!mapping.from.endsWith("/")) {
			if (!existsSync(join(sourceRoot, mapping.from))) {
				problems.push(`${mapping.from}: mapped source is missing`);
				continue;
			}
			expected.set(mapping.to, mapping.from);
			continue;
		}
		const files = listed(sourceRoot, mapping.from).filter(
			(path) => !excluded(path),
		);
		if (files.length === 0) {
			problems.push(`${mapping.from}: mapped source tree is empty`);
		}
		for (const path of files) {
			expected.set(mapping.to + path.slice(mapping.from.length), path);
		}
	}

	const rewrites = new Map<string, Adaptations["rewrites"]>();
	for (const rewrite of adaptations.rewrites) {
		if (!expected.has(rewrite.file)) {
			problems.push(`${rewrite.file}: rewrite names no mapped file`);
			continue;
		}
		rewrites.set(rewrite.file, [
			...(rewrites.get(rewrite.file) ?? []),
			rewrite,
		]);
	}

	const present = new Set(listed(packageRoot));
	for (const [destination, source] of expected) {
		const target = join(packageRoot, destination);
		if (!present.has(destination)) {
			problems.push(`${destination}: missing from the package (${source})`);
			continue;
		}
		let text = readFileSync(join(sourceRoot, source)).toString("latin1");
		for (const rewrite of rewrites.get(destination) ?? []) {
			const from = Buffer.from(rewrite.from).toString("latin1");
			const count = text.split(from).length - 1;
			if (count !== rewrite.count) {
				problems.push(
					`${destination}: rewrite expects ${rewrite.count} occurrence(s) of ${JSON.stringify(rewrite.from)}, the source has ${count}`,
				);
				continue;
			}
			text = text.split(from).join(Buffer.from(rewrite.to).toString("latin1"));
		}
		if (!Buffer.from(text, "latin1").equals(readFileSync(target))) {
			problems.push(`${destination}: bytes differ from ${source}`);
		}
		if (executable(join(sourceRoot, source)) !== executable(target)) {
			problems.push(`${destination}: executable status differs from ${source}`);
		}
	}

	const only = new Set(adaptations.extractionOnly);
	for (const path of only) {
		if (expected.has(path)) {
			problems.push(`${path}: listed extraction-only but also mapped`);
		}
		if (!present.has(path)) {
			problems.push(`${path}: extraction-only file is missing`);
		}
	}
	for (const path of present) {
		if (expected.has(path) || only.has(path) || excluded(path)) continue;
		problems.push(`${path}: in the package but neither mapped nor listed`);
	}
	return problems.sort();
}

describe("the copy check (O26)", () => {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-copy-")));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));
	let count = 0;

	const ADAPTATIONS: Adaptations = {
		mappings: [
			{ from: "lib/shepherd/", to: "lib/shepherd/" },
			{ from: "agents/shepherd.ts", to: "agents/shepherd.ts" },
		],
		rewrites: [
			{
				file: "agents/shepherd.ts",
				from: 'from "../lib/agent-format/types";',
				to: 'from "troupe";',
				count: 1,
			},
		],
		extractionOnly: ["package.json"],
		excluded: [{ path: "lib/shepherd/results/", reason: "evidence" }],
	};

	/** A source repository holding a package that passes the check. */
	function fixture(): { source: string; pkg: string } {
		const source = join(scratch, `repo-${count++}`);
		const pkg = join(source, PACKAGE);
		const put = (root: string, path: string, text: string, mode = 0o644) => {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
			chmodSync(join(root, path), mode);
		};
		put(source, "lib/shepherd/a.ts", "export const a = 1;\n");
		put(source, "lib/shepherd/tool", "#!/bin/sh\n", 0o755);
		put(source, "lib/shepherd/results/x.json", "{}\n");
		put(
			source,
			"agents/shepherd.ts",
			'import type { X } from "../lib/agent-format/types";\n',
		);
		put(source, "agents/other.ts", "not mapped\n");
		put(pkg, "lib/shepherd/a.ts", "export const a = 1;\n");
		put(pkg, "lib/shepherd/tool", "#!/bin/sh\n", 0o755);
		put(pkg, "agents/shepherd.ts", 'import type { X } from "troupe";\n');
		put(pkg, "package.json", "{}\n");
		put(pkg, "lib/shepherd/results/own.json", "{}\n");
		spawnSync("git", ["init", "-q"], { cwd: source });
		return { source, pkg };
	}

	test("a faithful copy passes", () => {
		const { source, pkg } = fixture();
		expect(copyProblems(source, pkg, ADAPTATIONS)).toEqual([]);
	});

	test("a new package file fails", () => {
		const { source, pkg } = fixture();
		writeFileSync(join(pkg, "lib/shepherd/new.ts"), "new\n");
		expect(copyProblems(source, pkg, ADAPTATIONS)).toEqual([
			"lib/shepherd/new.ts: in the package but neither mapped nor listed",
		]);
	});

	test("a deletion fails on either side", () => {
		const { source, pkg } = fixture();
		rmSync(join(pkg, "lib/shepherd/a.ts"));
		rmSync(join(pkg, "package.json"));
		expect(copyProblems(source, pkg, ADAPTATIONS)).toEqual([
			"lib/shepherd/a.ts: missing from the package (lib/shepherd/a.ts)",
			"package.json: extraction-only file is missing",
		]);
		const other = fixture();
		rmSync(join(other.source, "agents/shepherd.ts"));
		expect(copyProblems(other.source, other.pkg, ADAPTATIONS)).toEqual([
			"agents/shepherd.ts: in the package but neither mapped nor listed",
			"agents/shepherd.ts: mapped source is missing",
			"agents/shepherd.ts: rewrite names no mapped file",
		]);
	});

	test("an unlisted byte change fails", () => {
		const { source, pkg } = fixture();
		writeFileSync(join(pkg, "lib/shepherd/a.ts"), "export const a = 2;\n");
		writeFileSync(
			join(pkg, "agents/shepherd.ts"),
			'import type { X } from "troupe";\n// extra\n',
		);
		expect(copyProblems(source, pkg, ADAPTATIONS)).toEqual([
			"agents/shepherd.ts: bytes differ from agents/shepherd.ts",
			"lib/shepherd/a.ts: bytes differ from lib/shepherd/a.ts",
		]);
	});

	test("an executable bit flip fails", () => {
		const { source, pkg } = fixture();
		chmodSync(join(pkg, "lib/shepherd/tool"), 0o644);
		expect(copyProblems(source, pkg, ADAPTATIONS)).toEqual([
			"lib/shepherd/tool: executable status differs from lib/shepherd/tool",
		]);
	});

	test("a stale rewrite fails: its text absent or counted differently", () => {
		const { source, pkg } = fixture();
		writeFileSync(
			join(source, "agents/shepherd.ts"),
			'import type { X } from "../lib/index";\n',
		);
		const stale = copyProblems(source, pkg, ADAPTATIONS);
		expect(stale).toContain(
			'agents/shepherd.ts: rewrite expects 1 occurrence(s) of "from \\"../lib/agent-format/types\\";", the source has 0',
		);
		writeFileSync(
			join(source, "agents/shepherd.ts"),
			'import type { X } from "../lib/agent-format/types";\nimport type { Y } from "../lib/agent-format/types";\n',
		);
		expect(copyProblems(source, pkg, ADAPTATIONS)).toContain(
			'agents/shepherd.ts: rewrite expects 1 occurrence(s) of "from \\"../lib/agent-format/types\\";", the source has 2',
		);
		expect(
			copyProblems(source, pkg, {
				...ADAPTATIONS,
				rewrites: [{ file: "agents/gone.ts", from: "a", to: "b", count: 1 }],
			}),
		).toContain("agents/gone.ts: rewrite names no mapped file");
	});

	test("the extracted package is a complete copy of the original layout", () => {
		const adaptations: Adaptations = JSON.parse(
			readFileSync(join(repo, PACKAGE, "ADAPTATIONS.json"), "utf8"),
		);
		expect(copyProblems(repo, join(repo, PACKAGE), adaptations)).toEqual([]);
		// Each listed exclusion names a real source path and why.
		for (const entry of adaptations.excluded) {
			expect(existsSync(join(repo, entry.path))).toBe(true);
			expect(entry.reason.length).toBeGreaterThan(0);
		}
		expect(adaptations.extractionOnly).toEqual(
			[...adaptations.extractionOnly].sort(),
		);
	});
});
