# Plan Review: agent-format

## Findings

- id: PR-002
  dimension: scope-size
  severity: high
  title: "Special-extension staging still turns shipped launchers into no-op binaries before cutover"
  plan_refs: D-017, Design §7 Compiler and publication lifecycle, Design §8 Fixed migration ownership, Implementation Order stages 5 and 7
  code_refs: scripts/compile-all.ts:27-41, scripts/compile-all.ts:70-93, scripts/watch-agents.ts:63-135, agents/build/comment-review.ts:41-73, agents/personas/github.ts:78-105, agents/tools/webfetch.ts:280-324
  description: |
    D-017 now correctly prevents the new compiler from importing ordinary legacy launchers, resolving the original double-launch defect for stage 4. The inverse staging problem remains in stage 5: it says to convert Comment Review, Audit, the diagrams, Git Fix, GitHub, PR Review, Webfetch, and Coach in place from executable launchers to `prepare`/`finish` modules, while stage 7 defers switching package compile/watch to the Markdown compiler.

    The current all-agent compiler discovers every non-test `.ts` under `agents/` and compiles it directly as a binary; the watcher does the same. After an in-place stage-5 conversion, either existing workflow will overwrite those shipped binaries with hook-library entry points that do not launch an agent. Thus stage 5 cannot leave the repository's shipped compile path working as the plan claims. The migration order needs a staging rule for extension-bearing agents, not only ordinary siblings. This correction can preserve Format A and does not require weakening any ratified decision.

- id: PR-011
  dimension: lifecycle-invariant
  severity: medium
  title: "Publication recovery still has states without exits or cross-process ownership"
  plan_refs: D-011, D-018, B-009, Design §7 publication states 1, 3-6, Risks — Publication interruption
  code_refs: scripts/compile-all.ts:70-116, scripts/watch-agents.ts:63-135
  description: |
    The revised stage/previous/next protocol resolves the original delete-then-replace gap, but its own states are incomplete. Startup says that when both `bin/` and `bin.previous/` exist, `bin/` is treated as committed and `previous` is removed only after roster validation; it gives no transition when that validation fails. Likewise, commit exit validates the installed `bin/` before removing `previous` but does not say to restore `previous` if that validation fails. Those omissions conflict with D-011's promise to restore `previous` on commit failure or next-run recovery.

    The compiler also has no cross-process publication owner. Serializing calls inside one watcher does not prevent a manual `compile:all` or a second watcher from concurrently manipulating the shared `bin.previous/`; the current watcher and compile script are independently invocable. The plan must define the invalid-`bin` rollback/recovery exit and concurrent publication policy before B-009 can honestly promise a coherent recoverable roster.

- id: PR-013
  dimension: behavior-spec
  severity: medium
  title: "Traceability aliases do not resolve the missing ratified Intent and acceptance spine"
  plan_refs: Overview traceability aliases, D-020, Risks — Legacy spec shape, Behaviors source fields
  code_refs: missions/plans/agent-format/spec.md:1-80, /Users/cosmos/Projects/cosmonauts/domains/shared/skills/work-artifacts/references/spec-format.md:1-55, /Users/cosmos/Projects/cosmonauts/domains/shared/skills/work-artifacts/references/deviation-protocol.md:1-46
  description: |
    The revision accurately maps every Requirements and Acceptance bullet to `REQ-*`/`ACC-*` aliases and explicitly refuses to let implementers rank conflicting ratified ground. That improves traceability, but aliases declared to be “not new acceptance criteria or invented invariants” cannot supply the required `## Intent` goal, `INV-###` invariants, rankings where invariants can conflict, or ratified `AC-###` criteria. `spec.md` itself remains unchanged and has none of that structure.

    This is still a human-ground issue rather than permission for the planner to invent intent. Ratifying a canonical Intent/acceptance spine, or explicitly ratifying a waiver for this legacy spec, requires human action under the deviation protocol. The eight verbatim decisions, Requirements, and Acceptance bullets must remain unchanged unless the human expressly amends them.

- id: PR-014
  dimension: quality-contract
  severity: medium
  title: "The required Quality Contract still predicts runtime capability binding"
  plan_refs: D-020, Design §1 final paragraph, Quality Contract final paragraph, Risks — Structural evidence gap
  code_refs: /Users/cosmos/Projects/cosmonauts/domains/shared/skills/work-artifacts/references/gate-contracts.md:1-39, /Users/cosmos/Projects/cosmonauts/domains/shared/skills/work-artifacts/references/plan-format.md:54-58
  description: |
    The revision correctly retains `## Quality Contract` because the user explicitly requires it, and its test/review obligations now have behavior, risk, and implementation-slice owners. That resolves the ownership part of round 1 without challenging the human-required section.

    A residual contradiction remains: D-020 says the section will contain no binding prediction, while Design, Risks, and the Quality Contract record that structural capabilities “remain unbound.” Binding state is a run-time fact that the gate contract says must never be written into a plan; it can change before sign-off. Remove only the binding-state assertions (while preserving the required Quality Contract and its behavior/risk traceability) or rewrite them as timeless evidence limitations rather than a predicted state.

- id: PR-015
  dimension: lifecycle-invariant
  severity: medium
  title: "The expanded exit table still omits prepare-owned children and decoder failures"
  plan_refs: D-018, B-006, Design §4 Extension contract, Design §5 process lifecycle table, Implementation Order stage 2
  code_refs: agents/build/comment-review.ts:18-47, agents/git/fix.ts:24-40, agents/review/pr.ts:189-208, missions/plans/agent-format/evidence/backend-matrix.md §2.10
  description: |
    The new table now covers thrown prepare/finish, adapter/spawn failures, interpolation children, backend children, signals, and cleanup, resolving most of round 1. But extensions are expressly allowed to perform their table-owned command IO, and the launchers being converted already run `git`/`gh` during the logic that will move into `prepare`. `PrepareContext` carries no cancellation signal or runner-owned command interface, and the signal row covers only interpolation and backend children. A signal while an async preparation command is pending therefore has no specified forwarding, await/termination, listener cleanup, or exit outcome.

    Stream decoding also has no failure row: the plan defines buffering and EOF flush but not the result of malformed JSON, a decoder exception, or an incomplete non-decodable final line. Since B-006 and D-018 claim deterministic exits for all execution modes, these reachable paths need explicit outcomes and cleanup ownership. This is derived lifecycle design; fixing it need not alter the ratified hook or mode decisions.

## Missing Coverage

- No Requirements or Acceptance bullet is untraced: REQ-001–REQ-011 and ACC-001–ACC-006 all map to B-001–B-012, and the eight ratified decisions remain verbatim in D-001–D-008.
- The extension-bearing migration stages still lack a source/binary coexistence mechanism that keeps the current compile/watch entry points valid before atomic cutover (PR-002).
- Publication lacks invalid-installed-roster recovery and cross-process exclusion, and execution lacks cancellation/decoder exits (PR-011, PR-015).
- Backend flags, exit codes, and envelopes were checked against the supplied Claude Code 2.1.282/Codex 0.156.1 evidence. They were not re-probed live because this reviewer role prohibits shell execution and no approved sandboxed invocation mechanism is available.
- Mechanical duplication, boundary-conformance, dead-code, changed-scope, and trace evidence remains unavailable from analysis capabilities (`unbound`, reason `no-provider`); no mechanical clean verdict is claimed.

## Coverage Ledger

- dimension: interface fidelity
  status: unchecked
  checked: Static comparison covered all eight ratified decisions, every Requirement/Acceptance bullet, both evidence files, current special launchers, runtime mappings, and the revised schema/extension/adapter contracts. Live external-CLI verification could not be rerun because shell execution is prohibited and no approved config-isolated probe mechanism is available.
  findings: PR-015

- dimension: code path duplication
  status: unchecked
  checked: Direct review compared the legacy launcher/runtime/compiler paths with the proposed replacement and removal path, but the duplication capability is unbound with reason `no-provider`; no mechanical duplicate-path conclusion is claimed.
  findings: none

- dimension: state and synchronization
  status: checked
  checked: Reviewed workspace reconstruction, temporary resources, watcher serialization, publication recovery, and concurrent compiler ownership.
  findings: PR-011

- dimension: risk blast radius
  status: checked
  checked: Traced stage-by-stage effects on shipped binaries, all Claude launches, Webfetch safety/output, Shepherd workspaces, and interrupted publication/execution.
  findings: PR-002, PR-011, PR-015

- dimension: user experience
  status: checked
  checked: Walked compile/watch, help, preview, required-input, interactive, print, stream, early-exit, signal, and recovery paths.
  findings: PR-002, PR-011, PR-015

- dimension: behavior spec quality
  status: checked
  checked: Mapped all Requirements and Acceptance bullets to B-001–B-012 and checked observers, shipped entry points, failure cases, and prose-review handling.
  findings: PR-013

- dimension: architecture record usefulness
  status: checked
  checked: The plan declares no durable architecture record. Its local stable-core/schema/compiler/runtime dependency rules were compared directly with current integration points; mechanical boundary conformance is unavailable and is not claimed.
  findings: none

- dimension: quality carried by behaviors and risks
  status: checked
  checked: Verified that the user-required Quality Contract now points to behavior/risk owners and does not contain a gate table; checked its residual binding-state language against the canonical gate contract.
  findings: PR-014

- dimension: lifecycle and invariant attack
  status: checked
  checked: Attacked extension conversion, preparation, interpolation, decoding, child signals, finish, cleanup, staged publication, rollback, restart, and concurrent invocation.
  findings: PR-002, PR-011, PR-015

- dimension: constraint ownership
  status: checked
  checked: Traced Shepherd additional directories, Webfetch normalization and permissions, GitHub input, stream decoding, TMPDIR, schema IO, tests, failure exits, and every migration/removal slice to explicit owners.
  findings: PR-015

- dimension: scope and size
  status: checked
  checked: The plan remains at the 12-behavior limit with eight candidate slices; dependency completeness and pre-cutover source ownership were reviewed against current compile/watch discovery.
  findings: PR-002

## Assessment

The revision preserves all eight ratified decisions and resolves most round-1 contract gaps, including Shepherd `additionalDirectories`, Webfetch normalization, stream-decoder ownership, GitHub required input, live policies, TMPDIR, pure schema IO, and behavior/acceptance traceability. It is viable with further revision, but PR-002 must be fixed first: converting extension launchers before the package compiler cutover makes the current shipped build path compile hook modules as binaries.
