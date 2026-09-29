# Backend capability matrix: Claude Code 2.1.282 vs Codex 0.156.1

Date: 2026-09-24. Scratch: `/private/tmp/backend-matrix` (probe scripts, mock server, captured requests).

**How Codex was verified.** The Codex account hit its usage limit at the first live call ("You've hit your
usage limit ... try again at Sep 30th, 2026 10:29 AM"), so every Codex behaviour below was verified
against a local mock of the Responses API. It is selected per invocation with
`-c 'model_providers.mock={name="mock",base_url="http://127.0.0.1:8787/v1",wire_api="responses",requires_openai_auth=false}' -c model_provider="mock"`.
The mock logs every request body and can script one tool call. The captured request is ground truth
for what reaches the model: `instructions` (the system prompt), `input[]` (developer and user
messages), `tools`, and `reasoning.effort`. This is stronger evidence than a canary echo, because it
shows *where* the text lands. Claude was verified live with `--model haiku` canary prompts.

Legend: **V** = verified by running it (evidence quoted below). **D** = doc-only (help text, binary
strings, or docs). "Leaks" = picked up from the user's global state unless suppressed.

## 1. One-page matrix

| # | Concern | Claude Code | Codex |
|---|---|---|---|
| 1a | System prompt, replace | `--system-prompt <text>` / `--system-prompt-file <path>` **V** | `-c model_instructions_file="<path>"` **V** (or inline `-c instructions=<toml str>` **V**; file wins). Replaces the whole 21k-char Codex harness prompt |
| 1b | System prompt, append | `--append-system-prompt <text>` / `--append-system-prompt-file <path>` **V** | `-c developer_instructions=<toml str>` **V** (first developer message; base prompt kept) |
| 1c | Dead keys | n/a | `base_instructions`, `experimental_instructions_file` are **ignored with a warning** **V** |
| 2a | Interactive + first message | `claude [flags] -- "<prompt>"` **D** (TUI blocked by trust dialog in untrusted dir **V**) | `codex [flags] "<prompt>"`; auto-submitted **V** |
| 2b | One-shot | `claude -p ... -- "<prompt>"` **V** | `codex exec ... "<prompt>"` (stdin `</dev/null` or it waits) **V** |
| 3 | Model / effort | `--model`, `--effort low..max` **V**; `--fallback-model` **D** | `-m/--model` **V**; effort only `-c model_reasoning_effort="minimal|low|medium|high"` **V** (no flag) |
| 4a | Tool allow/deny | `--allowedTools`, `--disallowedTools`, `--tools`, `--settings '{"permissions":{...}}'` **V** | No per-invocation equivalent. Exec-policy `prefix_rule` files only from `~/.codex/rules` or trusted `.codex/rules` **V**; MCP `enabled_tools/disabled_tools` **D**; `--disable <feature>` **D** |
| 4b | Approval | `--permission-mode <mode>` **D**, `--permission-prompts none` **V** | Interactive `-a on-request|never` **D**; exec rejects `-a` **V** and forces `never` for escalations **V** |
| 4c | Sandbox | none (permission rules only) | `-s read-only|workspace-write|danger-full-access` **V**, `--add-dir` **V** |
| 4d | Skip all | `--dangerously-skip-permissions` **D** | `--dangerously-bypass-approvals-and-sandbox` **D** (probe blocked by my own safety classifier) |
| 5a | MCP stdio, per run | `--mcp-config '<json>'` (+ `--strict-mcp-config`) **V** | `-c 'mcp_servers.<n>={command=...,args=[...],env={...}}'` **V** (tools are deferred behind `tool_search`) |
| 5b | MCP http, per run | `{"type":"http","url":...,"headers":{...}}` **V** | `-c 'mcp_servers.<n>={url="...",http_headers={...}}'` **V** |
| 6 | Hooks, per run | `--settings '{"hooks":{...}}'` **V** | `-c 'hooks.<Event>=[...]'` **plus** `--dangerously-bypass-hook-trust` **V** (silently skipped without it **V**) |
| 7a | Settings overlay | `--settings <file-or-json>` **V**; `--setting-sources` **V** | `-c key=value` (any key) **V**; `-p/--profile <name>` = `$CODEX_HOME/<name>.config.toml` only **V** |
| 7b | Isolation | `--setting-sources ""` **V**, `--strict-mcp-config` **V**, `--bare` (API key only **V**), `--safe-mode` **D** | `exec --ignore-user-config` **V** (exec only **V**); `CODEX_HOME=<dir>` **V** (loses auth) |
| 8a | Reads | CLAUDE.md root→cwd; AGENTS.md **only when that dir has no CLAUDE.md** **V** | AGENTS.md (+ `AGENTS.override.md`) from git root→cwd **V**; CLAUDE.md only via `project_doc_fallback_filenames` **V** |
| 8b | Inject w/o writing project | `--append-system-prompt-file`, or `--add-dir <dir>` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` **V** | `developer_instructions` / `model_instructions_file` **V**; no "extra AGENTS.md path" (absolute fallback path ignored **V**) |
| 9a | Extra dirs / cwd | `--add-dir` **V**; cwd = spawn cwd | `--add-dir` (writable) **V**; `-C/--cd` **D** |
| 9b | Non-git / untrusted | `-p` skips trust dialog **D**; interactive shows trust dialog **V** | `exec` refuses non-git untrusted dirs unless `--skip-git-repo-check` **V**; `-c projects.<p>.trust_level` does **not** count **V** |
| 10a | Session id / name | `--session-id <uuid>` **V**, `-n/--name` **V** | No preset id or name flag. Read `thread_id` from `--json` **V**; resume accepts id or name **D** |
| 10b | Resume | `-r <id>` / `-c`, `--fork-session` **V/D** | `codex exec resume <id> "<prompt>"` **V**; `codex resume`, `codex fork` **D** |
| 10c | Output | `--output-format text|json|stream-json`, `--json-schema` **V** | `--json` (JSONL events) **V**, `-o <file>` **V**, `--output-schema <file>` **V** |
| 10d | Limits | `--max-turns` (hidden from help) **V**, `--max-budget-usd` **D** | none |
| 11 | Skills / subagents | `--agents '<json>'` **V**, `--agent`, `--plugin-dir`, `.claude/skills|commands|agents` **D** | `.codex/skills`, `.agents/skills` (project) **V**; `-c 'agents.<role>={description,config_file}'` **V**; plugins **D** |

## 2. Details and evidence

### 2.1 System prompt (priority)

**Codex: why the current runtime is broken.** `lib/runtime/codex-cli.ts:423` emits
`--config base_instructions=<text>`. Codex 0.156.1 no longer has that key. It prints a warning and
drops it, **V**:

```
warning: Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.
  session-flags: `base_instructions` is ignored.
```

Same for `experimental_instructions_file` **V**. The key list in the binary's `ConfigToml` confirms
what does exist: `...notify instructions developer_instructions include_permissions_instructions
include_apps_instructions include_collaboration_mode_instructions include_environment_context
model_instructions_file compact_prompt ... project_doc_max_bytes project_doc_fallback_filenames ...`
(from `strings` on `/opt/homebrew/Caskroom/codex/0.156.1/bin/codex`).

**Codex: what works (all V, from captured request bodies)**

| Invocation | Captured request |
|---|---|
| default | `instructions` = `"You are Codex, a coding agent based on GPT-5. ..."`, 21299 chars |
| `-c 'instructions="INSTR-2222"'` | `instructions` = `"INSTR-2222"` (len 10). The base prompt is **replaced** |
| `-c model_instructions_file="/…/instr.md"` | `instructions` = `"FILE-7731 canary"`. **Replaced** |
| both of the above | `instructions` = file content. **`model_instructions_file` wins** |
| `-c 'developer_instructions="DEV-3333"'` | `instructions` = default; `input[0]` = developer message whose first part is `"DEV-3333"`. **Append-like** |
| `developer_instructions` + `model_instructions_file` | both applied (replaced base + developer message) |

- Interactive TUI (driven in a PTY): with `model_instructions_file`, `developer_instructions` and
  `model_reasoning_effort="low"`, the main-turn request had
  `{"instr":"TUI-FILE-7801","dev0":"TUI-DEV-7802","last":"TUI-FIRST-PROMPT-7803","effort":"low"}` **V**.
  The title-generation side request also used the replaced instructions.
- Quoting **V**: `-c "developer_instructions=$(JSON.stringify(text))"` round-trips exactly, including
  quotes, backslashes, tabs, newlines, lines that look like TOML (`Line2 = true`, `[section]`) and
  Unicode. Raw unquoted text also round-trips, *unless the whole value parses as TOML*:
  `-c instructions=true` aborts with `Error loading config.toml: invalid type: boolean `true`, expected a string`.
  So a launcher should always emit `JSON.stringify(text)` (JSON escapes are valid TOML basic strings).
- Resume pins instructions **V**. A thread started with `model_instructions_file=ra.md` and
  `developer_instructions="DEVA-5603"` kept both on `exec resume` without flags. Resuming with
  `-c model_instructions_file=rb.md` still sent `RESUME-A-5601`, so a new file is silently ignored.
- Caveat: "replace" throws away Codex's harness prompt (tool usage, apply_patch conventions, 21k
  chars). The closest match to Claude's default `--append-system-prompt` is `developer_instructions`.
  The closest match to `--system-prompt` is `model_instructions_file`.
- There is no `developer_instructions_file`, so developer text goes on argv. That is fine up to
  macOS ARG_MAX (about 1 MB).
- No need for AGENTS.md in the cwd (the reverted 5abfa01 approach). It still works, but it collides
  with Claude reading AGENTS.md (see 2.8).

**Claude (all V, haiku, prompt "list every WORD-NNNN phrase in your system prompt")**

| Flags | Reply |
|---|---|
| `--system-prompt "Canary: SYS-8001"` | `SYS-8001` |
| `--append-system-prompt "Canary: APP-8002"` | `APP-8002` |
| `--system-prompt-file sp.md` | `FILESYS-8101` |
| `--append-system-prompt-file ap.md` | `FILEAPP-8102` |
| `--system-prompt … --append-system-prompt …` | `SYS-8001, APP-8002` |

The `*-file` variants are not listed in `claude --help`, but `--bare` help names them
("Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file]") and they
work. With `--system-prompt`, CLAUDE.md is still injected (the `sysprompt` run in 2.8 reported
`ROOTCLAUDE-8200, SUBCLAUDE-8201`). `--system-prompt-snapshot on` (the default) pins the prompt
to the conversation on resume **D** (help text).

### 2.2 Initial prompt

- Claude one-shot **V**: `claude -p [flags] -- "<prompt>"`. The `--` matters because `--mcp-config`,
  `--allowedTools` etc. are variadic (the current runtime already does this).
- Claude interactive **D** for the first message (`claude [prompt]`, "starts an interactive session
  by default"). In an untrusted dir the TUI first shows **V**: "Accessing workspace:
  /private/tmp/backend-matrix/cc5 Quick safety check: Is this a project you created or one you
  trust? ... ❯ No, exit / Yes, I trust this folder". Accepting would write to `~/.claude.json`, so
  the run stopped there.
- Codex one-shot **V**: `codex exec [flags] "<prompt>"`. It prints `Reading additional input from stdin...` and
  blocks if stdin is an open pipe. Use `stdin: "ignore"` / `</dev/null` (the runtime already does).
  Progress and header go to stderr and the final message to stdout. `exec` without a prompt reads stdin.
- Codex interactive **V**: `codex [flags] "<prompt>"` auto-submits it (captured `last:"TUI-FIRST-PROMPT-7803"`).
  First-run popups can block it: a model upsell ("Meet GPT-6 Sol ... 1. Try new model 2. Use existing
  model") appeared and needed a keypress, and dismissing it **wrote to `~/.codex/config.toml`** (see §4).

### 2.3 Model and effort

- Claude: `--model haiku --effort low` accepted **V**. The JSON result reported
  `"model":["claude-haiku-4-5-20251001"]`. Env: `ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`,
  `CLAUDE_CODE_SUBAGENT_MODEL` (strings in the binary) **D**.
- Codex: `-m gpt-5.5` gives request `"model":"gpt-5.5"` **V**. `-c model_reasoning_effort="low"` gives
  `"reasoning":{"effort":"low"}` **V** (also `"minimal"` **V**). There is no `--effort` flag. Other keys **D**:
  `plan_mode_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `service_tier`.
- Leak: the Codex user config supplies model, effort, `service_tier = "fast"` (request showed
  `"service_tier":"priority"`) and `personality` unless overridden. During this session the user's
  global `model_reasoning_effort` changed from `medium` to `high` (not by these probes), and every
  later probe inherited it. Launchers should pin model and effort explicitly on both backends.

### 2.4 Permissions

**Claude (V, haiku asked to run `touch probe.txt`)**

| Flags | Result |
|---|---|
| `--allowedTools Bash --disallowedTools "Bash(touch *)"` | "Permission to use Bash with command touch probe.txt has been denied." |
| `--allowedTools Bash --settings '{"permissions":{"deny":["Bash(touch *)"]}}'` | same denial |
| `--permission-prompts none` (no allow) | "It requires approval, and this session has no approval surface ... so it was denied automatically." |
| `--tools "Read,Glob"` | built-ins limited to Glob, Read, but user and claude.ai MCP tools still listed |
| `--tools Read --strict-mcp-config` | `Read` only |

**Codex (V, mock scripts an `exec_command` call; the result is the `function_call_output` Codex sent back)**

| Flags | function_call_output |
|---|---|
| `-s workspace-write`, `touch inside.txt` | `Process exited with code 0 ... WROTE` |
| `-s read-only`, same | `touch: inside2.txt: Operation not permitted` |
| `-s workspace-write` + `exclude_slash_tmp`/`exclude_tmpdir_env_var`, write to `../extra` | `Operation not permitted` |
| same + `--add-dir /private/tmp/backend-matrix/extra` | `WROTE` |
| `.codex/rules/deny.rules`: `prefix_rule(pattern=["echo","RULE"], decision="forbidden")`, trusted repo | `rejected: policy forbids commands starting with `echo RULE`` |
| same + `--ignore-rules` | `RULE hit` (ran) |
| `require_escalated` call, `-c approval_policy="never"` | `approval policy is Never; reject command — you cannot ask for escalated permissions if the approval policy is Never` |
| `require_escalated`, `-c approval_policy="on-request" -c approvals_reviewer="user"` | **same rejection**. `exec` coerces approval to never |
| `codex exec -a never` | `error: unexpected argument '-a' found` (only the TUI has `-a`) |

- Rules are loaded from `~/.codex/rules/*.rules` (the user has `default.rules` with allow rules for
  `git add`, `git commit`, `cp`, ... that **leak** into every run) and from a trusted project's
  `.codex/rules/`. There is **no per-invocation rules flag**. `codex execpolicy check --rules <PATH>`
  only evaluates a file offline. Decisions are `allow` / `prompt` / `forbidden`, and matching is by
  argv prefix. This is the only Codex analogue of `Bash(cmd *)`.
- Nothing in Codex matches Claude's `Read(...)`, `Edit(...)`, `Write(...)`, `WebFetch(domain:...)` or per-MCP-tool
  rules, except coarse controls **D**: sandbox mode + `--add-dir` for file writes,
  `mcp_servers.<n>.enabled_tools|disabled_tools`, `tools.web_search` / `--search`, `--disable <feature>`.
- `--approve-for-me` routes approvals to automatic review **D**. The user config sets
  `approvals_reviewer = "guardian_subagent"` (leaks), which sends escalations to a model reviewer.
- Correction to `codex-cli.ts`: the comment "Exec mode defaults to approval_policy=never, so
  skipPermissions is a no-op" is only half true. Approval is forced to never, but the **sandbox still
  applies** (user default `workspace-write`), so `skipPermissions` in exec is not a no-op.
- Mapping Claude rules onto Codex: `Bash(<prefix> *)` allow/deny maps to a `.rules` file (only if the
  launcher may write to the project, or via a trusted `CODEX_HOME`). Everything else goes to
  sandbox mode plus prose in `developer_instructions`, or an enforcing hook (2.6).

### 2.5 MCP servers per invocation

- Claude stdio **V**: `--strict-mcp-config --mcp-config '{"mcpServers":{"canary":{"command":"<bun>","args":["run","mcp-canary.ts"],"env":{"CANARY_ENV":"claude-inline"}}}}'`.
  Server log: `claude-inline initialize / notifications/initialized / tools/list / tools/call`.
  Reply: `MCP-CANARY-9001 env=claude-inline`.
- Claude http **V**: `{"type":"http","url":"http://127.0.0.1:8787/mcp","headers":{"X-Forge-Probe":"claude"}}`.
  Log: `claude server/discover, initialize, ..., tools/call`. Reply `HTTP-MCP-CANARY-9002`.
- Codex stdio **V**: `-c 'mcp_servers.canary={command="<bun>", args=["run","…/mcp-canary.ts"], env={CANARY_ENV="codex-inline"}}'`.
  Log: `codex-inline initialize / notifications/initialized / tools/list`.
- Codex http **V**: `-c 'mcp_servers.httpcanary={url="http://127.0.0.1:8787/mcp", http_headers={X-Forge-Probe="codex"}}'`.
  Log: `codex initialize / notifications/initialized / tools/list`.
- Codex exposes MCP tools **deferred**. They are not in the request `tools` array (only a `tool_search`
  tool is), and a direct `mcp__canary__get_canary` call gave `unsupported call`. The feature flag
  `tool_search_always_defer_mcp_tools` is `removed ... true`, so this cannot be turned off. The model
  must `tool_search` first. With a real model that is transparent. The end-to-end call path on Codex
  is therefore **not** exercised; the spawn, env and listing are.
- Leak: Codex always merges `~/.codex/config.toml` `[mcp_servers.*]` (context7, node_repl) unless
  `exec --ignore-user-config` is used. Claude merges user, project and claude.ai connector servers
  unless `--strict-mcp-config` is used (verified by the tool listing above).
- Runtime gap: `buildMcpArgs` in `codex-cli.ts` only translates `command/args/env`. HTTP servers
  (`type/url/headers`) are dropped. Map them to `url` + `http_headers` (also **D**:
  `bearer_token_env_var`, `startup_timeout_sec`, `enabled`, `enabled_tools`, `disabled_tools`, `cwd`).

### 2.6 Hooks

- Claude **V**: `--settings '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"...; exit 2"}]}]}}'`
  fired (marker file written) and blocked: "The command was blocked by a hook: \"blocked by forge hook\"".
  Events **D**: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, SessionStart,
  SessionEnd, PreCompact, Notification, PermissionRequest. `CLAUDE_PROJECT_DIR` is set for hooks.
- Codex **V**: `-c 'hooks.PreToolUse=[{matcher="exec_command|Bash", hooks=[{type="command", command="...; exit 2"}]}]' --dangerously-bypass-hook-trust`
  gave `Command blocked by PreToolUse hook: blocked-by-forge-hook. Command: echo HOOKTEST`. The hook stdin
  was Claude-shaped: `{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"…","tool_input":{"command":"echo HOOKTEST"}}`.
- Without `--dangerously-bypass-hook-trust`, both the inline `-c hooks.*` hook and a project
  `.codex/hooks.json` were **silently skipped** (no warning; command ran) **V**. Trust is persisted as
  `[hooks.state."<file>:<event>:i:j"] trusted_hash = "sha256:..."` in the user config.
- Codex events (binary strings) **D**: PreToolUse, PermissionRequest, PostToolUse, PreCompact,
  PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt.
  Sources: `~/.codex/hooks.json` (the user has a SessionStart hook that **leaks**, seen as
  `hook: SessionStart` in every run), project `.codex/hooks.json`, `hooks` in config, plugins.
- Whether Codex PreToolUse covers `apply_patch` edits (not only shell) was not tested.

### 2.7 Settings overlays and leakage

- Claude `--settings <file-or-json>` **V** (inline JSON used for permissions and hooks above) layers on
  top of user, project and local settings. `--setting-sources ""` **V** also drops CLAUDE.md
  (canary run returned none). `--bare` **V** refuses OAuth: "Not logged in · Please run /login".
  `CLAUDE_CONFIG_DIR=<scratch>` **V** also loses login ("Not logged in"). `--safe-mode`, `--restricted` **D**.
- Codex `-c key=value` **V** can set any `ConfigToml` key (dotted paths, TOML values) and is the
  real overlay mechanism. A compiler can flatten a settings object into `-c` pairs.
- `-p/--profile <name>` **V** layers `$CODEX_HOME/<name>.config.toml` (tested with a scratch
  `CODEX_HOME`: `developer_instructions` from the profile reached the request). A missing profile is
  **silently ignored** **V**. Profiles cannot live outside `CODEX_HOME`, so a launcher cannot ship one
  without writing into `~/.codex`. Note that `-p` means profile on Codex and print on Claude.
- `codex exec --ignore-user-config` **V** drops config.toml (memories and plugins vanished from the
  request) but **still loads** the global `~/.codex/AGENTS.md` and user skills. Auth still works.
  The flag does not exist on interactive `codex` **V** (`error: unexpected argument '--ignore-user-config' found`),
  and neither do `--ephemeral`, `--json` or `--skip-git-repo-check`.
- `CODEX_HOME=<empty dir>` **V** removes global AGENTS.md, memory and plugins (only bundled system
  skills remained) but needs its own auth (the mock needed none). **D**: `CODEX_API_KEY` /
  `OPENAI_API_KEY` for API-key auth.
- What leaks into a default Codex run (V, from the captured request): the developer message
  carries `## Memory` (the full user memory summary from `~/.codex/memories`), `<skills_instructions>`,
  `<permissions instructions>`, `<apps_instructions>` and `<plugins_instructions>`. The user message carries
  `<recommended_plugins>`, `# AGENTS.md instructions` (global `~/.codex/AGENTS.md` + project chain) and
  `<environment_context>`. Tools include goals, `request_plugin_install`, `web_search`. The user
  config also forces `service_tier`, `personality`, approval reviewer, notify hook and SessionStart hook.

### 2.8 Project instruction files

- Claude **V** (tree `cc2/CLAUDE.md`, `cc2/sub/CLAUDE.md`, `cc2/sub/AGENTS.md`, run in `sub`): saw
  `ROOTCLAUDE-8200, SUBCLAUDE-8201`, **not** `SUBAGENTS-8202`. In a dir with only AGENTS.md
  (`cc3`) it saw `ONLYAGENTS-8301`. So Claude reads AGENTS.md as a per-directory fallback when there
  is no CLAUDE.md. That makes the old note in `work/todo/codex-system-prompt` ("Claude Code reads
  AGENTS.md too") only partly right.
- Claude injection without touching the project **V**: `--add-dir /…/ccextra` alone did *not* load
  `ccextra/CLAUDE.md`. With `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` it did (`EXTRACLAUDE-8203`).
  A launcher can keep a private dir with a CLAUDE.md and add it. Simpler: `--append-system-prompt-file`.
- Codex **V** (`exp2/AGENTS.md` + `exp2/sub/AGENTS.md`, git root `exp2`, run in `sub`): one user message
  `# AGENTS.md instructions for /…/exp2/sub` concatenating `ROOT-AGENTS-6001` then `SUB-AGENTS-6002`.
  `sub/AGENTS.override.md` replaced `sub/AGENTS.md` in that dir (`ROOT… OVERRIDE-6004`).
- Codex CLAUDE.md **V**: ignored by default. With `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'`
  it read `sub/CLAUDE.md` only when `sub` had no AGENTS.md.
- Suppression **V**: `-c project_doc_max_bytes=0` drops all project docs but keeps the global
  `~/.codex/AGENTS.md`. `-c 'project_root_markers=[]'` limits the walk to cwd only
  (`SUB-AGENTS-6002` only). No flag suppresses the global file except swapping `CODEX_HOME`.
- Codex injection without writing: `developer_instructions` / `model_instructions_file` (2.1). An
  absolute path in `project_doc_fallback_filenames` is **ignored** **V**, so there is no extra-doc path.

### 2.9 Extra dirs, cwd, non-git and untrusted

- Claude `--add-dir` **V** (tool access, CLAUDE.md only with the env var). cwd = process cwd (no
  `--cd`). `-p` skips the trust dialog (help: "The workspace trust dialog is skipped when Claude is run
  in non-interactive mode"). Interactive shows it **V**. Non-git dirs are fine.
- Codex `--add-dir` **V** (writable root), `-C/--cd` **D**, `--worktree` **D**.
- Codex non-git **V**: `codex exec` in a never-trusted non-git dir gives `Not inside a trusted directory and
  --skip-git-repo-check was not specified.` (exit 1). `-c 'projects."<dir>".trust_level="trusted"'`
  does **not** satisfy it (same error). `--skip-git-repo-check` works.
- Codex project `.codex/` (config.toml, rules, hooks, skills) needs a trusted project **V**. In a
  never-trusted dir, `codex debug prompt-input` showed the project AGENTS.md but not a
  `developer_instructions` set in `.codex/config.toml`. The `-c` trust override did not change that.
- Side effect **V (observed)**: after `codex exec` ran in git repos `exp1`, `exp2`, `exp3`, the user
  config gained `[projects."/private/tmp/backend-matrix/expN"] trust_level = "trusted"`. The non-git dir
  did not. So `exec` seems to auto-trust git repos it runs in. That means a launcher using
  `codex exec` in a git repo mutates `~/.codex/config.toml`, and that repo's `.codex/` is honoured from then on.

### 2.10 Sessions, output, env

- Claude **V**: `--session-id <uuid> -n forge-probe --output-format json --json-schema '{…}' --max-turns 2`
  gave `{"type":"result","subtype":"success","session_id":"897bb608-…","structured_output":{"word":"PINEAPPLE-4401"},"num_turns":2}`.
  `--resume 897bb608-…` then recalled `PINEAPPLE-4401` under the same session_id.
  `--no-session-persistence` (print only), `-c/--continue`, `--fork-session`, `--bg` **D**.
  `--max-turns` works although it is missing from `--help`.
- Codex **V**: `exec --json` emits JSONL:
  `{"type":"thread.started","thread_id":"01a0d577-…"}`, `turn.started`,
  `item.completed{item:{type:"agent_message",text}}`, `turn.completed{usage}`. `-o last.txt` holds
  the final message. `--output-schema schema.json` becomes request
  `text.format={type:"json_schema",strict:true,name:"codex_output_schema",…}`.
  `codex exec resume <thread_id> "SECOND"` sent `FIRST-TURN-5501 | SECOND-TURN-5502`.
  `--ephemeral` skips persistence (exec only).
- Codex cannot preset a session id or name from the CLI (no flag; `codex resume` accepts "Session
  id (UUID) or session name", so names are set elsewhere, e.g. in the TUI) **D**. For exec, read
  `thread_id` from `--json`. For interactive, fall back to `codex resume --last` or `~/.codex/session_index.jsonl` **D**.
- Env, Claude (binary strings, **D** unless noted): `CLAUDE_CONFIG_DIR` (V: isolates, loses auth),
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` (V), `CLAUDE_PROJECT_DIR`, `CLAUDE_ENV_FILE`,
  `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_MAX_TURNS`,
  `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_SIMPLE` (set by `--bare`), `CLAUDE_CODE_SAFE_MODE`,
  `CLAUDE_CODE_SESSION_NAME`, `CLAUDE_CODE_TMPDIR`, `CLAUDE_CODE_SHELL`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
  `ENABLE_CLAUDEAI_MCP_SERVERS`, `MAX_THINKING_TOKENS`, `DISABLE_AUTO_COMPACT`.
- Env, Codex (binary strings, **D** unless noted): `CODEX_HOME` (V), `CODEX_API_KEY`,
  `CODEX_ACCESS_TOKEN`, `CODEX_SQLITE_HOME`, `CODEX_CA_CERTIFICATE`, `CODEX_NON_INTERACTIVE`,
  `CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT`, `CODEX_MCP_PROTOCOL_VERSION`. The runtime also honours
  its own `CODEX_PATH` / `CLAUDE_PATH`.

### 2.11 Skills, subagents, commands

- Claude: inline subagents `--agents '{"canary-agent":{"description":…,"prompt":"…reply with exactly SUBAGENT-9301…","model":"haiku","tools":["Read"]}}'`
  **V**. The stream-json showed `"subagent_type":"canary-agent"` and `SUBAGENT-9301`. Also `--agent <name>`
  (main-thread agent), `--plugin-dir` (session-only plugin with skills, commands, agents, hooks, MCP),
  `.claude/{skills,commands,agents}`, `--disable-slash-commands` **D**.
- Codex skills **V**: project `.codex/skills/<n>/SKILL.md` and `.agents/skills/<n>/SKILL.md` were both
  listed (`r0 = …/exp3/.codex/skills`, `r9 = …/exp3/.agents/skills`, descriptions `SKILLPROBE-9401/9402`).
  User roots `~/.codex/skills` and `~/.agents/skills` leak. `skills.config` entries (path or name
  selectors) exist **D**.
- Codex subagent roles **V**: `-c 'agents.forgeprobe={description="ROLEPROBE-9501 probe role", config_file="/…/role.toml"}' --enable multi_agent_v2`.
  The request's `collaboration` tool described it as `ROLEPROBE-9501 probe role\n- This role's reasoning effort is set to `low``.
  `config_file` is a layered config for the role (its `model_reasoning_effort` showed up). There is also
  `nickname_candidates`. Codex has no custom slash commands in 0.156 (no `prompts` dir found in the binary) **D**.
  Plugins (`codex plugin`, `[plugins."x@market"]`) bundle skills, MCP and apps **D**.

## 3. Gaps and fallbacks

| Concern | Missing on | Closest fallback |
|---|---|---|
| Fine-grained tool allow/deny (`Read(...)`, `Edit(...)`, `WebFetch(domain:...)`, per-MCP-tool) | Codex | Sandbox mode + `--add-dir` for write scope; `mcp_servers.<n>.enabled_tools/disabled_tools` for MCP. For enforced deny lists, an inline PreToolUse hook with `--dangerously-bypass-hook-trust`: its payload is Claude-shaped (`tool_name:"Bash"`, `tool_input.command`), so one shared matcher script can enforce the same rules on both backends. Otherwise describe limits in `developer_instructions` (advisory only) |
| `Bash(prefix *)` rules per invocation | Codex | `.rules` files work only from `~/.codex/rules` or a trusted project `.codex/rules`. No flag. Use the hook fallback above, or a launcher-owned `CODEX_HOME` (needs auth there) |
| Approval prompts in one-shot | Codex exec | exec coerces approval to never. Choose sandbox up front; there is no "ask the host" channel like Claude's `--permission-prompts host` |
| Max turns / budget | Codex | None. Use an outer timeout, `--output-schema` to force a terminal answer, or kill on `turn.completed` count from `--json` |
| Hooks without trust ceremony | Codex | Requires `--dangerously-bypass-hook-trust` (per invocation) or persisted trust hashes in the user config. Without it, hooks are silently skipped |
| Settings file overlay | Codex | Flatten to `-c` pairs (every key is reachable). `--profile` only reads from `$CODEX_HOME` |
| Isolation from user config in interactive mode | Codex TUI | `--ignore-user-config` is exec only. Override the specific keys with `-c` (model, effort, approval, sandbox, reviewer, service_tier, `mcp_servers.<n>.enabled=false`). `CODEX_HOME` swap needs auth |
| Suppress global AGENTS.md / memories | Codex | Only a `CODEX_HOME` swap. `project_doc_max_bytes=0` does not cover the global file. Memories are gone with `--ignore-user-config` (exec) or per-key `-c features.memories=false` **D** |
| Suppress user MCP / skills | Codex | `--ignore-user-config` drops config MCP (exec). User skills in `~/.codex/skills` and `~/.agents/skills` still load |
| Isolation with OAuth | Claude | `--bare` and `CLAUDE_CONFIG_DIR` both lose OAuth login. Use `--setting-sources` + `--strict-mcp-config` + `--disable-slash-commands` instead |
| Extra project-doc path | Codex | None (absolute fallback filename ignored). Use `developer_instructions` |
| Extra doc dir | Claude | `--add-dir` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, or `--append-system-prompt-file` |
| Preset session id / name | Codex | Capture `thread_id` from `exec --json`. Interactive has no hook for it except `codex resume --last` or reading `session_index.jsonl` |
| Change instructions on resume | Codex (and Claude by default) | Codex pins instructions to the thread and ignores new ones. Start a new thread, or `codex fork` **D**. Claude: `--system-prompt-snapshot off` **D** |
| Direct MCP tool exposure | Codex | MCP tools always deferred behind `tool_search`. Mention the server and tool names in instructions so the model searches |
| Non-git dirs | Codex exec | `--skip-git-repo-check` (exec only). Interactive in an untrusted dir likely prompts **D** |
| System prompt that keeps harness guidance *and* replaces identity | Codex | `developer_instructions` (keeps base). `model_instructions_file` drops the 21k-char harness prompt entirely |
| Output `--output-format json` single result | Codex | `-o <file>` (last message) + `--json` stream |
| `--effort` flag | Codex | `-c model_reasoning_effort=...` (no `max`/`xhigh`; accepted values seen: minimal, low, medium, high) |

### Recommended mapping for the codex compiler (from the verified rows)

- system prompt, append: `-c developer_instructions=${JSON.stringify(text)}`
- system prompt, replace: write a temp file, then `-c model_instructions_file=${JSON.stringify(path)}`
- MCP: stdio `{command,args,env,cwd}` and http `{url,http_headers,bearer_token_env_var}` via `-c mcp_servers.<n>=`
- model / effort: `-m`, `-c model_reasoning_effort=`
- exec: always `</dev/null`, `--skip-git-repo-check` when not in a git repo, `-c approval_policy="never"` (explicit), `-s <mode>`
- interactive: `-a`, `-s`, positional prompt
- never emit `base_instructions` or `-a` on exec

## 4. Side effects of this investigation

- `~/.codex/config.toml` was modified by Codex itself, not by hand-editing:
  1. `[projects."/private/tmp/backend-matrix/exp1"]`, `exp2`, `exp3` with `trust_level = "trusted"`
     (apparently auto-added by `codex exec` in git repos).
  2. `[notice.model_migrations] "gpt-5.5" = "gpt-6-sol"` from dismissing the TUI model popup.

  I did not revert them, because other Codex sessions were writing the same file concurrently
  (`[projects."/Users/cosmos/Areas/Prep"]` appeared between my entries). The top-level `model` /
  `model_reasoning_effort` changes in that file came from elsewhere during the session. The probes
  pinned `model="gpt-5.5"` and never selected a model interactively.
- Session transcripts were written to `~/.codex/sessions` (non-ephemeral resume tests) and
  `~/.claude/projects/-private-tmp-backend-matrix-*` (Claude runs), as normal.
- No auth files were read or copied. Scratch `CODEX_HOME` and `CLAUDE_CONFIG_DIR` dirs contain no credentials.
