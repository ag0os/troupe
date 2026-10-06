# Guide: tool traps (Claude Code 2.1, Codex CLI 0.159, as of 2026-10-06)

Each tool's own help is the authority on syntax; these are the traps it does not mention. Herdr's are in the Herdr module of your prompt. A root workspace's `shared/tools.md` adds what its machine and accounts taught.

## Claude Code delegates

- Name a session at launch (`claude -n <name>`, or `shepherd -n <name>`); `/rename <name>` names one that is already running. Read the name back; record the name the host reports.
- `--permission-mode acceptEdits` still blocks on read-only Bash that uses shell expansion. For investigation, start in auto mode, or answer the first prompt with the option that switches to it.
- Delegates add their harness's attribution trailer to commits by default. If the workspace forbids it, say so in the brief.
- `/effort <level>` inside a session also saves that level as the default for every new session on that model. For one session only, pass `--effort <level>` at launch.
- A delegate started inside a repo gets a read prompt for files outside its cwd, a workspace's `.shepherd/` for example. Start it with `--add-dir <dir>`, or have it read with `cat`.
- Shell functions and aliases from the user's rc file are not visible to an agent's non-interactive shell; run them with `zsh -ic '<command>'`, and never run one that rewrites shared state such as the ssh agent.
- A resumed or forked session keeps the system prompt of its first launch until the conversation is compacted, so a changed header does not reach it.
- Claude Code keys its auto-memory by launch directory (`~/.claude/projects/<path-slug>/memory/`). Moving a workspace orphans what was written under the old path: move what still matters into `.shepherd/memories/` first.

## Codex CLI

- Pass the model and the effort on every launch (`codex --model <model> -c model_reasoning_effort=<effort>`, the same for `codex exec`); an interactive Codex may ignore its config default. Confirm them in the status bar before prompting.
- The system prompt: `-c developer_instructions=<json string>` appends to the harness prompt; `-c model_instructions_file=<path>` replaces it; `base_instructions` is ignored. `codex debug prompt-input -c ...` shows what reaches the model without a model call.
- Naming: `/rename <name>` ignores its argument on 0.159 and auto-titles the thread. Send `/rename` alone, clear the prefilled title, type the name, Enter. Resume with `codex resume <name>`. One-shot `codex exec` sessions cannot be renamed.
- Unattended runs: there is no `--full-auto`; use `-s workspace-write -a never`. Reaching local services (a database in Docker) needs `-s danger-full-access`; the write sandbox makes them look unavailable.
- `codex exec` needs `</dev/null`, rejects `-a`, forces approval to never, and refuses an untrusted non-git directory without `--skip-git-repo-check`. In a git repository it silently adds a trust entry to `config.toml`: run experiments in a scratch directory and say what changed.
- One Codex home per account (`CODEX_HOME=<dir>`), each logged in where Codex refreshes it; a copied `auth.json` goes stale when the refresh token rotates.
- Its agent messaging reaches only its own subagents, not peer sessions.
- After a version bump, the first launch offers an update with "Update now" highlighted; anything that reads as Enter upgrades it.
- Its context is smaller than Claude's: brief it tightly, and expect minutes per turn at high effort.

## Shell

- `while pgrep -f "<pattern>"` matches its own command line and never exits. Wait on the pid: `while kill -0 <pid>; do sleep 30; done`.
- Before removing files from a gitignored directory, check `git ls-files <dir>/`: a file committed before the ignore rule is still tracked, and removing it stages a deletion.
- On a shared database, cap every query (`SET SESSION MAX_EXECUTION_TIME=10000`) and use plain `EXPLAIN`; never execute the query under investigation.
- Take timestamps from `date`; a model's sense of the time is a guess.
