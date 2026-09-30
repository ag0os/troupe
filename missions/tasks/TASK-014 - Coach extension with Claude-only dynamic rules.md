---
id: TASK-014
title: Coach extension with Claude-only dynamic rules
status: To Do
priority: medium
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-009
createdAt: '2026-09-30T17:41:14.320Z'
updatedAt: '2026-09-30T18:30:00.000Z'
---

## Description

Step 5 special extensions, commit family 5: coach. Convert the same-stem launcher into an extension that keeps its runtime composition and returns Claude-only rules.

Ground: D-016 prepare carries required behavior, D-015 extensions return runner data, D-028 backend flags after `--`. Delivers the Coach portion of B-007 (owned by TASK-009) and extension mechanics of B-006 (owned by TASK-005); this task owns neither behavior. Design §8.

Ratified constraints: dynamic rules return only on Claude so a Codex preview never errors; extensions never spawn or build argv (D-015). Land as its own same-stem commit with Coach snapshots, a nested-workspace Codex preview, and an import-has-no-side-effects check.

<!-- AC:BEGIN -->
- [ ] #1 D-016: Coach's prepare handles init/list, persisted roster/student/integrations, prompt and cwd, and returns dynamic rules only when `ctx.backend === "claude"`
- [ ] #2 D-016: a Codex preview of a nested Coach workspace shows the prompt/cwd with no rule error and is snapshotted; rule objects are never returned on Codex (fail-closed)
- [ ] #3 D-015: importing the extension spawns no process and does not exit, and the same-stem pair builds as declaration+extension
- [ ] #4 D-028: Coach's `--resume`/`--permission-mode` follow `--`, and the Coach pack frontmatter stays a separate runtime content contract
- [ ] #5 `bun run typecheck` and the project's test step pass with Coach snapshots
- [ ] #6 D-028: Coach's `--cwd`/`--show-prompt` are framework flags, not Coach-parsed flags
<!-- AC:END -->
