/**
 * `troupe/provenance`: source hashing helpers. Today's implementation is the
 * legacy Shepherd source module, the distribution's one temporary member;
 * `buildManifest` joins this entry with its explicit domain parameter later.
 */
export {
	compareUtf8,
	createGitRunner,
	framedDigest,
	type GitRunner,
	type ManifestEntry,
	type SourceFile,
	type SourceManifest,
	sameSource,
} from "../../scripts/shepherd-source";
