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
| Session context header | generated (cwd, state dir, local date, backend, model and handoff ceiling, session name, Codex home when selected, enclosing workspace, workspaces beneath, charter status, loaded modules) | no |

The line beside Backend gives the selected model and its handoff ceiling, for example `- Model: gpt-5.6-sol; handoff ceiling: 80% of context window; delegates: Claude 45%, Codex 80%, other backends 45%`. The launcher uses the framework `--model`, `-m` or `--model` after `--`, Codex `-c model=...` or `-c model="..."`, interactive Codex configuration, or a declaration model. The same line lists resolved family ceilings for delegates and any exact model overrides, so a coordinator can look up a delegate's ceiling without seeing its session. Model flags take precedence over Codex configuration assignments. When none selects a model, the CLI decides: the header says `backend default (unknown)` and uses the backend ceiling. Resumes and forks without an explicit model say `saved conversation (unknown)`; their saved model is not available to the launcher. Hand off before quality degrades, raise the handoff unprompted as you approach the header's ceiling, and check usage periodically through the host.

On new interactive launches the header has a `Session name` line; resumes emit no such line. The line uses these wordings (with `forge-1006` as the example name):

- Launcher-named: `- Session name: forge-1006 (set by the launcher: use it as it stands in CURRENT.md and in messages, do not rename yourself)`
- `-n` after `--`: `- Session name: forge-1006 (given at launch: use it as it stands in CURRENT.md and in messages, do not rename yourself)`
- Codex: `- Session name: not set (Codex takes no name at launch: name it with its rename dialog, suggested forge-1006, then record the name the host reports)`

Interactive Codex launches also have a `Codex home` line.

The charter comes after every module to supply this workspace's agreed values in their declared slots. Modules stay authoritative about what a capability can do and about their safety rules.

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

A fresh workspace is deliberately generic. On first launch Shepherd runs an init conversation with the user to agree the mission, Shepherd's role, what lives where and what is confidential, the way of working, the cadence, what done means, the toolset (for example gh and project tooling), and any structure the workspace needs, then records the agreement as `.shepherd/charter.md`. The charter loads into every session and supplies agreed values; renegotiate those values rather than drift from them. A workspace can be any shape: one project, several, a coordinator of coordinators, internet chores.

The charter has one section per init topic: Mission, Role, What lives where, Way of working, Cadence, Done, Toolset and Structure. Core names the topics; the questions each one settles and the charter's skeleton are in the `charter` guide, which Shepherd reads with `shepherd tool guide charter` before it starts the conversation. The charter opens with `Agreed YYYY-MM-DD` once the user confirms it. The Toolset names tools, never models or accounts, and standing values agreed later go into the charter and rules into core or a module, never into `CURRENT.md`. A charter agreed before this skeleton stands as it is.

## Self evolution

Shepherd improves its own operating instructions over time, gated by agreement rather than capability:

- Memories, journal, and docs are written freely.
- Changes to `charter.md` or `.shepherd/integrations/*.md` are proposed first and applied once the user agrees, with the reason journaled.
- Ways of working that prove out across workspaces get promoted into the base (below) with the user's agreement. Promoted modules must stay self gated and free of workspace specifics.

## Extending Shepherd

- **Framework wide**: add a module to `system-prompts/shepherd/integrations/`, import it as text in `lib/shepherd/module-resolution.ts`, add it to `builtInModules()`, then recompile.
- **Per workspace**: drop a `*.md` module into `.shepherd/integrations/` in that directory, or let Shepherd write one during init. Loaded on next launch, no recompile. Local modules are appended after built in and inherited ones and may extend or override them; the charter comes last.

### Module format

Workspace integrations can remain plain Markdown indefinitely. Legacy modules load unchanged and receive an informational `module-frontmatter-missing` finding. Annotated modules start with strict YAML metadata:

```yaml
---
name: shared
type: domain
description: Shared reference files and conventions
budget: 250
charter-keys: {}
---
# Shared conventions

The prompt body starts here.
```

Recognition has a reserved signature: line one must be exactly `---`, and the first nonblank line after it must start at column zero with one of the eight field names below followed by `:` and whitespace or end of line. A `#` line before the first field makes the file legacy; comments after the first field remain valid YAML comments. Both LF and CRLF work. A matching opener with a later complete `---` line is annotated; the first such line closes the metadata. Everything through that delimiter's line ending is stripped, preserving every subsequent body byte, including blank lines and trailing whitespace. With no closing delimiter, a matching opener is malformed and the file is skipped. Any other opener is a legacy thematic break, even when a later `---` exists. For example, `---` followed by `# Title` or ordinary prose loads whole. Reserve the field signature for metadata rather than opening legacy prose with it.

| Field | Meaning |
|-------|---------|
| `name` | Required string matching the discovered filename without `.md`, including a symlink's discovered name rather than its target name. |
| `type` | Required descriptive value: `capability`, `method`, `role`, `domain`, or `persona`. |
| `description` | Required nonblank string with no newline. Used by checks, not inserted into prompts. |
| `applies-when` | Optional strict predicate mapping; absent or empty means eligible everywhere. |
| `provides` | Optional single slot identifier; providers load only when selected. |
| `default` | Optional boolean, false by default. May appear only with `provides`. |
| `budget` | Required positive safe integer in prompt words. Overruns warn without truncating or preventing loading. |
| `charter-keys` | Optional mapping, empty by default, of owned namespaced keys to `required` or `optional`. Metadata is validated here; charter values are parsed for `shepherd tool check` findings and never enforced as grants. |

Identifiers use lowercase alphanumeric segments separated by single hyphens: `[a-z0-9]+(?:-[a-z0-9]+)*`. Module names may start with digits, such as `00-flock`. Slots, selectable provider names, and `charter-declares` values use letters and hyphens only to fit the existing `Modules:` tokenizer. Charter keys have the form `namespace.key`, with both components starting with a letter. A module may declare its own namespace, its provided slot's namespace, and the eight existing core keys corresponding to the charter headings. Numeric-prefixed module names cannot own a same-name key namespace.

Parsing uses YAML 1.2 with no coercion. Unknown fields or predicate keys, null values, duplicate keys, nonmapping roots, nonstring mapping keys, directives, explicit tags, anchors, aliases, and merge keys are rejected. A quoted boolean or budget is a string and therefore invalid. The whole body is the prompt part; `<!-- guide -->` has no special meaning.

### Predicates and provider selection

The closed predicate vocabulary is:

| Predicate | Value and fact |
|-----------|----------------|
| `enclosing-modules` | Boolean matching whether the nearest enclosing workspace publishes at least one integration file. |
| `has-children` | Boolean matching whether the existing child walk finds a workspace. |
| `charter-declares` | Selectable identifier requested by the charter, directly or through a named provider of that slot. |

Multiple predicates combine with AND. A false boolean requires the fact to be false. Publication is measured before filtering: an ineligible inherited module still makes `nested` eligible. The header can therefore list `nested` under `Gated modules loaded:` while saying `inherited integrations: none`.

All valid candidates are collected before predicates and selection, including inactive alternatives. Eligible modules without `provides` load automatically. A provider loads only when its slot or specific name is requested by the unchanged, case-normalizing `Modules:` tokenizer. A slot token chooses its sole eligible default. One explicit provider name chooses that provider instead of the default; listing a slot plus that provider is valid. A token equal to a slot name always means the slot request, even when a provider has that name.

Two explicit providers for a slot, ambiguous explicit names, or multiple eligible defaults for a slot request are conflicts. A requested slot with no eligible default, or an explicitly requested ineligible provider, is unresolved. No provider loads for an affected slot, and independently resolved slots continue loading. Unknown tokens warn and remain unselected. There is no implicit local winner over inherited alternatives. Distinct eligible nonproviders with the same name both load. Realpath deduplication removes local copies of inherited files before selection. Survivors keep their original layer and filename order, and the header lists the filenames that actually loaded.

### Failure policy and accounting

A dotted bullet is a slot only when it is a `core.*` key or when a candidate module with valid metadata declares that exact key in `charter-keys`; candidates include every module the launcher sees, active or inactive, including the enclosing workspace's modules, and every other dotted bullet is ordinary prose. `tool check` warns with `charter-key-unknown` when an ordinary dotted bullet names an undeclared key in a valid candidate module's name or provided namespace, including inactive and enclosing modules; it stays prose and the warning does not change exit codes.

Invalid closed workspace metadata is reported and discarded in full. Its stripped body loads ungated, without provider identity, defaults, predicates, or charter declarations. Clearly intended but unclosed metadata is reported and skipped because its body cannot be safely separated. Invalid built-in metadata is a repository defect and composition throws.

Schema and selection problems, including unknown tokens, append `- Module problems: <file>: <code>: <reason>; ...` to the session header. With no problems this line is absent. The Shepherd extension writes the same details to stderr once during launch, print, and preview. Routine costs produce no launch notice. `shepherd tool check` reports schema and name errors, selection errors, unknown-token warnings, budgets, and legacy metadata information. Charter findings use `charter-slot-duplicate`, `charter-key-undeclared`, `charter-key-required` and `charter-module-restatement`. Built-in finding paths are always literal `builtin/<name>.md`. Module checking uses launch's nearest enclosing lookup, including an enclosing workspace outside the checked tree.

Costs use whitespace-separated body words, excluding recognized metadata. Inactive annotated candidates still get budget checks; built-ins get over-budget warnings without routine cost information. Shared totals count all published local bodies when a workspace has descendants, including degraded bodies, because publication is separate from effective selection. Unclosed bodies have unavailable costs and an explicitly incomplete subtotal. The opening prompt count includes selected and degraded fragments and the final header. If another composition failure forces a fallback estimate, readable local modules contribute stripped body words and unclosed metadata contributes none.

## Workspace state

Shepherd maintains `.shepherd/` in the launch directory:

```
.shepherd/
  charter.md         # agreed mission and way of working, written at init
  CURRENT.md         # index of the work and handoff to the next session
  pending.md         # warnings waiting for their destination, shown whole at start
  work/              # todo/ in-progress/ done/, one dir per item
  MEMORY.md          # index: one line per memory
  memories/          # one fact per file (frontmatter: name, description, type)
  journal.md         # append only history, current month
  checkpoint.json    # the last checkpoint: certified journal range and file hashes
  checkpoints/       # CURRENT.r<n>: the copy of CURRENT.md that revision n certified
  .state.lock/       # the workspace lock, present while a writer holds it, or left stale by a crashed one until `shepherd tool unlock`
  docs/              # runbooks, environment notes, checklists; INDEX.md lists them
  archive/           # closed work and past journal months; INDEX.md lists them
  integrations/      # workspace local capability modules
```

Core names the memory frontmatter keys and the four types; the full format is in the `memory` guide (`shepherd tool guide memory`).

Context is tiered (see core, "Context tiers"): the prompt and what `shepherd tool start` prints at session start (`CURRENT.md`, `pending.md`, the journal since the last checkpoint, `MEMORY.md`, `docs/INDEX.md` and the check findings) are always read; without the command, a session reads `CURRENT.md`, `MEMORY.md`, `docs/INDEX.md` and the journal's last two days. Everything else is reached through those indexes when needed, and history moves to `archive/`.

### Tracking standard

Core fixes the shape of the tracking files (see core, "Work tracking"), so every workspace keeps them the same way and tools can read them:

- `CURRENT.md` is the index and the handoff, rewritten whole at handoff: an `Updated: YYYY-MM-DD HH:MM` line with the session name, then `## Next session`, `## Items` (one entry each, led by a status word in bold: NEXT, SCHEDULED, WAITING, ASK or CANDIDATE; the line `No NEXT is set.` when there is none) and `## Live sessions` (name, harness, model, the item served).
- An item with more to it than its line is a directory under `work/` with a `STATUS.md`: frontmatter (`state`, `opened`, `closed`, `blocked_on`) and the sections What and origin, State, Next, and Next session must know. `CURRENT.md` is updated in the same turn as the `STATUS.md` it points to.
- `journal.md` is history, not handoff: one `## YYYY-MM-DD` heading per day, with one line bullets that start with the local `HH:MM`. `shepherd tool journal` appends in that form with the time from the clock; a past entry is never edited, only corrected by a new one.
- `pending.md` holds warnings whose destination does not exist yet or needs the user, one bullet each: `- YYYY-MM-DD <what, who found it> -> <destination>`. A bullet leaves when its destination carries it. `tool start` shows the file whole; `tool check` warns on a bullet older than `windows.pendingDays` days.
- `checkpoint.json` records what a session reconciled: the certified journal range, by entry id, and the hashes of `CURRENT.md`, `MEMORY.md`, `docs/INDEX.md`, `pending.md`, `charter.md` and every todo and in-progress `STATUS.md`. `shepherd tool checkpoint` writes it at handoff, with the certified copy of CURRENT under `checkpoints/`; `Updated:` stays for people. Apart from headings, the `Updated:` line, Live sessions lines and Items entries whose linked item is live, done with an `## Outcome`, or archived, a line dropped from CURRENT since the last checkpoint must appear whole in a live file (a doc, memory, STATUS, `pending.md`, the charter, a module, the outbox or the enclosing shared layer) or be journaled with a reason.
- A delegate's report (a `*report.md` file in a todo or in-progress item) ends with `## Discoveries`: new constraints, tool traps and unresolved uncertainties, or the word none. `tool check` warns on a report without it.
- `docs/INDEX.md` has one line per action a doc guards: `- [title](path): before <action>, read this`. `tool check` warns on a line that names no moment (none of before, when, after, if, while, once, during, until).

The declaration and extension preapprove Read and Edit inside `.shepherd/`, Read inside an enclosing workspace's `.shepherd/`, and `Bash(herdr:*)` so memory upkeep and Herdr coordination never prompt. There is no separate Write rule. Destructive Herdr operations are forbidden by the integration module instead. Everything else follows normal permission rules.

## Tools

Maintenance commands run without starting an agent backend:

```bash
shepherd tool check   [<workspace>...] [--all] [--status | --context] [--json] [--today YYYY-MM-DD]
shepherd tool archive [<workspace>...] [--recursive] [--apply] [--json] [--today YYYY-MM-DD]
shepherd tool init    [--master] [--json]
shepherd tool doctor  [--json]
shepherd tool guide   [<name>]
shepherd tool start      [--budget <words>] [--json]
shepherd tool journal    (<text> | --stdin) [--json]
shepherd tool checkpoint [--apply --token <token>] [--session <name>] [--accept-dropped <reason>] [--json]
shepherd tool unlock     [--json]
```

`tool check` checks this workspace and every workspace beneath it. Name one or more workspaces to limit the check. By default it hides informational findings; `--all` shows them, `--status` reports tracked work and live sessions, `--context` reports words by context tier, and `--json` produces machine readable output. `--status` and `--context` cannot be combined.

`tool archive` shows a dry run for the current workspace. Name workspaces to select them, or use `--recursive` to include this workspace and every workspace beneath it. `--apply` performs the planned item and journal moves and rewrites live references. It takes the workspace lock (below) of every workspace in the tree discovered from the launch directory, not only the selected ones, since the reference rewrite touches files across the tree, and plans again inside the locks, so the apply can differ from the dry run; it prints what it did. Before a journal move it simulates the rotation, and when a month's move would change the order of journal entries (entries without a heading, a heading out of date order, or a month that would land behind a later month already archived) it skips that month's move with the reason and the fix; other months and item moves go ahead. `--json` produces machine readable output. Both commands accept `--today YYYY-MM-DD` for a repeatable date during diagnosis or testing.

Exit code 0 means the command completed without an error. For the default check, exit code 1 means at least one error finding; for archive, it means at least one move or reference rewrite was skipped or a lock could not be taken. A move or rewrite whose path passes through a symlinked directory is skipped with the reason. Exit code 2 means invalid usage, an invalid date or selector, an invalid user configuration, or a directory that is not a workspace. Status and context reports use exit code 0 when they run successfully.

The four commands below act on the launch directory's workspace only (`--cwd` selects another) and take no workspace selectors.

`tool start` prints what a session must read before it acts, and takes no lock: a header with the time, the binary that answered and the checkpoint line; the verdict; `CURRENT.md` whole, never cut; `pending.md` whole unless it is absent or still the template; the journal since the checkpoint's boundary; `MEMORY.md`; `docs/INDEX.md`; this workspace's error and warning findings; and three fixed next steps. The verdict is `CLEAN` when a valid checkpoint's boundary is found and nothing is new since it: no journal entry, no changed, appeared or removed covered file, no changed evidence file, no unaccounted dropped CURRENT line. The checkpoint keeps each relied-on line's text, and the next dry run re-checks it when the file that held it changed. Anything else is `RECONCILE`, with one reason line each; a journal entry without a heading at or after the boundary is one such reason. Without a usable checkpoint the journal part falls back to the last two dated sections that hold entries. It keeps the newest entries whole within `--budget <words>` (default `start.journalWords`, 1,500) and prints a cut notice with the file and lines it left out. `CLEAN` covers the records only: the `freshness:` line compares the last Claude transcript activity in this directory with the last write of `CURRENT.md` or `journal.md`, whatever the backend. Codex activity is not measured, so on Codex the line can show an earlier Claude session's activity; `unknown` means no Claude activity was found. `--json` prints the same parts with their word counts. Exit 0 whenever the view renders, whatever the verdict; 2 for usage, an invalid user configuration or a directory that is not a workspace.

`tool journal` appends one entry to `journal.md`: `<text>` as one argument, or all of stdin with `--stdin`. Newlines and runs of whitespace collapse to one space. The time comes from the clock: a leading `HH:MM` in the text is removed, with the notice "time comes from the clock" on stderr, and a `## YYYY-MM-DD` heading is added when the file's last heading is not today's. It prints the line, its entry id and its line number; `--json` prints `line`, `id`, `day`, `time`, `text` and `headingAdded`. A missing `journal.md` is created from the template; a symlinked or non-regular one is refused, and so is one that ends inside an open code fence. Exit 0 on append; 1 when the text is empty, the journal path is unsafe, a fence is open or the lock could not be taken; 2 for usage.

Journal entry ids are derived at read time, never written. The journal sequence is `archive/journal/YYYY-MM.md` in month order (other files there are not part of it), then `journal.md`; each entry's id is the first 10 hex of a sha256 over the previous id and the entry's text. Appending changes no earlier id and neither does a heading fix; editing or removing a past entry changes every later id. The checkpoint reports a lost boundary only when the certified boundary entry or one before it changed; an edit after the boundary changes only the ids of unreviewed entries, which the next dry run shows. A code fence left open in a journal file makes that file unreadable: `tool start` says `RECONCILE`, the checkpoint refuses, and `tool check` warns with `journal-fence-unclosed` at the line that opened it.

`tool checkpoint` without flags is a dry run: it prints in full everything an apply would certify, with no budget: every journal entry in the range since the boundary (without a usable checkpoint, from the earlier of the two fallback sections to the end), each changed or appeared covered file whole with its word count, the count of dropped CURRENT lines found elsewhere, each line not accounted for with the nearest similar line as a hint (`--json` also lists the accounted lines and where each was found), the lock state, a token and the apply command to run: `shepherd tool checkpoint --apply --token <token> --session <your session name>`, plus `--accept-dropped "<why each line may go>"` when lines are unaccounted for. Replace the placeholders before running it; apply refuses placeholder or blank values. A checkpoint applied without `--session` shows its writer as unknown. `--json` carries the same command in its `apply` field. `--apply --token <token>` certifies under the workspace lock what the dry run showed. It refuses, and certifies nothing, when the checkpoint revision moved, when anything the token binds changed (the journal chain through its last entry, the covered files, the certified CURRENT, and what the dry run said about each dropped line), when `CURRENT.md` is missing, when a covered file is unsafe or a journal file unreadable, or when dropped lines are unaccounted for and `--accept-dropped <reason>` is not given. `--accept-dropped` journals each unaccounted line as `dropped from CURRENT (<reason>): <line>` and certifies those entries too; if the journal changes under the apply in any other way, it refuses, and the lines it appended stay. `--session <name>` records who wrote the checkpoint; `tool start` shows it in the checkpoint line. The apply writes `checkpoints/CURRENT.r<n>`, then `checkpoint.json` through a temporary file and a rename, then prunes older snapshots. The dry run refuses too, printing no token and no apply command (its `--json` has `refused` instead of `token` and `apply`), when a journal entry without a heading sits inside the range (give it a `## YYYY-MM-DD` heading, which changes no id), a covered file is unsafe or a journal file is unreadable. Exit 0 for a dry run that printed a token and for a written checkpoint; 1 for a refusal; 2 for usage, including `--apply` without `--token`, `--token` without `--apply`, or a malformed token.

`tool unlock` clears a stale workspace lock. Exit 0 when it cleared one or found none; 1 when the lock's owner is alive, another unlock is running, or the unlock lock is stale; 2 for usage.

The workspace lock serializes every writer: `tool journal`, `tool checkpoint --apply` and `tool archive --apply` take the directory `.shepherd/.state.lock/`, whose `owner` file holds the pid and start time; readers, the dry runs included, never take it. A writer that finds it held by a live pid waits up to 5 seconds, then fails with "locked by pid N (alive)". A lock whose pid is dead, or whose `owner` is missing or malformed, is stale: writers fail at once with "stale lock `.shepherd/.state.lock` left by pid N; run `shepherd tool unlock`" and never take or remove it. Run `shepherd tool unlock` only when no other Shepherd of the workspace is live (`shepherd tool check --status` shows live sessions); it refuses a live owner in any case. Unlocks serialize under a second lock, `.shepherd/.unlock.lock/`; one left by a crashed unlock makes `tool unlock` print the `rm -r` line to run by hand. `tool check` reports either stale lock as an error (`lock-stale`), and `tool start` prints the lock state. A crash can leave inert directories in `.shepherd/`: `.state.lock.<pid>.<uuid>.gone` from between a lock's rename away and its delete, and `.state.lock.<pid>.tmp` from between creating a lock and renaming it into place, with the same two names for `.unlock.lock`. Nothing cleans up a `.gone` directory. A `.tmp` directory has no general sweep either: only a later writer whose pid (and thread) gives the same name removes it. Both are safe to delete by hand when no Shepherd of the workspace is running.

For a fresh machine, follow [SETUP.md](SETUP.md).

### Init

`tool init` creates `.shepherd/` in the launch directory. Use `--cwd <dir>` to select another root. Nothing that exists is overwritten: existing files, directories and symlinks are kept. Required parent directories are created as needed; symlinked parent directories are supported. A file blocking a required directory or another write error stops the run, reports the failed entry and keeps completed writes. `--json` reports `created`, `kept` and `failed` entries, with paths relative to `.shepherd/`.

Every workspace gets these entries, in order:

| Path | Content |
|------|---------|
| `CURRENT.md` | Work index and first move: run the init conversation |
| `MEMORY.md` | Memory index |
| `journal.md` | Journal, empty, with the daily heading rule |
| `pending.md` | Pending warnings, empty, with the bullet form |
| `docs/INDEX.md` | Documentation index |
| `docs/STATUS-template.md` | Work item status template |
| `archive/INDEX.md` | Archive index |
| `work/todo/`, `work/in-progress/`, `work/done/` | Empty directories |

`--master` adds the shared layer for a root with workspaces beneath it:

| Path | Content |
|------|---------|
| `shared/user.md` | User context skeleton |
| `shared/machine.md` | Machine context skeleton |
| `shared/roster.md` | Roster card: which model, harness and effort to use now |
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

Configuration is layered from the user file at `$XDG_CONFIG_HOME/shepherd/config.json`, or `~/.config/shepherd/config.json` when `XDG_CONFIG_HOME` is unset, followed by `.shepherd/config.json` files from enclosing workspaces through the current workspace. User configuration may set `marks`, `windows`, `start`, `handoffCeilings`, and `codex` values for `home` or `homeFile`, `model`, and `effort`. Workspace configuration may set `marks`, `windows`, `start`, `handoffCeilings`, and the noninherited `sessionPrefix`. `windows.pendingDays` (default 14) is the age in days a `pending.md` bullet must exceed to be reported stale; `start.journalWords` (default 1,500) is the journal budget of `tool start` when `--budget` is not given. Both are positive integers. Unknown or misplaced keys are errors. Run `shepherd --help` for the generated option reference.

`handoffCeilings` maps model IDs to percentages of the context window. Values must be numbers greater than 0 and at most 100; fractional percentages are allowed. Individual entries merge from user to enclosing workspaces to the current workspace, and an invalid entry rejects its entire file with a `ConfigProblem`, like other keys. Exact model IDs win. Reserved entries `claude` and `codex` supply family defaults (45% and 80%), and `default` supplies the conservative fallback (45%) when neither model nor backend identifies a family. Claude IDs and the `opus`, `sonnet`, `haiku` aliases use `claude`; GPT and Codex IDs use `codex`. These family names match exactly or with a hyphen suffix. An absent or unrecognized model uses the selected backend's family value: `o3` and `o4-mini` on Codex use `codex`. An exact model entry still wins. For example, in either configuration layer:

```json
{
  "handoffCeilings": {
    "claude": 45,
    "codex": 80,
    "default": 45,
    "claude-opus-4-6": 48,
    "gpt-5.6-sol": 85
  }
}
```

The built-in Claude figure is the midpoint of the previous 40 to 50% advice. Codex/GPT starts at 80%. Configuration lets each model's observed behavior determine its ceiling.

## Backends

Shepherd declares Claude first, so Claude is the default. Select Codex with `--backend codex`; backend selection is never taken from the environment. Both backends receive the same prompt layers, but the generated context header names the selected backend. Codex receives the composed prompt as `developer_instructions`. Backend executables are found on `PATH`.

The Claude child receives neither a framework-root variable nor an inherited project-directory variable. Claude settings contain only the declared rules and any enclosing-workspace additions. Codex inherits its own configuration and adds `--skip-git-repo-check` for print mode outside a Git worktree.
