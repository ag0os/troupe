/**
 * The package's build identity and compiler for the evals, behind the names
 * `evals/shepherd/build-source.ts` re-exports. The original layout gives the
 * same names over the v1 adapter and the legacy wrapper; here they are the
 * v2 identity (`shepherd-source-v2.ts`) and `troupe/compiler`, so the eval
 * code is byte equal in both trees.
 *
 * A build's provenance keeps v1's shape. `revision` is the package's Git
 * `HEAD`; `sourceDirty` is the package origin's `dirty` marker (its selected
 * bytes differ from that commit under the prefix); `dirty` stays repository
 * wide, as in v1, so any uncommitted change in the repository marks the
 * build dirty (C22). The version line is the v2 line: its framework part is
 * the lockfile resolution of `troupe` for the package the build was
 * captured from (`packageRoot`), and its package part follows from
 * `revision` and `sourceDirty`, so a verifier can rebuild it from a
 * recorded build and the package whose source hash it records. It never
 * prints `dirty`.
 */

import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type Builder,
	type BuildStampPolicy,
	type CapturedBuildStamp,
	compileAgent as compileWithTroupe,
	type LoadedAgent,
} from "troupe/compiler";
import {
	createGitRunner,
	type GitRunner,
	SourceInputError,
	type SourceManifest,
} from "troupe/provenance";
import {
	SHEPHERD_ID,
	shepherdDefinition,
	troupeRoot,
} from "./shepherd-definition";
import {
	dependencyIdentity,
	FRAMEWORK_ORIGIN,
	frameworkRevision,
	isSourcePath,
	type OriginMarker,
	PACKAGE_ORIGIN,
	readV2Source,
	shepherdStampV2,
	v2VersionLine,
} from "./shepherd-source-v2";

export {
	compareUtf8,
	createGitRunner,
	framedDigest,
	type GitRunner,
	type ManifestEntry,
	type SourceFile,
	type SourceManifest,
	sameSource,
} from "troupe/provenance";
export { type Builder, isSourcePath, SHEPHERD_ID };

/** The identity module: a change to it always needs an eval result. */
export const IDENTITY_MODULE = "scripts/shepherd-source-v2.ts";

/**
 * Modules whose change always needs an eval result, whatever the path
 * policy says: the identity module and this seam, which v2's source
 * membership does not select.
 */
export const GATED_MODULES: readonly string[] = [
	IDENTITY_MODULE,
	"scripts/eval-source.ts",
];

export interface BuildProvenance {
	/** The package's full build-time `HEAD`. */
	revision: string;
	/** Staged, unstaged or nonignored untracked changes anywhere in the repository. */
	dirty: boolean;
	/** The package's selected paths or bytes differ from `HEAD`. */
	sourceDirty: boolean;
	manifest: SourceManifest;
	/**
	 * The package directory the build was captured from, whose lockfile
	 * gives the version line's framework part. Never recorded in a stamp.
	 */
	packageRoot?: string;
}

/** How a build is stamped: captured before any build file exists, rechecked before publication. */
export interface StampSource {
	capture(root: string): BuildProvenance | Promise<BuildProvenance>;
	recheck(root: string): SourceManifest | Promise<SourceManifest>;
}

/** Where a package sits in its repository (`prefix` is `""` at the top). */
export interface SourceLayout {
	gitRoot: string;
	prefix: string;
}

/** Problems that leave a Shepherd source identity undefined. */
export class ShepherdSourceError extends Error {
	constructor(readonly problems: string[]) {
		super(problems.join("\n"));
		this.name = "ShepherdSourceError";
	}
}

export const runGit = createGitRunner();

const FULL_COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

function gitText(
	git: GitRunner,
	args: readonly string[],
	cwd: string,
): { ok: boolean; text: string; error: string } {
	const result = git(args, cwd);
	return {
		ok: result.code === 0,
		text: new TextDecoder().decode(result.stdout),
		error: result.stderr.trim(),
	};
}

/** The repository top, which must be `root` itself. */
function repositoryRoot(root: string, git: GitRunner): string {
	const top = gitText(git, ["rev-parse", "--show-toplevel"], root);
	if (!top.ok) {
		throw new ShepherdSourceError([
			`${root} is not in a Git repository: ${top.error}`,
		]);
	}
	const path = top.text.trim();
	if (realpathSync(path) !== realpathSync(root)) {
		throw new ShepherdSourceError([
			`${root} is not the repository root (${path})`,
		]);
	}
	return path;
}

/**
 * The repository and prefix of the package at `root`, as v1 locates them:
 * without a layout `root` is the repository top; with one, `gitRoot` is the
 * top and `root` its `prefix` directory.
 */
function locate(
	root: string,
	git: GitRunner,
	layout: SourceLayout | undefined,
): { top: string; prefix: string } {
	if (!layout) return { top: repositoryRoot(root, git), prefix: "" };
	const prefix = layout.prefix.replace(/^\/+|\/+$/g, "");
	if (prefix.split("/").some((part) => part === ".." || part === ".")) {
		throw new ShepherdSourceError([`${layout.prefix}: not a package prefix`]);
	}
	const top = repositoryRoot(layout.gitRoot, git);
	const base = prefix === "" ? top : join(top, prefix);
	if (realpathSync(base) !== realpathSync(root)) {
		throw new ShepherdSourceError([
			`${root} is not ${prefix || "the root"} of the repository at ${top}`,
		]);
	}
	return { top, prefix };
}

function asShepherdError(error: unknown): unknown {
	return error instanceof SourceInputError
		? new ShepherdSourceError(error.problems)
		: error;
}

/**
 * The v2 manifest of the package at `root` as it is now, with the Troupe it
 * resolves. The package must be in Git, located as v1 locates it.
 */
export function readWorktreeSource(
	root: string,
	options: { git?: GitRunner; layout?: SourceLayout } = {},
): SourceManifest {
	locate(root, options.git ?? runGit, options.layout);
	try {
		return readV2Source({
			packageRoot: resolve(root),
			troupeRoot: troupeRoot(root),
		});
	} catch (error) {
		throw asShepherdError(error);
	}
}

/** The package's v2 provenance in v1's shape; `dirty` is repository wide. */
async function captureProvenance(
	root: string,
	git: GitRunner,
	layout: SourceLayout | undefined,
): Promise<BuildProvenance> {
	const { top, prefix } = locate(root, git, layout);
	const head = gitText(
		git,
		["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
		top,
	);
	if (!head.ok || !FULL_COMMIT.test(head.text.trim())) {
		throw new ShepherdSourceError([
			`${top} has no Git revision: HEAD does not name a commit`,
		]);
	}
	const readStatus = () => {
		const status = gitText(
			git,
			["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
			top,
		);
		if (!status.ok) {
			throw new ShepherdSourceError([
				`git status failed in ${top}: ${status.error}`,
			]);
		}
		return status;
	};
	// Bun's spawnSync can lose piped stdout and still report success, so
	// "clean" needs a second empty read to agree.
	let status = readStatus();
	if (status.text.length === 0) status = readStatus();
	let captured: CapturedBuildStamp;
	try {
		captured = await shepherdStampV2({
			packageRoot: resolve(root),
			troupeRoot: troupeRoot(root),
			revision: { gitRoot: top, prefix, git },
		}).capture({
			agentId: SHEPHERD_ID,
			consumerRoot: resolve(root),
			declarationRoot: join(resolve(root), "agents"),
			outDir: join(resolve(root), "bin"),
		});
	} catch (error) {
		throw asShepherdError(error);
	}
	const origins = Array.isArray(captured.provenance.origins)
		? captured.provenance.origins
		: [];
	const own = origins.find(
		(origin) => (origin as { origin?: string }).origin === PACKAGE_ORIGIN,
	) as { revision?: string; marker?: OriginMarker } | undefined;
	return {
		revision: own?.revision ?? head.text.trim(),
		dirty: status.text.length > 0,
		sourceDirty: own?.marker === "dirty",
		manifest: captured.manifest,
		packageRoot: resolve(root),
	};
}

/** The v2 stamp in v1's shape; with `layout`, of the package at its prefix. */
export function gitStamp(
	git: GitRunner = runGit,
	layout?: SourceLayout,
): StampSource {
	return {
		capture: (root) => captureProvenance(root, git, layout),
		recheck: (root) => readWorktreeSource(root, { git, layout }),
	};
}

/**
 * The package-relative path a manifest entry names, or undefined for an
 * entry outside the package: v2 entries carry their origin.
 */
export function entryPackagePath(entryPath: string): string | undefined {
	const prefix = `${PACKAGE_ORIGIN}/`;
	return entryPath.startsWith(prefix)
		? entryPath.slice(prefix.length)
		: undefined;
}

/** Whether manifest entries record that a file was untracked. v2's do not. */
export const RECORDS_UNTRACKED = false;

/**
 * The one line `shepherd --version` prints, without its newline, for the
 * build of the package at `provenance.packageRoot`.
 */
export function versionLine(provenance: BuildProvenance): string {
	if (provenance.packageRoot === undefined) {
		throw new ShepherdSourceError([
			"a version line needs the package root its build was captured from",
		]);
	}
	const framework = frameworkRevision(
		dependencyIdentity(provenance.packageRoot).resolved,
	);
	const marker: OriginMarker = !FULL_COMMIT.test(provenance.revision)
		? "local"
		: provenance.sourceDirty
			? "dirty"
			: null;
	return v2VersionLine(SHEPHERD_ID, {
		manifest: provenance.manifest,
		provenance: {
			origins: [
				{ origin: FRAMEWORK_ORIGIN, ...framework },
				{ origin: PACKAGE_ORIGIN, revision: provenance.revision, marker },
			],
		},
	});
}

function provenanceOf(stamp: CapturedBuildStamp): BuildProvenance {
	const { revision, dirty, sourceDirty } = stamp.provenance;
	return {
		revision: String(revision),
		dirty: dirty === true,
		sourceDirty: sourceDirty === true,
		manifest: stamp.manifest,
	};
}

function stampPolicy(source: StampSource, root: string): BuildStampPolicy {
	return {
		async capture(context) {
			const {
				manifest,
				packageRoot: _,
				...facts
			} = await source.capture(context.consumerRoot);
			return { manifest, provenance: { ...facts } };
		},
		recheck: (context) => source.recheck(context.consumerRoot),
		versionLine: (_agentId, captured) =>
			versionLine({ ...provenanceOf(captured), packageRoot: root }),
	};
}

/** Compile one declaration of the package at `root`; Shepherd is stamped. */
export async function compileAgent(options: {
	root: string;
	file: string;
	outFile: string;
	stamp?: StampSource;
	build?: Builder;
	signal?: AbortSignal;
}): Promise<LoadedAgent & { provenance?: BuildProvenance }> {
	const { root, outFile, stamp, ...rest } = options;
	const { stamp: captured, ...agent } = await compileWithTroupe({
		...rest,
		definition: shepherdDefinition(root, {
			stamp: stampPolicy(stamp ?? gitStamp(), resolve(root)),
		}),
		// Relative to the working directory, as in the original layout.
		outFile: resolve(outFile),
	});
	return captured
		? {
				...agent,
				provenance: { ...provenanceOf(captured), packageRoot: resolve(root) },
			}
		: agent;
}
