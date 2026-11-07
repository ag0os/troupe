/**
 * `troupe/provenance`: generic source identity. Framed manifests under an
 * explicit domain, and explicit multi-origin input reading.
 */
export {
	buildManifest,
	type CombinedSourceInputs,
	combineSourceInputs,
	compareUtf8,
	createGitRunner,
	type FramingOptions,
	framedDigest,
	type GitRunner,
	type InputProvenance,
	type ManifestEntry,
	readSourceInputs,
	type SourceFile,
	type SourceInput,
	type SourceInputDefinition,
	SourceInputError,
	type SourceManifest,
	type SourceTree,
	sameSource,
} from "../agent-format/provenance";
