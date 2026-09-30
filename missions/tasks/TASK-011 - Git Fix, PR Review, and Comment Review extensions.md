---
id: TASK-011
title: 'Git Fix, PR Review, and Comment Review extensions'
status: To Do
priority: medium
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-009
createdAt: '2026-09-30T17:41:08.464Z'
updatedAt: '2026-09-30T18:30:00.000Z'
---

## Description

Step 5 special extensions, commit family 2: git-fix + pr-review + comment-review. Add Markdown and convert the same-stem launchers into extensions with their early-exit and prompt contracts.

Ground: D-007 no hooks, D-015 extensions return runner data, D-016 prepare carries required behavior, D-019 exceptional migration contracts. Delivers the git-fix/pr-review/comment-review portion of B-007 (owned by TASK-009) and extension mechanics of B-006 (owned by TASK-005); this task owns neither behavior. Design §8.

Ratified constraints: preview never calls `gh` and writes nothing; extensions never spawn or build argv (D-015). Land as one same-stem commit family with snapshots, regressions and an import-has-no-side-effects check.

<!-- AC:BEGIN -->
- [ ] #1 D-019: Git Fix's prepare uses the supplied PR, else detects it with `gh` through `runCommand`; in preview it uses the supplied PR or a stable placeholder and never calls `gh`; a missing PR is a stderr early exit
- [ ] #2 D-019: PR Review declares its comment flag, prepare PR/conditional prompt and Claude rules, and the `review:pr --comment` regression is fixed. D-012/D-019: PR Review's prepare uses the supplied PR, or else detects it with `gh` through `runCommand`. In preview it uses the supplied PR or a stable placeholder and never calls `gh`. A missing PR is a stderr early exit with code 1. A negative test proves that `review:pr --show-prompt` with no PR argument spawns no `gh`
- [ ] #3 D-019: Comment Review's prepare computes the diff and exits empty when there is nothing to review, with Claude Edit/Read/Glob/Grep allow rules
- [ ] #4 D-007: the legacy echo hooks are represented as prompt text, not backend hooks
- [ ] #5 D-015: importing each extension spawns no process and does not exit, and each same-stem pair builds as declaration+extension
- [ ] #6 `bun run typecheck` and the project's test step pass with snapshots and regressions for the three agents
- [ ] #7 B-007/D-005: PR Review declares `backends: [claude]` and an explicit Codex backend fails clearly
<!-- AC:END -->
