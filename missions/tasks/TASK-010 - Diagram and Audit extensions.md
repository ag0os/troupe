---
id: TASK-010
title: Diagram and Audit extensions
status: To Do
priority: medium
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-009
createdAt: '2026-09-30T17:41:06.559Z'
updatedAt: '2026-09-30T17:41:06.559Z'
---

## Description

Step 5 special extensions, commit family 1: diagrams + audit. Add Markdown for Audit and the three diagram agents and convert their same-stem TypeScript into extensions.

Ground: D-016 prepare carries required behavior, D-019 exceptional migration contracts (diagram/audit banners at correct times), D-012 preview side-effect safety, D-015 extensions return runner data. Delivers the diagram/audit portion of B-007 (owned by TASK-009) and extension mechanics of B-006 (owned by TASK-005); this task owns neither behavior. Design §8.

Ratified constraints: preview must not create directories or print banners (D-012); extensions never spawn or build argv (D-015). Land as one same-stem commit family with its own snapshots and import-has-no-side-effects check.

<!-- AC:BEGIN -->
- [ ] #1 D-016: Audit declares its `expectations.md` include; prepare computes the audit directory, creates it only when `ctx.preview` is false, returns the start banner as `beforeRunMessages` and the post-child message as `afterRunMessages`
- [ ] #2 D-016: diagram all/consolidate/topic restore their bodies; prepare computes paths and mkdirs only when not preview, returns the start banner as `beforeRunMessages` and the post-child message as `afterRunMessages`, and topic validates and slugs its required argument
- [ ] #3 D-012: previewing Audit and each diagram agent leaves the temp workspace unchanged and emits no banner or prepare output
- [ ] #4 D-019: banner timing matches pre-migration behavior — start before the child, completion after it
- [ ] #5 D-015: importing each extension spawns no process and does not exit, and each same-stem pair is built as declaration+extension, never the hook as entry
- [ ] #6 `bun run typecheck` and the project's test step pass with snapshots for Audit and the three diagram agents
<!-- AC:END -->
