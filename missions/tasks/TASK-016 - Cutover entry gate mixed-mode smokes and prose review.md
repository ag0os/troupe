---
id: TASK-016
title: 'Cutover entry gate: mixed-mode smokes and prose review'
status: To Do
priority: high
labels:
  - testing
  - 'plan:agent-format'
dependencies:
  - TASK-015
createdAt: '2026-09-30T17:41:18.431Z'
updatedAt: '2026-09-30T17:41:18.431Z'
---

## Description

Step 7 cutover entry gate — a checkpoint, not a behavior owner. Prove all 23 work in mixed mode before any legacy removal: run the ACC-005 smokes (Shepherd and plan:riff on Claude and Codex) and the prose review against the step-6 mixed build, and record the outcomes for the cutover task.

This task owns no B-### behavior and no ratified constraint; it only gates the next step. Halt if the gate is not satisfied rather than proceeding to strict cutover.

<!-- AC:BEGIN -->
- [ ] #1 ACC-005: the four interactive smokes (Shepherd and `plan:riff` on Claude and Codex) are recorded against the step-6 mixed build with outcomes
- [ ] #2 the prose-review pass compares each migrated declaration/extension prompt against the still-present `system-prompts/*.md` and records the result
- [ ] #3 all 23 names exist in mixed mode and `bun run typecheck`, `bun run check`, `bun test` and `bun run compile:all` pass
- [ ] #4 the recorded outcomes are handed to the cutover task; this checkpoint owns no behavior or constraint
<!-- AC:END -->
