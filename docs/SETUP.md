# Shepherd setup

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

7. **Code host.** Run `gh auth login` for each account you use and set up SSH keys. Follow the [software module's identity check rule](../system-prompts/shepherd/integrations/software.md#rules-of-engagement) before writes and before trusting a 404.

8. **Workspaces.** Restore `.shepherd/` directories from backup, or run `shepherd tool init --master` in a root such as `~/shepherds` and `shepherd tool init` in each workspace beneath it. Launch `shepherd` in each and run the init conversation to agree its charter. Claude auto-memory is keyed by absolute path and does not travel with the workspace.

9. **Check.** Run `shepherd tool doctor` and apply the edits it prints by hand. It reads settings without changing them. Then run `shepherd tool check` from the root to check workspace state.
