/**
 * Legacy adapter: the shared compiler lives in `lib/agent-format/compiler.ts`
 * and takes an `AgentBuildDefinition`. This module keeps the repository's
 * call shapes (a `root`, optional `outDir` and `roster`) and supplies the
 * repository's configuration: declarations under `agents/`, includes under
 * `agents/` and `system-prompts/`, extension code under the two framework
 * directories, text under `system-prompts/`, the fixed `ROSTER`, `bin/`,
 * outputs of other `compile:*` scripts protected, and `agents/` and
 * `system-prompts/` watched. Existing imports of this path keep working.
 */

import { join, resolve } from "node:path";
import {
	type AgentBuildDefinition,
	type Builder,
	type BuildPlan,
	FRAMEWORK_DIRS,
	INCLUDE_ROOTS,
	type PublishOptions as LibPublishOptions,
	type WatcherOptions as LibWatcherOptions,
	type LoadedAgent,
	compileAgent as libCompileAgent,
	loadAgentDefinition as libLoadAgentDefinition,
	planBuild as libPlanBuild,
	publish as libPublish,
	resolveAgentName as libResolveAgentName,
	startWatcher as libStartWatcher,
	type PublishResult,
	protectedBinaries,
	ROSTER,
	TEXT_IMPORT_DIR,
	WATCH_ROOTS,
} from "../lib/agent-format/compiler";
import type { BuildProvenance, StampSource } from "./shepherd-source";

export * from "../lib/agent-format/compiler";

/**
 * The repository's build definition for `root`. Protected outputs are read
 * from `package.json` when pruning is decided, as before.
 */
export function legacyDefinition(
	root: string,
	options: { outDir?: string; roster?: readonly string[] } = {},
): AgentBuildDefinition {
	const consumerRoot = resolve(root);
	return {
		consumerRoot,
		declarationRoot: "agents",
		includeRoots: INCLUDE_ROOTS,
		extensionCodeRoots: FRAMEWORK_DIRS,
		extensionTextRoots: [TEXT_IMPORT_DIR],
		roster: options.roster ?? ROSTER,
		// Relative to the working directory, as before.
		outDir: resolve(options.outDir ?? join(consumerRoot, "bin")),
		get protectedOutputs() {
			return [...protectedBinaries(consumerRoot)];
		},
		watchRoots: WATCH_ROOTS,
	};
}

export interface CompilerOptions {
	root: string;
	/** Output directory. Defaults to `<root>/bin`. */
	outDir?: string;
	/** Defaults to `ROSTER`. */
	roster?: readonly string[];
	/** Shepherd's provenance. Defaults to the Git repository at `root`. */
	stamp?: StampSource;
	/** Defaults to `bun build --compile`; tests pass a fake. */
	build?: Builder;
}

export interface PublishOptions
	extends CompilerOptions,
		Omit<LibPublishOptions, "definition" | "stamp" | "build"> {}

export interface WatcherOptions
	extends CompilerOptions,
		Omit<LibWatcherOptions, "definition" | "stamp" | "build"> {}

export function loadAgentDefinition(
	root: string,
	file: string,
): Promise<LoadedAgent> {
	return libLoadAgentDefinition(legacyDefinition(root), file);
}

export function resolveAgentName(
	root: string,
	argument: string,
	cwd = process.cwd(),
): string {
	return libResolveAgentName(legacyDefinition(root), argument, cwd);
}

export function planBuild(
	options: CompilerOptions & { only?: string },
): Promise<BuildPlan> {
	return libPlanBuild({
		definition: legacyDefinition(options.root, options),
		only: options.only,
	});
}

export function compileAgent(options: {
	root: string;
	file: string;
	outFile: string;
	stamp?: StampSource;
	build?: Builder;
	signal?: AbortSignal;
}): Promise<LoadedAgent & { provenance?: BuildProvenance }> {
	const { root, outFile, ...rest } = options;
	return libCompileAgent({
		...rest,
		definition: legacyDefinition(root),
		// Relative to the working directory, as before.
		outFile: resolve(outFile),
	});
}

export function publish(options: PublishOptions): Promise<PublishResult> {
	const { root, outDir, roster, ...rest } = options;
	return libPublish({
		...rest,
		definition: legacyDefinition(root, { outDir, roster }),
	});
}

export function startWatcher(
	options: WatcherOptions,
): ReturnType<typeof libStartWatcher> {
	const { root, outDir, roster, ...rest } = options;
	return libStartWatcher({
		...rest,
		definition: legacyDefinition(root, { outDir, roster }),
	});
}
