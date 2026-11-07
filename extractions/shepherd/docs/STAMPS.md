# Shepherd build stamps in the extracted package

This page is extraction only: it describes how the package at `extractions/shepherd/` stamps Shepherd, and it has no counterpart in the original layout. The original layout still builds the live binary with the v1 stamp (`shepherd revision=<rev> dirty=<bool> source=sha256:<hex>`).

## The version line

`shepherd --version` prints one line:

```text
shepherd troupe-agent-source-v2 framework/troupe=<rev>[+local|+dirty] package/shepherd=<rev>[+local|+dirty] source=sha256:<hex>
```

- `source` is the framed SHA-256 under the domain `troupe-agent-source-v2` over both origins: `framework/troupe`, the installed Troupe distribution the build selects (its `package.json` and `lib/`, read from the real directory behind `node_modules/troupe`), and `package/shepherd`, the package's selected files (`scripts/shepherd-source-v2.ts` holds the table). Executable status of runtime tools is framed too.
- The framework revision is what the package's `bun.lock` resolves `troupe` to. For a Git dependency it is the resolved commit, unmarked; the installed bytes are not compared with that commit, the digest names them. For the folder dependency this package uses, it is the lockfile's resolution verbatim (`file:../.troupe-dist/troupe`) marked `+local`, since no commit records those bytes.
- The package revision is the Git `HEAD` of the repository holding the package. It is marked `+dirty` when the selected files (paths, contents, and the executable bit of runtime tools) differ from that commit's tree under the package's prefix, and `+local` (with revision `unknown`) outside Git. Files outside the selection, such as tests under `lib/shepherd/` or `biome.json`, never mark it dirty.

The stamp's provenance JSON carries `marker: "local" | "dirty" | null` for each origin.

## Eval builds and `dirty`

The evals build through `scripts/eval-source.ts`, which keeps the build provenance in the shape the eval results record: `revision` is the package's `HEAD`, `sourceDirty` is the package origin's `dirty` marker, and `dirty` stays repository wide, as in v1. Under the nested layout, any uncommitted change anywhere in the repository, an uncommitted Troupe change included, marks an extracted eval build dirty, even when the package's own selected bytes are clean. The version line never prints `dirty`; a verifier rebuilds the line from a recorded build's `revision`, `sourceDirty` and source hash, with the framework part taken from the package's lockfile.

v2 manifests do not record whether a file was untracked, so the verifier's note about untracked source entries never appears for package results.
