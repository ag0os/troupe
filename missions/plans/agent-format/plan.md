---
title: Declarative agent format
status: active
createdAt: '2026-09-29T17:31:56.878Z'
updatedAt: '2026-09-29T20:14:09.810Z'
---

## Overview

Replace 23 hand-written Claude launchers with strict Markdown declarations compiled to the same colon-named binaries. Each binary embeds one validated backend-neutral `AgentSpec`, imports an optional sibling `prepare`/`finish` extension, and selects a Claude Code or Codex argv adapter at launch.

`spec.md` is authoritative. The current human instruction to honor that unchanged legacy spec exactly is an explicit waiver of the newer canonical `Intent`/`INV-###`/`AC-###` shape for this plan; it does not authorize edits to the spec or invented invariants. Its Outcome, eight Ratified decisions, Requirements, Acceptance, and Out of scope are human ground. The following aliases are traceability indexes only:

- `REQ-001` Schema; `REQ-002` Prompt composition; `REQ-003` Initial prompt; `REQ-004` Flags; `REQ-005` Code hooks; `REQ-006` MCP; `REQ-007` Codex adapter; `REQ-008` Migration; `REQ-009` Shepherd 2026-09-25 behavior; `REQ-010` Removal; `REQ-011` Docs.
- `ACC-001` repository checks/exactly 23 binaries; `ACC-002` agent × declared-backend previews; `ACC-003` Codex developer-message canary; `ACC-004` named regressions; `ACC-005` four interactive smokes; `ACC-006` per-workspace Shepherd previews.

No implementer may rank conflicting ratified ground; such a collision halts for human resolution. Derived design yields to the spec. Backend mappings come from `evidence/agent-usage.md` and `evidence/backend-matrix.md` (Claude Code 2.1.282, Codex 0.156.1).

The rename, third backends, backend lifecycle hooks, Codex emulation of Claude rules, default user-config isolation, and a catalog CLI remain out of scope. The plan has 12 behavior clusters, at project guidance; implementation uses the dependency-complete slices below.

## Decision Log

- **D-001 - Format A**
  - Decision: **Format A.** One `agents/<ns>/<name>.md` per agent; the frontmatter is the spec and the body
    is the system prompt. An optional sibling `agents/<ns>/<name>.ts` may export `prepare(ctx)` and/or
    `finish(result)`. The binary name comes from the path, as today (`design/diagram/all.md` becomes `design:diagram:all`).
  - Alternatives: Keep TypeScript launchers or split declarations across directories.
  - Why: Ratified product ground and one normal source per agent.
  - Decided by: human, ratified in `spec.md`

- **D-002 - One internal AgentSpec, per-backend adapters**
  - Decision: **One internal AgentSpec, per-backend adapters.** The file compiles into a backend-neutral spec.
    Adapters for `claude` and `codex` turn it into argv. Only Claude Code and Codex are in scope, but
    the adapter seam must admit more backends without touching agent files.
  - Alternatives: Agent-built argv or backend-specific binaries.
  - Why: Ratified boundary.
  - Decided by: human, ratified in `spec.md`

- **D-003 - Prompt mode defaults to append**
  - Decision: **Prompt mode defaults to append.** Claude: `--append-system-prompt`. Codex:
    `-c developer_instructions=<JSON.stringify(text)>`. `replace` is opt-in (Claude `--system-prompt`,
    Codex `-c model_instructions_file=<path>`). Never emit `base_instructions`.
  - Alternatives: Broken Codex key or user-prompt prepending.
  - Why: Ratified verified mapping.
  - Decided by: human, ratified in `spec.md`

- **D-004 - Inherit the user's config by default**
  - Decision: **Inherit the user's config by default.** Codex follows the user's current config: no sandbox,
    approval, effort, MCP or model overrides unless the agent declares them. Same for Claude: no
    `--strict-mcp-config` or `--setting-sources` unless declared. `model` and `access` are optional.
  - Alternatives: Global isolation or pinned policy.
  - Why: Ratified default.
  - Decided by: human, ratified in `spec.md`

- **D-005 - Backend restriction is allowed**
  - Decision: **Backend restriction is allowed.** `backends: [claude]` is valid. The first listed backend
    is the default. Running on an undeclared backend fails with a clear message.
  - Alternatives: Require both or silently fall back.
  - Why: Ratified honest portability.
  - Decided by: human, ratified in `spec.md`

- **D-006 - Portable core, native escape hatch**
  - Decision: **Portable core, native escape hatch.** Portable: prompt, initial prompt template, declared flags,
    per-backend model and effort, `access` (read-only, workspace-write or full), MCP (stdio and http),
    mode (interactive, print or stream). Fine-grained tool rules, max-turns, subagents and other
    non-translatable settings go in `native.claude` / `native.codex` as raw passthrough. On Codex, a
    Claude-only rule is not emulated.
  - Alternatives: Lowest common denominator or false translation.
  - Why: Ratified portability contract.
  - Decided by: human, ratified in `spec.md`

- **D-007 - No hooks in the format for now**
  - Decision: **No hooks in the format for now.** The 6 existing echo hooks become prompt text.
  - Alternatives: Backend lifecycle hooks or deletion.
  - Why: Ratified scope; `prepare`/`finish` are launcher extensions, not backend hooks.
  - Decided by: human, ratified in `spec.md`

- **D-008 - The hub holds agents only**
  - Decision: **The hub holds agents only.** No utilities. The 23-agent roster is fixed (see agent-usage.md).
  - Alternatives: Discover every executable source.
  - Why: Ratified roster.
  - Decided by: human, ratified in `spec.md`

- **D-009 - Strict source validation, compiler-owned IO**
  - Decision: `yaml` parses and strict `zod` schemas validate already-read Markdown. The compiler alone resolves realpaths, enforces the repository boundary, reads includes, and supplies ordered text to pure materialization.
  - Alternatives: Coach's permissive parser or schema-owned filesystem IO.
  - Why: REQ-001 without dependency inversion. Addresses `review-1.md PR-010`.
  - Decided by: planner, revision from `review-1.md PR-010`

- **D-010 - Command and stream adapters replace capability classes**
  - Decision: `BackendAdapter` builds a `CommandPlan` and owns a line decoder for its stream wire format. Remove Codex SDK and warning-and-ignore behavior.
  - Alternatives: Retain current classes or teach the neutral runner backend JSON.
  - Why: D-002 and stream fidelity. Addresses `review-1.md PR-005`.
  - Decided by: planner, revision from `review-1.md PR-005`

- **D-011 - Recoverable, single-owner publication**
  - Decision: A repo-local ignored atomic lock serializes every compiler/watcher process. Under that lock, all outputs build in a same-parent `next`, then publish through validated `bin → previous`, `next → bin` renames with rollback and restart recovery.
  - Alternatives: One-by-one overwrite, delete-first swap, or in-process-only serialization.
  - Why: ACC-001 needs a coherent roster across failures, crashes, manual compiles, and multiple watchers. Addresses `review-1.md PR-011` and `review-2.md PR-011`.
  - Decided by: planner, revision from `review-1.md PR-011`, `review-2.md PR-011`

- **D-012 - Preview is deterministic and secret-safe**
  - Decision: `--show-prompt` runs preparation but no backend or `${cmd:...}` substitution. It prints backend, system prompt, initial prompt, and JSON argv; secrets/temp paths use stable redacted placeholders.
  - Alternatives: Live tokens or compile-time-only preview.
  - Why: REQ-004/ACC-002 plus credential safety.
  - Decided by: planner-proposed

- **D-013 - Declaration guards preserve verbatim user passthrough**
  - Decision: Reject reserved prompt transport, lifecycle hooks, and `base_instructions` in authored native declarations; structurally validate long equals/two-token and `-c` keys. Never inspect/rewrite post-`--` user tokens. Adapters themselves never synthesize Codex exec `-a` or `base_instructions`.
  - Alternatives: Filter user escape tokens or substring-scan payloads.
  - Why: Preserve both halves of REQ-004. Addresses `review-1.md` Missing Coverage.
  - Decided by: planner, revision from `review-1.md` Missing Coverage

- **D-014 - Access mappings are explicit and coarse**
  - Decision: `read-only` maps to Claude plan/Codex read-only; `workspace-write` to Claude accept-edits/Codex workspace-write; `full` to each backend's bypass. Absence emits nothing.
  - Alternatives: Prose, unconditional defaults, or fine-rule emulation.
  - Why: D-004/D-006.
  - Decided by: planner-proposed

- **D-015 - Extensions return runner data, never backend commands**
  - Decision: Use templates for ordinary agents and siblings only for launch IO, workspace composition, early exits, validated invocation overrides, or print finishing. Extensions use runner-owned command execution and never parse framework flags/build argv/spawn a backend.
  - Alternatives: Preserve launchers or grow one-use schema fields.
  - Why: REQ-005 without a second runtime.
  - Decided by: planner-proposed

- **D-016 - Prepare carries required existing behavior**
  - Decision: `extraAllowRules` contains rules plus additional directories; validated `flagOverrides` supports Webfetch normalization; `afterRunMessages` owns post-child banners. These are invocation data, not raw argv.
  - Alternatives: Stringly hide directories, mutate spec, or drop behavior.
  - Why: Preserve Shepherd, Webfetch, and interactive completion behavior. Addresses `review-1.md PR-001`, `PR-004`, `PR-007`.
  - Decided by: planner, revision from `review-1.md PR-001`, `PR-004`, `PR-007`

- **D-017 - Migration compiler supports a temporary mixed source set**
  - Decision: Before migrating agents, package compile/watch switch to the shared compiler in explicit migration mode: `.md` wins over same-stem legacy `.ts`; paired TypeScript is imported only when it exports `prepare`/`finish`; an unpaired non-test `.ts` remains a legacy launcher entry. Final strict mode rejects unpaired launchers and removes the fallback.
  - Alternatives: Import executable siblings; convert hooks while the old compiler still builds every `.ts`; one giant untestable cutover.
  - Why: Every pre-cutover compile/watch produces functional binaries, and no hook library becomes a no-op binary. Addresses `review-1.md PR-002` and `review-2.md PR-002`.
  - Decided by: planner, revision from `review-1.md PR-002`, `review-2.md PR-002`

- **D-018 - Runner owns all child cancellation and decode failures**
  - Decision: `PrepareContext` includes an `AbortSignal` and runner-owned `runCommand`; all preparation/interpolation/backend children share signal and cleanup ownership. Decoder malformed/incomplete/throw paths are explicit failures.
  - Alternatives: Direct hook spawning or best-effort stream parsing.
  - Why: Deterministic exits and no orphan children. Addresses `review-1.md PR-015` and `review-2.md PR-015`.
  - Decided by: planner, revision from `review-1.md PR-015`, `review-2.md PR-015`

- **D-019 - Exceptional migration contracts are explicit**
  - Decision: GitHub gets required-single-prompt preparation; Comment Review/Webfetch retain live Claude policies; Claude retains isolated TMPDIR; diagram/audit banners run at correct times.
  - Alternatives: Broad “preserve behavior” prose.
  - Why: Independent ownership. Addresses `review-1.md PR-006`–`PR-009`.
  - Decided by: planner, revision from `review-1.md PR-006`, `PR-007`, `PR-008`, `PR-009`

- **D-020 - Legacy artifact waiver and required Quality Contract**
  - Decision: The current human instruction makes unchanged `spec.md` authoritative and waives canonical Intent/AC formatting for this plan only. Keep the human-required `Quality Contract` as behavior/risk traceability, not a gate table or binding prediction; test files remain worker-owned outside Files to Change.
  - Alternatives: Edit/invent product ground, remove the requested section, or list speculative test files.
  - Why: Honor direct ground and canonical ownership as far as compatible. Addresses `review-1.md PR-012`–`PR-014`, `review-2.md PR-013`, `PR-014`.
  - Decided by: human, current request (legacy spec authority and Quality Contract); planner for traceability mechanics

- **D-021 - Preserve backend environment compatibility**
  - Decision: Backend resolution is CLI, then `FORGE_BACKEND`, then first declaration. Environment accepts new values and legacy `claude-cli`/`codex-cli` aliases with deprecation; CLI/schema expose only new names.
  - Alternatives: Silently drop existing Shepherd behavior or preserve a third backend.
  - Why: REQ-008 while Codex SDK stays out of scope. Addresses `review-1.md` Missing Coverage.
  - Decided by: planner, revision from `review-1.md` Missing Coverage

## Behaviors

### B-001 - Definitions compile strictly
- Source: REQ-001, REQ-002, decisions 1 and 8
- Observer: an agent author compiling one definition or roster
- Entry point: single/all compile
- Outcome: valid Markdown becomes the path-derived binary with ordered embedded body/includes and actual extension; malformed/unknown/cross-field/include/roster errors name file and field and publish nothing partial.

### B-002 - Generated binaries share one predictable CLI
- Source: REQ-004, decision 5
- Observer: terminal user
- Entry point: any binary's framework/agent flags, positionals, environment compatibility, and `--`
- Outcome: framework and declared bool/enum/string flags are consumed with defaults and both value forms; unknown pre-separator input fails; tail tokens remain verbatim; backend precedence is explicit and undeclared selection fails.

### B-003 - Real composed prompts are previewable
- Source: REQ-002–REQ-004, ACC-002
- Observer: user/maintainer
- Entry point: every agent × declared backend with `--show-prompt`
- Outcome: fixed-format preview contains compiled/prepared system prompt, rendered initial prompt, and adapter argv, then exits without backend/secret command; fixed-clock/workspace snapshots cover the full matrix.

### B-004 - Adapters preserve backend semantics and user config
- Source: REQ-007, decisions 2–6
- Observer: user launching Claude/Codex
- Entry point: default or selected backend
- Outcome: only declared prompt mode/mode/model/effort/access/MCP/cwd/native concerns become verified argv; undeclared policy/isolation remains absent; Codex exec ignores stdin, skips Git check only outside worktrees, and adapter-generated argv never uses exec `-a` or `base_instructions`.

### B-005 - MCP launches without exposing secrets
- Source: REQ-006, REQ-007
- Observer: user of declared stdio/HTTP MCP
- Entry point: actual launch
- Outcome: both transports map correctly; env/command interpolation occurs only at launch; missing/failed/interrupted resolution stops before backend with cleanup; secrets are not persisted/printed; Chrome uses `chrome-devtools-mcp`.

### B-006 - Extensions and modes have deterministic exits
- Source: REQ-005, decision 6
- Observer: user invoking composition, early command, print, or stream
- Entry point: generated binary plus optional extension
- Outcome: preparation returns validated invocation data/early exit and uses cancellable runner commands; interactive inherits IO, print finishes success/operational failures, stream uses adapter decoder, after-run messages follow successful decoding; hook/child/adapter/decoder/finish/signal failures have specified output/code/cleanup.

### B-007 - All 23 agents preserve intended behavior and remove named defects
- Source: REQ-008, REQ-010, ACC-004
- Observer: existing binary users
- Entry point: migrated 23 names
- Outcome: meaningful prompt/permission/MCP/mode/CLI/output behavior remains; dead settings/empty MCP/default mode/wrong project env/assets/lifecycle echoes are dropped or moved; named regressions are fixed; seven specified agents are Claude-only and all others declare Claude then Codex.

### B-008 - Shepherd preserves enclosing workspace and context tiers
- Source: REQ-009, ACC-006
- Observer: nested-workspace Shepherd user
- Entry point: preview/launch on either backend
- Outcome: nearest parent modules are sorted after built-ins/before charter, duplicate-realpath locals skipped, local follows charter; Claude receives both additional directory and absolute Read rule, Codex no emulation; Context tiers/flock module/directory remain observable.

### B-009 - Build publishes one coherent roster
- Source: REQ-010, ACC-001
- Observer: maintainer
- Entry point: repository type/style/test/all-compile workflows, including concurrent compile attempts
- Outcome: checks pass with exactly 23 binaries; obsolete paths are removed; single-owner build/recovery preserves or restores the last validated set under validation failure, build failure, commit failure, crash, or signal.

### B-010 - Codex receives a developer message
- Source: ACC-003
- Observer: maintainer with Codex
- Entry point: prompt-debug using adapter canary args
- Outcome: canary is a developer message and base remains; absent skips explicitly, installed failure fails.

### B-011 - Authors have one accurate reference
- Source: REQ-011
- Observer: contributor
- Entry point: guide linked from README/AGENTS/CLAUDE
- Outcome: one guide covers schema, prompts/templates, flags, extension data/cancellation, MCP trust, native mapping, mixed migration/strict compiler, and examples; active docs contain no stale path/backend guidance.

### B-012 - Interactive smoke works on both backends
- Source: ACC-005
- Observer: sign-off maintainer
- Entry point: Shepherd and `plan:riff`, each on Claude/Codex
- Outcome: all four start in requested cwd with prompts, interact, and terminate cleanly without Troupe-specific global MCP or suppressed user config.

## Design

### 1. Modules and dependency direction

- `lib/agent-format/types.ts`: pure stable contracts.
- `schema.ts`: `parseAgentMarkdown(path,text)` and pure materialization using `yaml`/`zod`.
- `template.ts`: minimal template validation/rendering.
- `cli.ts`: strict flags/help/backend precedence; no adapter import.
- `run.ts`: CLI → prepare → render → interpolation → adapter/preview → execute/decode → finish/messages → cleanup.
- `lib/runtime/types.ts`: `BackendAdapter`, `CommandPlan`, `StreamDecoder`; Claude/Codex modules own wire formats; `index.ts` selects and supplies process support.
- `scripts/agent-compiler.ts`: discovery, realpath/include IO, static extension-export inspection, mixed/strict source selection, lock, generated entries, staging/recovery.

No compatibility runtime remains after strict cutover. Planning-time analysis produced no mechanical complexity/duplication/boundary/trace evidence because no provider was available; implementation sign-off resolves whatever capabilities are available then and supplements absent evidence with direct review.

### 2. Schema

```ts
type Backend = "claude" | "codex";
type PromptMode = "append" | "replace";
type AgentMode = "interactive" | "print" | "stream";
type Access = "read-only" | "workspace-write" | "full";
type NativeArg = string | { flag: string };
type FlagSpec =
  | { type: "boolean"; description: string; short?: string; default?: boolean }
  | { type: "string"; description: string; short?: string; default?: string }
  | { type: "enum"; description: string; short?: string; values: string[]; default?: string };
type McpServer =
  | { command: string; args?: string[]; env?: Record<string,string>; cwd?: string }
  | { url: string; headers?: Record<string,string> };
interface AgentSource {
  description: string;
  backends: [Backend, ...Backend[]];
  promptMode?: PromptMode;
  mode?: AgentMode;
  initialPrompt?: string;
  includes?: string[];
  flags?: Record<string, FlagSpec>;
  model?: Partial<Record<Backend,string>>;
  effort?: { claude?: "low"|"medium"|"high"|"max"; codex?: "minimal"|"low"|"medium"|"high" };
  access?: Access;
  mcp?: Record<string,McpServer>;
  native?: {
    claude?: { args?: NativeArg[]; settings?: Record<string,unknown> };
    codex?: { args?: NativeArg[]; config?: Record<string,unknown> };
  };
}
```

`AgentSpec` adds path-derived `id` and resolved/defaulted prompt/mode fields and removes `includes`. Defaults: append, interactive, `{{args}}`. Empty body emits no prompt flag. Unknown keys error recursively except opaque native payloads, which are still checked for forbidden lifecycle/prompt keys. Duplicate/reserved flags/shorts/backends, enum-default mismatch, mixed MCP transports, undeclared native backend, bad references, and out-of-root realpath includes error with file/field. Body precedes stable-separated includes; binaries require no checkout assets.

### 3. Template, CLI, preview

Templates allow `{{args}}`, `{{cwd}}`, `{{flag.name}}`, and non-nested boolean/enum `if/else`; malformed/unknown/impossible references fail compile. No expressions/IO/commands.

CLI splits on first standalone `--`; tail is untouched. Before it, strict long separate/equals forms, declared shorts, booleans, and positionals apply. Framework `--model` overrides selected declared model; `--print` sets print; show supersedes execution. Backend order is D-021. Help covers description/default backend/mode/framework and agent flags/defaults/passthrough. Preview is exactly:

```text
Backend: <claude|codex>
--- System prompt ---
<text>
--- Initial prompt ---
<text>
--- Argv ---
["executable", ...]
```

Snapshots use fake process time and temporary workspaces, not a production clock field.

### 4. Extension and cancellation contract

The compiler reads TypeScript syntax without importing it and generated entries import only reserved extension exports.

```ts
interface CommandRequest { argv: [string, ...string[]]; cwd?: string; env?: Record<string,string> }
interface CommandResult { exitCode: number; stdout: string; stderr: string }
interface PrepareContext {
  readonly flags: Readonly<Record<string,string|boolean>>;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly backend: Backend;
  readonly spec: Readonly<AgentSpec>;
  readonly signal: AbortSignal;
  readonly runCommand: (request: CommandRequest) => Promise<CommandResult>;
}
type PrepareResult =
  | {
      systemPromptFragments?: string[];
      initialPrompt?: string;
      extraAllowRules?: { rules: string[]; additionalDirectories?: string[] };
      cwd?: string;
      flagOverrides?: Record<string,string|boolean>;
      afterRunMessages?: string[];
    }
  | { exit: { message: string; code: number } };
interface RunResult { exitCode:number; stdout?:string; stderr?:string }
```

`prepare`/`finish` may be sync/async. Runner revalidates declared flag overrides (Webfetch normalizes finite max turns to `max(1,floor(n))`, else 3), resolves cwd, freezes data, and merges Claude-only rules/directories; a nonempty rule object on Codex errors. After-run messages are forbidden for print-payload agents. Extensions must use `runCommand` for git/gh/other children; runner tracks one or more active preparation children, aborts/forwards signal, awaits termination, and removes listeners before exit.

### 5. Backend and execution contracts

| Concern | Claude | Codex |
|---|---|---|
| Append/replace | append/system flags | developer config/model-instructions temp file |
| Interactive | `claude [flags] -- prompt`, inherited IO | `codex [flags] prompt`, inherited IO |
| Print/stream | `--print`; stream JSON | `codex exec`; stream `--json`; stdin ignored |
| Model/effort | `--model`/`--effort` | `-m`/reasoning config |
| Access | plan/accept-edits/bypass | read-only/workspace-write/bypass |
| MCP | inline Claude JSON | `mcp_servers` TOML; HTTP uses `url/http_headers` |
| Config | inherit unless declared | inherit unless declared; skip Git check only outside worktree |

Claude native settings and prepared rules merge once; empty settings/MCP are omitted. Native args precede verbatim user tail; adapter owns final prompt placement. Codex append text is JSON-stringified; replace temp files are owner-only. Claude launches retain unique clean `TMPDIR`. Both are runner-owned resources cleaned on every exit.

`StreamDecoder` maps complete JSON lines to ordered stdout/stderr emissions. Claude assistant text goes stdout and non-assistant canonical JSON stderr; Codex completed agent-message text goes stdout and other canonical JSON stderr. Malformed JSON, decoder throw, or incomplete non-decodable final line produces a stderr diagnostic/code 1, terminates/awaits the backend when needed, cleans resources/listeners, and suppresses after-run completion messages. Already-emitted output cannot be retracted.

Runtime outcomes:

- Help: stdout/0, no prepare. Parse/cwd/backend: stderr/nonzero, no prepare.
- Prepare early exit: exact message/code. Prepare throw or command failure: interactive/stream stderr/1; print failure result goes to `finish`.
- Preview: redacted/0, no secret command/backend.
- Interpolation/adapter/spawn failure: interactive/stream stderr/1; print goes to `finish`.
- Interactive: inherited IO, child code, then messages. Print: captured success/failure → `finish` → transformed output/code. Stream: decoded output/child code/messages unless decoder failure; no `finish`.
- `finish` throw: cleanup then stderr/1, no recursion.
- Signal during preparation/interpolation/backend: abort/forward current tracked children, await/terminate, cleanup resources/listeners, signal-consistent nonzero exit.

Thus Webfetch maps operational failures to `ERROR:` stdout while invalid CLI/explicit early exits retain their own contract.

### 6. MCP trust

Interpolation visits MCP string leaves only. `${env:NAME}` reads launch env; `${cmd:...}` runs via the same cancellable runner command facility in effective cwd, trims one trailing line ending, and requires zero/nonempty output. Expansion is single-pass. Actual/display values travel together for redaction.

Only compiled Troupe declarations can declare commands; target-project files/runtime fragments cannot. Compile/help/preview never execute them; explicit agent launch is consent. Values remain uncached process data. The guide documents this boundary and GitHub's 1Password header.

### 7. Mixed migration compiler and final publication

The shared compiler has two explicit modes:

- **Migration mode:** discover union of Markdown and legacy non-test TypeScript names. Markdown wins a same-stem collision. Its paired TS is extension-only if static syntax exports `prepare`/`finish`, otherwise ignored as a legacy sibling. An unpaired TS remains directly built as its legacy launcher. Compile/watch switch to this mode before any agent conversion, so every binary is always either a working old launcher or a working new declaration.
- **Strict mode:** discover non-local Markdown only, require exact 23-name roster, reject any unpaired launcher, and build generated entries only. Final cutover enables this mode and removes fallback code/old launchers.

Both modes use one watcher/compiler. The watcher serializes its own queue, but cross-process ownership comes from an atomic lock directory under already-ignored `.cache/troupe/compile.lock`. Atomic creation wins; metadata records PID/start/token. A live owner makes another invocation wait or fail clearly without touching publication. A dead-owner lock is reported, removed, and reacquired; ambiguous live metadata blocks with manual-remediation guidance. Release happens in `finally`; crash recovery handles a stale dead owner.

Under lock:

1. Recover stale `next`. If only validated previous exists, restore it. If bin+previous exist, validate bin: valid bin wins and previous is removed; invalid bin is quarantined and validated previous is restored. If previous cannot be validated, halt without deleting either candidate.
2. Read/validate all source/include/extension contracts, then build exact stage in same parent. Failure removes stage, leaves bin.
3. Commit: validate previous candidate, rename bin→previous, next→bin. Install failure restores previous.
4. Validate installed bin. If invalid, quarantine it and restore validated previous; if restoration cannot be proven, retain all candidates and halt with remediation.
5. Only validated installed bin permits previous/quarantine cleanup. Crash between atomic renames is resolved by step 1. Signal before commit removes stage; synchronous rename interruption is reconciled at next locked start.

Single compile uses temp+rename under the same lock when targeting shared `bin/`. Dry-run validates/reports. Remove `--no-prune`. No in-memory roster/lock decides restart correctness.

### 8. Agent migration matrix

All except the seven specified restrictions declare `[claude,codex]`.

| Agent(s) | Ownership |
|---|---|
| Orient | quick/focus template; reminder in body |
| Builder | Claude-only; real Chrome MCP, tool rules, reminder |
| Comment Review | prepare diff/empty exit; Claude Edit/Read/Glob/Grep allow |
| Refactor, Designer | real Chrome MCP; Claude rules; Designer Claude sonnet/reminder |
| TDD, Rails Backlog | Claude-only; body reminder; dead settings dropped |
| Architect, Tailor | dual; Claude-only tool rules |
| Audit | expectations include; prepare mkdir/start; post-child message |
| Diagram all/consolidate/topic | restored bodies; prepare mkdir/start/post-child; topic validates/slugs required arg |
| Git Fix | prepare supplied/detected PR/error |
| Meta Prompt, Planner, Riff | declarative body; empty config dropped |
| Contain | Claude-only container MCP/allow/deny; remove deepwiki/default; reminder body |
| GitHub | Claude-only stream/replace; prepare requires only args[0]; strict declared HTTP MCP/tool list with 1Password interpolation; no SDK |
| PR Review | Claude-only; comment flag; prepare PR/conditional prompt; rules |
| Shepherd | dual; prepare persisted reconstruction, ordered fragments/cwd, Claude rules + additional directory |
| Webfetch | Claude print; flags and framework model; prepare usage/task/max-turn normalization; native WebFetch allow and Bash/Edit/Write/Read/Glob/Grep/Task/WebSearch deny; finish payload/ERROR |
| Coach | dual; prepare init/list, persisted roster/student/integrations, prompt/cwd, Claude-only dynamic rules |

Flat one-agent prompts move into Markdown bodies. Shared/dynamic fragments remain `system-prompts/expectations.md`, `system-prompts/shepherd/**`, and `system-prompts/coach/**`. Shepherd declares core/built-ins as includes, then prepare appends inherited, charter, local, header. Coach pack frontmatter stays a separate runtime content contract.

### 9. Test/removal/document ownership

Workers choose colocated tests; test files are not source ownership in Files to Change. Slice 1 owns schema/include/template/CLI/help/argv/preview. Slice 2 owns fake CLIs, cancellable preparation, interpolation, decoding/failures/cleanup/canary. Slice 3 owns mixed/strict discovery, lock contention/stale-owner, swap/recovery/watcher/roster. Each migration adds snapshots/regressions before deletion. Existing Webfetch tests are rewritten around extension helpers and preserved cases. Prompt prose is reviewed, not sentence-asserted.

Final cutover removes per-agent JSON, migrated flat prompts, assets, Claude helpers/types, Codex SDK, legacy launchers/fallback, and Agent SDK dependency; adds `yaml`/`zod`. Biome excludes authored Markdown from unsupported-file checks while retaining TS checks.

Add `docs/AGENT-FORMAT.md`, remove obsolete runtime proposal, update feature docs and targeted README plus AGENTS/CLAUDE links. Preserve rename context and document deprecated env aliases.

## Files to Change

- `package.json`, `bun.lock`, `biome.json` — dependencies/scripts/check scope.
- `lib/agent-format/types.ts`, `schema.ts`, `template.ts`, `cli.ts`, `run.ts` — new format core/composition.
- `lib/runtime/types.ts`, `claude-cli.ts`, `codex-cli.ts`, `index.ts` — adapter/process replacement.
- `lib/runtime/debug.ts`, `lib/runtime/codex-sdk.ts`, `lib/claude.ts`, `lib/flags.ts`, `lib/claude-flags.types.ts`, `lib/assets.ts`, `lib/assets.gen.ts`, `lib/forge-root.ts` — remove obsolete paths.
- `lib/index.ts` — export new contracts only.
- `scripts/agent-compiler.ts` — mixed/strict discovery, lock, includes/extensions, build/publication (new).
- `scripts/binary-name.ts`, `scripts/compile.ts`, `scripts/compile-all.ts`, `scripts/watch-agents.ts` — delegate shared compiler/modes.
- `scripts/gen-assets.ts` — remove.
- `agents/analyze/orient.md`, `agents/build/{builder,comment-review,refactor,tdd}.md`, `agents/design/{architect,audit,designer}.md`, `agents/design/diagram/{all,consolidate,topic}.md`, `agents/git/fix.md`, `agents/meta/prompt.md`, `agents/modes/contain.md`, `agents/personas/github.md`, `agents/plan/{planner,riff}.md`, `agents/rails/backlog.md`, `agents/resume/tailor.md`, `agents/review/pr.md`, `agents/shepherd.md`, `agents/tools/webfetch.md`, `agents/tutors/coach.md` — 23 declarations (new).
- `agents/build/comment-review.ts`, `agents/design/audit.ts`, `agents/design/diagram/{all,consolidate,topic}.ts`, `agents/git/fix.ts`, `agents/personas/github.ts`, `agents/review/pr.ts`, `agents/shepherd.ts`, `agents/tools/webfetch.ts`, `agents/tutors/coach.ts` — convert to extensions.
- `agents/analyze/orient.ts`, `agents/build/{builder,refactor,tdd}.ts`, `agents/design/{architect,designer}.ts`, `agents/meta/prompt.ts`, `agents/modes/contain.ts`, `agents/plan/{planner,riff}.ts`, `agents/rails/backlog.ts`, `agents/resume/tailor.ts` — remove at strict cutover.
- `settings/*.json` — remove after live data migration.
- `system-prompts/{builder-prompt,comment-review-prompt,design-architect,design-audit-prompt,designer-prompt,diagram-all-prompt,diagram-consolidate-prompt,diagram-topic-prompt,github-examples,orient-prompt,planner-prompt,pr-review-prompt,prompt-improver-prompt,rails-backlog-coordinator-prompt,refactor-prompt,resume-tailor,riff-prompt,tdd-coordinator-prompt,webfetch-prompt}.md` — remove after body migration.
- `system-prompts/shepherd/core.md` — update stale source references, preserve Context tiers.
- `docs/AGENT-FORMAT.md` — new single guide.
- `docs/AGENT-RUNTIME.md` — remove.
- `docs/SHEPHERD.md`, `docs/COACH.md`, `docs/WEBFETCH-SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `README.md` — targeted source/backend/authoring updates.

## Quality Contract

This human-required section declares no gate table or future binding state. Behavior ownership is: B-001–B-003 strict source/CLI/preview/snapshots; B-004–B-006 adapters/MCP/cancellable lifecycle/decoding; B-007–B-008 migration policies/prose/Shepherd; B-009 roster/lock/recovery/repository checks; B-010 canary; B-011 guide review; B-012 recorded smokes.

Use red-green-refactor per slice and observable argv/output/files/exits, not helper calls. Prompt prose is reviewed for meaning; routing/order/interpolation are tested. Negative/mutation checks catch flag leakage, append/replace swap, adapter-generated forbidden keys, dropped HTTP headers, missing fragments, undeclared fallback, wrong stream channel/failure handling, orphan preparation children, lost Webfetch safety, missing Shepherd directory, lock races/stale recovery, resource leaks, and partial publication.

Snapshots use temp workspaces/fake time. Planning-time structural investigation produced no mechanical evidence because no provider was available; sign-off resolves current capability bindings and records actual outcomes, while direct review covers any unavailable structural evidence.

## Risks

- **Legacy spec waiver:** current human direction authorizes use as-is, not new intent. Ratified collision still halts (`review-2.md PR-013`).
- **Backend drift:** repeat relevant experiment; ratified mapping conflicts halt.
- **Mixed-mode leakage:** strict cutover must prove no unpaired TS/fallback remains; otherwise B-009 fails.
- **Native/user escape:** authored data guarded, user tail raw; repeated prepared needs trigger core reconsideration.
- **Secrets/trust:** inability to prevent preview/error/debug disclosure aborts interpolation.
- **Extension creep:** direct child/backend spawn or framework parsing snaps back.
- **Permission asymmetry:** safety-dependent Claude rules require restriction/escalation, never Codex prose emulation.
- **Target variance:** handle monorepos, `.git` file/dir, non-git, spaces, symlinks/realpaths.
- **Publication ownership:** ambiguous/live lock or unvalidated recovery blocks rather than deleting candidates.
- **Structural evidence limitation:** planning had no mechanical evidence; unexpected duplicate runtime/high complexity requires refactor.
- **Scope:** new product behavior requires spec amendment; implementation complexity splits within fixed slices.

## Implementation Order

1. **Contract/preview vertical (B-001–B-004):** types, pure schema, template/CLI, both pure argv adapters, preparation/preview, static export inspection, minimal single compiler; one fixture compiles/previews both backends. No temporary runtime.
2. **Execution lifecycle (B-005/B-006/B-010):** cancellable `runCommand`, MCP/redaction, TMPDIR/temp prompt, process/signals, print finish-on-failure, messages, decoders and malformed/incomplete exits, fake CLIs/canary.
3. **Compiler migration/publication (B-009):** mixed and strict discovery, cross-process lock/stale handling, includes, exact staging, every recovery/rollback state, single rename, dry-run, watcher reuse. Switch package compile/watch to mixed mode now, before converting any agent.
4. **Ordinary migration (part B-007):** add ordinary Markdown/policies/reminders/snapshots. In mixed mode each `.md` atomically shadows its still-present legacy sibling while unpaired agents remain functional legacy binaries.
5. **Special extensions except Shepherd (B-006/B-007):** in same-stem pairs add Markdown and convert Comment Review, Audit, diagrams, Git Fix, GitHub, PR Review, Webfetch, Coach. Mixed compiler immediately builds the declaration+extension, never the hook as entry. Rewrite Webfetch tests.
6. **Shepherd (B-008):** characterize/convert nearest parent, order, realpath dedupe, additional directory+Read, Context tiers, env compatibility, fixed previews; compare `~/shepherds/*`.
7. **Strict cutover/cleanup/docs (B-009/B-011):** after all 23 work in mixed mode, enable strict mode, prove exact roster/no fallback, publish, remove old launchers/prompts/settings/assets/helpers/SDK, update Biome/guide/docs. No artifact references a deleted seam.
8. **Whole-roster acceptance (B-003/B-007–B-012):** full snapshots, named regressions, repository checks, exact binaries, canary, Shepherd workspaces, four smokes, prose review.

Every slice leaves owned behavior demonstrable. Evidence contradiction, secret leak, safety downgrade, unrepresentable ratified behavior, lock/recovery ambiguity, or unrecoverable publication halts under the deviation protocol.
