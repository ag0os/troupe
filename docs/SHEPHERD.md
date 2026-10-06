# Shepherd

Shepherd is an executive assistant and manager for day to day work. It runs in any directory, fills in for the user on routine work, manages terminal sessions and other coding agents (through Herdr when available), talks to co sessions over inter agent messaging when the harness supports it, and keeps persistent state in the launch directory so it improves at a workspace over time.

## Usage

```bash
shepherd                          # interactive session in the current directory
shepherd "triage my morning"      # with an initial message
shepherd --cwd ~/work             # run against another root
shepherd --backend codex          # use Codex instead of the default Claude backend
shepherd -n <name>                # name a new Claude session
# Codex: start it, then use its rename dialog.
shepherd --print "status report"  # one-shot, non-interactive
shepherd --show-prompt            # print the composed prompt, don't spawn
shepherd -- --resume SESSION_ID   # pass a backend flag through
shepherd -- -n session-name       # pass a backend short flag through
```

The declaration is `agents/shepherd.md`, paired with the `agents/shepherd.ts` extension. Its flat path produces the plain `shepherd` binary. Rebuild with `bun run compile -- shepherd` or `bun run compile:all`.

Framework flags such as `--model` go before `--`. Backend flags such as `--resume`, `--permission-mode`, and `-n` go after a standalone `--` and reach either selected backend verbatim. In print mode, the prompt must go before `--`; tokens after it are backend flags, not the prompt. `-h` and `--help` print generated help.

`--show-prompt` launches no backend. It prints the selected backend, system prompt, initial prompt, and final argv in the standard preview envelope. Print mode buffers backend output and writes it after the backend exits.

## Prompt composition

The session prompt is layered, in order:

| Layer | Source | Baked in |
|-------|--------|----------|
| Core | `system-prompts/shepherd/core.md` | yes |
| Built in integrations | `system-prompts/shepherd/integrations/*.md`, those that apply to this launch | yes |
| Inherited integrations | `.shepherd/integrations/*.md` of the nearest enclosing workspace (a parent directory with its own `.shepherd/`) | no, read at launch |
| Workspace integrations | `.shepherd/integrations/*.md` in the launch directory | no, read at launch |
| Workspace charter | `.shepherd/charter.md` in the launch directory | no, read at launch |
| Session context header | generated (cwd, state dir, local date, backend, session name, Codex home when selected, enclosing workspace, workspaces beneath, charter status, loaded modules) | no |

On new interactive launches the header has a `Session name` line; resumes emit no such line. The line uses these wordings (with `forge-1006` as the example name):

- Launcher-named: `- Session name: forge-1006 (set by the launcher: use it as it stands in CURRENT.md and in messages, do not rename yourself)`
- `-n` after `--`: `- Session name: forge-1006 (given at launch: use it as it stands in CURRENT.md and in messages, do not rename yourself)`
- Codex: `- Session name: not set (Codex takes no name at launch: name it with its rename dialog, suggested forge-1006, then record the name the host reports)`

Interactive Codex launches also have a `Codex home` line.

The charter comes after every module because it is the contract: where it and a module disagree about how the workspace works, the charter wins. Modules stay authoritative about what a capability can do and about their safety rules.

An enclosing workspace lets a group of workspaces share one layer: put them in subdirectories of a workspace whose `integrations/` holds the shared modules, and each one inherits them, with no copies or links. The extension also adds that workspace's real `.shepherd/` path as a readable directory, so the modules can point at reference files there. A local module that resolves to the same file as an inherited one is skipped.

### Built in modules

Two modules load into every Shepherd and check their own availability at run time, which keeps the prompt harness agnostic. The launcher adds the other three only when they apply, so no Shepherd spends prompt on a module that would tell it to skip itself.

| Module | For | Loaded when |
|--------|-----|-------------|
| `herdr.md` | Running commands and agents in Herdr panes | always; checks `HERDR_ENV=1` itself |
| `inter-agent.md` | Messaging other agent sessions | always; checks for messaging tools itself |
| `nested.md` | Living under an enclosing workspace's shared layer | an enclosing workspace exists and publishes at least one module |
| `root.md` | Keeping that shared layer, and acting as the user's assistant across workspaces | workspaces sit beneath the launch directory |
| `software.md` | Coordinating work that changes code | the charter has the line `Modules: software` |

- **Nested.** A parent directory that has a `.shepherd/` but no `integrations/*.md` shares nothing, so it is named in the header and `nested.md` stays out.
- **Root.** The launcher walks down from the launch directory for directories with their own `.shepherd/`, does not look inside one it finds, skips hidden directories, `node_modules` and symlinks, and stops three levels down. The header lists what it found as `- Workspaces beneath: <relative paths>`, or `none within 3 levels`. A further header line, `- Gated modules loaded: <names>` or `none`, shows which of `nested`, `root` and `software` this launch loaded, so a misspelt `Modules:` line is visible.
- **Software.** Nothing on disk says what a workspace's work is, so the charter declares it: a line of its own reading `Modules: software`. Init names the module when it reaches the charter's Structure section. An existing charter needs the line added, with the user's agreement like any charter change.

## Init and the charter

A fresh workspace is deliberately generic. On first launch Shepherd runs an init conversation with the user to agree the mission, Shepherd's role, what lives where and what is confidential, the way of working, the cadence, what done means, the toolset (for example gh and project tooling), and any structure the workspace needs, then records the agreement as `.shepherd/charter.md`. The charter loads into every session and is the contract; renegotiate it rather than drift from it. A workspace can be any shape: one project, several, a coordinator of coordinators, internet chores.

The charter has one section per init topic: Mission, Role, What lives where, Way of working, Cadence, Done, Toolset and Structure. It opens with `Agreed YYYY-MM-DD` once the user confirms it. The Toolset names tools, never models or accounts, and standing rules agreed later go into the charter, not into `CURRENT.md`. A charter agreed before this skeleton stands as it is.

## Self evolution

Shepherd improves its own operating instructions over time, gated by agreement rather than capability:

- Memories, journal, and docs are written freely.
- Changes to `charter.md` or `.shepherd/integrations/*.md` are proposed first and applied once the user agrees, with the reason journaled.
- Ways of working that prove out across workspaces get promoted into the base (below) with the user's agreement. Promoted modules must stay self gated and free of workspace specifics.

## Extending Shepherd

- **Framework wide**: add a module to `system-prompts/shepherd/integrations/`, import it in `agents/shepherd.ts`, add it to `builtInIntegrations()`, then recompile.
- **Per workspace**: drop a `*.md` module into `.shepherd/integrations/` in that directory, or let Shepherd write one during init. Loaded on next launch, no recompile. Local modules are appended after built in and inherited ones and may extend or override them; the charter comes last.

## Workspace state

Shepherd maintains `.shepherd/` in the launch directory:

```
.shepherd/
  charter.md         # agreed mission and way of working, written at init
  CURRENT.md         # index of the work and handoff to the next session
  work/              # todo/ in-progress/ done/, one dir per item
  MEMORY.md          # index: one line per memory
  memories/          # one fact per file (frontmatter: name, description, type)
  journal.md         # append only history, current month
  docs/              # runbooks, environment notes, checklists; INDEX.md lists them
  archive/           # closed work and past journal months; INDEX.md lists them
  integrations/      # workspace local capability modules
```

Context is tiered (see core, "Context tiers"): the prompt and a short session-start list (`CURRENT.md`, `MEMORY.md`, `docs/INDEX.md`, the journal's last two days) are always read; everything else is reached through those indexes when needed, and history moves to `archive/`.

### Tracking standard

Core fixes the shape of the tracking files (see core, "Work tracking"), so every workspace keeps them the same way and tools can read them:

- `CURRENT.md` is the index and the handoff, rewritten whole at handoff: an `Updated: YYYY-MM-DD HH:MM` line with the session name, then `## Next session`, `## Items` (one entry each, led by a status word in bold: NEXT, SCHEDULED, WAITING, ASK or CANDIDATE; the line `No NEXT is set.` when there is none) and `## Live sessions` (name, harness, model, the item served).
- An item with more to it than its line is a directory under `work/` with a `STATUS.md`: frontmatter (`state`, `opened`, `closed`, `blocked_on`) and the sections What and origin, State, Next, and Next session must know. `CURRENT.md` is updated in the same turn as the `STATUS.md` it points to.
- `journal.md` is history, not handoff: one `## YYYY-MM-DD` heading per day, with one line bullets that start with the local `HH:MM`.
- `docs/INDEX.md` has one line per doc: `- [title](path): when to read it`.

The declaration and extension preapprove Read and Edit inside `.shepherd/`, Read inside an enclosing workspace's `.shepherd/`, and `Bash(herdr:*)` so memory upkeep and Herdr coordination never prompt. There is no separate Write rule. Destructive Herdr operations are forbidden by the integration module instead. Everything else follows normal permission rules.

## Tools

Maintenance commands run without starting an agent backend:

```bash
shepherd tool check   [<workspace>...] [--all] [--status | --context] [--json] [--today YYYY-MM-DD]
shepherd tool archive [<workspace>...] [--recursive] [--apply] [--json] [--today YYYY-MM-DD]
shepherd tool init    [--master] [--json]
shepherd tool doctor  [--json]
shepherd tool guide   [<name>]
```

`tool check` checks this workspace and every workspace beneath it. Name one or more workspaces to limit the check. By default it hides informational findings; `--all` shows them, `--status` reports tracked work and live sessions, `--context` reports words by context tier, and `--json` produces machine readable output. `--status` and `--context` cannot be combined.

`tool archive` shows a dry run for the current workspace. Name workspaces to select them, or use `--recursive` to include this workspace and every workspace beneath it. `--apply` performs the planned item and journal moves and rewrites live references. `--json` produces machine readable output. Both commands accept `--today YYYY-MM-DD` for a repeatable date during diagnosis or testing.

Exit code 0 means the command completed without an error. For the default check, exit code 1 means at least one error finding; for archive, it means at least one move was skipped. Exit code 2 means invalid usage, an invalid date or selector, an invalid user configuration, or a directory that is not a workspace. Status and context reports use exit code 0 when they run successfully.

For a fresh machine, follow [SETUP.md](SETUP.md).

### Init

`tool init` creates `.shepherd/` in the launch directory. Use `--cwd <dir>` to select another root. Nothing that exists is overwritten: existing files, directories and symlinks are kept. Required parent directories are created as needed; symlinked parent directories are supported. A file blocking a required directory or another write error stops the run, reports the failed entry and keeps completed writes. `--json` reports `created`, `kept` and `failed` entries, with paths relative to `.shepherd/`.

Every workspace gets these entries, in order:

| Path | Content |
|------|---------|
| `CURRENT.md` | Work index and first move: run the init conversation |
| `MEMORY.md` | Memory index |
| `journal.md` | Journal with the current date |
| `docs/INDEX.md` | Documentation index |
| `docs/STATUS-template.md` | Work item status template |
| `archive/INDEX.md` | Archive index |
| `work/todo/`, `work/in-progress/`, `work/done/` | Empty directories |

`--master` adds the shared layer for a root with workspaces beneath it:

| Path | Content |
|------|---------|
| `shared/user.md` | User context skeleton |
| `shared/machine.md` | Machine context skeleton |
| `shared/roster.md` | Workspace roster skeleton |
| `shared/tools.md` | Tool notes skeleton |
| `integrations/shared.md` | Shared module inherited by workspaces beneath the root |

Init writes no `charter.md`. Launch Shepherd afterwards to agree the charter; `shepherd tool guide charter` supplies its questions and shape. Running init again fills only missing entries; adding `--master` to an existing workspace adds the shared layer.

### Doctor

`tool doctor` checks the machine from the launch directory, which need not be a workspace. It reads files and runs no external commands. Each check reports `ok`, `gap` with an edit to apply by hand, or `skip` when a dependency is absent. It never changes settings. `--json` reports check ids, statuses, edits and totals.

| Check id | What it checks |
|----------|----------------|
| `path:claude` | Claude Code is executable on PATH |
| `path:codex` | Codex is executable on PATH; skipped when Codex is not configured |
| `path:herdr` | Herdr is executable on PATH; absence skips this and its hook checks |
| `path:jq` | `jq` is executable on PATH for the status line |
| `path:shepherd` | Shepherd on PATH resolves to this binary, comparing realpaths |
| `config:user` | User config is absent or valid; a configured `codex.homeFile` is readable and names an absolute existing directory; `CODEX_HOME`, if set, is absolute |
| `claude:settings` | Claude settings are absent or a readable JSON object |
| `claude:cross-session-inbound` | `crossSessionInbound` is `"accept"` |
| `claude:status-line` | A command status line mentions `used_percentage` |
| `claude:herdr-hook` | A SessionStart hook names an existing `herdr-agent-state.sh` at an absolute path |
| `codex:home:<path>` | Each Codex home exists and contains `auth.json` |
| `codex:herdr-hook:<path>` | Each home's `hooks.json` has a SessionStart hook naming an existing `herdr-agent-state.sh` at an absolute path |

Claude settings come from `~/.claude/settings.json`, or an absolute `CLAUDE_CONFIG_DIR`. Bad settings skip the dependent Claude checks. Codex homes come from user config, an absolute `CODEX_HOME`, and existing `~/.codex*` directories, deduplicated by realpath. With no Codex configuration or homes, its home check is skipped. If HOME cannot be listed, `codex:home` reports a skip while explicitly selected homes are still checked. An `auth.json` file records a login; it does not prove the token is live.

Printed edits cover installation, PATH, JSON settings, logins and Herdr hooks. Herdr installs Codex hooks into `~/.codex`; for another home, link its `hooks.json` and `herdr-agent-state.sh`. Doctor reports bad user config as gaps; init and guide never read it.

### Guides and exit codes

`tool guide` lists three shipped guides. `tool guide <name>` prints one to stdout:

| Name | Purpose |
|------|---------|
| `charter` | The init conversation's questions and the charter's shape |
| `memory` | The memory file format and what each type holds |
| `tools` | Generic traps in Claude Code delegates, the Codex CLI and the shell |

Guide accepts no command flags. Init accepts only `--master` and `--json`; doctor accepts only `--json`. These three commands run without an existing workspace and use the launch directory, selected with `--cwd` if needed. `--model` applies only to launches and is refused with exit 2.

For init, doctor and guide, exit 0 means done. Doctor exits 1 when it finds at least one gap; init exits 1 on a write failure and lists completed writes without rolling them back. Exit 2 means invalid usage, an unknown guide name or a flag belonging to another command. Under `--show-prompt`, a tool refusal exits 1, not 2.

### Configuration

Configuration is layered from the user file at `$XDG_CONFIG_HOME/shepherd/config.json`, or `~/.config/shepherd/config.json` when `XDG_CONFIG_HOME` is unset, followed by `.shepherd/config.json` files from enclosing workspaces through the current workspace. User configuration may set `marks`, `windows`, and `codex` values for `home` or `homeFile`, `model`, and `effort`. Workspace configuration may set `marks`, `windows`, and the noninherited `sessionPrefix`. Unknown or misplaced keys are errors. Run `shepherd --help` for the generated option reference.

## Backends

Shepherd declares Claude first, so Claude is the default. Select Codex with `--backend codex`; backend selection is never taken from the environment. Both backends receive the same prompt layers, but the generated context header names the selected backend. Codex receives the composed prompt as `developer_instructions`. Backend executables are found on `PATH`.

The Claude child receives neither a framework-root variable nor an inherited project-directory variable. Claude settings contain only the declared rules and any enclosing-workspace additions. Codex inherits its own configuration and adds `--skip-git-repo-check` for print mode outside a Git worktree.
