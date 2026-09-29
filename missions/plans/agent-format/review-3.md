# Plan Review: agent-format

## Findings

- id: PR-016
  dimension: interface-fidelity
  severity: high
  title: "The extension contract cannot express Webfetch's output envelope"
  plan_refs: Design §4 Extension and cancellation contract, Design §5 Runtime outcomes, Design §8 Agent migration matrix — Webfetch
  code_refs: agents/tools/webfetch.ts:112-136, agents/tools/webfetch.ts:172-189, agents/tools/webfetch.ts:242-277, agents/tools/webfetch.ts:314-319, agents/git/fix.ts:70-82
  description: |
    The proposed extension types define `RunResult` and `PrepareResult`, but no `finish` signature or return type. The runner is nevertheless expected to let Webfetch transform stdout, stderr, and the exit code. More concretely, `{ exit: { message, code } }` has no output-channel field: current Webfetch writes its missing-URL `ERROR:` to stdout with code 64, while Git Fix writes its no-PR usage failure to stderr. A runner-wide success/stdout and failure/stderr convention cannot preserve both.

    This is not just an implementation detail: Webfetch's stdout-only payload is consumed by automation, and the plan explicitly says operational failures go through `finish` while invalid CLI and explicit early exits retain their contracts. Define the exact `finish` input/output signature and a structured early-exit envelope that can select stdout versus stderr. Weakening the existing Webfetch envelope would alter the ratified migration requirement to preserve behavior, so that route would require escalation rather than a derived-plan patch.

- id: PR-017
  dimension: lifecycle-invariant
  severity: high
  title: "Required start banners contradict the fixed preview envelope"
  plan_refs: D-012, D-019, B-003, Design §3 Preview, Design §4 PrepareResult, Design §8 Audit and diagram migration rows
  code_refs: agents/design/audit.ts:33-42, agents/design/audit.ts:61-63, agents/design/diagram/all.ts:19-27, agents/design/diagram/all.ts:75-78, agents/design/diagram/consolidate.ts:20-35, agents/design/diagram/topic.ts:34-48
  description: |
    B-003 and Design §3 require every `--show-prompt` invocation to emit an exact envelope beginning with `Backend:`. D-012 says preview runs `prepare`, while D-019 and the migration matrix require Audit and the diagram agents to preserve their pre-child mkdir/start banners in `prepare`. `PrepareResult` has only post-run `afterRunMessages`; it has no runner-owned pre-run message field and `PrepareContext` has no preview indicator.

    If the converted extensions print their current banners directly during `prepare`, every corresponding preview is prefixed by those messages and the full-matrix fixed-format acceptance fails. If they omit the messages, the preservation promise fails. The plan needs a lifecycle seam that lets the runner emit execution-only pre-run messages (or an equivalent explicit rule) without contaminating preview.

- id: PR-018
  dimension: interface-fidelity
  severity: medium
  title: "Prepare cannot observe the effective mode needed by Shepherd"
  plan_refs: B-002, B-006, B-007, Design §3 CLI, Design §4 PrepareContext, Design §8 Shepherd migration row
  code_refs: agents/shepherd.ts:181-192
  description: |
    The framework `--print` flag changes an invocation from the declaration's default mode to print, but `PrepareContext` exposes only the compiled `spec`, flags, args, cwd, and backend. `spec.mode` remains the declaration's resolved default; there is no effective invocation mode in the contract. Shepherd currently permits an empty interactive launch but rejects `shepherd --print` without a prompt before spawning.

    A Shepherd extension therefore cannot preserve that mode-dependent guard through the proposed interface, and a global “all print runs require prompts” rule is not stated or necessarily valid for other declarations. Add the effective mode to the preparation contract or give this validation another explicit owner; silently dropping the guard conflicts with the ratified behavior-preserving migration requirement.

- id: PR-019
  dimension: interface-fidelity
  severity: medium
  title: "The named adapter types still do not define the runner boundary"
  plan_refs: D-010, Design §1 Modules and dependency direction, Design §5 Backend and execution contracts, Implementation Order stages 1-2
  code_refs: lib/runtime/types.ts:222-307, lib/runtime/claude-cli.ts:104-126, lib/runtime/codex-cli.ts:113-142, lib/runtime/codex-cli.ts:263-303
  description: |
    The revision names `BackendAdapter`, `CommandPlan`, and `StreamDecoder`, but provides no signatures or data shapes for them. The current boundary is an `AgentRuntime` that owns spawning through `run`/`runStreaming`/`runInteractive`; there is no existing command-plan seam that workers can extend. Runner and adapter tasks are left to invent how executable/argv, stdio, actual-versus-display values, temporary resources, decoder construction, and cleanup transfer across the new boundary.

    The missing contract also hides a concrete dependency: Codex exec must add `--skip-git-repo-check` only outside worktrees, while stage 1 calls the argv adapters pure. The current Codex builder neither performs nor accepts that worktree determination. The plan must define the adapter signatures and assign worktree probing to an infrastructure owner whose result is an explicit adapter input; otherwise workers must either violate the declared purity boundary or leave non-git Codex print/stream launches broken.

- id: PR-020
  dimension: risk-blast-radius
  severity: medium
  title: "The GitHub migration drops the 1Password sign-in preflight"
  plan_refs: D-018, D-019, Design §6 MCP trust, Design §8 Agent migration matrix — GitHub
  code_refs: agents/personas/github.ts:24-45, agents/personas/github.ts:65-73
  description: |
    The current GitHub launcher deliberately runs `op signin --raw` before `op item get`, so biometric/session establishment happens before token retrieval. The migration assigns GitHub only required-single-prompt preparation and a `${cmd:...}` MCP-header interpolation; it never assigns the sign-in preflight to `prepare` or specifies a multi-command interpolation contract.

    On a machine without an already-active `op` session, implementing only the documented item lookup can fail before the backend starts. The gap is compounded by the absence of quoting/tokenization semantics for `${cmd:...}`, whose required item name contains spaces. The plan should explicitly own the two-step credential flow and define whether interpolation is argv-based or shell-based; an implicit shell chain would create a new quoting and injection contract.

- id: PR-021
  dimension: state-sync
  severity: medium
  title: "The watcher has no dependency rule for arbitrary in-repository includes"
  plan_refs: B-001, B-009, Design §1 Compiler ownership, Design §2 Schema includes, Design §7 Mixed migration compiler, Files to Change — scripts/watch-agents.ts
  code_refs: scripts/watch-agents.ts:9-13, scripts/watch-agents.ts:154-185
  description: |
    The proposed schema permits `includes` anywhere inside the repository boundary; only out-of-root realpaths are rejected. The current watcher subscribes to three hard-coded roots (`agents`, `system-prompts`, and `settings`). The plan says the watcher will reuse the shared compiler and serialize its queue, but it does not say how the watcher learns the resolved include dependency set or constrain includes to a watched directory.

    A valid declaration that includes a file elsewhere in the repository can therefore compile correctly once but stay stale under the shipped watch workflow when that fragment changes. Specify either a constrained include root or compiler-produced dependency subscriptions, including how subscriptions are refreshed when declarations change.

## Missing Coverage

- Live Claude Code/Codex probes were not rerun. This role prohibits shell execution, and no approved mechanism was available that could guarantee project configuration/plugins would not execute; external flags and envelopes were checked only against the supplied Claude Code 2.1.282/Codex 0.156.1 evidence.
- Mechanical duplication, dead-code/deletion, boundary-conformance, changed-scope, and trace evidence is unavailable (`analysis_status`: `unbound`, reason `no-provider`), so no mechanical clean verdict is claimed for the runtime replacement or removal list.
- The `~/shepherds/*` workspaces required by ACC-006 could not be enumerated with the available read-only tools. The current repository implementation of enclosing-workspace inheritance was checked, but the per-workspace preview claim remains unverified.

## Coverage Ledger

- dimension: interface fidelity
  status: unchecked
  checked: Static review compared the schema, CLI, extension, runner, adapter, MCP, special-agent, and compiler contracts with all 23 current launchers and the supplied backend evidence. Live external-tool verification was unavailable because shell execution is prohibited and no config/plugin-isolated probe mechanism was available.
  findings: PR-016, PR-018, PR-019

- dimension: code path duplication
  status: unchecked
  checked: Direct review compared the legacy compiler/runtime/launcher paths with the planned replacement and removal path, but the duplication capability is unbound with reason `no-provider`; no mechanical duplicate-path conclusion is claimed.
  findings: none

- dimension: state and synchronization
  status: checked
  checked: Reviewed persisted Shepherd/Coach reconstruction, preparation state, temporary resources, compiler locking/recovery, watcher queueing, and source-to-include invalidation.
  findings: PR-021

- dimension: risk blast radius
  status: checked
  checked: Traced the runtime replacement across Claude/Codex launches, Webfetch automation output, GitHub credential retrieval, non-git Codex execution, previews, publication, and nested Shepherd workspaces.
  findings: PR-016, PR-017, PR-018, PR-019, PR-020, PR-021

- dimension: user experience
  status: checked
  checked: Walked help, preview, required-input, early-exit, interactive, print, stream, signal, credential, and compile/watch flows for ordinary and exceptional agents.
  findings: PR-016, PR-017, PR-018, PR-020, PR-021

- dimension: behavior spec quality
  status: checked
  checked: Mapped the legacy Requirements/Acceptance aliases to B-001–B-012 and checked observers, shipped entry points, failure cases, and prose-review handling. The human-ratified legacy-format waiver in D-020 was respected.
  findings: none

- dimension: architecture record usefulness
  status: checked
  checked: The plan declares no separate durable architecture record. Its local compiler/core/runtime dependency rules were reviewed against the current runtime boundary; mechanical boundary conformance is unavailable and is not claimed.
  findings: PR-019

- dimension: quality carried by behaviors and risks
  status: checked
  checked: Verified that the human-required Quality Contract contains no gate table or future binding prediction and traced its obligations to behaviors, risks, and implementation slices.
  findings: none

- dimension: lifecycle and invariant attack
  status: checked
  checked: Attacked preview preparation, early exits, pre/post-run messages, effective mode, interpolation, decoding, child cancellation, cleanup, watch invalidation, and compiler publication/recovery.
  findings: PR-016, PR-017, PR-018, PR-021

- dimension: constraint ownership
  status: checked
  checked: Traced special-agent migration requirements, output channels, credential steps, worktree detection, watcher dependencies, removals, prose review, and tests to behavior or implementation owners.
  findings: PR-019, PR-020, PR-021

- dimension: scope and size
  status: checked
  checked: The plan remains at the 12-behavior limit and now has dependency-complete high-level slices; the revised mixed-mode cutover occurs before extension conversion.
  findings: none

## Assessment

The plan is viable with revisions; the migration and publication ordering issues from earlier rounds are substantially resolved. Fix PR-016 first: the public extension contract still cannot represent the stdout/stderr/exit transformations required by Webfetch, so runner and extension workers do not yet share an implementable output contract.
