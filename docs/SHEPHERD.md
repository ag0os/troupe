# Shepherd

Shepherd is a personal day to day assistant and agent coordinator. It runs in any directory, helps with routine work, coordinates terminal sessions and other coding agents (through Herdr when available), talks to co sessions over inter agent messaging when the harness supports it, and keeps persistent state in the launch directory so it improves at a workspace over time.

## Usage

```bash
shepherd                          # interactive session in the current directory
shepherd "triage my morning"      # with an initial message
shepherd --cwd ~/work             # run against another root
shepherd --backend codex          # use Codex instead of the default Claude backend
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
| Built in integrations | `system-prompts/shepherd/integrations/*.md` | yes |
| Inherited integrations | `.shepherd/integrations/*.md` of the nearest enclosing workspace (a parent directory with its own `.shepherd/`) | no, read at launch |
| Workspace charter | `.shepherd/charter.md` in the launch directory | no, read at launch |
| Workspace integrations | `.shepherd/integrations/*.md` in the launch directory | no, read at launch |
| Session context header | generated (cwd, state dir, date, backend, charter status, loaded modules) | no |

An enclosing workspace lets a group of workspaces share one layer: put them in subdirectories of a workspace whose `integrations/` holds the shared modules, and each one inherits them, with no copies or links. The extension also adds that workspace's real `.shepherd/` path as a readable directory, so the modules can point at reference files there. A local module that resolves to the same file as an inherited one is skipped.

Every integration module is self gated: it declares how to detect availability (for example `HERDR_ENV=1`, or the presence of messaging tools) and Shepherd skips the capability cleanly when the check fails. That is what keeps the prompt harness agnostic.

### Built in modules

All four load into every Shepherd, in this order, and each one gates itself:

| Module | For | Gate |
|--------|-----|------|
| `herdr.md` | Running commands and agents in Herdr panes | `HERDR_ENV=1` |
| `inter-agent.md` | Messaging other agent sessions | The harness exposes messaging tools this session |
| `nested.md` | Workspaces inside workspaces: the shared layer and who keeps it | The header's "Enclosing workspace" line, or workspaces beneath the launch directory |
| `software.md` | Coordinating work that changes code | The charter makes changing code part of the workspace's work |

`nested.md` has two readers. A workspace with an enclosing workspace gets the rules for living under a shared layer: its charter wins on how it works, shared facts beat its own memories, it reads the shared reference files before acting, and it files corrections, shared facts and promotions through `.shepherd/outbox/` instead of editing the shared layer. The root (no enclosing workspace, workspaces beneath it) is the steward of that layer and the user's general assistant across the workspaces. The module carries the mechanism only: what a shared layer says stays in the workspace that keeps it.

A root's own `integrations/` holds the modules its workspaces inherit. For the root itself they are local modules, composed after its charter, so `nested.md` tells the root that its charter still governs it.

`software.md` gives the investigate, decide, implement, review, verify cycle and the checks specific to code, such as Shepherd running the gates itself and checking its code host identity before a write.

## Init and the charter

A fresh workspace is deliberately generic. On first launch Shepherd runs an init conversation with the user to agree the mission, the way of working, the toolset (for example cosmonauts, gh, project tooling), and any structure the workspace needs, then records the agreement as `.shepherd/charter.md`. The charter loads into every session and is the contract; renegotiate it rather than drift from it. A workspace can be any shape: one project, several, a coordinator of coordinators, internet chores.

The charter has one section per init topic: Mission, Role, What lives where, Way of working, Cadence, Done, Toolset and Structure. It opens with `Agreed YYYY-MM-DD` once the user confirms it. The Toolset names tools, never models or accounts, and standing rules agreed later go into the charter, not into `CURRENT.md`.

## Self evolution

Shepherd improves its own operating instructions over time, gated by agreement rather than capability:

- Memories, journal, and docs are written freely.
- Changes to `charter.md` or `.shepherd/integrations/*.md` are proposed first and applied once the user agrees, with the reason journaled.
- Ways of working that prove out across workspaces get promoted into the base (below) with the user's agreement. Promoted modules must stay self gated and free of workspace specifics.

## Extending Shepherd

- **Framework wide**: add a module to `system-prompts/shepherd/integrations/`, import it in `agents/shepherd.ts`, add it to `builtInIntegrations()`, then recompile.
- **Per workspace**: drop a `*.md` module into `.shepherd/integrations/` in that directory, or let Shepherd write one during init. Loaded on next launch, no recompile. The charter and local modules are appended after built ins and may extend or override them.

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
  docs/              # runbooks, environment notes, agent rosters; INDEX.md lists them
  archive/           # closed work and past journal months; INDEX.md lists them
  integrations/      # workspace local capability modules
```

Context is tiered (see core, "Context tiers"): the prompt and a short session-start list (`CURRENT.md`, `MEMORY.md`, `docs/INDEX.md`, the journal's last two days) are always read; everything else is reached through those indexes when needed, and history moves to `archive/`.

### Tracking standard

Core fixes the shape of the tracking files (see core, "Work tracking"), so every workspace keeps them the same way and tools can read them:

- `CURRENT.md` is the index and the handoff, rewritten whole: an `Updated: YYYY-MM-DD HH:MM` line with the session name, a Next session block, one entry per item led by a status word (NEXT, SCHEDULED, WAITING, ASK or CANDIDATE), and the Live sessions.
- Each item is a directory under `work/` with a `STATUS.md`: frontmatter (`state`, `opened`, `closed`, `blocked_on`) and the sections What and origin, State, Next, and Next session must know. `CURRENT.md` is updated in the same turn as the `STATUS.md` it points to.
- `journal.md` is history, not handoff: one `## YYYY-MM-DD` heading per day, with one line bullets that start with the local `HH:MM`.
- `docs/INDEX.md` has one line per doc: `- [title](path): when to read it`.

The declaration and extension preapprove Read and Edit inside `.shepherd/`, Read inside an enclosing workspace's `.shepherd/`, and `Bash(herdr:*)` so memory upkeep and Herdr coordination never prompt. There is no separate Write rule. Destructive Herdr operations are forbidden by the integration module instead. Everything else follows normal permission rules.

## Backends

Shepherd declares Claude first, so Claude is the default. Select Codex with `--backend codex`; backend selection is never taken from the environment. Both backends receive the same prompt layers, but the generated context header names the selected backend. Codex receives the composed prompt as `developer_instructions`. Backend executables are found on `PATH`.

The Claude child receives neither a framework-root variable nor an inherited project-directory variable. Claude settings contain only the declared rules and any enclosing-workspace additions. Codex inherits its own configuration and adds `--skip-git-repo-check` for print mode outside a Git worktree.
