# Plan Review: agent-format

## Findings

- id: PR-001
  dimension: interface-fidelity
  severity: high
  title: "Shepherd's required additional directory cannot cross the prepare contract"
  plan_refs: B-008, Design §4 Sibling extension contract, Design §8 Migration ownership
  code_refs: agents/shepherd.ts:62-83, agents/shepherd.ts:167-180, missions/plans/agent-format/spec.md:57-63
  description: |
    B-008 promises that the enclosing `.shepherd/` will appear in `permissions.additionalDirectories`, and the migration table assigns that reconstruction to Shepherd's `prepare`. The proposed `PrepareResult` can return prompt fragments, an initial prompt, `extraAllowRules`, or `cwd`; it cannot return additional directories or a backend settings overlay. The current launcher separately emits both the absolute `Read(/<abs>/**)` rule and `permissions.additionalDirectories: [shared]`, so the allow rule alone does not satisfy the contract.

    This would silently break the ratified Shepherd requirement for nested workspaces. The planner must revise the derived extension/ invocation contract so this value has an explicit route; weakening B-008 or the spec requirement would touch ratified ground and must be escalated rather than patched.

- id: PR-002
  dimension: scope-size
  severity: high
  title: "The ordinary-agent staging slice imports legacy launchers as extensions"
  plan_refs: D-011, Design §4 Sibling extension contract, Implementation Order stage 4
  code_refs: agents/analyze/orient.ts:85-173, agents/build/builder.ts:25-48, agents/plan/riff.ts:32-59, scripts/compile.ts:14-25
  description: |
    D-011 says every generated entry namespace-imports an existing sibling `.ts`, while stage 4 says to create ordinary `.md` definitions but keep their old launchers during staging. Those existing siblings are executable modules with top-level `await main()` or equivalent; importing one does not merely inspect exports, it launches the legacy agent before the generated runner executes. The instruction not to let the package's published compiler discover both paths does not protect direct new-compiler builds or the snapshots stage 4 also requires.

    Implemented literally, the supposedly demonstrable Markdown slice can double-launch or hang. The slice needs an explicit staging rule that prevents legacy executable siblings from being imported; this is a derived-plan correction and does not require changing Format A.

- id: PR-003
  dimension: scope-size
  severity: medium
  title: "The first three vertical slices are ordered before their required seams exist"
  plan_refs: D-011, Implementation Order stages 1-3, B-001, B-003
  code_refs: scripts/compile.ts:14-25, lib/runtime/types.ts:222-307, lib/runtime/index.ts:528-660
  description: |
    Stage 1 promises to compile a generated entry, but D-011 requires that entry to import the new `run.ts`, which stage 2 owns. Stage 2 promises a real-path preview with exact adapter argv, while the `BackendAdapter` contract and both argv builders are deferred to stage 3. The current compiler only builds a supplied launcher directly, and the current runtime exposes capability classes rather than either missing seam, so existing code cannot fill these dependencies.

    These stages cannot each leave their owned behavior demonstrable without temporary runners/adapters, contradicting the plan's no-second-runtime direction and creating throwaway paths. The implementation order needs to be made dependency-complete before task creation.

- id: PR-004
  dimension: interface-fidelity
  severity: medium
  title: "Webfetch max-turn normalization cannot reach the native binding"
  plan_refs: Design §2 NativeArg, Design §4 PrepareResult, Design §8 tools:webfetch migration
  code_refs: agents/tools/webfetch.ts:178-194, agents/tools/webfetch.ts:288-306, missions/plans/agent-format/evidence/agent-usage.md §tools:webfetch
  description: |
    Current webfetch turns a finite `--max-turns` value into `max(1, floor(value))` and falls back to 3 for a non-number. The plan models the flag as a declared string and substitutes its raw validated value into a native Claude argument. `prepare` can inspect the immutable flag map, but its result cannot replace a flag value or return computed native arguments.

    Thus `--max-turns -2`, `2.8`, or a non-number cannot preserve the current contract through the proposed binding. The planner must either give the normalized value an explicit route or record an intentional behavior change; silently changing it conflicts with the ratified migration requirement that behavior be preserved except for named defects.

- id: PR-005
  dimension: interface-fidelity
  severity: medium
  title: "Stream normalization has no adapter contract"
  plan_refs: B-006, Design §5 BackendAdapter.build and CommandPlan, adapter mapping table, Design §8 personas:github
  code_refs: agents/personas/github.ts:78-101, lib/runtime/claude-cli.ts:378-449, lib/runtime/codex-cli.ts:391-462, missions/plans/agent-format/evidence/backend-matrix.md §2.10
  description: |
    The plan says Claude stream JSON and Codex JSONL are normalized by the runner, but the only adapter contract described is `build(invocation, preview) -> CommandPlan` with command, argv, stdio, display argv, and resources. It carries no backend-specific event decoder or normalization function. The two CLIs emit different formats, and the current GitHub agent has observable routing: assistant text goes to stdout while every other SDK chunk is serialized to stderr.

    A backend-neutral runner cannot implement the promised stream behavior from the stated contract without learning backend wire formats or adding an unstated switch. Define the missing shared seam and the GitHub stream outcome before Claude/Codex adapter tasks are split.

- id: PR-006
  dimension: interface-fidelity
  severity: medium
  title: "The declarative GitHub migration loses its required single prompt"
  plan_refs: Design §2 default initialPrompt, Design §8 personas:github, Files to Change launcher removals
  code_refs: agents/personas/github.ts:11-22, missions/plans/agent-format/evidence/agent-usage.md §personas:github
  description: |
    `personas:github` currently requires a prompt, exits non-zero with usage when absent, and consumes only `positionals[0]`. The planned schema has no positional cardinality/required-input contract, defaults `initialPrompt` to all joined `{{args}}`, assigns no sibling extension to this agent, and removes its old `.ts` file.

    The migrated binary would therefore accept an empty invocation and change multi-token handling unless an unrecorded special case is added. The migration row must explicitly place this behavior in a reachable declaration or extension.

- id: PR-007
  dimension: interface-fidelity
  severity: low
  title: "Prepare-only diagram and audit extensions cannot naturally preserve completion banners"
  plan_refs: Design §4 Finish contract, Design §8 design:audit and diagram rows
  code_refs: agents/design/audit.ts:61-83, agents/design/diagram/all.ts:75-111, agents/design/diagram/consolidate.ts:61-91, agents/design/diagram/topic.ts:66-101
  description: |
    The migration table says these interactive agents preserve their banners through `prepare`, but each current launcher prints a completion banner after the child exits. `prepare` runs before spawn, and the only post-run extension is `finish`, which the plan and ratified requirement limit to print-mode output.

    Moving a completion banner into `prepare` would report completion before work starts. The planner should either give the post-run message an explicit owner or state that this minor behavior is intentionally dropped; the current promise is not implementable through the described hook timing.

- id: PR-008
  dimension: constraint-ownership
  severity: medium
  title: "Live permission policies are absent from two migration rows"
  plan_refs: B-007, Design §8 build:comment-review and tools:webfetch rows, Design §9 Removal
  code_refs: settings/comment-review.settings.json:1-5, settings/webfetch.settings.json:1-6, agents/build/comment-review.ts:57-69, agents/tools/webfetch.ts:288-306, missions/plans/agent-format/evidence/agent-usage.md §2 Essential vs accidental
  description: |
    The evidence classifies scoped allow/deny behavior as essential. Comment Review currently pre-approves `Edit`, `Read`, `Glob`, and `Grep`; webfetch permits `WebFetch` and denies shell, file, task, and search tools. Yet their migration rows describe prompt/preparation/output work without assigning these policies to `native.claude`, while cleanup deletes every settings file.

    B-007's phrase “meaningful launch behavior” is too broad to tell isolated migration workers which settings are live versus dead, especially because neighboring rows explicitly name native tool rules. The migration table must own these values or explicitly classify their removal; webfetch's deny list is a safety boundary, not merely formatting.

- id: PR-009
  dimension: risk-blast-radius
  severity: medium
  title: "The Claude TMPDIR crash workaround has no destination"
  plan_refs: D-010, Design §1 removals, Design §5 adapter contract, Design §9 Removal
  code_refs: lib/claude.ts:72-121, lib/runtime/claude-cli.ts:107-160, lib/runtime/claude-cli.ts:181-230, missions/plans/agent-format/evidence/agent-usage.md §2 Essential vs accidental
  description: |
    Both current Claude spawn paths create a per-process clean `TMPDIR` specifically to avoid Claude file-watcher failures and remove it during cleanup. The evidence labels this a runtime workaround rather than agent configuration—it does not say to drop it. The plan removes/rebuilds both paths but names only replace-prompt temporary files in the new adapter and never assigns the Claude TMPDIR resource.

    A literal migration can reintroduce the watcher crash across all Claude agents. The workaround needs an explicit runtime owner and the same normal/error/signal cleanup guarantees, or a recorded evidence-based decision that the supported Claude version no longer needs it.

- id: PR-010
  dimension: interface-fidelity
  severity: medium
  title: "The schema module's declared dependency rule contradicts include resolution"
  plan_refs: Design §1 schema boundary, Design §2 include resolution
  code_refs: scripts/gen-assets.ts:1-20, scripts/compile-all.ts:17-45
  description: |
    Design §1 says `schema.ts` resolves ordered includes while depending only on `types.ts` and parser/validator libraries. Design §2 also requires it to resolve paths, enforce the repository-root boundary, and read UTF-8 files. Those operations require filesystem/path infrastructure or an injected resolver, neither of which is in the stated contract. Existing compile-time file discovery and asset reading live under `scripts/`, making the missing dependency especially concrete.

    Independent workers must not be left to choose between violating the boundary and leaving includes unwired. The plan needs to state where filesystem ownership sits and the exact input contract across that boundary.

- id: PR-011
  dimension: lifecycle-invariant
  severity: medium
  title: "Atomic publication has no failure or interruption protocol"
  plan_refs: D-011, B-009, Design §7 publication, Risks — atomic publication
  code_refs: scripts/compile-all.ts:70-116
  description: |
    Staging all builds fixes the current script's one-by-one overwrite, but “replace `bin/`” is not itself an atomic publication algorithm for a populated directory. The plan defines no backup/swap sequence, publication-failure rollback, or restart recovery if interruption occurs after the old directory is displaced but before the staged directory is installed. Its state matrix covers agent execution, not compiler publication.

    B-009 promises the previous set survives a failed validation or build, while D-011 more broadly claims atomic publication. The lifecycle needs explicit entry, commit, rollback, and stale-stage/backup exits so a worker cannot implement `rm bin && rename(stage, bin)` and call it atomic.

- id: PR-012
  dimension: constraint-ownership
  severity: medium
  title: "The files list omits every test artifact, including one that must change"
  plan_refs: Files to Change, Quality Contract, Implementation Order stages 1-8
  code_refs: agents/tools/webfetch.test.ts:1-105, agents/tools/webfetch.ts:139-324
  description: |
    The plan requires schema, CLI, adapter, lifecycle, compiler, roster, snapshot, and canary coverage but names no existing or new test file in `Files to Change`. This is already a concrete omission: `agents/tools/webfetch.test.ts` imports `parseWebfetchArgs`, `normalizeRunResult`, and `runWebfetchCli`, while the planned sibling becomes only `prepare`/`finish`, so that test cannot remain unchanged.

    Because file ownership drives task decomposition, leaving all test artifacts outside the flat list makes the behavior harness ownerless. The planner must enumerate the existing test migration and the planned test modules/snapshots at the same granularity as implementation files.

- id: PR-013
  dimension: behavior-spec
  severity: medium
  title: "The authoritative spec has no Intent invariants or stable acceptance IDs"
  plan_refs: Overview, Behaviors Source fields
  code_refs: missions/plans/agent-format/spec.md:1-80, /Users/cosmos/Projects/cosmonauts/domains/shared/skills/work-artifacts/references/spec-format.md:1-55
  description: |
    The plan acknowledges that the legacy spec lacks `INV-###` and `AC-###` IDs and substitutes heading/bullet labels. That does not provide the required goal, ranked invariants, or stable acceptance spine for a planned refactor with real collisions—for example behavior preservation versus a stricter shared CLI, and user-config inheritance versus safety policies.

    This is not an invitation for the planner to invent intent. Adding or ranking invariants and changing the letter of acceptance are ratified-ground decisions under the deviation protocol, so the missing Intent/acceptance structure must be escalated for human ratification before implementation uses derived choices to resolve collisions.

- id: PR-014
  dimension: quality-contract
  severity: medium
  title: "A forbidden Quality Contract carries task-critical requirements outside the behavior spine"
  plan_refs: Quality Contract, Design §1 structural-analysis paragraph, Risks — structural analysis
  code_refs: /Users/cosmos/Projects/cosmonauts/domains/shared/skills/work-artifacts/references/plan-format.md:54-58, /Users/cosmos/Projects/cosmonauts/domains/shared/skills/work-artifacts/references/gate-contracts.md:1-39
  description: |
    New plans do not carry a separate `## Quality Contract`, predict capability binding, or make test/gate prescriptions an independent contract. This plan does all three: it records unbound structural capabilities in Design/Risks and places mutation checks, fake-CLI expectations, snapshot mechanics, and prose-review obligations in a section that task decomposition is not guaranteed to carry.

    The issue is not that these checks are unnecessary; it is that their observable requirements and risk pivots need behavior/risk owners. Remove the separate quality contract only after tracing each load-bearing item to B-001–B-012 or a named risk.

- id: PR-015
  dimension: lifecycle-invariant
  severity: medium
  title: "The claimed complete exit matrix omits extension and pre-spawn failures"
  plan_refs: B-005, B-006, Design §3 state/exit matrix, Design §4 extension contract, Design §6 interpolation
  code_refs: agents/build/comment-review.ts:18-47, agents/tools/webfetch.ts:288-322, lib/runtime/claude-cli.ts:142-166
  description: |
    The matrix calls itself complete but has no state for a thrown/rejected `prepare`, a thrown/rejected `finish`, adapter-build or spawn failure, or interruption while `${cmd:...}` is running. These are reachable: current preparation uses throwing `execSync`, and current webfetch deliberately catches runtime exceptions so it can preserve its `ERROR:` stdout contract. The signal row applies only “while a child runs” and does not say whether that includes interpolation children.

    Without these exits, workers can disagree about stderr/stdout, exit code, whether webfetch `finish` runs, and who cleans temporary files/listeners. Add the missing failure transitions and cleanup ownership; B-006's deterministic-exit claim is otherwise incomplete.

## Missing Coverage

- The disposition of Shepherd's existing `FORGE_BACKEND` environment override is not stated; only `--backend` is assigned to the new CLI.
- Shepherd and Coach previews include current dates, but the snapshot design does not specify a clock seam or stable date normalization.
- Native passthrough conflict handling does not state how reserved long options expressed as `--flag=value`, aliases, or values following a repeated `-c` are recognized without rejecting unrelated payload text.
- No independent live CLI probe was run in this review because the reviewer role prohibits shell execution. Backend mappings were checked against the supplied Claude Code 2.1.282/Codex 0.156.1 evidence, not re-executed.
- Mechanical dead-code, duplicate-path, boundary-conformance, trace, and deletion checks are unavailable (`analysis_status`: `unbound`, reason `no-provider`); removal completeness therefore still needs direct implementation review.

## Coverage Ledger

- dimension: interface fidelity
  status: checked
  checked: Compared all eight ratified decisions, Requirements/Acceptance bullets, the backend matrix, proposed AgentSpec/prepare/finish/adapter contracts, current runtime signatures, special launchers, and migration rows. D-001 through D-008 are substantively preserved; contract gaps are listed.
  findings: PR-001, PR-004, PR-005, PR-006, PR-007, PR-010

- dimension: code path duplication
  status: unchecked
  checked: Directly inspected the legacy spawn/runtime/compiler paths and the plan's removal list, but the duplication capability is unbound with reason `no-provider`; no mechanical duplicate-path conclusion is claimed.
  findings: none

- dimension: state and synchronization
  status: checked
  checked: Reviewed embedded spec state, per-invocation preparation, workspace rehydration, watcher rediscovery, temporary resources, and publication state. No correctness cache is proposed; publication and failure exits remain incomplete.
  findings: PR-011, PR-015

- dimension: risk blast radius
  status: checked
  checked: Traced runtime replacement across all Claude launches, compiler publication, webfetch safety, nested Shepherd workspaces, cleanup, and backend user-config inheritance.
  findings: PR-001, PR-008, PR-009, PR-011

- dimension: user experience
  status: checked
  checked: Walked help/preview/early-exit/interactive/print/stream paths and the exceptional agent migrations, including empty input and post-run output.
  findings: PR-006, PR-007, PR-008, PR-015

- dimension: behavior spec quality
  status: checked
  checked: Mapped every Requirements and Acceptance bullet to B-001–B-012 and checked observers, shipped entry points, failure cases, and authored-prose handling. Coverage is broad, but the upstream intent/acceptance spine is non-canonical.
  findings: PR-013

- dimension: architecture record usefulness
  status: checked
  checked: The plan does not declare or depend on a separate durable architecture record, so `Architecture Context` is not required. Its local dependency rules were reviewed directly.
  findings: PR-010

- dimension: quality carried by behaviors and risks
  status: checked
  checked: Compared B-001–B-012 and Risks with the separate Quality Contract and canonical gate rules.
  findings: PR-012, PR-014

- dimension: lifecycle and invariant attack
  status: checked
  checked: Attacked preparation, early exit, preview, interpolation, child signals, finish, temporary resources, watcher restart, and staged publication for missing exits and contradictory writes.
  findings: PR-011, PR-015

- dimension: constraint ownership
  status: checked
  checked: Traced migration-table values, live settings, runtime workarounds, prose review, tests, and every listed removal to behavior or stage owners.
  findings: PR-008, PR-009, PR-012, PR-014

- dimension: scope and size
  status: checked
  checked: The plan is at the 12-behavior limit and provides eight candidate slices; their dependency order and legacy-sibling staging were checked against current entry points.
  findings: PR-002, PR-003

## Assessment

The plan is viable only after substantial revision, not fundamental product rethinking. Fix PR-001 first: the current prepare contract cannot deliver the ratified Shepherd workspace guarantee and would create the exact silent failure the spec warns about; then repair the migration slicing so workers can build demonstrable vertical increments without executing legacy launchers.
