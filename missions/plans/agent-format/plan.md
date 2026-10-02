---
title: Declarative agent format
status: active
createdAt: '2026-09-29T17:31:56.878Z'
updatedAt: '2026-09-30T00:30:00.000Z'
---

## Overview

Replace 22 hand-written Claude launchers with strict Markdown declarations compiled to the same colon-named binaries. Each binary embeds one validated backend-neutral `AgentSpec`, imports an optional sibling `prepare`/`finish` extension, and selects a Claude Code or Codex argv adapter at launch. The 23rd launcher, `personas:github`, is removed rather than migrated (D-036). *(Amended 2026-10-02, D-036)*

`spec.md` is authoritative. The current human instruction to honor that unchanged legacy spec exactly is an explicit waiver of the newer canonical `Intent`/`INV-###`/`AC-###` shape for this plan; it does not authorize edits to the spec or invented invariants. Its Outcome, eight Ratified decisions, Requirements, Acceptance, and Out of scope are human ground. The following aliases are traceability indexes only:

- `REQ-001` Schema; `REQ-002` Prompt composition; `REQ-003` Initial prompt; `REQ-004` Flags; `REQ-005` Code hooks; `REQ-006` MCP; `REQ-007` Codex adapter; `REQ-008` Migration; `REQ-009` Shepherd 2026-09-25 behavior; `REQ-010` Removal; `REQ-011` Docs.
- `ACC-001` repository checks/exactly 22 binaries *(Amended 2026-10-02, D-036)*; `ACC-002` agent × declared-backend previews; `ACC-003` Codex developer-message canary; `ACC-004` named regressions; `ACC-005` four interactive smokes; `ACC-006` per-workspace Shepherd previews.

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
  - Decision: **The hub holds agents only.** No utilities. The 22-agent roster is fixed (see agent-usage.md; `personas:github` removed by D-036). *(Amended 2026-10-02, D-036)*
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

- **D-011 - One shared compiler, single-process build then rename** *(Revised 2026-09-29 after review)*
  - Decision: `compile`, `compile:all` and the watcher use one shared compiler. `compile:all` builds all 22 binaries in one process into a temporary directory on the same filesystem as `bin/`. Only when every build succeeds does it rename each binary into `bin/` and then prune orphans. A failed build removes the temporary directory and leaves `bin/` untouched. The existing `--dry-run` (report, build nothing) and `--no-prune` (rebuild, leave orphans) flags keep their meaning. The compiler owns `bin/` for the fixed roster: private agents under `agents/local/` are no longer supported, because the hub holds exactly the 22 (D-008). Single compile accepts only roster names, and pruning removes every `bin/` entry outside the roster except binaries owned by other package `compile:*` scripts (the existing protection rule; none exist today). There is no cross-process lock, no `previous`/`next`/quarantine protocol and no manifest validation (D-023). *(Amended 2026-10-02, D-036)*
  - Alternatives: One-by-one overwrite in place; the earlier revision's cross-process lock with `bin → previous`/`next → bin` recovery (cut, D-023); keeping `agents/local/` outside the exact-23 count.
  - Why: The spec asks for a shared compiler, watcher reuse and exactly 23 binaries (REQ-010, ACC-001), nothing more. Addresses `review-1.md PR-011` and `review-2.md PR-011` within spec scope; applies the Shepherd orchestrator's decision on independent-review findings 2, 16 and 17.
  - Decided by: Shepherd orchestrator, 2026-09-29 after review; dropping `agents/local/` support goes to the human gate

- **D-012 - Preview is deterministic and secret-safe**
  - Decision: `--show-prompt` runs preparation with `ctx.preview === true` but no backend or `${cmd:...}` substitution. It prints backend, system prompt, initial prompt, and JSON argv; secrets/temp paths use stable redacted placeholders. Preview-mode preparation writes nothing to the filesystem, runs no network children, and prints nothing itself; runner-owned `beforeRunMessages`/`afterRunMessages` are never emitted in preview.
  - Alternatives: Live tokens, compile-time-only preview, or letting prepare detect preview by other means.
  - Why: REQ-004/ACC-002 plus credential safety; the fixed envelope must survive agents whose prepare creates directories or calls `gh`. Addresses `review-3.md PR-017` and independent-review finding 14.
  - Decided by: planner-proposed; preview flag and side-effect rule revised 2026-09-29 after review

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
  - Decision: `extraAllowRules` contains rules plus additional directories; validated `flagOverrides` lets an extension normalize declared flag values (Webfetch no longer uses it: its max turns is a fixed native Claude arg, D-037) *(Amended 2026-10-02, D-037)*; `beforeRunMessages` owns pre-child start banners and `afterRunMessages` owns post-child banners, both emitted by the runner on execution only. `PrepareContext` exposes the effective invocation `mode` and a `preview` flag. Early exits name their output stream, and `finish` has an explicit signature (Design §4). These are invocation data, not raw argv.
  - Alternatives: Stringly hide directories, mutate spec, let prepare print directly, or drop behavior.
  - Why: Preserve Shepherd, Webfetch, diagram/audit banners, and interactive completion behavior. Addresses `review-1.md PR-001`, `PR-004`, `PR-007`, `review-3.md PR-016`, `PR-017`, `PR-018`.
  - Decided by: planner, revision from `review-1.md PR-001`, `PR-004`, `PR-007`; extended 2026-09-29 after `review-3.md`

- **D-017 - Migration compiler supports a temporary mixed source set**
  - Decision: Before migrating agents, package compile/watch switch to the shared compiler in explicit migration mode: `.md` wins over same-stem legacy `.ts`; paired TypeScript is imported only when it exports `prepare`/`finish` and its top level is statically side-effect free; an unpaired non-test `.ts` remains a legacy launcher entry. Final strict mode rejects any non-test `.ts` under `agents/` that is not a same-stem sibling statically exporting `prepare`/`finish`, and removes the fallback.
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

- **D-021 - `FORGE_BACKEND` is dropped** *(Revised 2026-09-30 at the human gate)*
  - Decision: No generated binary reads `FORGE_BACKEND`. Backend resolution is explicit `--backend`, then the first declared backend (ratified decision 5). An explicit `--backend` naming an undeclared backend fails hard with D-005's clear message. The env var, its legacy aliases (`claude-cli`, `codex-cli`, `codex-sdk`) and `getBackend` in `lib/flags.ts` are removed with the legacy launchers; the docs stop mentioning it. A shell alias (for example `alias shepherd-codex='shepherd --backend codex'`) is the user's way to avoid typing the flag.
  - Alternatives: The planner's global env selector (broke the seven Claude-only agents under an exported value); an env preference honored only by agents that declare that backend (the orchestrator's earlier D-022); scoping the variable to Shepherd only.
  - Why: The user decided at the human gate (2026-09-30) to drop the variable for now and reconsider later. It keeps ratified decision 5 intact and removes the ambient-environment failure mode entirely. Shepherd's documented `FORGE_BACKEND` behavior (REQ-008) is an intended change, recorded next to D-028. Addresses independent-review findings 1, 7 and 13.
  - Decided by: the user, 2026-09-30, human gate

- **D-023 - Crash-safe publication cut to spec scope** *(Added 2026-09-29 after review)*
  - Decision: Remove the cross-process lock under `.cache/troupe/compile.lock`, the `bin`/`previous`/`next`/quarantine protocol, restart recovery, the validated-bin predicate, and the removal of `--no-prune`. Publication is D-011's single-process build into a temporary directory followed by renames.
  - Alternatives: Keep the protocol as unratified scope; define a manifest-based validation predicate (independent-review finding 17's fix).
  - Why: None of it is in the spec, and the plan's own Scope risk says new product behavior needs a spec amendment. A manifest predicate would only serve the removed recovery protocol. Crash-safe publication can return as a separately ratified follow-up.
  - Decided by: Shepherd orchestrator, 2026-09-29 after review (independent-review findings 2 and 17)

- **D-024 - Adapters live in a new namespace beside the legacy runtime** *(Added 2026-09-29 after review)*
  - Decision: `BackendAdapter`, `CommandPlan`, `StreamDecoder` and the Claude/Codex adapters are new modules under `lib/agent-format/adapters/`. The existing `lib/runtime/**`, `lib/flags.ts`, `lib/claude.ts` and `lib/index.ts`'s `export * from "./runtime"` stay compiled and typechecked, unchanged, until Implementation step 7 removes them with the last legacy launcher and their colocated tests.
  - Alternatives: Replace `lib/runtime` in place during steps 1-2, which breaks legacy Shepherd and Webfetch until steps 5-6.
  - Why: D-017 promises every binary is a working old launcher or a working new declaration after every step. Addresses independent-review findings 9 and 19 and `review-3.md PR-019`.
  - Decided by: planner, 2026-09-29 after review

- **D-025 - Template conditionals cover orient without a behavior change** *(Added 2026-09-29 after review)*
  - Decision: The template grammar allows one level of `if / else if / else` over boolean flags, enum equality and `args` truthiness. Nesting stays forbidden.
  - Alternatives: Accept orient changes (both texts under `--quick --focus`, a dangling "Additional context:" label) or give orient a `prepare`.
  - Why: The spec requires conditionals "enough for orient `--quick/--focus`"; today quick overrides focus and the context suffix appears only with arguments. Addresses independent-review finding 10.
  - Decided by: planner, 2026-09-29 after review

- **D-026 - `${cmd:...}` is tokenized into argv without a shell** *(Added 2026-09-29 after review)*
  - Decision: The command text is split shell-style (single and double quotes, backslash escapes) into an argv array and run through `runCommand` with no shell. Pipes, redirection, globbing, `;`/`&&` and variable expansion are not supported and fail compile. GitHub's `op signin --raw` preflight moves into GitHub's `prepare`, runs through `runCommand` on execution only, and its output is discarded as today.
  - Alternatives: `sh -c` (a new quoting and injection contract), whitespace splitting (breaks `"Github CLI Token"`), or dropping the sign-in preflight.
  - Why: REQ-006 names the 1Password token; its item name has spaces. Keeping the preflight preserves today's launch order at no cost. Addresses `review-3.md PR-020` and independent-review finding 12.
  - Decided by: planner, 2026-09-29 after review

- **D-027 - Includes stay inside the watched roots** *(Added 2026-09-29 after review)*
  - Decision: An include's realpath must fall under `agents/` or `system-prompts/`; anything else is a compile error naming file and field. The watcher watches exactly those two roots.
  - Alternatives: Compiler-produced dependency subscriptions refreshed on each declaration change.
  - Why: A valid include elsewhere in the repository would compile once and then go stale under `bun watch`. All current shared fragments already live under `system-prompts/`. Addresses `review-3.md PR-021`.
  - Decided by: planner, 2026-09-29 after review

- **D-028 - Backend flags now follow `--`** *(Added 2026-09-29 after review)*
  - Decision: Strict pre-`--` parsing (REQ-004) means backend flags such as `--resume`, `--permission-mode` and Claude's `-p` must follow `--` (for example `shepherd -- --resume <id>`). This is an intended user-visible change from the spec's D2/D3 fixes, not a regression. No unknown-flag forwarding or `-p` alias is added.
  - Alternatives: Forward unknown flags for Contain, Shepherd and Coach, which re-opens D3.
  - Why: Spec REQ-004 is explicit; the docs that promise direct passthrough must change with it. Addresses independent-review finding 11.
  - Decided by: planner, 2026-09-29 after review, applying spec REQ-004

- **D-029 - MCP header secrets travel by environment, not argv** *(Added 2026-09-30 at the human gate)*
  - Decision: A header value produced by `${env:NAME}` or `${cmd:...}` interpolation is never placed literally in the backend argv or in a config file the backend reads. The runner exports each resolved secret into the child's environment under a generated variable name (`TROUPE_MCP_<server>_<header>`), and the adapter emits an env reference: Claude MCP JSON `${VAR}` in the header value, Codex `env_http_headers` (or `bearer_token_env_var` for a bare bearer token). Literal, non-interpolated header values still map literally. B-005's "not persisted/printed" extends to process listings.
  - Alternatives: Literal header values on argv as today (visible in `ps` for the life of the process); a local credential proxy such as Executor (executor.sh), which holds credentials in its own sandbox and exposes one MCP endpoint to every agent, so no agent declaration carries a secret at all. Executor is recorded as a candidate follow-up for personas:github, not part of this plan.
  - Why: The user chose it at the human gate (2026-09-30) after independent-review finding 12 and the Risks entry. The evidence verifies literal header mapping only, so Step 2 carries one experiment that verifies both env-reference forms on the installed CLIs before the adapters rely on them; a failed experiment halts per "Backend drift".
  - Decided by: the user, 2026-09-30, human gate

- **D-030 - Preview exits are diagnostics** *(Added 2026-09-30 after review)*
  - Decision: In `--show-prompt`, an early exit from `prepare` is reported on stderr and the process exits 1 regardless of the declared code.
  - Alternatives: Honor the early exit's named stream and code as Design §5 does for execution.
  - Why: Preview output is for humans and CI and must never be mistaken for a run result.
  - Decided by: Shepherd orchestrator

- **D-031 - Preview shows one backend per run** *(Added 2026-09-30 after review)*
  - Decision: `--show-prompt` prints the envelope for the resolved backend (explicit `--backend`, else the first declared); per-backend snapshots select each backend explicitly.
  - Alternatives: One envelope per declared backend in a single run.
  - Why: Matches Design §3's single `Backend:` line and lets `prepare` see one `ctx.backend`.
  - Decided by: Shepherd orchestrator

- **D-032 - A stdio MCP `cwd` is rejected when Claude is a declared backend** *(Added 2026-10-01 at the human gate)*
  - Decision: Compile fails, naming file and field, when an agent whose declared backends include `claude` declares `cwd` on a stdio MCP server. An agent that declares only `codex` may use it, and the Codex adapter emits it. The Claude adapter never emits `cwd`.
  - Alternatives: Wrap the server in a no-shell launcher that sets the directory (more machinery, no agent needs it today); document `cwd` as Codex-only without enforcing it (fails open).
  - Why: The TASK-006 experiment (evidence row 5e, Claude Code 2.1.287) showed Claude accepts the field silently and starts the server in its own cwd. No roster agent declares a stdio `cwd`, so failing closed costs nothing today.
  - Decided by: the user, 2026-10-01, human gate

- **D-033 - Literal `${` in MCP strings is rejected when Claude is a declared backend** *(Added 2026-10-01 at the human gate)*
  - Decision: Compile fails, naming file and field, when an agent whose declared backends include `claude` has an MCP string leaf that contains `${` outside Troupe's own `${env:NAME}` and `${cmd:...}` references. With that, D-029's "literal values map literally" holds by construction on both backends.
  - Alternatives: Accept Claude's expansion and document it; route such values through the env-reference path (works for headers only).
  - Why: The TASK-006 experiment (evidence row 5d) showed Claude expands `${VAR}` in every inline MCP string, and neither `$${X}` nor `\${X}` keeps it literal.
  - Decided by: the user, 2026-10-01, human gate

- **D-034 - Codex header secrets use `env_http_headers` only** *(Added 2026-10-01 at the human gate)*
  - Decision: The Codex adapter emits `env_http_headers` for every interpolated header, as TASK-003 implemented. `bearer_token_env_var` is not emitted.
  - Alternatives: `bearer_token_env_var` for bare bearer tokens (verified to work, evidence row 5c), which would make the runner split the scheme from the token.
  - Why: One form covers every header; the second adds a special case for no gain.
  - Decided by: the user, 2026-10-01, human gate

- **D-035 - Codex append mode replaces a user's own `developer_instructions`** *(Added 2026-10-01 at the human gate)*
  - Decision: Accepted as a known limitation. In append mode the agent's `-c developer_instructions` replaces a `developer_instructions` value from the user's Codex config or profile; Troupe does not read the user's config to combine them. The authoring guide documents it, and a canary test pins the behavior so a Codex change is noticed.
  - Alternatives: Have the runner read the user's Codex config and concatenate (breaks D-004's stance of not reading or rewriting user config).
  - Why: Found in the TASK-007 review and recorded in evidence §2.1 (codex-cli 0.159.3). The base developer items Codex itself adds are kept, which is what D-003 protects.
  - Decided by: the user, 2026-10-01, human gate

- **D-036 - personas:github is removed from the hub** *(Added 2026-10-02)*
  - Decision: `personas:github` is deleted: its legacy launcher, its private prompt `system-prompts/github-examples.md`, its roster entry and its binary. The roster is 22 agents and strict mode requires exactly those 22. The six remaining Claude-only agents (rails:backlog, tdd, builder, review:pr, webfetch, contain) are unchanged. The `@anthropic-ai/claude-agent-sdk` dependency, which only this launcher imported, goes with it. The MCP secret-interpolation mechanism (`${env:...}`, `${cmd:...}`, D-026, D-029, D-032 to D-034) stays in the format with no current user.
  - Alternatives: Migrate it as planned (Design §8's former GitHub row); keep it as a legacy launcher outside the format.
  - Why: The user, 2026-10-02: "the github agent is providing a complexity that we don't need by now and I haven't used it in ages and still coupled with things like one password let's just remove that one I don't care about it". The TASK-013 review also left three majors unresolved: the run was no longer isolated from user config (no `--strict-mcp-config` or `--setting-sources ""`), its seven tools had no permission grant in stream mode, and the token's environment variable is readable by a same-user `ps eww`.
  - Decided by: the user, 2026-10-02

- **D-037 - Webfetch's max turns is fixed at 3** *(Added 2026-10-02)*
  - Decision: Webfetch declares no `max-turns` flag, so `webfetch --max-turns 5` before `--` is rejected like any unknown flag. The cap is the static native Claude arg `--max-turns=3` under `native.claude.args`. `prepare` does no max-turn normalization and returns no `flagOverrides` for it. No flag-to-native-arg binding is added to the format; `flagOverrides` stays in the extension contract unchanged.
  - Alternatives: A native-arg binding to a declared flag's value; passthrough only.
  - Why: The user chose the simplest option ("you can just drop the flag"). Declared flags reach only prompt templates, so a normalized value had no route into Claude's argv. No documented caller passes `--max-turns` (`docs/WEBFETCH-SKILL.md` and the installed skills), and a binding would add a core seam for one agent.
  - Decided by: the user, 2026-10-02

## Behaviors

### B-001 - Definitions compile strictly
- Source: REQ-001, REQ-002, decisions 1 and 8
- Observer: an agent author compiling one definition or roster
- Entry point: single/all compile
- Outcome: valid Markdown becomes the path-derived binary with ordered embedded body/includes and actual extension; malformed/unknown/cross-field/include/roster errors name file and field and publish nothing partial. Includes outside `agents/` or `system-prompts/` (D-027), `${cmd:...}` text that needs a shell (D-026), and a paired extension with top-level side effects fail compile with file and line.

### B-002 - Generated binaries share one predictable CLI
- Source: REQ-004, decision 5 (D-021: no env selection)
- Observer: terminal user
- Entry point: any binary's framework/agent flags, positionals, environment compatibility, and `--`
- Outcome: framework and declared bool/enum/string flags are consumed with defaults and both value forms; unknown pre-separator input fails, so backend flags go after `--` (D-028); tail tokens remain verbatim. Backend precedence follows D-021: explicit `--backend`, then the first declared backend; an explicit `--backend` naming an undeclared backend fails. No binary reads `FORGE_BACKEND`.

### B-003 - Real composed prompts are previewable
- Source: REQ-002–REQ-004, ACC-002
- Observer: user/maintainer
- Entry point: every agent × declared backend with `--show-prompt`
- Outcome: fixed-format preview contains compiled/prepared system prompt, rendered initial prompt, and adapter argv, then exits without backend/secret command, filesystem writes, network children or banners; fixed-clock/workspace snapshots cover the full matrix, and previewing Audit and the diagram agents leaves the temp workspace unchanged.

### B-004 - Adapters preserve backend semantics and user config
- Source: REQ-007, decisions 2–6
- Observer: user launching Claude/Codex
- Entry point: default or selected backend
- Outcome: only declared prompt mode/mode/model/effort/access/MCP/cwd/native concerns become verified argv; undeclared policy/isolation remains absent; Claude stream mode emits `--print --output-format stream-json --verbose`; Codex exec ignores stdin, skips Git check only when the runner's worktree probe says the cwd is outside a worktree, and adapter-generated argv never uses exec `-a` or `base_instructions`. One recorded real-CLI Claude stream-mode launch proves the stream argv.

### B-005 - MCP launches without exposing secrets
- Source: REQ-006, REQ-007
- Observer: user of declared stdio/HTTP MCP
- Entry point: actual launch
- Outcome: both transports map correctly; env/command interpolation occurs only at launch; `${cmd:...}` becomes argv by quote-aware splitting with no shell, so a quoted argument (for example the item name in `op item get "Github CLI Token" --fields password --reveal`) reaches the process as one argument; missing/failed/interrupted resolution stops before backend with cleanup; secrets are not persisted/printed, and interpolated header values never appear in argv, backend config files or process listings (D-029: env reference, secret exported into the child's environment); Chrome uses `chrome-devtools-mcp`. No roster agent declares `${cmd:...}` after D-036; the mechanism stays tested with fixtures. *(Amended 2026-10-02, D-036)*

### B-006 - Extensions and modes have deterministic exits
- Source: REQ-005, decision 6
- Observer: user invoking composition, early command, print, or stream
- Entry point: generated binary plus optional extension
- Outcome: preparation sees the effective mode and preview flag, returns validated invocation data or an early exit on a named stream, and uses cancellable runner commands; before-run messages print after preparation and before spawn; interactive inherits IO, print finishes success/operational failures through the typed `finish`, stream uses adapter decoder, after-run messages follow successful decoding; hook/child/adapter/decoder/finish/signal failures have specified output/code/cleanup. Importing a converted extension spawns no process and does not exit.

### B-007 - All 22 agents preserve intended behavior and remove named defects
- Source: REQ-008, REQ-010, ACC-004
- Observer: existing binary users
- Entry point: migrated 22 names *(Amended 2026-10-02, D-036)*
- Outcome: meaningful prompt/permission/MCP/mode/CLI/output behavior remains; dead settings/empty MCP/default mode/wrong project env/assets/lifecycle echoes are dropped or moved; named regressions are fixed; six specified agents are Claude-only and all others declare Claude then Codex *(Amended 2026-10-02, D-036)*. The one intended CLI change is that backend flags follow `--` (D-028). Orient keeps quick-over-focus and the argument-only context suffix, pinned by `orient`, `orient --quick --focus tech` and `orient foo`.

### B-008 - Shepherd preserves enclosing workspace and context tiers
- Source: REQ-009, ACC-006
- Observer: nested-workspace Shepherd user
- Entry point: preview/launch on either backend
- Outcome: nearest parent modules are sorted after built-ins/before charter, duplicate-realpath locals skipped, local follows charter; Claude receives both the additional directory and the literal rule `Read(/<realpath of enclosing>/.shepherd/**)`, which renders as `Read(//abs/...)` exactly like `agents/shepherd.ts:81`; prepare returns rules only when `ctx.backend === "claude"`, so a Codex preview of a nested workspace shows the inherited fragments with no rule error; `shepherd --print` without a prompt still fails before spawn; Context tiers/flock module/directory remain observable and match the `e18f56b` baseline.

### B-009 - Build publishes the 22-binary roster
- Source: REQ-010, ACC-001
- Observer: maintainer
- Entry point: repository type/style/test workflows, `compile`, `compile:all` (with `--dry-run` and `--no-prune`) and `bun watch`
- Outcome: checks pass with exactly 22 binaries (D-036); compile, compile-all and the watcher share one compiler; a failed build leaves `bin/` untouched; orphans outside the roster are pruned unless `--no-prune`; `--dry-run` reports without writing; single compile rejects names outside the roster; `agents/local/` is not compiled; obsolete paths are removed. *(Amended 2026-10-02, D-036)*

### B-010 - Codex receives a developer message
- Source: ACC-003
- Observer: maintainer with Codex
- Entry point: prompt-debug using adapter canary args
- Outcome: canary is a developer message and base remains; absent skips explicitly, installed failure fails.

### B-011 - Authors have one accurate reference
- Source: REQ-011
- Observer: contributor
- Entry point: guide linked from README/AGENTS/CLAUDE
- Outcome: one guide covers schema, prompts/templates, flags and `--` passthrough, extension data/cancellation, MCP trust (including Codex project auto-trust), the backend mapping table (portable fields to Claude/Codex argv from Design §5 and D-014: append/replace, mode, model/effort, access, MCP, config inheritance) plus the `native.claude`/`native.codex` escape hatch, backend selection (`--backend` only; no env selection), the strict compiler and publication, and examples; active docs contain no stale path, backend, CLI passthrough or private-agent guidance.

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
- `run.ts`: CLI → prepare → render → interpolation → adapter/preview → execute/decode → finish/messages → cleanup. It owns process support: spawning, the Codex worktree probe, temp resources, signals and cleanup.
- `lib/agent-format/adapters/types.ts`: `BackendAdapter`, `Invocation`, `CommandPlan`, `StreamDecoder` (Design §5); `claude.ts`/`codex.ts` own wire formats; `index.ts` selects an adapter by backend id. Adapters are pure: they receive resolved values and resource paths and never probe the filesystem or spawn.
- `scripts/agent-compiler.ts`: discovery, realpath/include IO, static extension inspection, mixed/strict source selection, generated entries, temp-dir build, rename and prune.

The legacy `lib/runtime/**`, `lib/flags.ts`, `lib/claude.ts` and `lib/index.ts`'s runtime re-export stay unchanged and typechecked beside the new modules until Implementation step 7 (D-024). No compatibility runtime remains after strict cutover. Planning-time analysis produced no mechanical complexity/duplication/boundary/trace evidence because no provider was available; implementation sign-off resolves whatever capabilities are available then and supplements absent evidence with direct review.

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

`AgentSpec` adds path-derived `id` and resolved/defaulted prompt/mode fields and removes `includes`. Defaults: append, interactive, `{{args}}`. Empty body emits no prompt flag. Unknown keys error recursively except opaque native payloads, which are still checked for forbidden lifecycle/prompt keys. Duplicate/reserved flags/shorts/backends, enum-default mismatch, mixed MCP transports, undeclared native backend, bad references, and includes whose realpath is outside `agents/` or `system-prompts/` (D-027) error with file/field. Body precedes stable-separated includes; binaries require no checkout assets.

### 3. Template, CLI, preview

Templates allow `{{args}}`, `{{cwd}}`, `{{flag.name}}`, and one level of `if / else if / else` whose conditions are a boolean flag, an enum flag equal to a declared value, or `args` (true when positionals are non-empty) (D-025). Nesting is forbidden; malformed/unknown/impossible references fail compile. No expressions/IO/commands. Orient's template therefore renders quick, else each focus value, else full orientation, then `Additional context: {{args}}` only under `if args`.

CLI splits on first standalone `--`; tail is untouched. Before it, strict long separate/equals forms, declared shorts, booleans, and positionals apply. Framework `--model` overrides selected declared model; `--print` sets print; show supersedes execution. Backend order is D-021 (`--backend`, then the first declared backend; no environment values). Help covers description/default backend/mode/framework and agent flags/defaults/passthrough. Preview is exactly:

```text
Backend: <claude|codex>
--- System prompt ---
<text>
--- Initial prompt ---
<text>
--- Argv ---
["executable", ...]
```

Nothing else reaches stdout in preview: no prepare output, no before/after-run messages. Snapshots use fake process time and temporary workspaces, not a production clock field.

### 4. Extension and cancellation contract

The compiler reads TypeScript syntax without importing it and generated entries import only reserved extension exports. Because an ES import still evaluates the whole module, static inspection also rejects a paired extension whose top level contains anything other than imports, exports, type/interface declarations, function/class declarations, and `const` declarations with side-effect-free initializers (literals, arrow/function expressions, object/array literals of those). Value imports are limited to packages, builtins and the framework module; relative imports, side-effect imports and re-exports are rejected, because importing a module runs it. The inspection guards against accidental launches, not against a hostile author. Expression statements, top-level `await`, `if`/`try` blocks and call-expression initializers fail compile with file and line.

```ts
interface CommandRequest { argv: [string, ...string[]]; cwd?: string; env?: Record<string,string> }
interface CommandResult { exitCode: number; stdout: string; stderr: string }
interface PrepareContext {
  readonly flags: Readonly<Record<string,string|boolean>>;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly backend: Backend;
  readonly mode: AgentMode;          // effective mode after --print, not spec.mode
  readonly preview: boolean;         // true under --show-prompt
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
      beforeRunMessages?: string[];
      afterRunMessages?: string[];
    }
  | { exit: { message: string; code: number; stream: "stdout" | "stderr" } };
interface RunResult { exitCode: number; stdout: string; stderr: string; failure?: { stage: "prepare"|"interpolation"|"adapter"|"spawn"|"backend"; message: string } }
interface FinishResult { exitCode: number; stdout?: string; stderr?: string }
type Finish = (result: RunResult, ctx: PrepareContext) => FinishResult | Promise<FinishResult>;
```

`prepare`/`finish` may be sync/async. An early exit writes `message` to the named stream and exits with `code` (Webfetch's missing-URL `ERROR:` goes to stdout with 64; Git Fix's no-PR usage goes to stderr). `finish` runs only in print mode, receives the captured result including operational failures, and its `FinishResult` is written verbatim (absent streams write nothing) with its exit code. Runner revalidates declared flag overrides (Webfetch declares no max-turns flag; its cap is the fixed native arg `--max-turns=3`, D-037 *(Amended 2026-10-02, D-037)*), resolves cwd, freezes data, and merges Claude-only rules/directories; a nonempty rule object on Codex errors (fail-closed), so dual-backend extensions (Shepherd, Coach) return `extraAllowRules` only when `ctx.backend === "claude"`. Before-run messages go to stdout after preparation and before spawn; after-run messages follow a successful run. Both are execution-only and forbidden for print-payload agents. With `ctx.preview` true, preparation must not write files, run network children or print; it computes paths and returns the same prompt data. Extensions branch on `ctx.mode` for mode-dependent guards (Shepherd rejects print without a prompt). Extensions must use `runCommand` for git/gh/other children; runner tracks one or more active preparation children, aborts/forwards signal, awaits termination, and removes listeners before exit.

### 5. Backend and execution contracts

| Concern | Claude | Codex |
|---|---|---|
| Append/replace | append/system flags | developer config/model-instructions temp file |
| Interactive | `claude [flags] -- prompt`, inherited IO | `codex [flags] -- prompt`, inherited IO |
| Print/stream | `--print`; stream `--print --output-format stream-json --verbose` | `codex exec [flags] -- prompt`; stream `--json`; stdin ignored |
| Model/effort | `--model`/`--effort` | `-m`/reasoning config |
| Access | plan/accept-edits/bypass | read-only/workspace-write/bypass |
| MCP | inline Claude JSON; interpolated header values as `${VAR}` env references (D-029); no stdio `cwd` (D-032) and no literal `${` (D-033), both rejected at compile | `mcp_servers` TOML; stdio `cwd` allowed for Codex-only agents; HTTP uses `url/http_headers`, interpolated values via `env_http_headers` (D-029, D-034) |
| Config | inherit unless declared | inherit unless declared; skip Git check only outside worktree |

The `--` keeps a prompt that matches a subcommand or starts with a dash from being parsed as one (verified on Codex 0.159). *(Added 2026-09-30 after review)*

Claude rejects `--print --output-format stream-json` without `--verbose` (verified on Claude Code 2.1.285; `evidence/backend-matrix.md` row 10c omits it), so the Claude stream argv always carries `--verbose` and the fake Claude CLI rejects stream-json without it.

The adapter boundary is:

```ts
interface ResolvedValue { actual: string; display: string }   // display is the redacted form
interface Invocation {
  spec: Readonly<AgentSpec>; backend: Backend; mode: AgentMode;
  systemPrompt: string; initialPrompt: string; cwd: string; model?: string;
  flags: Readonly<Record<string,string|boolean>>;
  extraAllowRules?: { rules: string[]; additionalDirectories?: string[] };
  mcp: Record<string, ResolvedMcpServer>;         // McpServer with every string leaf a ResolvedValue (placeholders in preview)
  passthrough: readonly string[];                  // verbatim tail after --
  insideGitWorktree: boolean;                      // probed by run.ts, input to Codex exec argv
}
interface ResourceNeeds { promptFile?: string /* text to write */; tmpDir?: boolean }
interface ResourcePaths { promptFile?: string; tmpDir?: string }  // real at launch, stable placeholders in preview
interface CommandPlan {
  executable: string; argv: string[]; displayArgv: string[];
  cwd: string;                                     // inv.cwd; the runner spawns here (Added 2026-09-30 after review)
  stdin: "inherit" | "ignore"; stdout: "inherit" | "pipe"; stderr: "inherit" | "pipe";
  env: Record<string,string>;                      // additions only, e.g. TMPDIR
}
type Emission = { stream: "stdout" | "stderr"; text: string };
interface StreamDecoder { line(text: string): Emission[]; end(): Emission[] }  // throws on malformed input
interface BackendAdapter {
  readonly id: Backend;
  resources(inv: Invocation): ResourceNeeds;
  build(inv: Invocation, paths: ResourcePaths): CommandPlan;
  decoder(): StreamDecoder;
}
```

`run.ts` asks the adapter for `resources`, creates them (owner-only prompt file, clean TMPDIR) or substitutes placeholders in preview, then calls `build`. It probes `git rev-parse --is-inside-work-tree` in the effective cwd through the runner command facility before building a Codex print/stream plan, so the adapter stays pure. A new backend adds one adapter module and one id; agent files do not change (D-002).

Claude native settings and prepared rules merge once; empty settings/MCP are omitted. Native args precede verbatim user tail; adapter owns final prompt placement. Codex append text is JSON-stringified; replace temp files are owner-only. Claude launches retain unique clean `TMPDIR`. Both are runner-owned resources cleaned on every exit.

`StreamDecoder` maps complete JSON lines to ordered stdout/stderr emissions. Claude assistant text goes stdout and non-assistant canonical JSON stderr; Codex completed agent-message text goes stdout and other canonical JSON stderr. Malformed JSON, decoder throw, or incomplete non-decodable final line produces a stderr diagnostic/code 1, terminates/awaits the backend when needed, cleans resources/listeners, and suppresses after-run completion messages. Already-emitted output cannot be retracted.

Runtime outcomes:

- Help: stdout/0, no prepare. Parse/cwd/backend: stderr/nonzero, no prepare.
- Prepare early exit: exact message on its named stream, exact code. Prepare throw or command failure: interactive/stream stderr/1; print failure result goes to `finish`.
- Preview: redacted/0, no secret command/backend.
- Interpolation/adapter/spawn failure: interactive/stream stderr/1; print goes to `finish`.
- Interactive: inherited IO, child code, then messages. Print: captured success/failure → `finish` → transformed output/code. Stream: decoded output/child code/messages unless decoder failure; no `finish`.
- `finish` throw: cleanup then stderr/1, no recursion.
- Signal during preparation/interpolation/backend: abort/forward current tracked children, await/terminate, cleanup resources/listeners, signal-consistent nonzero exit.

Thus Webfetch maps operational failures to `ERROR:` stdout while invalid CLI/explicit early exits retain their own contract.

### 6. MCP trust

Interpolation visits MCP string leaves only. `${env:NAME}` reads launch env; `${cmd:...}` text is split shell-style (single/double quotes, backslash escapes) into argv and run with no shell via the same cancellable runner command facility in effective cwd; it trims one trailing line ending and requires exit zero and nonempty output (D-026). Shell operators, globbing and variable expansion fail compile. Expansion is single-pass. Actual/display values travel together for redaction.

Only compiled Troupe declarations can declare commands; target-project files/runtime fragments cannot. Compile/help/preview never execute them; explicit agent launch is consent. Values remain uncached process data. The guide documents this boundary and how a header secret is declared with `${cmd:...}` or `${env:...}`. An extension that needs a pre-step before interpolation (for example a credential sign-in) runs it in `prepare` through `runCommand` on execution only (not in preview); interpolation follows preparation. *(Amended 2026-10-02, D-036)*

This boundary covers Troupe's own interpolation only. Under D-004 Codex loads its own config: `codex exec` in a git repo may write `[projects."<repo>"] trust_level = "trusted"` to `~/.codex/config.toml`, after which that repo's `.codex/` (MCP servers, hooks, rules, developer instructions) is honored natively (`evidence/backend-matrix.md` §2.9, §4). First-run Codex TUI popups can also swallow the auto-submitted interactive prompt (§2.2). The guide documents both as inherited backend behavior.

### 7. Mixed migration compiler and publication

The shared compiler has two explicit modes. Neither discovers `agents/local/`; a present `agents/local/` directory produces one warning line that private agents are not compiled (D-011).

- **Migration mode:** discover union of Markdown and legacy non-test TypeScript names. Markdown wins a same-stem collision. Its paired TS is extension-only if static syntax exports `prepare`/`finish` and passes the top-level side-effect check (§4); otherwise it is ignored as a legacy sibling. An unpaired TS remains directly built as its legacy launcher. Compile/watch switch to this mode before any agent conversion, so every binary is always either a working old launcher or a working new declaration.
- **Strict mode:** discover Markdown only, require exact 22-name roster (D-036), reject any non-test `.ts` under `agents/` that is not a same-stem sibling statically exporting `prepare`/`finish` (so paired leftovers fail as well as unpaired ones), and build generated entries only. Final cutover removes the 12 ordinary launchers first, then enables this mode, so the strict check itself proves the removal. *(Amended 2026-10-02, D-036)*
- **Clarifications** *(Added 2026-10-01 after the TASK-008 reviews)*: every `.md` under `agents/` is a declaration, so include fragments live in `system-prompts/`. Builds run one at a time: concurrent `bun build --compile` jobs lost and corrupted outputs under load (bun 1.2.22). Before the first rename the compiler verifies every built output and every target; a failure after the first rename is reported as a partial update, never as untouched. A same-stem sibling without hooks is ignored in migration mode unless its export shape could hide `prepare`/`finish`. The watcher covers `agents/` and `system-prompts/` only (D-027), so a change under `settings/` needs a manual `compile:all` while legacy launchers still embed it.

Both modes use one compiler, shared by `compile`, `compile:all` and the watcher (D-011). Publication is single-process:

1. Read and validate every source, include and extension contract. Any error names file and field, and nothing is built.
2. Build every binary into a temporary directory on the same filesystem as `bin/`. A build failure or signal removes the temporary directory and leaves `bin/` untouched.
3. Rename each built binary into `bin/`.
4. Unless `--no-prune`, remove every `bin/` entry outside the roster, except binaries owned by other package `compile:*` scripts (existing rule).

`--dry-run` validates and reports what would be built and pruned, and writes nothing. Single compile validates one roster name, builds it into a temporary file and renames it into `bin/`; a name outside the roster fails. The watcher serializes its own queue, rebuilds all agents on any change (as today), and watches exactly `agents/` and `system-prompts/` (D-027). There is no cross-process lock, no `previous`/`next`/quarantine protocol and no manifest validation (D-023).

### 8. Agent migration matrix

All except the six specified restrictions declare `[claude,codex]`. *(Amended 2026-10-02, D-036)*

| Agent(s) | Ownership |
|---|---|
| Orient | quick/focus template using D-025 `else if` and `if args` (quick overrides focus; context suffix only with args); reminder in body |
| Builder | Claude-only; real Chrome MCP, tool rules, reminder |
| Comment Review | prepare diff/empty exit; Claude Edit/Read/Glob/Grep allow |
| Refactor, Designer | real Chrome MCP; Claude rules; Designer Claude sonnet/reminder |
| TDD, Rails Backlog | Claude-only; body reminder; dead settings dropped |
| Architect, Tailor | dual; Claude-only tool rules |
| Audit | expectations include; prepare computes the audit dir, creates it only when not preview, and returns the start banner as `beforeRunMessages`; post-child message as `afterRunMessages` |
| Diagram all/consolidate/topic | restored bodies; prepare computes paths, mkdir only when not preview, start banner as `beforeRunMessages`, post-child as `afterRunMessages`; topic validates/slugs required arg |
| Git Fix | prepare uses the supplied PR, else detects it with `gh` through `runCommand`; in preview it uses the supplied PR or a stable placeholder and never calls `gh`; no PR is a stderr early exit |
| Meta Prompt, Planner, Riff | declarative body; empty config dropped |
| Contain | Claude-only container MCP/allow/deny; remove deepwiki/default; reminder body; Claude flags such as `-p` now follow `--` (D-028) |
| PR Review | Claude-only; comment flag; prepare PR/conditional prompt; rules |
| Shepherd | dual; prepare persisted reconstruction, ordered fragments/cwd; on Claude only, the literal `Read(/<realpath of enclosing>/.shepherd/**)` rule plus the additional directory; rejects `ctx.mode === "print"` without a prompt; `--resume` and similar follow `--` |
| Webfetch | Claude print; flags and framework model; prepare usage/task normalization, max turns fixed at 3 as the native Claude arg `--max-turns=3` with no declared flag *(Amended 2026-10-02, D-037)*, missing URL as a stdout `ERROR:` early exit with code 64; native WebFetch allow and Bash/Edit/Write/Read/Glob/Grep/Task/WebSearch deny; typed `finish` payload/ERROR; ignores an exported `FORGE_BACKEND` (D-021) |
| Coach | dual; prepare init/list, persisted roster/student/integrations, prompt/cwd, dynamic rules returned only when `ctx.backend === "claude"`; a Codex preview is snapshotted |

Flat one-agent prompts move into Markdown bodies. Shared/dynamic fragments remain `system-prompts/expectations.md`, `system-prompts/shepherd/**`, and `system-prompts/coach/**`. Shepherd declares core/built-ins as includes, then prepare appends inherited, charter, local, header. Coach pack frontmatter stays a separate runtime content contract.

The one intended CLI change across the roster is D-028: backend flags that used to pass straight through (Contain's `-p`, Shepherd's and Coach's `--resume`/`--permission-mode`) now follow `--`.

### 9. Test/removal/document ownership

Workers choose colocated tests; test files are not source ownership in Files to Change. Slice 1 owns schema/include/template/CLI/help/argv/preview. Slice 2 owns fake CLIs (the fake Claude rejects stream-json without `--verbose`), cancellable preparation, interpolation and tokenization, decoding/failures/cleanup/canary. Slice 3 owns mixed/strict discovery, extension side-effect inspection, temp-dir build/rename/prune, `--dry-run`/`--no-prune`, watcher roots and roster. Each migration adds snapshots/regressions before deletion. Existing Webfetch tests are rewritten around extension helpers and preserved cases. Prompt prose is reviewed, not sentence-asserted.

Slice 1 declares `yaml` and `zod` (^4, matching the strict-schema API) in `package.json` and `bun.lock`; today `yaml` is absent and `zod@3` is only a transitive SDK dependency. Final cutover removes per-agent JSON, migrated flat prompts, assets, Claude helpers/types, the legacy `lib/runtime/**` with its colocated tests (`registry.test.ts`, `capability-checks.test.ts`, `integration.test.ts`), Codex SDK and legacy launchers/fallback; the `@anthropic-ai/claude-agent-sdk` dependency was already removed with `personas:github` (D-036) *(Amended 2026-10-02, D-036)*. Biome excludes authored Markdown from unsupported-file checks while retaining TS checks.

Add `docs/AGENT-FORMAT.md` with the §5 backend mapping table, remove obsolete runtime proposal, update feature docs and targeted README plus AGENTS/CLAUDE links. Preserve rename context and state that `FORGE_BACKEND` is no longer read (D-021). Rewrite the passthrough sentences in `docs/SHEPHERD.md` and `docs/COACH.md` to the `--` form, and remove or rewrite the CLAUDE.md "Private agents"/`agents/local/` rows and the AGENTS.md `agents/local/` bullet.

## Files to Change

- `package.json`, `bun.lock` — step 1 adds `yaml` and `zod` ^4; the D-036 removal drops `@anthropic-ai/claude-agent-sdk`; scripts. *(Amended 2026-10-02, D-036)*
- `biome.json` — check scope.
- `lib/agent-format/types.ts`, `schema.ts`, `template.ts`, `cli.ts`, `run.ts` — new format core/composition.
- `lib/agent-format/adapters/types.ts`, `claude.ts`, `codex.ts`, `index.ts` — new adapter boundary, added in steps 1-2 beside the legacy runtime (D-024).
- `lib/runtime/types.ts`, `claude-cli.ts`, `codex-cli.ts`, `index.ts`, `debug.ts`, `codex-sdk.ts` — unchanged until step 7, then removed with their colocated tests.
- `lib/claude.ts`, `lib/flags.ts`, `lib/claude-flags.types.ts`, `lib/assets.ts`, `lib/assets.gen.ts`, `lib/forge-root.ts` — remove obsolete paths at step 7.
- `lib/index.ts` — keeps its runtime re-export until step 7, then exports new contracts only.
- `scripts/agent-compiler.ts` — mixed/strict discovery, includes/extensions and side-effect inspection, temp-dir build/rename/prune (new).
- `scripts/binary-name.ts`, `scripts/compile.ts`, `scripts/compile-all.ts`, `scripts/watch-agents.ts` — delegate shared compiler/modes.
- `scripts/gen-assets.ts` — remove.
- `agents/analyze/orient.md`, `agents/build/{builder,comment-review,refactor,tdd}.md`, `agents/design/{architect,audit,designer}.md`, `agents/design/diagram/{all,consolidate,topic}.md`, `agents/git/fix.md`, `agents/meta/prompt.md`, `agents/modes/contain.md`, `agents/plan/{planner,riff}.md`, `agents/rails/backlog.md`, `agents/resume/tailor.md`, `agents/review/pr.md`, `agents/shepherd.md`, `agents/tools/webfetch.md`, `agents/tutors/coach.md` — 22 declarations (new). *(Amended 2026-10-02, D-036)*
- `agents/build/comment-review.ts`, `agents/design/audit.ts`, `agents/design/diagram/{all,consolidate,topic}.ts`, `agents/git/fix.ts`, `agents/review/pr.ts`, `agents/shepherd.ts`, `agents/tools/webfetch.ts`, `agents/tutors/coach.ts` — convert to extensions. `agents/personas/github.ts` and `system-prompts/github-examples.md` are deleted (D-036). *(Amended 2026-10-02, D-036)*
- `agents/analyze/orient.ts`, `agents/build/{builder,refactor,tdd}.ts`, `agents/design/{architect,designer}.ts`, `agents/meta/prompt.ts`, `agents/modes/contain.ts`, `agents/plan/{planner,riff}.ts`, `agents/rails/backlog.ts`, `agents/resume/tailor.ts` — remove at strict cutover.
- `settings/*.json` — remove after live data migration.
- `system-prompts/{builder-prompt,comment-review-prompt,design-architect,design-audit-prompt,designer-prompt,diagram-all-prompt,diagram-consolidate-prompt,diagram-topic-prompt,orient-prompt,planner-prompt,pr-review-prompt,prompt-improver-prompt,rails-backlog-coordinator-prompt,refactor-prompt,resume-tailor,riff-prompt,tdd-coordinator-prompt,webfetch-prompt}.md` — remove after body migration. *(Amended 2026-10-02, D-036)*
- `system-prompts/shepherd/core.md` — update stale source references, preserve Context tiers.
- `docs/AGENT-FORMAT.md` — new single guide.
- `docs/AGENT-RUNTIME.md` — remove.
- `docs/SHEPHERD.md`, `docs/COACH.md`, `docs/WEBFETCH-SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `README.md` — targeted source/backend/authoring updates, including the `--` passthrough rewrite in SHEPHERD/COACH, the removal of `FORGE_BACKEND` from SHEPHERD, and removal of `agents/local/` guidance.

## Quality Contract

This human-required section declares no gate table or future binding state. Behavior ownership is: B-001–B-003 strict source/CLI/preview/snapshots; B-004–B-006 adapters/MCP/cancellable lifecycle/decoding; B-007–B-008 migration policies/prose/Shepherd; B-009 roster/build/prune/repository checks; B-010 canary; B-011 guide review; B-012 recorded smokes.

Use red-green-refactor per slice and observable argv/output/files/exits, not helper calls. Prompt prose is reviewed for meaning; routing/order/interpolation are tested. Negative/mutation checks catch flag leakage, append/replace swap, adapter-generated forbidden keys, dropped HTTP headers, missing fragments, silent fallback on an explicit undeclared `--backend`, wrong stream channel/failure handling, orphan preparation children, lost Webfetch safety, missing Shepherd directory, single-slash `Read(/abs/**)` instead of `Read(//abs/**)`, Claude stream argv without `--verbose`, any binary reading `FORGE_BACKEND`, prepare output or filesystem writes during preview, an extension that launches on import, a quoted `${cmd:...}` argument split apart, resource leaks, and a failed build that touches `bin/`.

Snapshots use temp workspaces/fake time. Planning-time structural investigation produced no mechanical evidence because no provider was available; sign-off resolves current capability bindings and records actual outcomes, while direct review covers any unavailable structural evidence.

## Risks

- **Legacy spec waiver:** current human direction authorizes use as-is, not new intent. Ratified collision still halts (`review-2.md PR-013`).
- **Backend drift:** repeat relevant experiment; ratified mapping conflicts halt.
- **Mixed-mode leakage:** strict cutover must prove no non-extension TS (paired or unpaired) or fallback remains; otherwise B-009 fails.
- **Native/user escape:** authored data guarded, user tail raw; repeated prepared needs trigger core reconsideration.
- **Secrets/trust:** inability to prevent preview/error/debug disclosure aborts interpolation.
- **Extension creep:** direct child/backend spawn or framework parsing snaps back.
- **Permission asymmetry:** safety-dependent Claude rules require restriction/escalation, never Codex prose emulation.
- **Target variance:** handle monorepos, `.git` file/dir, non-git, spaces, symlinks/realpaths.
- **Publication scope (cut 2026-09-29, D-023):** publication is a single-process temp-dir build then rename. Two concurrent `compile:all` runs, or a crash between renames, can leave a mixed `bin/` until the next successful run; crash-safe publication is a separately ratified follow-up, not this plan.
- **Private agents dropped (human gate):** `agents/local/` is no longer compiled, and pruning removes any `local:*` binary from `bin/`, which is on the user's PATH. No local agents exist today; the CLAUDE.md and AGENTS.md guidance that promises them is removed (D-011).
- **`FORGE_BACKEND` dropped (D-021):** users who relied on the variable for Shepherd must pass `--backend` or define a shell alias; the SHEPHERD doc says so.
- **Codex project trust:** `codex exec` in a git repo may mark it trusted in `~/.codex/config.toml`, after which that repo's `.codex/` loads natively. This is inherited Codex behavior under D-004, outside the §6 interpolation boundary, and the guide documents it.
- **Env-referenced MCP headers unverified:** D-029 relies on Claude `${VAR}` header expansion and Codex `env_http_headers`/`bearer_token_env_var`, which `evidence/backend-matrix.md` does not cover. Step 2 runs the verifying experiment on the installed CLIs first and records the result in the evidence file; if either form fails, halt for human resolution ("Backend drift"). Claude `${VAR}` expansion of literal header values, and Claude honoring `cwd` for stdio MCP servers, are verified in TASK-006 before adapters rely on them. Result (2026-10-01): the env-reference forms pass on both CLIs; Claude ignores stdio `cwd` and expands literal `${VAR}`, resolved by D-032 and D-033. On macOS a same-user `ps eww` shows a child's environment, so an env-referenced secret is hidden from argv and from default listings, not from that command (found in the TASK-013 review, 2026-10-02). *(Amended 2026-10-02, D-036)*
- **Structural evidence limitation:** planning had no mechanical evidence; unexpected duplicate runtime/high complexity requires refactor.
- **Scope:** new product behavior requires spec amendment; implementation complexity splits within fixed slices.

## Implementation Order

1. **Contract/preview vertical (B-001–B-004):** declare `yaml` and `zod` ^4; types, pure schema, template/CLI, both pure argv adapters under `lib/agent-format/adapters/` beside the untouched legacy runtime (D-024), `PrepareContext` with `mode`, `preview`, `signal` and a basic runner-owned `runCommand`, preparation/preview, static export and side-effect inspection, minimal single compiler; one fixture compiles/previews both backends. Preview uses the D-012 placeholder model for temp prompt paths and MCP display values; the pure adapters receive placeholder paths and create no files. No temporary runtime.
2. **Execution lifecycle (B-005/B-006/B-010):** child tracking, abort/forwarding and cleanup for `runCommand`, MCP interpolation with D-026 tokenization and redaction, the D-029 env-reference experiment on both installed CLIs (recorded in `evidence/backend-matrix.md`) and the env-reference header mapping, TMPDIR/temp prompt resources, worktree probe, process/signals, typed `finish` and print finish-on-failure, before/after-run messages, decoders and malformed/incomplete exits, fake CLIs/canary.
3. **Compiler migration/publication (B-009):** mixed and strict discovery, includes limited to watched roots, temp-dir build, rename, prune with `--dry-run`/`--no-prune`, roster-only single compile, `agents/local/` warning, watcher reuse. Switch package compile/watch to mixed mode now, before converting any agent.
4. **Ordinary migration (part B-007):** add ordinary Markdown/policies/reminders/snapshots. In mixed mode each `.md` atomically shadows its still-present legacy sibling while unpaired agents remain functional legacy binaries.
5. **Special extensions except Shepherd (B-006/B-007):** in same-stem pairs add Markdown and convert Comment Review, Audit, diagrams, Git Fix, PR Review, Webfetch, Coach. Mixed compiler immediately builds the declaration+extension, never the hook as entry. Land it as separate same-stem commits, one per contract family (diagrams+audit; git-fix+pr-review+comment-review; webfetch; coach), each with its own snapshots, regressions and an import-has-no-side-effects check. Rewrite Webfetch tests. `personas:github` is removed instead (D-036). *(Amended 2026-10-02, D-036)*
6. **Shepherd (B-008):** the baseline is `e18f56b`. Before converting, capture for each `~/shepherds/*` workspace the legacy system prompt and the `shepherdSettings(enclosing)` output (additional directory plus the `Read(//abs/**)` rule) as characterization fixtures, with the date normalized; the legacy `--show-prompt` omits settings. Then convert nearest parent, order, realpath dedupe, additional directory+Read, Context tiers, env compatibility, print-without-prompt guard, fixed previews; diff the new Claude preview's prompt and `--settings` argv against the fixtures, and snapshot a Codex preview of a nested workspace.
7. **Strict cutover/cleanup/docs (B-009/B-011):** the entry gate is that all 22 work in mixed mode, meaning the ACC-005 smokes (Shepherd and `plan:riff` on Claude and Codex) and the prose review pass against the step-6 mixed build, with outcomes recorded and the prose compared against the still-present `system-prompts/*.md`. Then remove the 12 ordinary launchers, enable strict mode and prove the exact roster with no fallback, and only then remove prompts/settings/assets/helpers, and the legacy `lib/runtime/**` with its tests (the Agent SDK is already gone, D-036). No artifact references a deleted seam. The guide and doc updates (B-011) are a separate task from the cutover and deletions. *(Amended 2026-10-02, D-036)*
8. **Whole-roster acceptance (B-003/B-007–B-012):** full snapshots, named regressions (including orient combinations and Webfetch ignoring an exported `FORGE_BACKEND=codex`), repository checks, exact binaries, canary, Shepherd workspaces against the `e18f56b` fixtures, the four smokes re-run after the helpers are gone, one real-CLI Claude stream-mode launch, a recorded check of whether any `codex exec` flag avoids the project-trust write, and prose review. *(Amended 2026-10-02, D-036)*

Every slice leaves owned behavior demonstrable. After every step, `bun run typecheck` passes and `compile:all` builds all 22 names, legacy Shepherd and Webfetch included. *(Amended 2026-10-02, D-036)* Evidence contradiction, secret leak, safety downgrade, unrepresentable ratified behavior, or a failed build that alters `bin/` halts under the deviation protocol.
