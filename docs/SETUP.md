# Shepherd setup

> Transitional copy: the Shepherd package owns this document at [extractions/shepherd/docs/SETUP.md](../extractions/shepherd/docs/SETUP.md). Until the package leaves this repository, every change lands in both copies; `scripts/shepherd-copy.test.ts` checks they differ only by this line.

Follow these steps on a fresh machine. Shepherd keeps workspace state on disk; machine settings and logins need their own setup.

1. **Prerequisites.** Install git, `jq` and Bun. On macOS, Homebrew can supply git and `jq`. The status line below needs `jq`; Bun installs dependencies and builds Troupe's binaries.

2. **Harnesses.** Install Claude Code, the required default backend, and optionally the Codex CLI. Sign in to each harness you intend to use. `codex login` runs per Codex home, so authenticate each home separately.

3. **Herdr, optional.** Install the Herdr binary, then run `herdr integration install claude` and, if using Codex, `herdr integration install codex`. These hooks let panes report agent state. Shepherd also runs without Herdr.

4. **Troupe.** Clone the Troupe repository, enter it, run `bun install`, then `bun run compile:all`. Put the repository's `bin/` directory on PATH in your shell configuration so `shepherd` resolves to the binary you built.

5. **Claude Code settings.** In `~/.claude/settings.json`, or the settings file under `CLAUDE_CONFIG_DIR`, add `"crossSessionInbound": "accept"` for peer messages and this status line for the model and context percentage:

```json
"statusLine": {
  "type": "command",
  "command": "jq -r '\"\\(.model.display_name) \\(.context_window.used_percentage // 0 | floor)%\"'"
}
```

   Merge these properties into the settings object, keeping valid JSON. When launching Shepherds with permissions bypassed, also set `"skipDangerousModePermissionPrompt": true`.

6. **Codex homes.** Keep a home per account. In `~/.config/shepherd/config.json`, or `$XDG_CONFIG_HOME/shepherd/config.json`, configure the `codex` section with `home` or `homeFile`, and optional `model` and `effort`. The full keys are `codex.home` and `codex.homeFile`; the latter names a file whose first non-empty line supplies the home path. See [Shepherd's Tools section](SHEPHERD.md#tools). Log in with the selected home in `CODEX_HOME`. Herdr's Codex integration installs into `~/.codex`; for other homes, link its `hooks.json` and `herdr-agent-state.sh`.

7. **Code host.** Run `gh auth login` for each account you use and set up SSH keys. Follow the [software module's identity check rule](../packages/software/MODULE.md#rules-of-engagement) before writes and before trusting a 404.

8. **Workspaces.** Restore `.shepherd/` directories from backup, or run `shepherd tool init --master` in a root such as `~/shepherds` and `shepherd tool init` in each workspace beneath it. Launch `shepherd` in each and run the init conversation to agree its charter. Claude auto-memory is keyed by absolute path and does not travel with the workspace.

9. **Check.** Run `shepherd tool doctor` and apply the edits it prints by hand. It reads settings without changing them. Then run `shepherd tool check` from the root to check workspace state.

## Independent installation proof

Bun 1.2.22 is the reference version for setup and replay. During extraction, from the Troupe worktree run:

```sh
bun scripts/replay-extraction-outside.ts --evidence <evidence-directory>
```

The replay copies `extractions/shepherd/` and the identical staged artifact at `extractions/.troupe-dist/troupe/` into fresh sibling directories under the system temporary directory. Run `bun run setup:extractions` first to prepare that artifact. The replay checks copied bytes and modes, refuses Git, `.shepherd` and `node_modules` ancestors, and denies reads of the original checkout with macOS `sandbox-exec`. It installs frozen, runs typecheck, Biome and the complete package suite, then builds exactly one `bin/shepherd` beside the copied `packages/`. Doctor checks both the complete installation and a binary-only copy; the latter must report the missing base packages.

Consumer commands use `--no-install` and `NODE_PATH=<package>/node_modules`. The stage-parent `node_modules` link points to that one consumer. Its four assumptions are one consumer, no `node_modules` inside the stage, Bun 1.2.22 per-file links (the proof can also rehearse 1.4.4 hardlinks), and exactly `typescript`, `yaml` and `zod` as the staged runtime dependencies. Resolution is checked against the consumer lockfile by runtime probes and the stage-resolution test. The link exposes development dependencies too; it is a transitional extraction mechanism.

Use `--bun <absolute-bun-path>` to repeat with another already available Bun release. The replay does not call setup in the outside copy, so it avoids setup's Bun 1.4.4 `Loader.registry` probe. Every output records its Bun version, scratch parent, artifact manifest, resolved dependency versions and generated-entry/binary checkout-path checks. Preserve `packages/` beside `bin/` when moving the complete installation.
