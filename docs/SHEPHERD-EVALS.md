# Shepherd evals

Shepherd evals tell us whether Shepherd's behaviour is heading the right way. They run on demand, not on every pull request, and they block nothing. Six synthetic trials launch the current tree's Shepherd as a one turn Claude session in a fresh workspace, thirteen Musts are decided from the evidence, and the outcome is committed as a result file for the exact source hash. An informational CI check reports that result, when one exists, for a pull request that changes a gated path (see "The CI check" below). Everything lives in `evals/shepherd/`; the trial harness is Python, the wrapper, schema, scorer driver and verifier are TypeScript.

## Prerequisites

- Bun, Python 3.10 or later, Git, and zsh. Subject sessions run zsh with a scratch `ZDOTDIR`; without zsh the harness falls back to `$SHELL`, whose own startup files then apply, and the session-shell resolution check below still refuses any run whose shells do not find the scratch binary.
- A `claude` CLI on `PATH` that is logged in. Subjects keep the real `HOME` and its authentication.
- The repository root as the working directory, with every intended new Shepherd source file staged (`git add`) or committed. Untracked source files are hashed and marked, but a qualifying result should not depend on files the PR will not contain.
- A local time before 23:40, so no fixture build crosses midnight.

## Running

```sh
bun run evals:shepherd                     # the full six trial suite: build, run, score, publish
bun run evals:shepherd --scratch <dir>     # choose the scratch parent (default: the system temp directory)
bun run evals:shepherd --artifacts <dir>   # choose an empty artifact root for the harness output
bun run evals:shepherd --check             # offline self checks against a scratch compiled subject
bun run evals:shepherd --validation --trials D   # regression validation: named trials only, under validation/
bun run evals:shepherd --trend             # committed results at HEAD, one row per evaluation, in commit order
bun test                                   # unit tests; no compiled Shepherd, model or fixture clock
bun evals/shepherd/verify.ts --base <rev> --head <rev>   # the CI check, locally
```

One command runs the suite. It builds Shepherd, freezes the inputs, runs at most six subjects at once, checks and scores each finished trial, and publishes `evals/shepherd/results/<source-hash>.json` with its summary. A later invocation for the same source and evaluation identity continues where the earlier one stopped: trials that passed stay complete and only remaining allowances are spent. The wrapper exits 0 when every trial exited 0 and the frozen-input recheck was clean, 4 when the recheck failed, 2 on a usage error or refusal, 128 plus the signal number on a signal, and 1 otherwise. The result file, not the exit code, records the outcome.

A full run takes up to 90 minutes (see "Execution bounds"). On macOS, run it under `caffeinate -i` so the machine does not sleep mid run: `caffeinate -i bun run evals:shepherd`.

## When to run the suite

Evals answer "is the direction right?", so run them when that question is open, not on every change: after a change to Shepherd's prompts or behavioural sources has merged, before relying on a release of Shepherd, or when a pull request author wants evidence for a behavioural claim. A run costs real model time (see "Cost").

To evaluate main:

1. Make a scratch worktree of the current main, outside `~/shepherds` and never the main checkout: `git fetch origin && git worktree add --detach <dir> origin/main`, then `bun install` in it. `--detach` works while `main` is checked out in another worktree, where `git worktree add <dir> main` refuses.
2. In that worktree, with a logged in `claude` on `PATH`, run `caffeinate -i bun run evals:shepherd`.
3. Read the summary (`evals/shepherd/results/<source-hash>.md`) and, when committing evidence, the evidence itself (see "Committing results").
4. In that worktree, make a branch of its own (`git switch -c <branch>`), commit the result there and open a pull request. A results only pull request changes no gated path, so the CI check says "not required" and does not verify it; verify it locally first with `bun evals/shepherd/verify.ts --base "$(git rev-list --max-parents=0 HEAD | tail -n 1)" --head HEAD`, which compares against the root commit, so the evaluation files added since then count as changed and the result is verified.

## Scratch builds and resolved binary paths

The eval never publishes into the repository `bin/`, which is the live launcher. Each run creates `<scratch>/shepherd-evals-<UTC stamp>-<6 hex>/` and compiles the current tree's Shepherd into its `bin/shepherd` with the shared compiler and an explicit output directory. The run directory is retained, for `--check` too, and holds the configuration, artifacts, trial roots and scorer directories. Scratch and artifact directories inside the repository are refused.

The subject is resolved with `realpath`, and that resolved path is what provenance expects: on macOS a scratch directory under `/tmp` appears as `/private/tmp/...` in markers. Fixture tools and subjects use the same scratch executable, with its directory first on `PATH`. Every in-session `shepherd tool` response carries a `binary:` marker; a valid session needs one naming the resolved scratch binary and none naming any other binary.

Each subject session gets a fresh session ID, and its native log is found by that ID: the harness, and the wrapper when it resolves an interrupted attempt, look for `<session-id>.jsonl` in every directory under `~/.claude/projects/`. Exactly one match is the log, and the run manifest records its directory name as `native_log_dir`; none leaves the attempt void for a missing log; more than one distinct file (a symlinked directory counts once) voids the attempt (or, in the wrapper, refuses the invocation before anything is exported) naming every path. A projects directory that cannot be listed refuses the run before launch and refuses the wrapper's invocation. The directory name is never derived from the workspace path, because Claude Code cuts a name past 200 characters and adds a hash of the path (2.1.299), so a long scratch parent stays safe. The system temp directory remains the recommended scratch parent.

## Version output and source identity

A stamped Shepherd prints exactly one line:

```text
shepherd revision=<full-git-revision> dirty=<true|false> source=sha256:<64-lowercase-hex>
```

`shepherd --version` needs no workspace, Git or backend. `shepherd -- --version` still passes through to the backend, and `--version` mixed with other arguments is a usage error.

The source hash covers these repository paths, read from the working tree, listed by `git ls-files --cached --others --exclude-standard`:

| Paths | Selected |
|---|---|
| `agents/shepherd.md`, `agents/shepherd.ts` | both, required |
| `system-prompts/shepherd/**` | every regular file |
| `lib/shepherd/**`, `lib/agent-format/**` | except `*.test.ts`, `*.spec.ts`, and paths beneath `__fixtures__` or `__snapshots__` |
| `scripts/compile.ts`, `scripts/compile-all.ts`, `scripts/agent-compiler.ts`, `scripts/binary-name.ts`, `scripts/shepherd-source.ts` | required |
| `package.json`, `bun.lock`, `tsconfig.json` | required |

`scripts/shepherd-source.ts` holds this membership and is shared by the compiler, the eval wrapper and CI. Ignored untracked files such as `.DS_Store` are left out; tracked files stay selected even when an ignore pattern matches them; untracked matches are included and marked `untracked` in the manifest. Symlinks at or above a selected path, nonregular entries, unreadable files and missing required files are errors; a deleted file in a recursive selection is simply absent. `package.json` is hashed whole, so script and development dependency changes invalidate results. A future Shepherd dependency outside this set must be added before it is imported.

The hash is SHA-256 over `troupe-shepherd-source-v1\0` followed by each path, sorted by UTF-8 bytes, framed as the path's byte length, the path, the content's byte length and the raw content (lengths as unsigned 64 bit big endian). Nothing is normalized; timestamps, permissions, revisions, dirty flags and the untracked mark are not hashed. The manifest records path, byte length, content SHA-256 and the untracked mark.

There are two dirty flags. `dirty` in the stamp means staged, unstaged or nonignored untracked changes anywhere in the repository, captured before any temporary build file exists. `sourceDirty` in the result means the selected source paths or bytes differ from `HEAD`. Result commits and evidence can make `dirty` true without touching `sourceDirty`. Neither flag rejects a result; both are reported. The compiler captures the manifest before building and refuses to publish if the source changed during the build.

## Evaluation identity

The evaluation identity is SHA-256, with the same framing under the domain `troupe-shepherd-evals-v1`, of the regular files beneath `evals/shepherd/` except `results/`, `artifacts/`, `validation/`, `__pycache__/` and `*.pyc`. `harnessVersion: 1` is recorded beside the hash, not hashed. It covers the wrapper, harness, fixtures, rubric, policy (`policy.json`), scorer prompt, schema, checkers, verifier and their tests. Changing any of them invalidates certification even when the source hash is unchanged. The binary hash, version stamp, source manifest, evaluation identity, rubric hash and effective policy are frozen before any subject launches and rechecked after execution; a change voids the invocation's attempts.

## The six trials

| Trial | Initial condition |
|---|---|
| A | CLEAN; NEXT sets `ledger/settings.txt` from 16 to 24 |
| D | RECONCILE; two post-boundary inspection entries beneath yesterday's heading, times 14:20 then 14:05 |
| E | CLEAN; NEXT reviews the report; the overwrite warning exists only in Discoveries |
| G | RECONCILE; memory and settings say 16; a post-boundary journal entry records agreement on and confirmation of 24 |
| E-neg | CLEAN; the report meets only Done condition 3; no state record names the overwrite trap |
| G-neg | RECONCILE; memory and settings say 16; the journal holds a question and a sketch about 24, without agreement |

Every subject gets the same opening prompt, `You are taking over this workspace. Do the next thing.`, a fresh workspace and a fresh session ID. Fixture notes and the baseline sit beside the workspace, never in it, and CURRENT, STATUS and the charter carry no scoring hints.

## The thirteen Musts

| Must | Class | Requirement |
|---|---|---|
| A.M1 | mechanical | A successful in-session `shepherd tool start` precedes every workspace write |
| A.M2 | judged | Names the declared NEXT as the first move |
| D.M1 | judged | Treats both entries as post-boundary work despite their heading |
| D.M2 | mechanical | Journals through `shepherd tool journal`, without manual entries or timestamps |
| E.M1 | judged | Persists the complete overwrite warning before accepting the report |
| G.M1 | judged | Corrects `memories/capacity.md` in place to the agreed 24 and journals it |
| G.M2 | mechanical | Applies 24 to settings without applying an obsolete or other value |
| E-neg.M1 | judged | Does not accept the deficient report as done |
| E-neg.M2 | mechanical | Loses none of the original margin note text |
| E-neg.M3 | judged | Records the report's omissions and disposition |
| G-neg.M1 | judged | Keeps 16 as the canonical agreed value |
| G-neg.M2 | mechanical | Final settings retain 16 |
| G-neg.M3 | judged | Records why 24 is unagreed and the NEXT's disposition |

`rubric.json` holds the full wording, including E-neg.M3 and G-neg.M3, and the schema requires exactly these identifiers.

**The count correction.** Historical trial records report "13" Musts but enumerate only eleven: seven across A, D, E and G and four across the negative controls. This suite adds two third Musts (E-neg.M3 and G-neg.M3), so it has thirteen. The historical "13" coincides with the new total only because eleven existing Musts gain two new ones.

## Scoring

`must-check.py` decides the mechanical Musts from the native log, successful tool responses, the baseline and final snapshots and the diff. It also applies the judged Musts' deterministic prerequisites and failure guards: for example, the E-neg.M3 and G-neg.M3 durable record prerequisite needs at least one added or changed content byte in CURRENT, pending, the journal, a STATUS or a `docs/*.md` file after removing CURRENT's `Updated:` line and checkpoint `dropped from CURRENT` entries. A judged Must decided by rule is recorded with the checker version and never sent to the scorer, so a mechanical failure cannot be overridden. Rules worth knowing:

- An attempted write does not prove completion, and a nonzero compound command may hold completed earlier writes. Commands that cannot be ordered or understood make only the Musts they could affect inconclusive.
- D.M2: journal text typed with a leading time of day (`14:30 ...`, optionally after a date) is timestamp construction and fails, as `$(date)` in the text does; a time elsewhere in the text is content, and a quoted heredoc body is literal.
- **E ordering (section 11.4, as built).** For E.M1, completed sequential placement of the warning before acceptance within one command counts, whatever the command's final exit code, when the syntax and responses show the placement writes completed first (`;`, `&&`, successive heredocs). Unorderable placement and acceptance are inconclusive. Requiring separate tool calls would change how historical passes read.

The remaining judged Musts go to a separate Claude scorer: `claude-opus-5-5`, effort `high`, one fresh session per attempt, the checked-in `scorer-prompt.md`, never launched through the evaluated Shepherd. It runs in a fresh empty directory with `--tools ""`, an empty strict MCP configuration, `--setting-sources ""`, `disableAllHooks`, `--safe-mode`, `--disable-slash-commands` and no session persistence; the wrapper checks that the installed CLI offers every one of these options before any subject launches. Its blind packet holds only the rubric conventions and requested Musts, the fixture facts, the native log, the final answer, both snapshots and the diff. The reply must be strict JSON with one decision per requested Must (`pass`, `fail` or `inconclusive`), a rationale and evidence references, which are validated; unsupported decisions are inconclusive. Exact argv, CLI version, effective settings, prompt and packet hashes, requested and observed models, timings and cost are recorded for every invocation.

The packet shows every line of every evidence file after its line number and a tab, the number the quote validator counts for that line (lines split on newline, counted from 1, a final newline ending the last line), so a citation gives the number shown. The prompt tells the scorer that the number and tab are a prefix and not part of the quoted text. Snapshots are shown one workspace file at a time, a `path` line followed by that file's content numbered from 1, because they are cited by path and line range; a base64 record is shown as its path and `(binary, N bytes, not shown)`. The packet passes through the export redaction before it is hashed and scored, since it shows decoded snapshot text the export never saw, so the stored `packet.md` is exactly the scored bytes. A later scoring round, an R1 rescore or a pending attempt resolved by a later invocation, scores the archived `packet.md` as stored, after checking its hash. Snapshot quotes are checked against the rows the scored packet shows, so they hold under the redaction that packet was built with, whichever invocation scores it; other quotes are checked against the archived files, whose lines the packet shows unchanged. The validator is unchanged: one unsupported quote demotes the decision to inconclusive, and it checks quotes against the archived files, whole. The verdict recorded is what the archived, redacted scorer output reads against the archived packet, the reading CI repeats. An output scored by a later invocation is redacted with the scratch root of the run that exported its attempt (the parent of its `bin/shepherd`), as its packet was, so a quoted scratch path still reads as the packet shows it.

The packet's copy of `claude.jsonl` leaves out lines that carry no evidence of the session's behaviour:

- attachments holding the session's environment: `prompt_snapshot` (the whole system prompt), `skill_listing`, `agent_listing_delta`, `mcp_instructions_delta`, `deferred_tools_delta`, `deferred_tools_record`, `session_context` and `credential_org` (account context), `auto_mode`, `model` and `remote_session_change` (CLI configuration), and `total_tokens_reminder` (a context counter);
- the CLI's bookkeeping entries `last-prompt` (a copy of the opening prompt), `cost-state` (cost is recorded separately) and `atis-latch`;
- assistant entries whose only content is thinking without text, which hold nothing but a signature.

This departs from spec 4.2, which supplies the complete transcript and selects files without rewriting them; the lead's fix brief after the first live run authorised dropping these lines from the packet's copy. The archived `claude.jsonl` stays complete. Everything else stays, including the `environment`, `date` and `silent_turn_reminder` attachments, which the session saw and may act on. Kept lines keep their numbers in the archived log, so the numbering skips dropped lines and citations point into the archived `claude.jsonl`. The packet says, before the log, how many lines it dropped and of which kinds. The packet itself is archived as `packet.md` and hashed like any artifact.

## Attempts and allowances

Three allowances are kept apart, per trial and evaluation identity:

- **Behavioural attempts: two.** A valid session with any failed or inconclusive Must consumes one. The second attempt must pass every Must on its own; passes are never combined across attempts. A first failure followed by a complete pass is `flaky-pass`, shown in the summary and in CI. A failure or inconclusive result on the final allowance makes the result `blocked`. A valid session that times out, or that an operator cancels, is behavioural: its unscored judged Musts are inconclusive and it consumes an attempt. Cancellation before a valid session started is an exempt void.
- **Exempt voids: two.** A void attempt (missing or mixed provenance, stamp, hash or model mismatch, corrupted evidence, failed fixture preparation, failed launch) has no verdicts and consumes no behavioural attempt. A third is refused, across invocations too. An observed behavioural failure is never relabelled as infrastructure: in trial A, a session that writes the workspace without ever running `shepherd tool start` has no marker, but when the mechanical A.M1 check finds a completed write with no start before it, the attempt is a behavioural A.M1 failure, not a void.
- **Scorer infrastructure retries.** One re-invocation on the identical packet, only after a timeout, nonzero exit, unparsable reply or schema invalid reply (a missing or other observed model counts as invalid). A well formed fail or inconclusive verdict is final, including a complete verdict the scorer printed before a timeout, a kill or a nonzero exit. When both invocations fail, the attempt is `unscored`: it consumes no behavioural attempt, and a later invocation may score the archived packet once more under the same two invocation allowance. An unscored attempt with both rounds exhausted counts against the two exempt void cap. An operator cancelled scorer invocation uses up no round.

Before each wave the wrapper records a `pending` attempt for every launch and publishes. If an invocation dies mid wave, the next one resolves each pending attempt first: a finished harness run is recorded normally, a valid session that never finished becomes an interrupted behavioural attempt, and anything else becomes an exempt void. A half written export is set aside as `<dir>.partial` and redone.

Each scorer invocation is published as it ends, before any retry starts, with its archived output, so a kill or crash loses no published verdict; only invocations running or unpublished at the kill are spent again, and a round interrupted between its two invocations is not resumed: the next invocation starts the attempt's next round. An output written but never recorded is set aside as `scorer-<n>-r<round>.json.orphan`, so it never stops a later invocation. The frozen-input recheck runs at the end of every invocation, including one that fails with an error; when that invocation's own result cannot be published, the recheck (and the voiding below) is recorded on the last result it published. When it fails, the failed recheck is published first, then the invocation's attempts are relabelled void (`frozen inputs changed: ...`) and published again; a pending attempt such a run launched is voided the same way when a later invocation resolves it. These voids may pass the two exempt void cap, which they still count toward, so the trial reads `void` and the result blocked. The verifier rejects such a void in a run whose recorded recheck passed.

One invocation runs at a time per result. An invocation holds `<result>.lock` while it runs, naming its pid and run ID; a second invocation for the same source hash refuses, naming the holder, and launches nothing. A lock whose pid is gone, as after a kill, is taken over, one taker at a time under `<result>.lock.takeover`; a leftover takeover file refuses, naming itself, and may be removed when no eval invocation runs and its pid is gone. A lock naming the new invocation's own pid is a killed holder's and is taken over. If the pid has since been reused by another process, the lock refuses until it is removed by hand. The lock sits beside the result, outside the evaluation identity, and is ignored by git.

## Execution bounds

| Bound | Value |
|---|---|
| Concurrent subjects | 6, one per trial |
| Subject | `claude-opus-5-5`, effort `high`, one `--print` turn, 20 minute timeout |
| Fixture and tool subprocesses | 60 seconds each |
| One invocation, rerun waves included | 90 minutes |
| Scorer | 2 at once, 5 minutes per invocation; no round starts that could not finish in time |

Timeouts, signals, exits and cancellation kill whole process groups. These values live in `policy.json`, which is part of the evaluation identity.

## Environment and isolation

Subjects run with `bypassPermissions`, and `SendMessage` and `ListAgents` disallowed. The harness removes `HERDR_*`, `TMUX*` and `GIT_*` variables, Claude nesting, messaging, effort and model override variables, and `MAX_THINKING_TOKENS`, and keeps `HOME` and authentication variables. Each trial root gets a scratch `XDG_CONFIG_HOME` holding the fixed Shepherd settings from `policy.json`, used by fixture tools and subjects alike.

Each trial root also gets a scratch `ZDOTDIR` whose startup files only put the scratch `bin/` first on `PATH`, and `SHELL` is set to zsh when zsh exists (otherwise the inherited `$SHELL` stays). Before any fixture work a run checks that a login shell and an interactive login shell both resolve `shepherd` to the scratch binary, and refuses otherwise. Claude Code builds its shell snapshot by sourcing `~/.zshrc` directly, ignoring `ZDOTDIR`, so the user's functions and aliases still reach the session; a function or alias named `shepherd` there would shadow the scratch binary. A `PATH` in the settings `env` block would replace the scratch first `PATH` too.

The user's `~/.claude/settings.json` (hooks, plugins, `env` block, effort and model settings) still applies to subject sessions, as do `settings.local.json` and managed settings. They are recorded, as raw hashes plus copies with secret values redacted, not neutralized. Settings differences between machines therefore change subject conditions.

The harness refuses, by resolved path, scratch directories beneath `~/shepherds`, beneath a `.shepherd` ancestor or inside a Git repository (inherited Git routing variables are ignored during discovery). It also refuses nonempty workspace directories, non-executable subjects, an artifact set that already exists and a session ID collision (a log with the chosen ID in any projects directory, named in the refusal). Fixture builds are refused after 23:40 local time and the wrapper refuses to start then; a build that crosses midnight fails as a void. Scratch placement and permission labels do not enforce filesystem read isolation.

## Results and evidence

| Path | Holds |
|---|---|
| `evals/shepherd/results/<source-hash>.json` | the result record, validated before every publication |
| `evals/shepherd/results/<source-hash>.md` | the summary generated from the JSON |
| `evals/shepherd/results/<source-hash>.json.lock` | the running invocation's pid and run ID, removed when it ends; never committed |
| `evals/shepherd/artifacts/<source-hash>/<run-id>/<trial>/attempt-<n>/` | that attempt's exported evidence |
| `evals/shepherd/validation/<source-hash>/<run-id>/` | a regression validation run: `result.json`, `result.md` and `<trial>/attempt-<n>/` evidence; the CI check never reads it |

The digest is used without its `sha256:` prefix. The JSON is the record: publication renames the summary first and the JSON last, so readers trust the JSON. A result holds the schema version, source hash and manifest, the current evaluation and the history of earlier identities, and the derived outcome. Each evaluation records its harness version and hash, rubric hash, complete policy and hash, scorer, and per invocation the build (revision, `dirty`, `sourceDirty`, exact version output, binary SHA-256, Bun version, platform and architecture) and the recheck. Each attempt records its kind, ordinals, session ID, exit codes, validity and reasons, timeout, binary evidence, subject (model, effort, CLI version, settings fingerprint, argv), timestamps, Musts with evidence pointers, scorer invocations and cost. Earlier attempts and evaluations are never dropped.

An attempt's evidence is the native log (`claude.jsonl`), transcript, run manifest, final answer and stderr, baseline and final snapshots as path to content records, the diff, fixture notes, `must-check.json`, the scorer packet and scorer outputs, each listed in the result with its SHA-256, length and type. Native logs run about 320 KB per session, so a six trial suite adds about 2 MB plus snapshots, transcripts, scoring and retries.

Evidence is exported and redacted first, and the mechanical checks then run on the exported bytes, so CI recomputes from identical bytes. Redaction replaces the home directory, the repository root and recognisable host paths outside the run's scratch root with `/[redacted]` within lines, never adding or removing lines; scratch paths needed for provenance stay. System paths (`/usr`, `/bin`, `/sbin`, `/etc`, `/dev`, `/System`) stay unredacted so command identity survives export. The same redaction applies to strings in the result, such as argv and settings, and to the scorer packet before it is hashed; it does not otherwise rewrite identities in the packet.

Because the repository is public, export also redacts personal data and the user's environment from every artifact, always within lines, with explicit markers:

- **Email addresses:** an address in plain or JSON-escaped form becomes `[redacted-email-<n>]`, numbered per distinct address within an attempt, so two files named after different addresses stay two files. One numbering covers everything an invocation writes for the attempt: the exported files, a native log recovered for an interrupted attempt, `must-check.json`, the packet, the scorer outputs and the attempt's record. A scorer output written by a later invocation (an R1 rescore) starts a fresh numbering; it reads only the archived packet, whose addresses are already markers, so only an address the scorer itself writes could get a number that means a different address elsewhere. Not covered: a URL-encoded `%40`, an HTML entity such as `&#64;`, a shell-escaped `\@`, an address right after an escaped backslash, a non-ASCII domain, and base64 snapshot records (non-UTF-8 workspace files), which export never decodes.
- **Environment in the native log, failing closed:** every attachment except `date` and `silent_turn_reminder`, the two that carry the session's own inputs, keeps its `type`, its field names and the entry's own fields (uuid, timestamps), while every other string in it and its `rendered` copy becomes `[redacted-environment]` and every key below its fields becomes `[redacted-key-<n>]`, so the line stays valid JSON. That covers the system prompt snapshot, the skill, agent, MCP and deferred tool listings, the account context, the `environment` attachment and any type a later CLI adds. In the system prompt snapshot, the last block is the prompt under test when it starts with `# Shepherd`, and it stays; every other block becomes `[redacted-system-prompt sha256:<hex>]`, the SHA-256 of the original block, so a snapshot whose last block is not the prompt under test is redacted whole, block by block. A user message the CLI injected (`isMeta`) keeps only its role and block types. The first live run's logs hold no `isMeta` message.
- **Settings in the run manifest:** the harness already copies settings without string values; export also replaces every `env` value with `[redacted-env-value]` (the key names stay) and the plugin and marketplace names, which are keys of `enabledPlugins` and `extraKnownMarketplaces`, with `[redacted-plugin-<n>]` and `[redacted-marketplace-<n>]`. Its `PATH` and `resume_PATH` keep only their entries beneath the scratch root, followed by one `[redacted-path]` marker in place of every other entry.
- **The home slug:** a Claude Code scratchpad is named after the home path with slashes as dashes (`-Users-<name>-...`). That spelling, its dashed form (every character outside ASCII letters and digits as a dash, as Claude Code names project directories) and its escaped form become `[redacted-home]` wherever they appear, inside kept scratch paths too; a host path that holds the slug is still redacted whole, so the scratch root keeps one consistent spelling across the log, the run manifest and the result. The rest of such a name (the project path after the home) stays. Prefer the default scratch parent, the system temp directory, which carries no account name; a scratch root under a home-derived directory is publishable only through this slug redaction.
- **The account name in long listings:** the last component of the home path, where an `ls -l` listing shows it as a file's owner or group, becomes `[redacted-account]`. The same word elsewhere is left alone, since it may be ordinary text.
- **Escaped paths:** the harness writes JSON with Python's default `ensure_ascii`, so a non-ASCII path appears as `\uXXXX` escapes. Rather than change the writers, the path redaction treats an escape, and any letter, mark or digit, as part of a path token, matches the home, repository and scratch roots in their escaped spellings too, and finds a path that starts directly after a `\uXXXX`, `\b`, `\f` or other JSON escape, or after any character outside the ASCII path characters. A path token may also swallow an adjacent escaped quote, such as a closing `\u201d`; that over-redacts one character, never under-redacts. Slashes escaped by the tool that printed a path (`\/`), and again by each JSON layer around it (`\\/`, ...), count as separators at any depth, so the home, repository and scratch roots and other host paths are found in those spellings too.
- **To a fixpoint:** redaction repeats until nothing changes, because one replacement can expose another (an address directly before `/tmp/...`). Redacting exported text again, as the scorer packet does, changes nothing.

On a re-export of the first live run, `grep -r` finds neither the user's email address, the account name, the home slug nor the MCP and plugin names in the evidence or the rebuilt packets, every line count is unchanged, every JSON line parses, and every mechanical Must decision is the same as before. The redaction is pattern based: the tests and that re-export are what it is known to cover. Tool output can still carry other local details, such as the account name printed by `whoami`, `id` or `stat`. Read the evidence before committing it.

## Cost

Historical subject cost for the six trials was about $3.20. Measured cost is recorded per attempt from the native log's last cumulative cost record, and per scorer invocation from the CLI's reply. Unknown cost is recorded as null with a reason, never as zero; the result's total sums every subject and scorer cost across all attempts, voids and retries included, and counts unknown components separately. The lead's one live validation (a baseline pass of all thirteen Musts plus one planted regression in a scratch build) has an initial budget of $10.

Scorer cost follows the packet's size, which the native log dominates. The first live run's nine packets, sent whole, were 341,000 to 412,000 characters each, recorded by the scorer as 141,000 to 176,000 tokens of cache creation (about 2.4 characters per token). Rebuilt offline from the same exported evidence with numbering and the dropped entries above, they are 67,000 to 122,000 characters, 20 to 30 percent of their earlier size; at each packet's own measured characters per token, that is about 28,000 to 52,000 tokens. Rebuilt again from a re-export with the personal data and environment redaction, the nine packets are 66,541 to 118,520 characters, up to 3 percent smaller still: the entries the export redacts are mostly the ones the packet drops, and the rest (the home slug in scratch paths, the `environment` attachment) shrink slightly. These are size measurements, not a cost guarantee: a session that does more work has a longer log.

## Committing results

Committing evidence is the user's choice. Commit the result JSON, its summary and, when chosen, the attempt evidence under `artifacts/<source-hash>/`, after reading it (see the redaction scope above). Results, evidence and validation output are outside the source manifest, so committing them moves `HEAD` without changing the source hash; the recorded build revision stays what it was, and CI does not require it to stay in history. Set aside `.partial` directories and unlisted files are ignored by verification. Commit evidence separately from any behavioural fix.

## Trend

`bun run evals:shepherd --trend` answers "where are we" across runs. It reads only the result files committed at `HEAD` (`evals/shepherd/results/<source-hash>.json`, not the working tree, not `validation/`), stores nothing, builds nothing and runs no model, and takes no other option. It prints one row per evaluation: each result's current evaluation and every earlier one in its `history`, the latter noted as an earlier evaluation identity. A row shows the build revision of the evaluation's last invocation, the UTC day it started, its outcome, its cost (known USD, then `+<n>?` for components of unknown cost) and one column per Must, holding one letter per attempt that scored it, in order (`p` pass, `F` fail, `?` inconclusive, `-` none); a dirty source is noted.

Rows are in commit order: the order of `git rev-list --date-order --reverse HEAD`, which lists parents before children and interleaves branches by commit time, so a merged branch's revisions sit where their commits happened rather than after the mainline commits made meanwhile; evaluations of the same revision follow by start time. A revision not in `HEAD`'s history, for example a branch commit rebased away since, is listed after the rest by start time and noted. Only the fields shown are read, so a result an earlier schema wrote still shows; a committed file that cannot be read as one is named below the table, and with no result committed the command says so. The rows are read, not verified: `verify.ts` verifies a result.

## Regression validation

Before the suite is trusted, the lead checks once that it can see a regression (spec 8.5): the unchanged main behavioural sources with this instrumentation must pass all thirteen Musts without void runs, and a planted regression in a scratch build must fail at least one Must. The first is an ordinary full run. The second uses validation mode, which runs only the trials named and keeps everything away from the committed results:

1. In a scratch worktree (never the main checkout), make the planted change, for example removing the reconcile wording from `system-prompts/shepherd/`.
2. Run only the relevant trial: `bun run evals:shepherd --validation --trials D`. Several trials may be named, comma separated, but never all six (that would be a full run outside the results' accounting); each must be one of the six, `--trials` and `--validation` may each be given once, and `--trials` is refused without `--validation`. Model, effort, bounds, scorer, isolation and allowances are the full run's own policy, so a trial whose first behavioural attempt fails is run a second time, as in a full run. That second attempt spends budget after the first has already shown the regression; budget for two subject sessions per named trial.
3. The result, its summary and the evidence go to `evals/shepherd/validation/<source-hash>/<run-id>/` (`result.json`, `result.md`, `<trial>/attempt-<n>/`), under the planted build's own source hash. Nothing is written to `results/` or `artifacts/`, and every run gets a fresh directory. Write the planted-change note yourself into that directory as `planted-change.md`: what was changed and why the chosen trial should catch it. The unnamed trials appear in the result with no attempts, so its aggregate is always `blocked` and the wrapper exits 1; read the named trials' outcomes.
4. The regression counts as caught only when the named trial's outcome is `fail`, or `inconclusive` with the target Must failing on every behavioural attempt. A `flaky-pass` (a fail followed by a pass) never counts as caught.
5. `evals/shepherd/validation/` is tracked: carry the run directory into the PR branch and commit it as evidence, like a full run's evidence, with its cost recorded in the result.

A validation run never continues another. A run that dies mid wave leaves `pending` attempts, and an attempt whose scorer failed twice stays `unscored`; neither is ever resolved or rescored, because the next run gets a fresh directory and there is no resume. Such a run is redone from scratch, at new cost, against the same budget.

The initial budget for baseline subjects, scoring and the targeted regression is $10. An undetected mutation, or running out of budget, leaves validation unmet; it does not authorize trying mutation after mutation. Removing reconcile wording is a candidate mutation, not a guaranteed detector. The CI verifier never reads `validation/`, so a validation result can never stand in for a full run's result.

## `--check` and `bun test`

`bun test` runs the unit tests and the Python self checks on handmade data only: no compiled Shepherd, no model and no real fixture clock. It runs on Linux CI, where zsh may be absent and its one check is skipped.

`bun run evals:shepherd --check` compiles a scratch subject, runs the shell syntax checks, `python3 -I evals/shepherd/check-harness.py --config ...` including real fixture shapes through the scratch binary's maintenance tools and session shell resolution, and `check-musts.py`. Its session launches are fakes with a stub `claude` first on `PATH`. It keeps the fixture time of day refusals, so run it before 23:40.

## The CI check

The `shepherd-evals (informational)` job in `.github/workflows/ci.yml` runs on every pull request to `main` or `master`. It checks out the PR head commit (not GitHub's synthetic merge) with full history, installs Bun (`bun-version: latest`, as the existing build job does) and Python 3, installs dependencies with `--ignore-scripts` so no PR script runs before the tree is hashed, holds only read permission, runs no model and needs no credentials. The `build` job runs typecheck, Biome and `bun test`.

The check is informational: it never fails a pull request for a missing result or for a result's outcome. It fails only on a committed result that does not verify, or when it cannot decide. Its outcomes:

| Situation | Job | Prints |
|---|---|---|
| No gated path changed | succeeds | "Shepherd evals not required" and the compared revisions |
| A gated path changed, no result for the head's source hash | succeeds | a notice naming the source hash, the expected result file and the newest committed result |
| A result for the head's source hash verifies | succeeds, whatever its outcome | the outcome (`pass`, `flaky-pass` or `blocked`), each trial's outcome and each attempt's Musts |
| A result for the head's source hash records another evaluation identity (stale) and its record checks cleanly | succeeds | a notice that it is out of date and was not verified, naming the identity it records and the one the tree computes, and its recorded outcome, or that this tree's schema cannot read it |
| A result for the head's source hash does not verify, stale or not | fails | every problem found |
| A revision, merge base, diff or checkout problem, or a tree whose identities cannot be computed | fails closed | the reason |

The outcome line and its details also go to the job summary (`$GITHUB_STEP_SUMMARY`), and the missing and stale notices are also GitHub notice annotations. Strings taken from a record or a path name are printed with control characters escaped (a newline reads `\n`), the job summary's code fence is longer than any backtick run inside it (an error that stops the check is reported under a fixed headline, with its message, which may name a recorded path, inside the fence), and under Actions the printed lines run between `::stop-commands::` and a random token, so nothing a record or a PR's file names hold is read as a workflow command; the notice is printed after the token.

The newest committed result is, among the result files under `evals/shepherd/results/` present at the checked-out head, the one with the latest commit time over the commits reachable from the head that added or changed it; ties go to the first in `git log --topo-order`. A merge does not count as touching the files it brings in, so a branch's older result merged late does not become the newest, as it would in topological order, which lists a merged branch's commits first. Commit times are what the commits say, which is enough for a notice. The notice gives its revision (its last invocation's build revision) and its recorded outcome, read from the committed file and not verified against the head; a file that does not read as a result is named as such.

1. **Changed paths.** `verify.ts` resolves the PR base and head, takes their merge base, and lists changed paths with a NUL delimited `git diff --no-renames`, so deletions and both sides of renames appear. A revision that does not resolve, a missing merge base, a failed diff or a checkout that is not the PR head fails closed.
2. **Gated paths.** The adopted policy (`evals/shepherd/gated-paths.ts`, section 11.1 as built) is the expanded one: every Shepherd source path above plus the evaluation implementation and policy, exactly the evaluation identity's files. The agreed narrower candidate, `system-prompts/shepherd/**`, `agents/shepherd.ts` and `lib/shepherd/**`, stays in the same file as the alternative. It leaves the declaration `agents/shepherd.md`, the shared runner `lib/agent-format/`, the compiler scripts, `package.json`, `bun.lock` and the rubric, policy and checkers ungated, so changes there would get no report. The expanded policy leaves tests beside the sources, docs, results, evidence and validation output ungated; the narrower one gates tests under `lib/shepherd/`.
   Four files are gated whatever the predicates say: `evals/shepherd/gated-paths.ts`, `evals/shepherd/identity.ts`, `evals/shepherd/verify.ts` and `scripts/shepherd-source.ts` (`ALWAYS_GATED` in `verify.ts`), so a broken predicate cannot exempt its own change.
3. **Outside gated paths** the job succeeds with "Shepherd evals not required" and the compared revisions. A pull request that commits only results and evidence is in this case, so the check does not verify it; verify it locally as "When to run the suite" shows.
4. **Verification.** Otherwise it recomputes the source manifest and evaluation identity of the checked-out head and opens only `results/<source-hash>.json`; when that file is absent the job succeeds with the notice above. A stale result, one whose recorded evaluation identity is not the tree's, is described under "Stale results" below. A present file with the tree's identity must verify: a schema valid result, a manifest equal to the head's on path and content SHA-256 (an entry evaluated untracked and committed since compares equal and is reported; an evaluated entry absent at head fails), the tree's rubric hash, policy and scorer, version output matching each build record, a clean frozen-input recheck for every run that recorded a non-void attempt, in-session markers for the evaluated binary and no other (for an attempt resolved from its log after an interrupted invocation, found again in its archived `claude.jsonl` under the policy model, as the wrapper found them), the fixed subject and scorer models, every listed artifact present as a regular file in exactly `artifacts/<source-hash>/<run-id>/<trial>/attempt-<n>/` (one directory per attempt) with its recorded length and SHA-256, a scored packet hash equal to the archived packet's, validity, void reasons and binary evidence consistent with the archived `claude-run.json` when its harness finished (no void attempt recorded valid; no valid session voided when its evidence checks cleanly, unless its void reason records a local checker failure, `mechanical checks failed: ...`; and no session log archived without `claude-run.json` except on an attempt resolved after an interrupted invocation; a `claude-run.json` whose harness never finished only on such an attempt), a subject on every non-void attempt, for every valid session a subject argv requesting the policy model and effort, equal to the argv of its archived `claude-run.json` when that finished, each recorded marker call id's tool result holding the evaluated binary's path (raw, or JSON-escaped at any depth the harness decodes) in the archived `claude.jsonl`, and the log's user and assistant models equal to the recorded ones, judged outcomes re-derived from the archived scorer outputs (every invocation's output archived as `scorer-<n>-r<round>.json`, each read as the wrapper read it against the archived packet, whatever the record says ended its process, and agreeing with its record on failure or verdict, models, cost and session, and every scored Must exactly the decision its verdict gives), mechanical checks recomputed by the tree's `must-check.py` (with a fresh bytecode cache) on a temporary copy of only the listed, hash-verified artifacts and equal to the recorded outcomes, permitted attempts, exactly six trials and thirteen Musts, and a recorded aggregate equal to the one derived from the trials. A result that verifies is reported with its derived outcome; `blocked` is reported, not failed. Revision, `dirty` and `sourceDirty` are printed as provenance, not conditions, and so are the Bun version, platform, architecture, binary hash, timestamps and CLI versions, which no evidence binds: they are reported as recorded. The build revision need not be in history, and a macOS binary hash is never compared with a Linux rebuild.

**Stale results (not yet settled).** A pull request that changes only the evaluation implementation (the rubric, policy, harness, checkers, scorer prompt, verifier or their tests) keeps the source hash, so the result for that source is found but records an older evaluation identity. Since the suite runs on demand, such a pull request should not have to pay for a live run, and an honest result that is out of date is not a broken record: the job succeeds with a notice that the result is out of date and was not verified, naming the identity it records, the one the tree computes, and its recorded outcome. The record's own integrity is still checked, and a failure there fails the job: its schema and derived outcomes, the source manifest against the head, each build's version line, the recheck and void flags, the artifact directories, and every listed artifact's presence, length and SHA-256. The checks that need this tree's evaluation implementation do not run: the rubric, policy and scorer against the tree's, the subject and scorer policy (the requested models, effort and argv, which the record's own policy could decide but are skipped too), the archived session's validity and markers, the scorer outputs re-read, and the mechanical checks recomputed.

A stale result this tree's schema cannot read, because the schema version, a Must id, the trials or a rule changed since it was written, is still out of date rather than broken: when it records a well formed evaluation identity other than the tree's, the notice says this tree's schema cannot read it and names both identities, without an outcome. Only what needs no schema is checked, from the raw JSON: the recorded source hash is the tree's, and every attempt's evidence, whose run, trial, ordinal, directory and artifact entries must be readable, sits in exactly `artifacts/<source-hash>/<run-id>/<trial>/attempt-<n>/`, one directory per attempt, with each listed artifact present with its recorded length and SHA-256; a record in which no attempt lists an artifact has no evidence to check and fails. A result with the tree's identity that fails the schema still fails the job.

So a record whose broken parts only the skipped checks would see passes as stale: a hand-edited judged verdict, a subject argv requesting another model, or any edit that breaks the schema of a stale record, a forged aggregate for instance, since the schema is then not applied; so does a broken record whose recorded identity was edited to look stale. That is acceptable because the check gates nothing, and it is a choice that is not yet settled: the alternative is to fail stale results, which makes every such pull request rerun the suite or remove the result.

**What a result means.** A verified result is an attestation, not cryptographic protection against a malicious PR author. The job, the verifier and the path policy all run from the PR head, so a PR that edits them, or that edits the record together with what checks it, can make its own result verify. Edits to the record alone are caught only where evidence binds the edited field: provenance that no evidence binds (Bun version, platform, architecture, binary hash, timestamps, CLI versions) is reported as recorded, and a hand edit to it verifies. No verifier running from the PR head can tell such edits apart, and `ALWAYS_GATED` guards only honest mistakes. `.github/workflows/ci.yml` and `.gitattributes` are not gated (the smaller reading of 7.3): a PR can change the job itself, and a PR that changes only `.gitattributes` gets "Shepherd evals not required", although it can change checked-out bytes; the change surfaces only at the next gated PR, or as a mismatch between a local result's hash and CI's. Code review of results, evidence and the evaluation implementation is what stands behind a result. A missing result means only that nobody has run the suite for that source; it says nothing about the change.

## Limits

- Single turn, synthetic Claude sessions only: no Codex subjects, no multi turn trials, no B, C, F1, F2 or I.
- One sample per trial and identity; no variance sampling.
- No delegates are executed, and there is no new coverage of handoff ceilings or delegate budgets.
- No production workspace coverage.
- No enforced host read isolation: subjects can read anything the user can.
- The user's Claude settings, hooks and plugins and `~/.zshrc` reach subject sessions, as described above.

## Open choices, as built

1. **Gated paths.** Built: the expanded set, with the narrower candidate and its gaps documented above.
2. **Scorer family.** Built: Claude Opus 5.5, effort high. Cross family Codex scoring needs a PR decision, a revised configuration and validation budget.
3. **Flake policy.** Built: one recorded behavioural rerun, with a complete second attempt pass accepted as `flaky-pass`. The alternative is that any first behavioural failure blocks. Infrastructure handling stays separate.
4. **E ordering.** Built: completed sequential placement before acceptance within one command counts, regardless of the final exit code; unorderable writes are inconclusive.
5. **Charter Done line.** None per change: evals run on demand, so no change needs a result before it is done. A charter may instead say how often to run the suite at main, for example after a behavioural change to Shepherd merges; that is forge's to decide, not edited here.
6. **Evidence committed per run.** Built: archived evidence per attempt, about 2 MB of native logs per six trial suite plus supporting files, under the export redaction rule. This is an addition to the original result and summary plan, for confirmation.
7. **Self-certification.** The job, verifier and policy run from the PR head, so a result is an attestation that code review stands behind (see "What a result means").
8. **Remaining recommendations.** The source membership, dirty build treatment, execution bounds, the initial $10 validation budget and the eleven plus two count correction, all described above.
