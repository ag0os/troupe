/**
 * The Shepherd package's build definition: the roster is `shepherd` alone,
 * declarations under `agents/`, extension code under `lib/shepherd/`, text
 * under `system-prompts/`, binaries in the package's `bin/`, and the v2
 * stamp over the installed Troupe and this package.
 */

import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { AgentBuildDefinition, BuildStampPolicy } from "troupe/compiler";
import { createGitRunner, type GitRunner } from "troupe/provenance";
import { shepherdStampV2, type V2Layout } from "./shepherd-source-v2";

/** The package directory this module belongs to. */
export const PACKAGE_ROOT = resolve(import.meta.dir, "..");

/** The binary the package builds and stamps. */
export const SHEPHERD_ID = "shepherd";

/** Where a file of the installed compiler lies below the distribution root. */
const COMPILER_FILE = "lib/agent-format/compiler.ts";

/**
 * The real directory of the Troupe distribution that `packageRoot` resolves:
 * the `realpath` of its installed `lib/agent-format/compiler.ts`, walked up
 * to the distribution root. Bun 1.2.22 installs a folder dependency as
 * per-file symlinks and 1.4.4 as hardlinks; the realpath names the staged
 * files under either. A directory without an installation of its own (a
 * test fixture) gets the Troupe this package resolves.
 */
export function troupeRoot(packageRoot: string = PACKAGE_ROOT): string {
	for (const from of [packageRoot, PACKAGE_ROOT]) {
		let entry: string;
		try {
			entry = Bun.resolveSync("troupe/compiler", from);
		} catch {
			continue;
		}
		// `<root>/lib/entries/compiler.ts` beside `<root>/lib/agent-format/`.
		const installed = join(dirname(dirname(dirname(entry))), COMPILER_FILE);
		return dirname(dirname(dirname(realpathSync(installed))));
	}
	throw new Error(`troupe is not installed for ${packageRoot}`);
}

/**
 * Where the package's revision is read: the Git repository holding it and
 * its prefix there, or undefined outside Git.
 */
export function packageRevision(
	packageRoot: string = PACKAGE_ROOT,
	git: GitRunner = createGitRunner(),
): V2Layout["revision"] {
	const result = git(["rev-parse", "--show-toplevel"], packageRoot);
	if (result.code !== 0) return undefined;
	const gitRoot = new TextDecoder().decode(result.stdout).trim();
	const prefix = relative(realpathSync(gitRoot), realpathSync(packageRoot));
	return { gitRoot, prefix, git };
}

/** The v2 layout of the package at `packageRoot`. */
export function packageLayout(packageRoot: string = PACKAGE_ROOT): V2Layout {
	const revision = packageRevision(packageRoot);
	return {
		packageRoot: resolve(packageRoot),
		troupeRoot: troupeRoot(packageRoot),
		...(revision ? { revision } : {}),
	};
}

/** The v2 stamp, with the layout read when a build captures it. */
export function packageStamp(
	packageRoot: string = PACKAGE_ROOT,
): BuildStampPolicy {
	let policy: BuildStampPolicy | undefined;
	const current = () => {
		policy ??= shepherdStampV2(packageLayout(packageRoot));
		return policy;
	};
	return {
		capture: (context) => current().capture(context),
		recheck: (context, captured) => current().recheck(context, captured),
		versionLine: (agentId, captured) =>
			current().versionLine(agentId, captured),
	};
}

/** The directories the package's watcher rebuilds on. */
export const WATCH_ROOTS = [
	"agents",
	"system-prompts",
	"lib/shepherd",
	"packages",
	"scripts",
];

export function shepherdDefinition(
	root: string = PACKAGE_ROOT,
	options: { outDir?: string; stamp?: BuildStampPolicy } = {},
): AgentBuildDefinition {
	const consumerRoot = resolve(root);
	return {
		consumerRoot,
		declarationRoot: "agents",
		includeRoots: ["agents", "system-prompts"],
		extensionCodeRoots: ["lib/shepherd"],
		extensionTextRoots: ["system-prompts"],
		roster: [SHEPHERD_ID],
		outDir: resolve(options.outDir ?? join(consumerRoot, "bin")),
		// The compile and identity inputs. The watcher takes directories, so
		// the metadata files at the root (package.json, bun.lock,
		// tsconfig.json) are not watched; bin/, node_modules and eval
		// evidence never are.
		watchRoots: WATCH_ROOTS,
		stamps: { [SHEPHERD_ID]: options.stamp ?? packageStamp(consumerRoot) },
	};
}
