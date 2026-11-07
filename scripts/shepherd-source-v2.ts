/**
 * Shepherd source identity, v2: package-relative, table-driven membership
 * over two origins, `framework/troupe` (the installed Troupe bytes the build
 * selects) and `package/shepherd` (the Shepherd package). It is Shepherd
 * policy, built on Troupe's generic `troupe/provenance` helpers; PR 4 moves
 * it with the package. The shipped binary is still stamped by v1
 * (`scripts/shepherd-source.ts`), whose identities are never relabeled.
 *
 * Membership is explicit. Git ignore rules play no part: the package's own
 * `.gitignore` is an input, and a host's global excludes cannot change what
 * is hashed. Outputs, the staged distribution and generated eval evidence
 * are never selected; evaluation inputs have their own selector.
 *
 * The table is the extracted package's (design.md section 4): its build
 * definition, build and watch scripts and this policy, not the repository's
 * legacy wrappers or the v1 adapter. `biome.json` and `ADAPTATIONS.json`
 * are not build inputs and are left out. One implementation selects:
 * `isSourcePath` decides, and the reader walks the trees and keeps exactly
 * the paths it accepts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BuildStampPolicy,
	CapturedBuildStamp,
	StampJson,
} from "../lib/agent-format/compiler";
import {
	combineSourceInputs,
	type GitRunner,
	readSourceInputs,
	type SourceInputDefinition,
	type SourceManifest,
} from "../lib/agent-format/provenance";

export const SOURCE_DOMAIN_V2 = "troupe-agent-source-v2";
export const FRAMEWORK_ORIGIN = "framework/troupe";
export const PACKAGE_ORIGIN = "package/shepherd";

/** Package files every v2 Shepherd identity reads; each must exist. */
export const PACKAGE_FILES = [
	".gitignore",
	"agents/shepherd.md",
	"agents/shepherd.ts",
	"bun.lock",
	"package.json",
	"scripts/build.ts",
	"scripts/shepherd-definition.ts",
	"scripts/shepherd-source-v2.ts",
	"scripts/watch.ts",
	"tsconfig.json",
] as const;

/**
 * Package trees selected recursively. Where `tests` is false, `*.test.ts`,
 * `*.spec.ts` and paths beneath `__fixtures__` or `__snapshots__` are left
 * out; other helpers stay selected.
 */
export const PACKAGE_TREES = [
	{ dir: "lib/shepherd", tests: false },
	{ dir: "packages", tests: true },
	{ dir: "system-prompts/shepherd", tests: true },
] as const;

/** Never selected: outputs, the staged distribution and eval evidence. */
export const EXCLUDED_DIRS = [
	"bin",
	"extractions/.troupe-dist",
	"evals/shepherd/artifacts",
	"evals/shepherd/results",
	"evals/shepherd/validation",
] as const;

/** Names never selected anywhere: host and tool byproducts. */
const EXCLUDED_NAMES = new Set([".DS_Store", "node_modules", "__pycache__"]);

/** Runtime tools, whose executable status dispatch checks. */
export function isRuntimeTool(path: string): boolean {
	return /^packages\/[^/]+\/tools\//.test(path);
}

/**
 * Judged on every path component, names and suffixes alike, so a byproduct
 * directory hides its contents and the selector agrees with the traversal,
 * which prunes an excluded directory without visiting it.
 */
function excluded(path: string): boolean {
	const parts = path.split("/");
	return (
		parts.some((part) => EXCLUDED_NAMES.has(part) || part.endsWith(".pyc")) ||
		EXCLUDED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`))
	);
}

function isTestPath(path: string): boolean {
	const parts = path.split("/");
	const name = parts.pop() ?? "";
	return (
		name.endsWith(".test.ts") ||
		name.endsWith(".spec.ts") ||
		parts.includes("__fixtures__") ||
		parts.includes("__snapshots__")
	);
}

/** Whether a package-relative path is part of the v2 package origin. */
export function isSourcePath(path: string): boolean {
	if (excluded(path)) return false;
	if ((PACKAGE_FILES as readonly string[]).includes(path)) return true;
	return PACKAGE_TREES.some(
		(tree) =>
			path.startsWith(`${tree.dir}/`) && (tree.tests || !isTestPath(path)),
	);
}

/** The evaluation harness's inputs: a selector separate from source. */
export function evaluationInputs(packageRoot: string): SourceInputDefinition {
	return {
		origin: "evaluation/shepherd",
		root: packageRoot,
		trees: [{ dir: "evals/shepherd" }],
		exclude: excluded,
	};
}

export interface V2Layout {
	/** The package's directory. */
	packageRoot: string;
	/**
	 * The real directory the installed compiler runs from, derived from the
	 * `realpath` of an installed file such as `lib/agent-format/compiler.ts`.
	 * Never `node_modules/troupe` walked directly: Bun 1.2.22 installs a
	 * `file:` dependency as per-file symlinks, which `readSourceInputs`
	 * refuses (1.4.4 uses hardlinks).
	 */
	troupeRoot: string;
	/** Where the package's Git revision is read, when known. */
	revision?: { gitRoot: string; prefix: string; git?: GitRunner };
}

/** The `troupe` dependency as the package and its lockfile record it. */
export function dependencyIdentity(packageRoot: string): {
	requested?: string;
	resolved?: string;
} {
	const identity: { requested?: string; resolved?: string } = {};
	try {
		const pkg = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		);
		const requested = pkg.dependencies?.troupe;
		if (typeof requested === "string") identity.requested = requested;
	} catch {}
	try {
		const text = readFileSync(join(packageRoot, "bun.lock"), "utf8");
		// bun.lock is JSON with trailing commas.
		const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
		const resolved = lock.packages?.troupe?.[0];
		if (typeof resolved === "string") identity.resolved = resolved;
	} catch {}
	return identity;
}

/** Both origins' explicit membership. */
export function v2Inputs(layout: V2Layout): SourceInputDefinition[] {
	return [
		{
			origin: FRAMEWORK_ORIGIN,
			root: layout.troupeRoot,
			files: ["package.json"],
			trees: [{ dir: "lib" }],
			exclude: excluded,
			dependency: dependencyIdentity(layout.packageRoot),
		},
		{
			origin: PACKAGE_ORIGIN,
			root: layout.packageRoot,
			files: PACKAGE_FILES,
			trees: PACKAGE_TREES.map((tree) => ({ dir: tree.dir })),
			// The reader keeps exactly what `isSourcePath` accepts.
			exclude: (path) => !isSourcePath(path),
			executables: isRuntimeTool,
			...(layout.revision ? { revision: layout.revision } : {}),
		},
	];
}

/** The v2 manifest of both origins as they are now. */
export function readV2Source(layout: V2Layout): SourceManifest {
	return combineSourceInputs(
		SOURCE_DOMAIN_V2,
		v2Inputs(layout).map(readSourceInputs),
	).manifest;
}

/**
 * The v2 stamp as a `BuildStampPolicy`. Its version line names the domain,
 * each origin's revision (`unknown` when unknown) and the digest.
 */
export function shepherdStampV2(layout: V2Layout): BuildStampPolicy {
	return {
		capture() {
			const combined = combineSourceInputs(
				SOURCE_DOMAIN_V2,
				v2Inputs(layout).map(readSourceInputs),
			);
			return {
				manifest: combined.manifest,
				provenance: {
					domain: SOURCE_DOMAIN_V2,
					origins: combined.origins.map(
						(origin) => JSON.parse(JSON.stringify(origin)) as StampJson,
					),
				},
			};
		},
		recheck: () => readV2Source(layout),
		versionLine: (agentId, captured) => v2VersionLine(agentId, captured),
	};
}

export function v2VersionLine(
	agentId: string,
	captured: CapturedBuildStamp,
): string {
	const origins = Array.isArray(captured.provenance.origins)
		? captured.provenance.origins
		: [];
	const revisions = origins.map((origin) => {
		const { origin: name, revision } = origin as {
			origin: string;
			revision: string;
		};
		return `${name}=${revision}`;
	});
	return [agentId, SOURCE_DOMAIN_V2, ...revisions]
		.join(" ")
		.concat(` source=${captured.manifest.source}`);
}
