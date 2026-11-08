#!/usr/bin/env bun
/**
 * O25: prove each root and package gate catches a known failure. In a
 * disposable copy of this worktree's tracked files (with root dependencies
 * linked and `setup:extractions` run), plant a type error, a Biome lint
 * error and a failing test, one at a time, in a root framework file, a root
 * Shepherd file and a package file. Each plant must fail every gate that
 * covers its file, and every gate must pass on the clean copy before and
 * after the plants. The root gates cover package files too: root
 * TypeScript, Biome and `bun test` deliberately sweep the extracted package.
 * Prints a table and exits nonzero on any miss; the copy is removed unless
 * `--keep` is given.
 *
 * Usage:
 *   bun scripts/check-extraction-gates.ts [--keep]
 */

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PACKAGE_DIR = "extractions/shepherd";

export type Gate =
	| "root typecheck"
	| "root biome"
	| "root test"
	| "package typecheck"
	| "package biome"
	| "package test";

export const GATES: readonly Gate[] = [
	"root typecheck",
	"root biome",
	"root test",
	"package typecheck",
	"package biome",
	"package test",
];

export type Kind = "type" | "lint" | "test";
export type Place = "root framework" | "root shepherd" | "package";

/** A planted failure and the gates that must detect it. */
export interface Plant {
	place: Place;
	kind: Kind;
	/** The repository path the plant edits or creates. */
	file: string;
	/** Whether `file` is created (a test file) or appended to. */
	creates: boolean;
	text: string;
	gates: Gate[];
}

/** The file each place's type and lint plants append to. */
export const SOURCES: Record<Place, string> = {
	"root framework": "lib/agent-format/interpolate.ts",
	"root shepherd": "lib/shepherd/text.ts",
	package: `${PACKAGE_DIR}/lib/shepherd/text.ts`,
};

const TEST_FILE = "gate-plant.test.ts";

/** The test file each place's test plant creates, beside its source. */
export function testFile(place: Place): string {
	return join(dirname(SOURCES[place]), TEST_FILE);
}

const TYPE_TEXT = '\nexport const gatePlantType: number = "not a number";\n';
const LINT_TEXT = "\nexport function gatePlantLint(): void {\n\tdebugger;\n}\n";
/** The name of the failing plant's test, which detection must find in the gate's output. */
export const SENTINEL = "gate plant sentinel";
const testText = (pass: boolean) =>
	`import { expect, test } from "bun:test";\n\ntest("${pass ? "gate plant" : SENTINEL}", () => {\n\texpect(1).toBe(${pass ? 1 : 2});\n});\n`;

/** Every plant: three kinds in each of three places. */
export function plans(): Plant[] {
	const places: Place[] = ["root framework", "root shepherd", "package"];
	return places.flatMap((place): Plant[] => {
		const inPackage = place === "package";
		const gate = (kind: "typecheck" | "biome" | "test"): Gate[] =>
			inPackage ? [`root ${kind}`, `package ${kind}`] : [`root ${kind}`];
		return [
			{
				place,
				kind: "type",
				file: SOURCES[place],
				creates: false,
				text: TYPE_TEXT,
				gates: gate("typecheck"),
			},
			{
				place,
				kind: "lint",
				file: SOURCES[place],
				creates: false,
				text: LINT_TEXT,
				gates: gate("biome"),
			},
			{
				place,
				kind: "test",
				file: testFile(place),
				creates: true,
				text: testText(false),
				gates: gate("test"),
			},
		];
	});
}

/** The bare `bun test` filter the test gates pass: discovery, not a named path. */
export const TEST_FILTER = "gate-plant";

/**
 * The command and cwd (relative to the copy) of each gate. The test gates
 * pass a bare filter, so the plant files are found by ordinary discovery
 * from the gate's directory (a filter matching nothing exits nonzero).
 * On the clean copy they run the passing versions, under a plant the
 * failing one.
 */
export function gateCommand(gate: Gate): { argv: string[]; cwd: string } {
	const bun = process.execPath;
	switch (gate) {
		case "root typecheck":
			return { argv: [bun, "run", "typecheck"], cwd: "." };
		case "root biome":
			return { argv: [bun, "run", "check"], cwd: "." };
		case "root test":
			return { argv: [bun, "test", TEST_FILTER], cwd: "." };
		case "package typecheck":
			return { argv: [bun, "run", "typecheck"], cwd: PACKAGE_DIR };
		case "package biome":
			return { argv: [bun, "run", "check"], cwd: PACKAGE_DIR };
		case "package test":
			return { argv: [bun, "test", TEST_FILTER], cwd: PACKAGE_DIR };
	}
}

/**
 * Whether a test gate's output shows it ran the planted file: the plant's
 * path relative to the gate's directory as Bun's file header, and the
 * sentinel test's failure. Another failure is not detection.
 */
export function detected(plant: Plant, gate: Gate, output: string): boolean {
	const { cwd } = gateCommand(gate);
	const path = cwd === "." ? plant.file : plant.file.slice(cwd.length + 1);
	return (
		output.split("\n").includes(`${path}:`) &&
		output.includes(`(fail) ${SENTINEL}`)
	);
}

export interface Row {
	plant: string;
	gate: Gate;
	expected: "pass" | "fail";
	exit: number | null;
	ok: boolean;
}

function run(
	argv: string[],
	cwd: string,
): { exit: number | null; output: string } {
	const [command, ...args] = argv;
	const result = spawnSync(command ?? "", args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, NO_COLOR: "1" },
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	return {
		exit: result.status,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

/** Copy the tracked files of `repo` into a new directory, link root dependencies and run setup. */
export function disposableCopy(repo: string, parent: string): string {
	const copy = join(parent, "troupe");
	for (const path of git(["ls-files", "-z"], repo).split("\0")) {
		if (path === "") continue;
		const target = join(copy, path);
		mkdirSync(dirname(target), { recursive: true });
		try {
			copyFileSync(join(repo, path), target);
		} catch {
			// A tracked path deleted in the worktree is not copied.
		}
	}
	symlinkSync(join(repo, "node_modules"), join(copy, "node_modules"));
	if (run([process.execPath, "run", "setup:extractions"], copy).exit !== 0) {
		throw new Error(`setup:extractions failed in ${copy}`);
	}
	return copy;
}

const label = (plant: Plant) => `${plant.place} ${plant.kind} (${plant.file})`;

/** Write the passing test files every test gate runs on the clean copy. */
function cleanTests(copy: string): void {
	for (const place of [
		"root framework",
		"root shepherd",
		"package",
	] as Place[]) {
		writeFileSync(join(copy, testFile(place)), testText(true));
	}
}

function clean(copy: string, round: string): Row[] {
	return GATES.map((gate) => {
		const { argv, cwd } = gateCommand(gate);
		const { exit } = run(argv, join(copy, cwd));
		return {
			plant: `clean (${round})`,
			gate,
			expected: "pass",
			exit,
			ok: exit === 0,
		};
	});
}

export function checkGates(
	copy: string,
	log: (row: Row) => void = () => {},
): Row[] {
	const rows: Row[] = [];
	const record = (row: Row) => {
		rows.push(row);
		log(row);
	};
	cleanTests(copy);
	for (const row of clean(copy, "before")) record(row);
	for (const plant of plans()) {
		const path = join(copy, plant.file);
		const before = readFileSync(path);
		if (plant.creates) writeFileSync(path, plant.text);
		else appendFileSync(path, plant.text);
		try {
			for (const gate of plant.gates) {
				const { argv, cwd } = gateCommand(gate);
				const { exit, output } = run(argv, join(copy, cwd));
				record({
					plant: label(plant),
					gate,
					expected: "fail",
					exit,
					ok:
						exit !== 0 &&
						exit !== null &&
						(plant.kind !== "test" || detected(plant, gate, output)),
				});
			}
		} finally {
			writeFileSync(path, before);
		}
	}
	for (const row of clean(copy, "after")) record(row);
	return rows;
}

export function table(rows: readonly Row[]): string {
	return [
		"| plant | gate | expected | exit | result |",
		"|---|---|---|---|---|",
		...rows.map(
			(row) =>
				`| ${row.plant} | ${row.gate} | ${row.expected} | ${row.exit} | ${row.ok ? "ok" : "MISS"} |`,
		),
	].join("\n");
}

if (import.meta.main) {
	const repo = resolve(import.meta.dir, "..");
	const keep = process.argv.includes("--keep");
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "extraction-gates-")));
	let rows: Row[] = [];
	try {
		console.log(`bun ${Bun.version}`);
		console.log(
			`repository ${repo} at ${git(["rev-parse", "HEAD"], repo).trim()}`,
		);
		const copy = disposableCopy(repo, parent);
		console.log(
			`disposable copy ${copy} (tracked files, root node_modules linked, setup:extractions run)`,
		);
		for (const gate of GATES) {
			const { argv, cwd } = gateCommand(gate);
			console.log(
				`${gate}: (cd ${cwd} && ${argv.map((arg) => (arg === process.execPath ? "bun" : arg)).join(" ")})`,
			);
		}
		rows = checkGates(copy, (row) =>
			console.error(
				`${row.ok ? "ok  " : "MISS"} ${row.plant}: ${row.gate} exit ${row.exit}`,
			),
		);
		console.log(table(rows));
	} finally {
		if (keep) console.log(`kept ${parent}`);
		else rmSync(parent, { recursive: true, force: true });
	}
	const misses = rows.filter((row) => !row.ok).length;
	console.log(
		misses === 0
			? `all ${rows.length} checks ok`
			: `${misses} of ${rows.length} checks missed`,
	);
	process.exit(misses === 0 && rows.length > 0 ? 0 : 1);
}
