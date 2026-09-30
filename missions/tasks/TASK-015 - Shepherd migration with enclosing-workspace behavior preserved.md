---
id: TASK-015
title: Shepherd migration with enclosing-workspace behavior preserved
status: To Do
priority: high
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-009
  - TASK-010
  - TASK-011
  - TASK-012
  - TASK-013
  - TASK-014
createdAt: '2026-09-30T17:41:16.320Z'
updatedAt: '2026-09-30T17:41:16.320Z'
---

## Description

Step 6 Shepherd migration. Baseline `e18f56b`. Capture per-workspace characterization fixtures before converting, then preserve nearest-parent inheritance, ordering, realpath dedupe, the Claude-only additional directory plus `Read(//abs/**)` rule, Context tiers, the print-without-prompt guard and fixed previews.

Ground: D-016 prepare carries required behavior, D-019 exceptional migration contracts, D-028 backend flags after `--`, REQ-009/ACC-006 (Shepherd 2026-09-25 behavior). Behavior owner for B-008 and B-012. Design §8.

Ratified constraints (stop-and-escalate): the literal `Read(//abs/**)` rule and additional directory are preserved on Claude only; a Codex preview returns no rule object; `--resume` follows `--`; Context tiers and flock module match the baseline. Halt on any missing-directory or single-slash rule regression.

<!-- AC:BEGIN -->
- [ ] #1 B-008/D-019: prepare finds the nearest parent with its own `.shepherd/`, sorts inherited modules after built-ins and before the charter, skips a local module whose realpath matches an inherited one, and keeps local after charter; the Context tiers subsection and flock module/directory match the `e18f56b` baseline
- [ ] #2 B-008: on Claude only, prepare returns the literal `Read(/<realpath of enclosing>/.shepherd/**)` rule plus the additional directory, rendering as `Read(//abs/...)` exactly like `agents/shepherd.ts:81`
- [ ] #3 B-008/D-016: prepare returns rules only when `ctx.backend === "claude"`, so a Codex preview of a nested workspace shows inherited fragments with no rule error; `shepherd --print` without a prompt fails before spawn
- [ ] #4 B-008/D-019: characterization fixtures captured before conversion (date-normalized legacy prompt and `shepherdSettings(enclosing)`) match the new Claude preview's prompt and `--settings` argv, and a Codex preview of a nested workspace is snapshotted
- [ ] #5 B-012: all four interactive smokes — Shepherd and `plan:riff`, each on Claude and Codex — start in the requested cwd with their prompts, interact, and terminate cleanly without Troupe-specific global MCP or suppressed user config
- [ ] #6 D-028: Shepherd's `--resume` and similar backend flags follow `--`, and `--cwd`/`--show-prompt` are framework flags — stop-and-escalate ratified ground
- [ ] #7 `bun run typecheck` passes and mixed-mode `compile:all` builds Shepherd as declaration+extension while the legacy launcher stays until strict cutover
<!-- AC:END -->
