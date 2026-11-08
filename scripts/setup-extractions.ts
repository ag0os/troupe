#!/usr/bin/env bun
/**
 * Prepare the extracted packages for checks: stage Troupe into
 * `extractions/.troupe-dist/troupe/` (`scripts/stage-troupe.ts`), then run
 * each package's frozen install. A fresh checkout runs this before its first
 * commit, and root checks assume it ran.
 *
 * Bun links each staged file into the package at install time, so changed
 * bytes in an existing member need no reinstall, but the installed tree must
 * hold exactly the staged members. Each install records the inventory it
 * linked in `node_modules/.troupe-stage-inventory.json`. When a restage
 * changes the inventory, the frozen install runs again (Bun 1.2.22 and 1.4.4
 * both relink added and removed members of a folder dependency on a frozen
 * install with an unchanged lockfile); if the installed tree still differs,
 * the installed `troupe` is removed and installed afresh.
 *
 * Bun 1.2.22 resolves a per-file symlinked module from its real path, the
 * stage, whose imports (`typescript`, `yaml`, `zod`) would otherwise walk up
 * to this checkout's own `node_modules` before `NODE_PATH` is consulted
 * (C9). Setup links the stage's parent `node_modules` to the package's, so
 * the walk stops there, then runs the package's `scripts/resolution.ts`
 * with `--no-install` and `NODE_PATH=<package>/node_modules`: it records in
 * `node_modules/.troupe-resolution.json` where each runtime dependency
 * resolves under the runtime, `bun test`, `bun build` and `tsc`, and setup
 * fails unless every one is the package's own copy at its `bun.lock`
 * version.
 *
 * Usage:
 *   bun scripts/setup-extractions.ts
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DEFAULT_STAGE, STAGE_MANIFEST, stageTroupe } from "./stage-troupe";

/** The extracted packages that install the staged distribution. */
export const PACKAGES = ["extractions/shepherd"] as const;

/** Where an install records the inventory it linked, inside `node_modules`. */
export const INVENTORY_FILE = "node_modules/.troupe-stage-inventory.json";

/** Where setup records the package's runtime dependency resolutions. */
export const RESOLUTION_FILE = "node_modules/.troupe-resolution.json";

/** The package script that probes and checks those resolutions. */
export const RESOLUTION_SCRIPT = "scripts/resolution.ts";

export interface SetupOptions {
	/** The Troupe checkout to stage from. */
	root: string;
	/** The stage directory. Defaults to `<root>/extractions/.troupe-dist/troupe`. */
	stage?: string;
	/** Package directories. Defaults to `PACKAGES` under `root`. */
	packages?: readonly string[];
	/** The Bun executable that installs. Defaults to the running one. */
	bun?: string;
	log?: (line: string) => void;
}

export interface PackageSetup {
	dir: string;
	/** Why the package was installed: first install, a changed inventory, or a routine frozen install. */
	reason: "fresh" | "inventory" | "frozen";
	/** True when the installed tree still differed and `troupe` was reinstalled from scratch. */
	relinked: boolean;
	/** Where each runtime dependency resolved, per tool, as the package's guard reported it. */
	resolutions: { tool: string; name: string; dir: string; version: string }[];
}

/**
 * Point `<stage parent>/node_modules` at the package's `node_modules`,
 * replacing an older link; refuse anything that is not a link.
 */
function linkStageParent(stage: string, pkg: string): void {
	const link = join(dirname(stage), "node_modules");
	const target = relative(dirname(link), join(pkg, "node_modules"));
	const stat = lstatSync(link, { throwIfNoEntry: false });
	if (stat !== undefined) {
		if (!stat.isSymbolicLink()) {
			throw new Error(`${link} exists and is not a symlink; remove it`);
		}
		if (readlinkSync(link) === target) return;
		rmSync(link);
	}
	symlinkSync(target, link);
}

/**
 * Run the package's resolution guard as an installed consumer would:
 * `--no-install`, `NODE_PATH=<package>/node_modules`, cwd the package.
 */
function checkResolution(
	bun: string,
	dir: string,
): PackageSetup["resolutions"] {
	const result = spawnSync(bun, ["--no-install", RESOLUTION_SCRIPT, "--json"], {
		cwd: dir,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, NODE_PATH: join(dir, "node_modules") },
		encoding: "utf8",
	});
	let report: { resolutions: PackageSetup["resolutions"]; problems: string[] };
	try {
		report = JSON.parse(result.stdout);
	} catch {
		throw new Error(
			`${RESOLUTION_SCRIPT} failed in ${dir} (exit ${result.status}):\n${result.stdout}${result.stderr}`,
		);
	}
	writeFileSync(
		join(dir, RESOLUTION_FILE),
		`${JSON.stringify(report.resolutions, null, "\t")}\n`,
	);
	if (result.status !== 0 || report.problems.length > 0) {
		throw new Error(
			`${dir}: the installed troupe's runtime imports do not resolve to the package's own dependencies:\n${report.problems.join("\n")}`,
		);
	}
	return report.resolutions;
}

/** Every file path the stage holds, sorted: its members plus metadata. */
function stagedInventory(stage: string): string[] {
	const manifest = JSON.parse(
		readFileSync(join(stage, STAGE_MANIFEST), "utf8"),
	) as { members: { path: string }[] };
	return [
		...manifest.members.map((member) => member.path),
		"package.json",
		STAGE_MANIFEST,
	].sort();
}

/**
 * Every file path the installed `troupe` holds, sorted. Bun 1.2.22 installs
 * per-file symlinks and 1.4.4 hardlinks, so both count as files.
 */
function installedInventory(dir: string): string[] {
	const installed = join(dir, "node_modules/troupe");
	const files: string[] = [];
	const walk = (sub: string) => {
		for (const entry of readdirSync(join(installed, sub), {
			withFileTypes: true,
		})) {
			const path = sub === "" ? entry.name : `${sub}/${entry.name}`;
			if (entry.isDirectory()) walk(path);
			else files.push(path);
		}
	};
	if (existsSync(installed)) walk("");
	return files.sort();
}

function readRecorded(dir: string): string[] | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, INVENTORY_FILE), "utf8"));
	} catch {
		return undefined;
	}
}

const same = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((value, index) => value === b[index]);

function frozenInstall(bun: string, dir: string): void {
	const result = spawnSync(bun, ["install", "--frozen-lockfile"], {
		cwd: dir,
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
	if (result.status !== 0) {
		throw new Error(
			`bun install --frozen-lockfile failed in ${dir}:\n${result.stdout}${result.stderr}`,
		);
	}
}

export function setupExtractions(options: SetupOptions): PackageSetup[] {
	const root = resolve(options.root);
	const stage = resolve(options.stage ?? join(root, DEFAULT_STAGE));
	const bun = options.bun ?? process.execPath;
	const log = options.log ?? (() => {});
	const staged = stageTroupe(root, stage);
	log(
		`staged ${staged.members.length} members into ${relative(root, stage) || stage}`,
	);
	const inventory = stagedInventory(stage);
	const packages = (options.packages ?? PACKAGES).map((entry) =>
		resolve(root, entry),
	);
	if (packages.length !== 1) {
		throw new Error(
			"setup links the stage's parent node_modules to one package; stage each package separately",
		);
	}
	const results: PackageSetup[] = [];
	for (const dir of packages) {
		const recorded = readRecorded(dir);
		const reason: PackageSetup["reason"] =
			recorded === undefined
				? "fresh"
				: same(recorded, inventory)
					? "frozen"
					: "inventory";
		frozenInstall(bun, dir);
		let relinked = false;
		if (!same(installedInventory(dir), inventory)) {
			rmSync(join(dir, "node_modules/troupe"), {
				recursive: true,
				force: true,
			});
			frozenInstall(bun, dir);
			relinked = true;
			if (!same(installedInventory(dir), inventory)) {
				throw new Error(
					`${dir}: the installed troupe does not hold the staged inventory after a fresh install`,
				);
			}
		}
		writeFileSync(
			join(dir, INVENTORY_FILE),
			`${JSON.stringify(inventory, null, "\t")}\n`,
		);
		log(
			`${relative(root, dir)}: frozen install (${reason}${relinked ? ", relinked" : ""})`,
		);
		linkStageParent(stage, dir);
		const resolutions = checkResolution(bun, dir);
		for (const entry of resolutions) {
			log(
				`${relative(root, dir)}: ${entry.tool} ${entry.name}@${entry.version} ${relative(root, entry.dir) || entry.dir}`,
			);
		}
		results.push({ dir, reason, relinked, resolutions });
	}
	return results;
}

if (import.meta.main) {
	try {
		setupExtractions({
			root: resolve(import.meta.dir, ".."),
			log: (line) => console.log(line),
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
