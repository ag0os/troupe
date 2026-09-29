# What the 23 agents actually use

Source: claude-forge `main` at 88332a5, read only. Claude Code 2.1.282. Paths are repo-relative.
Verified by experiment where marked (✔). Everything else is from reading the code.

## Shared plumbing (applies unless an agent says otherwise)

- **Launcher.** `spawnClaude` always runs the `claude` binary (`lib/claude.ts:106`). It inherits stdin
  (`:107`) and sets `CLAUDE_FORGE_DIR` plus a per-process `TMPDIR` (`lib/claude.ts:112-115`).
  The TMPDIR is a workaround for a file-watcher crash (`:77-82`). Only `shepherd` and `webfetch` go
  through `lib/runtime` instead.
- **Arg parsing.** `lib/flags.ts:26-37` parses `process.argv` once at import, with `strict:false`.
  It declares only `backend`, `print` and `cwd`. `buildClaudeFlags(defaults, user)` spreads user values over
  defaults (`:66-72`), so any launcher default can be overridden from the command line.
- **Mode.** Unless noted, the agent runs Claude interactively, with an optional initial positional
  prompt. The user can add `--print`, which is declared boolean in `lib/flags.ts:31`, so it passes
  through cleanly.

## Defects referenced below

| ID | Defect | Evidence |
|----|--------|----------|
| D1 | **assetsFor lookup misses.** The key is the importer's basename (`lib/assets.ts:11-17,40-43`), but the map keys are `diagram-all`, `webfetch` and so on (`lib/assets.gen.ts:40-57`). Under `bun run`, `agents/design/diagram/all.ts` looks up `all`. Compiled, it looks up `design:diagram:all`, because `import.meta.url` = `file:///$bunfs/root/design:diagram:all` ✔. | diagram ×3 get no system prompt and no settings. webfetch works under `bun run` but loses both in the binary. |
| D2 | **`--flag value` passthrough.** An undeclared option under `strict:false` becomes `true` and its value moves to the positionals. ✔ `--model opus "x"` → `{model:true}`, and the prompt becomes `"opus x"`. `-p` → `--p` → `claude: error: unknown option '--p'` ✔. `--model=opus` and `--print` work. | Every agent that uses the lib parser (20). |
| D3 | **Forge flags leak to claude.** Agents that pass `parsedArgs.values` raw skip `extractClaudeFlags` (`lib/flags.ts:54-60`). That forwards `--backend`, `--cwd` and the agent's own flags. Claude 2.1.282 rejects them: `error: unknown option '--quick'` ✔. | 15 agents fully affected. `orient --quick/--focus` and `pr --comment` are broken today. coach leaks only `--backend`. |
| D4 | **Wrong `CLAUDE_PROJECT_DIR`.** `resolvePath("../")` resolves against `import.meta.url`. That gives `<forge>/agents/` under `bun run` and `/$bunfs/` when compiled. Nothing in `settings/` or `system-prompts/` reads `CLAUDE_PROJECT_DIR` or `CLAUDE_FORGE_DIR` (rg: no hits). | 7 agents, harmless today. |
| D5 | **Dead chrome-devtools MCP.** The package `@anthropic-ai/mcp-chrome-devtools` returns 404 on npm ✔ (the real package is `chrome-devtools-mcp`), so the stdio server never starts. | builder, designer, refactor |

Abbreviations: **SP** = system prompt. **UP** = initial user prompt. **CPD** = `CLAUDE_PROJECT_DIR`.
"append" means `--append-system-prompt`.

## Per agent

**analyze:orient** (`agents/analyze/orient.ts`)
- **SP:** static `orient-prompt.md` (`:30`), append (`:157`).
- **UP:** built in code from `--quick` or `--focus` plus the positionals as "Additional context" (`:101-152`). Never empty.
- **Permissions and MCP:** none.
- **Settings:** `orient.settings.json` is passed (`:158`). It has a live `PostToolUse(Grep)` echo hook (`orient.settings.json:10-20`). Dead keys: `name`, `description`, `settings.model=claude-3-5-sonnet-latest`, `temperature`, `maxTokens`, `systemPromptMode` (`:2-9`).
- **CPD:** D4 (`:39,166`).
- **Launch logic:** second parseArgs for `-q/--quick`, `-f/--focus <enum>` and `-h/--help` (`:42-61`). Prints help. Exits 1 on an unknown focus (`:132-135`).
- **Claude-only text:** "CLAUDE.md" (`orient-prompt.md:31`), soft.
- **Mode:** interactive.
- **Defects:** D2 (`--focus tech` also adds "tech" to the prompt), D3 (`--quick` and `--focus` are rejected by claude), D4.

**build:builder**
- **SP:** static `builder-prompt.md`, append (`:24,35`).
- **UP:** positionals (`:29-41`).
- **Permissions:** `defaultMode:default`, allow 7 `mcp__chrome-devtools__*` (`builder.settings.json:3-12`).
- **MCP:** chrome-devtools, stdio `npx` (`builder.mcp.json`), passed (`:37`). Dead (D5).
- **Hooks:** UserPromptSubmit echo, live (`builder.settings.json:14-24`).
- **CPD:** cwd (`:45`).
- **Claude-only text:** `AskUserQuestion` (`builder-prompt.md:8,30,36,39,62,123`). Delegation via `Task` to `general-purpose`/`Explore` (`:9,37,43,108`).
- **Mode:** interactive.
- **Defects:** D2, D3 (`:39`), D5.

**build:comment-review**
- **SP:** static `comment-review-prompt.md`, append (`:15,65`).
- **UP:** built in code. Embeds `git diff <base>...HEAD` and `git diff --cached` (`:37-62`).
- **Permissions:** allow `Edit, Read, Glob, Grep` (`comment-review.settings.json:3`).
- **MCP:** none (no `--mcp-config`).
- **CPD:** cwd (`:71`).
- **Launch logic:** base branch detection main/master/origin (`:19-35`). Exits 0 with a message when the diff is empty (`:51-54`).
- **Claude-only text:** none.
- **Mode:** interactive.
- **Defects:** D2 only. It uses the stripped default parse (`:64`).

**build:refactor**
- **SP:** static `refactor-prompt.md`, append (`:26,44`).
- **UP:** positionals.
- **Permissions:** `defaultMode:default`, allow 7 chrome-devtools tools (`refactor.settings.json:3-11`).
- **MCP:** chrome-devtools, dead (D5).
- **Hooks:** none.
- **CPD:** D4 (`:35,54`).
- **Claude-only text:** persona "Claude Code — Refactorer" (`refactor-prompt.md:3`), cosmetic.
- **Defects:** D2, D3, D4, D5.

**build:tdd**
- **SP:** static `tdd-coordinator-prompt.md`, append (`:32,51`).
- **UP:** positionals (`:44-55`).
- **Permissions:** `defaultMode:default` only.
- **MCP:** `{}`, passed.
- **Hooks:** UserPromptSubmit echo, live. It has `matcher:"*"`, which UserPromptSubmit does not use (`tdd-coordinator.settings.json:6-18`).
- **Dead settings key:** `systemPromptFiles` (`:5`).
- **CPD:** D4 (`:41,59`).
- **Claude-only text:** delegate "via the Task tool" (`prompt:45`), plus `general-purpose` and `rails-dev-plugin:*` agents (`:111-122`). "CLAUDE.md" (`:130`).
- **Defects:** D2, D4.

**design:architect**
- **SP:** static `design-architect.md`, append (`:23,43`).
- **UP:** positionals.
- **Permissions:** allow `WebSearch, WebFetch` (`:27-32`).
- **MCP:** `{}`.
- **CPD:** cwd.
- **Claude-only text:** tool names `WebSearch`/`WebFetch` (`design-architect.md:38`).
- **Defects:** D2, D3.

**design:audit**
- **SP:** composed at launch from 2 static files: `design-audit-prompt.md` + `[Expectations Quality Bar]` + `expectations.md`. Append (`:68`).
- **UP:** templated with cwd, output dir and positionals as focus (`:44-58`).
- **Settings:** `design-audit.settings.json` is passed (`:69`), but every key is non-Claude (`name`, `capabilities.tools.enabled/disabled`, `analysis`, `search`). The tool restriction it describes is never enforced.
- **MCP:** none.
- **CPD:** cwd.
- **Launch logic:** `mkdir ai/design-audit` (`:33-42`), banner prints (`:61-63,81-82`).
- **Claude-only text:** none.
- **Defects:** D2, D3.

**design:designer**
- **SP:** static `designer-prompt.md`, append (`:26,44`).
- **UP:** positionals.
- **Permissions:** allow 7 chrome-devtools tools.
- **Hooks:** UserPromptSubmit echo, live (`designer.settings.json:14-24`).
- **MCP:** chrome-devtools, dead (D5).
- **Model:** fixed `sonnet` (`:47`), can be overridden.
- **CPD:** D4 (`:35,55`).
- **Claude-only text:** `mcp__chrome-devtools__*` names (`designer-prompt.md:75`) and "Claude Code" (`:3`).
- **Defects:** D2, D3, D4, D5.

**design:diagram:all / :consolidate / :topic**
- **SP:** meant to come from `assetsFor` → `diagram-*-prompt.md` (`all.ts:82`, `consolidate.ts:63`, `topic.ts:73`). It is **never delivered** (D1), so the effective SP is none and no settings are passed. The settings files would be dead keys anyway.
- **UP:** templated with cwd, `ai/diagrams` and positionals (`all.ts:31-74`, `consolidate.ts:29-55`, `topic.ts:48-64`). `topic` requires a first positional and slugifies it (`topic.ts:14-33`).
- **Permissions and MCP:** none.
- **CPD:** cwd.
- **Launch logic:** `mkdir ai/diagrams` and banner prints.
- **Claude-only text:** none.
- **Defects:** D1, D2, D3.

**git:fix**
- **SP:** none.
- **UP:** built in code (`:42-64`) from the PR number, taken from the positional or auto-detected with `gh pr view` (`:26-40,70-83`). Exits 1 if no PR is found.
- **Permissions and MCP:** none.
- **CPD:** cwd.
- **Claude-only text:** none.
- **Defects:** D2, D3 (`:87`).

**meta:prompt**
- **SP:** static `prompt-improver-prompt.md`, append (`:21,39`).
- **UP:** positionals.
- **Settings and MCP:** none passed.
- **CPD:** D4 (`:30,47`).
- **Claude-only text:** none.
- **Defects:** D2, D3, D4.

**modes:contain**
- **SP:** none.
- **UP:** raw `process.argv.slice(2)` passthrough (`:42`). It bypasses the lib parser, so D2 and D3 don't apply.
- **Permissions:** `defaultMode:default`. Allow 10 `mcp__container-use__*` plus `mcp__deepwiki__ask_question`, which has no server configured, so it is dead (`contain.settings.json:4-16`). Deny 13 built-ins: `Bash, Edit, MultiEdit, Write, Read, LS, Glob, Grep, Task, WebFetch, WebSearch, NotebookEdit, NotebookRead` (`:17-31`).
- **Hooks:** UserPromptSubmit echo, live (`:33-43`).
- **MCP:** `container-use` stdio `container-use stdio` (`contain.mcp.json`), passed (`:40-41`).
- **CPD:** D4 (`:35,47`).
- **Claude-only:** the mechanism itself is a deny list of Claude built-in tool names.
- **Defects:** D4.

**personas:github**
- **SP:** static `github-examples.md`, passed as the SDK `systemPrompt` string. That **replaces** the default SP (`:6,82`).
- **UP:** `positionals[0]` only, required (`:14-21`). Its own parseArgs runs strict, so unknown flags throw.
- **Permissions:** SDK `tools:` = `Write` + 6 `mcp__github__search_*/get_file_contents` (`:48-56,83`). No `defaultMode`.
- **MCP:** `github`, http `https://api.githubcopilot.com/mcp/`, with a Bearer token read from 1Password at launch (`op signin`, `op item get "Github CLI Token"`) (`:24-45,65-73`).
- **Model and CPD:** none.
- **Mode:** Agent SDK `query()` (`:3,78`), headless streaming. Assistant text goes to stdout and every other chunk goes to stderr as JSON (`:88-97`).
- **Claude-only text:** none. The launcher itself is Claude-only.
- **Defects:** none of D1-D5.

**plan:planner**
- **SP:** static `planner-prompt.md`, append (`:21,42`).
- **UP:** positionals.
- **Settings:** `defaultMode:default`, `allow:[]` (`:25-30`), a no-op. MCP `{}`.
- **CPD:** cwd.
- **Claude-only text:** `AskUserQuestion` (`planner-prompt.md:29,210`).
- **Defects:** D2, D3.

**plan:riff**
- Same shape as planner (`:32-41`) with `riff-prompt.md`.
- **Claude-only text:** none.
- **Defects:** D2, D3.

**rails:backlog**
- **SP:** static `rails-backlog-coordinator-prompt.md`, append (`:32,51`).
- **UP:** positionals.
- **Permissions:** `defaultMode:default` only.
- **MCP:** `{}`.
- **Hooks:** UserPromptSubmit echo, live, with `matcher:"*"` (`rails-backlog.settings.json:6-18`).
- **Dead settings key:** `systemPromptFiles` (`:5`).
- **CPD:** D4 (`:41,59`).
- **Claude-only text:** heavy. The whole prompt dispatches `Task` with `subagent_type: rails-dev-plugin:*` (`prompt:16,196-215`), which needs that Claude plugin installed. "CLAUDE.md" (`:29,140,160,177`).
- **Defects:** D2, D4.

**resume:tailor**
- **SP:** static `resume-tailor.md`, append (`:23,44`).
- **UP:** positionals.
- **Permissions:** allow `Read, Write, Edit, Glob, Bash(typst:*)` (`:27-32`).
- **MCP:** `{}`.
- **CPD:** cwd.
- **Claude-only text:** none.
- **Defects:** D2, D3.

**review:pr**
- **SP:** static `pr-review-prompt.md`, append (`:29,217`).
- **UP:** built in code by `buildReviewPrompt(prRef, postComment)` (`:55-186`). The PR comes from the positional or `gh` auto-detection (`:189-208`). `--comment` toggles step 7 (`:130-135,211`).
- **Permissions:** allow 13 `Bash(gh …:*)`/`Bash(git …:*)` + `Read, Glob, Grep, Task`, deny `[]` (`pr-review.settings.json:3-22`).
- **MCP:** none.
- **CPD:** cwd.
- **Claude-only text:** the UP orchestrates "haiku/sonnet/opus agent" subagents (`pr.ts:68-122`). `GUIDELINE_FILES = CLAUDE.md, AGENTS.md` (`:34`) and "CLAUDE.md - Claude Code specific" (`pr-review-prompt.md:32`).
- **Defects:** D3 (`--comment` is rejected by claude, so the flag is unusable), D2.

**shepherd** (`agents/shepherd.ts`)
- **SP:** composed at launch (`:109-134`) from:
  - static `core.md`, `herdr.md` and `inter-agent.md`
  - read from disk: `.shepherd/charter.md` and `.shepherd/integrations/*.md` (`:87-107`)
  - a generated header with cwd, date, backend and what was loaded.
- **SP delivery:** claude-cli appends (`lib/runtime/claude-cli.ts:369-370`). codex-cli uses `--config base_instructions=`, which **replaces** Codex's base prompt (`lib/runtime/codex-cli.ts:419-420`).
- **UP:** positionals, required with `--print` (`:183-187`).
- **Permissions:** allow `Read/Write/Edit(.shepherd/**)` and `Bash(herdr:*)`, `defaultMode:default` (`:67-77`). Passed on claude-cli only (`:174-180`).
- **MCP:** `{}`, claude-cli only.
- **Model:** `--model` goes to the runtime (`:173`).
- **CPD and spawn cwd:** the `--cwd` root (`:171-172`).
- **Launch logic:**
  - `--backend`/`FORGE_BACKEND` selection and validation (`lib/flags.ts:101-155`)
  - `--cwd`
  - `--show-prompt` prints the SP and exits (`:162-165`)
  - `--print` runs `runAgentStreaming` (`:183-192`)
  - raw passthrough minus `FORGE_LEVEL_FLAGS`, claude-cli only (`:59,141-150`).
- **Claude-only text:** none required. `core.md:14` says to stay harness agnostic. `inter-agent.md:3` names `ListAgents`/`SendMessage` as a self-gated example.
- **Mode:** interactive, or print streaming. On codex it drops settings, MCP and rawArgs.
- **Defects:** D2. With `--model opus`, `model` is `true` and "opus" joins the prompt, because `FORGE_LEVEL_FLAGS` strips `model` from rawArgs but not from `options.model`.

**tools:webfetch**
- **SP:** meant to come from `assetsFor` → `webfetch-prompt.md` (`:295`), appended by the runtime (`claude-cli.ts:302-303`). D1: it is present under `bun run` and missing in the binary.
- **UP:** built in code by `buildTaskPrompt(url, prompt, raw)` (`:218-229`).
- **Permissions:** `--allowedTools WebFetch` (`:303`). `webfetch.settings.json` has allow `WebFetch` and deny `Bash, Edit, Write, Read, Glob, Grep, Task, WebSearch`. The deny list is lost in the binary (D1).
- **MCP:** none.
- **Model and flags:** model defaults to `haiku`, `--max-turns` to 3 (`:110-111,156-157`). Backend is hard-coded `claude-cli` (`:305`).
- **Launch logic:** its own CLI contract.
  - flags `--url`, `--prompt`, `--raw`, `--model`, `--max-turns`, `--describe`/`-h` (`:147-216`)
  - prints a usage doc, exits 64 on usage errors
  - stdout is normalized to a payload or an `ERROR:` line (`:245-277`).
- **Mode:** print through `runAgentOnce` (`lib/runtime/index.ts:540`), stdin ignored.
- **Claude-only:** it exists to wrap Claude's `WebFetch` (`webfetch-prompt.md:1-17`).
- **Defects:** D1.

**tutors:coach**
- **SP:** composed at launch (`:383-408`).
  - Subject mode: student + `core.md` + generated roster + pack body.
  - Coordinator mode: student + roster + `coordinator.md` + `herdr.md` + `.coach/integrations/*.md` + a generated header.
  - Read from disk: `.coach/student.md` (`:248-267`), `.coach/packs/*.md`, which replace the built-ins once present (`:187-215`), and `.coach/integrations/*.md` (`:221-236`).
  - Delivery: append (`:438`).
- **UP:** positionals after the optional subject slug (`:429-431`).
- **Permissions:** `defaultMode:default`. Allow is `Read/Write/Edit(.coach/**)` plus the pack frontmatter `allow:`, which is data read at runtime. The coordinator adds `Bash(herdr:*)` instead (`:104,116,415-425`). The built-in packs declare no `allow`.
- **MCP:** `{}`.
- **CPD and spawn cwd:** the root (`:446-450`).
- **Launch logic:**
  - `--cwd` root check (`:305-315`)
  - `--init` writes seed files (`:270-299`)
  - `--list` (`:337-361`)
  - `--show-prompt`
  - subject dispatch with typo detection (`:363-375`)
  - frontmatter parser (`:132-159`).
- **Claude-only text:** Claude tool names as data in pack frontmatter (`coordinator.md:272`).
- **Mode:** interactive.
- **Defects:** D2, and D3 for `--backend` only (it strips `cwd` at `:434`).

## 1. Feature × agent matrix

| Feature | Count | Agents |
|---------|------:|--------|
| SP static file, append | 14 | orient, builder, comment-review, refactor, tdd, architect, designer, planner, riff, backlog, meta, tailor, pr, webfetch¹ |
| SP composed at launch | 3 | audit (2 static files), shepherd, coach |
| SP includes files read from disk at runtime | 2 | shepherd, coach |
| SP replaces the default | 1 (+1) | github (SDK); shepherd on codex |
| No effective SP | 5 | contain, git:fix, diagram ×3 (D1) |
| UP = positionals | 13 | builder, refactor, tdd, designer, architect, planner, riff, backlog, meta, tailor, github, shepherd, coach |
| UP built or templated in code | 9 | orient, comment-review, audit, diagram ×3, git:fix, pr, webfetch |
| UP = raw argv | 1 | contain |
| Non-empty allow list | 12 | builder², refactor², designer², contain, comment-review, tailor, architect, pr, github, shepherd, coach³, webfetch |
| Scoped patterns (`Bash(x:*)`, `Read(dir/**)`) | 5 | tailor, pr, shepherd, coach, (contain uses MCP names) |
| Deny list | 2 | contain, webfetch¹ |
| `defaultMode` set (always `"default"`) | 12 | builder, refactor, designer, contain, tdd, backlog, planner, riff, tailor, architect, shepherd, coach |
| Skip permissions | 0 | none |
| MCP server that works | 2 | contain (stdio), github (http + secret header) |
| MCP server that is dead | 3 | builder, designer, refactor (D5) |
| Empty `mcpServers:{}` passed | 8 | tdd, backlog, planner, riff, tailor, architect, shepherd, coach |
| Fixed model | 2 | designer (sonnet), webfetch (haiku) |
| Max turns | 1 | webfetch |
| Live hooks (all echo a static reminder) | 6 | builder, designer, contain, tdd, backlog (UserPromptSubmit); orient (PostToolUse) |
| Dead settings keys | 7 files | orient, tdd, backlog, audit, diagram-all/-topic/-consolidate |
| CPD = cwd | 12 | builder, comment-review, architect, audit, diagram ×3, git:fix, planner, riff, tailor, pr |
| CPD = wrong (D4) | 7 | orient, refactor, tdd, designer, backlog, meta, contain |
| CPD = `--cwd` root | 2 | shepherd, coach |
| CPD not set | 2 | github, webfetch |
| Custom forge flags | 5 | orient, pr, webfetch, shepherd, coach |
| Runs external commands before launch | 4 | comment-review (git), git:fix (gh), pr (gh), github (op) |
| Writes the filesystem before launch | 5 | audit, diagram ×3 (mkdir), coach (`--init`) |
| Reads a workspace state dir | 2 | shepherd (`.shepherd/`), coach (`.coach/`) |
| Mode: interactive only | 20 | all except github, shepherd, webfetch |
| Mode: print only | 1 | webfetch |
| Mode: SDK headless streaming | 1 | github |
| Mode: interactive + print | 1 | shepherd |
| Multi-backend | 1 | shepherd |
| Affected by D1 / D2 / D3 / D4 / D5 | 4 / 20 / 15(+coach) / 7 / 3 | see above |

¹ Only under `bun run` (D1). ² Allows only the dead MCP's tools. ³ Plus pack-provided entries.

## 2. Essential vs accidental

**Essential** (the format must express these):
- **SP text.**
  - Static files (21 agents intend one).
  - Composition from several fragments (audit, shepherd, coach).
  - Runtime-read fragments and generated headers (shepherd, coach).
  - Append vs replace: every Claude-cli agent appends, github replaces.
- **Initial prompt.** Positionals, or a template over cwd, output dir, positionals, flags and command output.
- **Permissions.**
  - Allow lists with scoped patterns: `Bash(gh pr view:*)`, `Bash(typst:*)`, `Read(.coach/**)`.
  - Deny lists of built-ins (contain, webfetch).
  - Per-launch allow entries from data (coach packs).
- **MCP.** stdio (container-use) and http with an auth header sourced from a secret (github).
- **Model pin and max turns** (designer, webfetch).
- **Mode.** Interactive with an initial prompt (20), print with clean stdout (webfetch), headless streaming (github).
- **Launch cwd** (coach, shepherd).

**Accidental** (drop or fix, don't model):
- `defaultMode:"default"` (12). It is already the default.
- `allow:[]` (planner, riff) and `mcpServers:{}` (8).
- Non-Claude settings schemas: `systemPromptFiles` (tdd, backlog), orient's `name/description/settings.model/temperature/maxTokens/systemPromptMode`, and the audit and diagram `capabilities/analysis/output_preferences/search`. Their tool restrictions were never enforced.
- chrome-devtools MCP and its 7-tool allow lists in 3 agents (D5). `mcp__deepwiki__ask_question` in contain (no server).
- `CLAUDE_PROJECT_DIR` (set by 21, read by nothing) and `CLAUDE_FORGE_DIR` (no consumer in settings or prompts).
- `matcher:"*"` on UserPromptSubmit.
- The 6 echo hooks. Each only injects a fixed reminder that could be one line of SP. Keep hooks in the format only if a real hook appears.
- Per-process `TMPDIR`. It is a runtime workaround, not agent config.

## 3. Agents whose launch logic can't be purely declarative

These 11 are declarative today, given `{{args}}` for the positionals: builder, refactor, tdd, designer, architect, planner, riff, backlog, meta, tailor, contain (raw passthrough).

| Agent | What needs code | Minimal hook |
|-------|-----------------|--------------|
| audit, diagram ×3 | cwd and output-dir templating, `mkdir`, banners. `topic` has a required arg and slugifies it. | Template vars `{{cwd}}`, `{{args}}`, `{{arg0}}` plus a required-arg declaration. Could be fully declarative with a `slug` filter and a "create dirs" list, or let the prompt create the dir. |
| orient | `--quick` and `--focus <enum>` map to prompt text. | Declared custom flags (bool, enum) that are consumed rather than forwarded, plus conditional template sections. |
| pr, git:fix | PR ref = arg0, or the output of `gh pr view --json number` with an error exit. pr's `--comment` bool toggles a prompt section. | Arg default from a command, plus a declared bool flag in the template. Or a `prepare(ctx) → {prompt}` function. |
| comment-review | Embeds the git diff and exits early when it is empty. | `prepare(ctx) → {prompt} \| {exit, message}`. |
| github | Secret from 1Password into the MCP header. SDK launch. | Secret or env interpolation in MCP config (for example `${env:GITHUB_TOKEN}` with a pre-launch command). The SDK is not needed, since print or stream mode covers it. |
| webfetch | Its own CLI contract: flags, exit 64, `--describe` doc, stdout normalized to a payload or `ERROR:`. | A custom arg parser plus an output post-processor (`finish(result) → {stdout, exitCode}`). Print mode only. |
| shepherd | SP composed from disk plus a generated header (date, backend). `--cwd`, `--show-prompt`, `--print`. | `composeSystemPrompt(ctx)`. `--cwd` and `--show-prompt` should be framework flags, not agent code. |
| coach | Subject dispatch, subcommands (`--init` writes files, `--list` prints), SP composition from `.coach/`, allow list from pack data, launch cwd. | A full `prepare(ctx) → {systemPrompt, prompt, allow, cwd}` plus custom commands that exit before launch. It is the hardest case. |

The recurring needs are:
- framework `--cwd` and `--show-prompt`
- declared, consumed custom flags (fixes D3)
- `{{cwd}}`/`{{args}}` templating
- one `prepare(ctx)` escape hatch for shepherd, coach and comment-review
- an output post-processor for webfetch.

## 4. Effectively Claude-only today

- **By launcher:** 21 of 23. `spawnClaude` hard-codes `claude` (`lib/claude.ts:106`). webfetch pins `claude-cli` (`webfetch.ts:305`). github uses the Claude Agent SDK. Only shepherd can pick a backend.
- **By semantics** (these stay Claude-only after a backend swap unless the prompt or config changes):
  - **rails:backlog.** `Task` dispatch to `rails-dev-plugin:*` subagent types, which needs the Claude plugin.
  - **build:tdd.** Delegates everything via the `Task` tool, including plugin agents.
  - **build:builder.** `Task` to `general-purpose`/`Explore`, and `AskUserQuestion` approvals.
  - **review:pr.** Parallel subagents with Claude model names (haiku/sonnet/opus) and `Task` in the allow list.
  - **tools:webfetch.** Its whole purpose is Claude's `WebFetch` tool.
  - **modes:contain.** Works by denying 13 Claude built-in tools so the model is forced onto the MCP.
  - **personas:github.** Agent SDK `query()` with a replaced SP. It would port to print or stream mode.
- **Soft** (a prompt wording change or graceful degradation is enough):
  - planner (`AskUserQuestion`)
  - designer (`mcp__chrome-devtools__*` names, and its MCP is dead anyway)
  - architect (`WebSearch`/`WebFetch` names)
  - orient and tdd (`CLAUDE.md`)
  - refactor ("Claude Code" persona).
- **Portable by design:** shepherd (harness-agnostic core, self-gated integrations) and coach (no Claude tool names outside pack data). Also riff, tailor, meta, git:fix, comment-review, audit and diagram ×3, whose prompts name no Claude tools.
