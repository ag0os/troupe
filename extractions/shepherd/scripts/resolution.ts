#!/usr/bin/env bun
/**
 * Where the installed Troupe's runtime imports resolve (C8, C9). Troupe's
 * staged sources import `typescript`, `yaml` and `zod`; this package must
 * supply them from its own `node_modules`, at the versions its `bun.lock`
 * records, under every tool that loads them: the runtime, `bun test`,
 * `bun build` and `tsc`.
 *
 * Bun 1.2.22 installs a folder dependency as per-file symlinks and resolves
 * a symlinked module from its real path, the stage. In the in-repo layout
 * the stage sits inside the Troupe checkout, so its imports would otherwise
 * walk up to the checkout's own `node_modules` before `NODE_PATH` is
 * consulted; `setup:extractions` links the stage's parent `node_modules` to
 * this package's. This script is the guard: it fails when any import
 * resolves anywhere else or at another version.
 *
 * Every probe runs with `--no-install` (auto-install ignores declared
 * ranges) and `NODE_PATH=<package>/node_modules`, from probe files it writes
 * under `node_modules/.troupe-probe/` and removes afterwards.
 *
 * Usage:
 *   bun --no-install scripts/resolution.ts [--json]
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** The installed Troupe's runtime dependencies. */
export const RUNTIME_DEPENDENCIES = ["typescript", "yaml", "zod"] as const;

/** Every public entry; importing them all loads every runtime import. */
const ENTRIES = [
	"troupe",
	"troupe/declaration",
	"troupe/cli",
	"troupe/runtime",
	"troupe/compiler",
	"troupe/provenance",
	"troupe/testing",
];

export type Tool = "runtime" | "test" | "build" | "tsc";

export interface Resolution {
	tool: Tool;
	name: string;
	/** The real path of the package directory the import resolved to. */
	dir: string;
	/** That directory's `package.json` version. */
	version: string;
}

export interface ResolutionOptions {
	/** The Bun executable for the runtime, test and build probes. */
	bun?: string;
}

const PROBE_DIR = "node_modules/.troupe-probe";

function probeEnv(pkg: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		NO_COLOR: "1",
		NODE_PATH: join(pkg, "node_modules"),
	};
}

function run(argv: string[], pkg: string): string {
	const [command, ...args] = argv;
	const result = spawnSync(command ?? "", args, {
		cwd: pkg,
		env: probeEnv(pkg),
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	if (result.status !== 0) {
		throw new Error(
			`${argv.join(" ")} failed in ${pkg} (exit ${result.status}):\n${`${result.stdout}${result.stderr}`.slice(-4000)}`,
		);
	}
	return `${result.stdout}${result.stderr}`;
}

/** The directory of package `name` holding `file`, by its last `node_modules/<name>/` segment. */
function packageDirOf(file: string, name: string): string | undefined {
	const marker = `/node_modules/${name}/`;
	const at = file.lastIndexOf(marker);
	if (at < 0) return undefined;
	return file.slice(0, at + marker.length - 1);
}

function describe(tool: Tool, name: string, dir: string): Resolution {
	const real = realpathSync(dir);
	const version = JSON.parse(
		readFileSync(join(real, "package.json"), "utf8"),
	).version;
	return { tool, name, dir: real, version };
}

/** One resolution per distinct directory each dependency was loaded from. */
function collect(tool: Tool, files: Iterable<string>): Resolution[] {
	const found = new Map<string, Resolution>();
	for (const file of files) {
		for (const name of RUNTIME_DEPENDENCIES) {
			const dir = packageDirOf(file, name);
			if (dir === undefined) continue;
			const resolution = describe(tool, name, dir);
			found.set(`${name}\0${resolution.dir}`, resolution);
		}
	}
	return [...found.values()];
}

const LOADED = `console.log(JSON.stringify([...globalThis.Loader.registry.keys()]));`;

/** Run each probe and report where every runtime dependency resolved, and which probes failed. */
export function probeResolution(
	pkgDir: string,
	options: ResolutionOptions = {},
): { resolutions: Resolution[]; failures: string[] } {
	const pkg = realpathSync(resolve(pkgDir));
	const bun = options.bun ?? process.execPath;
	const probe = join(pkg, PROBE_DIR);
	rmSync(probe, { recursive: true, force: true });
	mkdirSync(probe, { recursive: true });
	try {
		const imports = ENTRIES.map((entry) => `import "${entry}";`).join("\n");
		writeFileSync(join(probe, "entry.ts"), `${imports}\n`);
		writeFileSync(join(probe, "runtime.ts"), `${imports}\n${LOADED}\n`);
		writeFileSync(
			join(probe, "probe.test.ts"),
			`${imports}\nimport { test } from "bun:test";\ntest("loaded", () => {\n${LOADED}\n});\n`,
		);
		writeFileSync(
			join(probe, "tsconfig.json"),
			JSON.stringify({
				extends: "../../tsconfig.json",
				compilerOptions: { noEmit: true },
				files: ["entry.ts"],
				include: [],
			}),
		);
		const loaded = (output: string): string[] => {
			const line = output
				.split("\n")
				.find((candidate) => candidate.startsWith("["));
			if (line === undefined)
				throw new Error(`no loaded module list in:\n${output}`);
			return JSON.parse(line);
		};
		const probes: Record<Tool, () => string[]> = {
			runtime: () =>
				loaded(run([bun, "--no-install", join(probe, "runtime.ts")], pkg)),
			test: () =>
				loaded(
					run(
						[bun, "--no-install", "test", `./${PROBE_DIR}/probe.test.ts`],
						pkg,
					),
				),
			build: () => {
				const bundle = join(probe, "bundle.js");
				run(
					[
						bun,
						"--no-install",
						"build",
						join(probe, "entry.ts"),
						"--target",
						"bun",
						"--outfile",
						bundle,
					],
					pkg,
				);
				// Bun marks each bundled module with a `// <path>` line relative to the cwd.
				return readFileSync(bundle, "utf8")
					.split("\n")
					.filter((line) => line.startsWith("// ") && line.includes("/"))
					.map((line) => `${resolve(pkg, line.slice(3).trim())}/`);
			},
			tsc: () => {
				const trace = run(
					[
						join(pkg, "node_modules/.bin/tsc"),
						"-p",
						join(probe, "tsconfig.json"),
						"--traceResolution",
					],
					pkg,
				);
				return [
					...trace.matchAll(
						/Module name '([^']+)' was successfully resolved to '([^']+)'/g,
					),
				].map((match) => match[2] ?? "");
			},
		};
		const results: Resolution[] = [];
		const failures: string[] = [];
		for (const [tool, files] of Object.entries(probes) as [
			Tool,
			() => string[],
		][]) {
			try {
				results.push(...collect(tool, files()));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${tool}: the probe failed: ${message}`);
			}
		}
		return { resolutions: results, failures };
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}

/** Each runtime dependency's location and version as the package's `bun.lock` records them. */
export function lockedDependencies(
	pkgDir: string,
): Map<string, { dir: string; version: string }> {
	const pkg = realpathSync(resolve(pkgDir));
	// bun.lock is JSON with trailing commas.
	const text = readFileSync(join(pkg, "bun.lock"), "utf8").replace(
		/,(\s*[}\]])/g,
		"$1",
	);
	const lock = JSON.parse(text) as { packages: Record<string, unknown[]> };
	const locked = new Map<string, { dir: string; version: string }>();
	for (const name of RUNTIME_DEPENDENCIES) {
		// A copy nested under troupe would be keyed `troupe/<name>`.
		const key = `troupe/${name}` in lock.packages ? `troupe/${name}` : name;
		const spec = lock.packages[key]?.[0];
		if (typeof spec !== "string") continue;
		locked.set(name, {
			dir: join(
				pkg,
				"node_modules",
				...key
					.split("/")
					.flatMap((part, index) =>
						index === 0 ? [part] : ["node_modules", part],
					),
			),
			version: spec.slice(spec.lastIndexOf("@") + 1),
		});
	}
	return locked;
}

/** Every resolution that is not the locked package directory and version; empty when all agree. */
export function resolutionProblems(
	pkgDir: string,
	resolutions: readonly Resolution[],
): string[] {
	const locked = lockedDependencies(pkgDir);
	const problems: string[] = [];
	const tools: Tool[] = ["runtime", "test", "build", "tsc"];
	for (const name of RUNTIME_DEPENDENCIES) {
		const expected = locked.get(name);
		if (expected === undefined) {
			problems.push(`${name}: bun.lock records no version`);
			continue;
		}
		const dir = existsSync(expected.dir)
			? realpathSync(expected.dir)
			: expected.dir;
		for (const tool of tools) {
			const found = resolutions.filter(
				(entry) => entry.tool === tool && entry.name === name,
			);
			if (found.length === 0) {
				problems.push(`${tool}: ${name} was never resolved`);
				continue;
			}
			for (const entry of found) {
				if (entry.dir !== dir) {
					problems.push(
						`${tool}: ${name} resolved to ${entry.dir}, not ${dir} (the package's node_modules)`,
					);
				} else if (entry.version !== expected.version) {
					problems.push(
						`${tool}: ${name} is ${entry.version}, but bun.lock records ${expected.version}`,
					);
				}
			}
		}
	}
	return problems;
}

if (import.meta.main) {
	const pkg = resolve(import.meta.dir, "..");
	const { resolutions, failures } = probeResolution(pkg);
	const problems = [...failures, ...resolutionProblems(pkg, resolutions)];
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify({ resolutions, problems }, null, "\t"));
	} else {
		for (const entry of resolutions) {
			console.log(
				`${entry.tool}\t${entry.name}@${entry.version}\t${entry.dir}`,
			);
		}
		for (const problem of problems) console.error(problem);
	}
	process.exit(problems.length === 0 ? 0 : 1);
}
