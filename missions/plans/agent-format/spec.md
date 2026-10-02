# Spec: declarative agent format (Troupe agent hub, formerly claude-forge)

## Why
claude-forge is becoming a backend-agnostic agent hub: agents declared once, compiled into
binaries in `bin/`, run from a terminal on Claude Code or Codex. Today every agent is a hand-written
TypeScript launcher hard-wired to `claude`, and the shared plumbing has live defects: flag
passthrough (D2), forge flags leaking to claude (D3), the `assetsFor` misses (D1), a wrong
`CLAUDE_PROJECT_DIR` (D4), a dead chrome-devtools MCP (D5), and Codex agents running without their
system prompt. Evidence: `agent-usage.md` and `backend-matrix.md` (attached with the plan).

## Outcome
Every one of the 22 agents (amended 2026-10-02, D-036) is defined by a Markdown file (frontmatter spec plus system prompt body),
optionally with a sibling `.ts` code hook. `bun run compile:all` builds each one into
`bin/<namespace:name>`. Every agent runs on each backend it declares, with its prompt delivered
correctly, and the old Claude-only launch plumbing is gone.

## Ratified decisions (honor verbatim)
1. **Format A.** One `agents/<ns>/<name>.md` per agent; the frontmatter is the spec and the body
   is the system prompt. An optional sibling `agents/<ns>/<name>.ts` may export `prepare(ctx)` and/or
   `finish(result)`. The binary name comes from the path, as today (`design/diagram/all.md` becomes `design:diagram:all`).
2. **One internal AgentSpec, per-backend adapters.** The file compiles into a backend-neutral spec.
   Adapters for `claude` and `codex` turn it into argv. Only Claude Code and Codex are in scope, but
   the adapter seam must admit more backends without touching agent files.
3. **Prompt mode defaults to append.** Claude: `--append-system-prompt`. Codex:
   `-c developer_instructions=<JSON.stringify(text)>`. `replace` is opt-in (Claude `--system-prompt`,
   Codex `-c model_instructions_file=<path>`). Never emit `base_instructions`.
4. **Inherit the user's config by default.** Codex follows the user's current config: no sandbox,
   approval, effort, MCP or model overrides unless the agent declares them. Same for Claude: no
   `--strict-mcp-config` or `--setting-sources` unless declared. `model` and `access` are optional.
5. **Backend restriction is allowed.** `backends: [claude]` is valid. The first listed backend
   is the default. Running on an undeclared backend fails with a clear message.
6. **Portable core, native escape hatch.** Portable: prompt, initial prompt template, declared flags,
   per-backend model and effort, `access` (read-only, workspace-write or full), MCP (stdio and http),
   mode (interactive, print or stream). Fine-grained tool rules, max-turns, subagents and other
   non-translatable settings go in `native.claude` / `native.codex` as raw passthrough. On Codex, a
   Claude-only rule is not emulated.
7. **No hooks in the format for now.** The 6 existing echo hooks become prompt text.
8. **The hub holds agents only.** No utilities. The 22-agent roster is fixed (see agent-usage.md; personas:github was removed, amended 2026-10-02, D-036).

## Requirements
- **Schema:** validated at compile time (zod or similar). Unknown keys are an error, so no more
  silently-dead settings. Clear errors name the file and field.
- **Prompt composition:** the body plus declared fragment includes (for example design:audit's
  `expectations.md`), inlined at compile time. Runtime fragments come only through `prepare`.
- **Initial prompt:** a template over `{{args}}`, `{{cwd}}` and declared flags, with minimal
  conditionals, enough for orient `--quick/--focus`, the diagram agents, and audit.
- **Flags:** framework flags `--backend`, `--cwd`, `--model`, `--print`, `--show-prompt` (prints
  the resolved prompt and the argv per backend, then exits) and `--help` (generated from the spec).
  Declared agent flags (bool, enum, string, with defaults) are consumed and never forwarded. Anything
  after `--` passes through to the backend CLI verbatim. `--flag value` and `--flag=value` both
  work (fixes D2 and D3).
- **Code hooks:** `prepare(ctx)` receives the parsed flags, args, cwd, backend and spec. It returns
  overrides (system prompt fragments, initial prompt, extra allow rules, cwd), or an early exit with
  a message and code. `finish(result)` post-processes print-mode output (webfetch).
- **MCP:** stdio `{command,args,env,cwd}` and http `{url,headers}` on both backends, with
  `${env:NAME}` and `${cmd:...}` interpolation resolved at launch (for example a header token read from a password manager; amended 2026-10-02, D-036).
- **Codex adapter:** interactive `codex [flags] "<prompt>"`, and `codex exec` for print (stdin
  ignored, `--skip-git-repo-check` outside git repos, never `-a`). HTTP MCP maps to `url`/`http_headers`.
- **Migration:** all 22 agents (amended 2026-10-02, D-036) move to the format with behavior preserved, minus the defects. The
  chrome-devtools MCP uses the real package (`chrome-devtools-mcp`). Dead settings keys, empty
  `mcpServers`, `defaultMode:"default"` and `CLAUDE_PROJECT_DIR` are dropped. The Claude-only agents
  (rails:backlog, tdd, builder, review:pr, webfetch, contain) declare `backends: [claude]`.
  personas:github is removed instead of migrated (amended 2026-10-02, D-036). shepherd and
  coach keep their runtime composition via `prepare`, and their `--cwd`/`--show-prompt` become
  framework flags.
- **Shepherd must keep its 2026-09-25 behavior** (commits `1b0208e` and `e18f56b`, which postdate the
  first draft of this spec): (1) enclosing-workspace inheritance: `prepare` finds the nearest parent
  directory with its own `.shepherd/`, appends that workspace's `integrations/*.md` after the built-in
  modules and before the charter, skips a local module whose realpath matches an inherited one, and adds
  the parent's `.shepherd/` to `permissions.additionalDirectories` plus `Read(/<abs>/**)`; (2) the
  "Context tiers" subsection of `system-prompts/shepherd/core.md`. Every workspace under `~/shepherds`
  depends on (1) for its shared flock module; dropping it fails silently.
- **Removal:** `lib/claude.ts` spawn helpers, `lib/flags.ts` `buildClaudeFlags`,
  `lib/claude-flags.types.ts`, `assetsFor`/`assets.gen.ts`/`gen-assets.ts`, the per-agent
  `settings/*.json`, and the old `.ts` launchers. `scripts/watch-agents.ts` either reuses the compiler or is dropped.
- **Docs:** one authoring guide (the format reference plus the backend mapping table). CLAUDE.md,
  AGENTS.md and README point to it. No full README rewrite (that comes with the rename).

## Acceptance
- `bun run typecheck`, `bun run check`, `bun test` and `bun run compile:all` pass, with exactly 22 binaries (amended 2026-10-02, D-036).
- For each agent and each declared backend, a snapshot test pins the `--show-prompt` output (prompt
  plus argv).
- The Codex prompt is verified by `codex debug prompt-input` in a test (skipped when codex is absent):
  the agent's canary text appears as a developer message.
- Regressions fixed: `orient --quick`, `orient --focus tech`, `review:pr --comment`, `--model opus`
  on any agent, the diagram agents receiving their prompt, and compiled webfetch keeping its prompt.
- Manual smoke test: shepherd and one simple agent launch interactively on both backends.
- Shepherd's `--show-prompt` in each `~/shepherds/*` workspace still contains the inherited flock module and the enclosing `.shepherd/` in additionalDirectories (compare against `e18f56b`).

## Out of scope
The rename, backends beyond Claude and Codex, hooks, Codex enforcement of Claude-style tool rules,
isolation from user config beyond opt-in native flags, and a hub catalog CLI.