# Shepherd

Shepherd is a personal day to day assistant and agent coordinator. It runs in any directory, helps with routine work, coordinates terminal sessions and other coding agents (through Herdr when available), talks to co sessions over inter agent messaging when the harness supports it, and keeps persistent state in the launch directory so it improves at a workspace over time.

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

On interactive launches the header has a `Session name` line. Interactive Codex launches also have a `Codex home` line.

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
```

`tool check` checks this workspace and every workspace beneath it. Name one or more workspaces to limit the check. By default it hides informational findings; `--all` shows them, `--status` reports tracked work and live sessions, `--context` reports words by context tier, and `--json` produces machine readable output. `--status` and `--context` cannot be combined.

`tool archive` shows a dry run for the current workspace. Name workspaces to select them, or use `--recursive` to include this workspace and every workspace beneath it. `--apply` performs the planned item and journal moves and rewrites live references. `--json` produces machine readable output. Both commands accept `--today YYYY-MM-DD` for a repeatable date during diagnosis or testing.

Exit code 0 means the command completed without an error. For the default check, exit code 1 means at least one error finding; for archive, it means at least one move was skipped. Exit code 2 means invalid usage, an invalid date or selector, an invalid user configuration, or a directory that is not a workspace. Status and context reports use exit code 0 when they run successfully.

Configuration is layered from the user file at `$XDG_CONFIG_HOME/shepherd/config.json`, or `~/.config/shepherd/config.json` when `XDG_CONFIG_HOME` is unset, followed by `.shepherd/config.json` files from enclosing workspaces through the current workspace. User configuration may set `marks`, `windows`, and `codex` values for `home` or `homeFile`, `model`, and `effort`. Workspace configuration may set `marks`, `windows`, and the noninherited `sessionPrefix`. Unknown or misplaced keys are errors. Run `shepherd --help` for the generated option reference.

## Backends

Shepherd declares Claude first, so Claude is the default. Select Codex with `--backend codex`; backend selection is never taken from the environment. Both backends receive the same prompt layers, but the generated context header names the selected backend. Codex receives the composed prompt as `developer_instructions`. Backend executables are found on `PATH`.

The Claude child receives neither a framework-root variable nor an inherited project-directory variable. Claude settings contain only the declared rules and any enclosing-workspace additions. Codex inherits its own configuration and adds `--skip-git-repo-check` for print mode outside a Git worktree.
