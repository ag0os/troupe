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
 * Usage:
 *   bun scripts/setup-extractions.ts
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { DEFAULT_STAGE, STAGE_MANIFEST, stageTroupe } from "./stage-troupe";

/** The extracted packages that install the staged distribution. */
export const PACKAGES = ["extractions/shepherd"] as const;

/** Where an install records the inventory it linked, inside `node_modules`. */
export const INVENTORY_FILE = "node_modules/.troupe-stage-inventory.json";

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
	const results: PackageSetup[] = [];
	for (const entry of options.packages ?? PACKAGES) {
		const dir = resolve(root, entry);
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
		results.push({ dir, reason, relinked });
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
