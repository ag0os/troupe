---
id: TASK-019
title: Whole-roster acceptance verification
status: To Do
priority: high
labels:
  - testing
  - 'plan:agent-format'
dependencies:
  - TASK-017
  - TASK-018
createdAt: '2026-09-30T17:41:23.708Z'
updatedAt: '2026-09-30T18:30:00.000Z'
---

## Description

Step 8 whole-roster acceptance — a verification task, not a behavior owner. Run the full matrix and recorded sign-off evidence after strict cutover and docs: full snapshots, named regressions, repository checks, exact binaries, canary, Shepherd fixture comparison, the four smokes re-run, one real-CLI Claude stream-mode launch, the codex project-trust check and prose review.

This task owns no B-### behavior and no ratified constraint. D-020: test files stay worker-owned and are not Files to Change entries. If any recorded outcome contradicts ratified ground, halt under the deviation protocol.

<!-- AC:BEGIN -->
- [ ] #1 ACC-001/ACC-002: full `--show-prompt` snapshots for every agent × declared backend pin prompt plus argv, and repository checks plus `compile:all` produce exactly 23 binaries
- [ ] #2 ACC-003/ACC-004: the Codex canary is recorded (skipped when absent) and the named regressions pass — `orient --quick`, `orient --focus tech`, `review:pr --comment`, `--model opus`, the diagram agents receiving their prompt, and compiled Webfetch keeping its prompt and ignoring an exported `FORGE_BACKEND=codex`
- [ ] #3 ACC-005/ACC-006: the four smokes are re-run after the SDK and helpers are gone, and Shepherd's `--show-prompt` for each `~/shepherds/*` workspace still contains the inherited flock module and the enclosing `.shepherd/` in additionalDirectories against the `e18f56b` fixtures
- [ ] #4 one recorded real-CLI Claude stream-mode launch proves the `--print --output-format stream-json --verbose` argv
- [ ] #5 Quality Contract: a recorded check states whether any `codex exec` flag avoids the project-trust write, and direct review covers the prompt prose
- [ ] #6 D-020: test files remain worker-owned and outside Files to Change; this acceptance task owns no behavior or constraint
- [ ] #7 canary, re-run smokes, real-CLI stream launch and project-trust check outcomes are written to `missions/plans/agent-format/evidence/acceptance.md`, with the interactive smokes performed by the sign-off maintainer
<!-- AC:END -->
