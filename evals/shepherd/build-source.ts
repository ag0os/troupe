/**
 * The build identity and compiler the evals use, and the only eval module
 * that imports them. Its two module specifiers are the only lines an
 * extracted copy rewrites; every name below must exist on both sides.
 */

export { type Builder, compileAgent } from "../../scripts/agent-compiler";
export {
	type BuildProvenance,
	compareUtf8,
	createGitRunner,
	framedDigest,
	type GitRunner,
	gitStamp,
	IDENTITY_MODULE,
	isSourcePath,
	type ManifestEntry,
	readWorktreeSource,
	runGit,
	SHEPHERD_ID,
	ShepherdSourceError,
	type SourceFile,
	type SourceLayout,
	type SourceManifest,
	type StampSource,
	sameSource,
	versionLine,
} from "../../scripts/shepherd-source";
