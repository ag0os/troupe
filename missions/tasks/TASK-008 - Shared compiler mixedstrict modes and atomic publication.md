---
id: TASK-008
title: 'Shared compiler: mixed/strict modes and atomic publication'
status: To Do
priority: high
labels:
  - backend
  - devops
  - 'plan:agent-format'
dependencies:
  - TASK-005
  - TASK-006
  - TASK-007
createdAt: '2026-09-30T17:40:29.973Z'
updatedAt: '2026-09-30T18:30:00.000Z'
---

## Description

Step 3 compiler migration/publication. Extend the minimal compiler into the shared mixed/strict compiler with atomic single-process publication and the watcher, then switch package compile/watch to mixed mode before any agent conversion.

Ground: D-011 shared compiler and single-process build, D-017 mixed source set, D-023 publication cut to spec scope, D-027 includes in watched roots, D-008 roster. Behavior owner for B-009. Design §1, §7.

Ratified constraints (stop-and-escalate): publication is a single-process temp-dir build then rename, with no cross-process lock/quarantine/manifest validation (D-023); `agents/local/` is not compiled and any `local:*` binary is pruned (D-011); includes stay inside `agents/` and `system-prompts/` (D-027). A failed build that alters `bin/` halts.

<!-- AC:BEGIN -->
- [ ] #1 B-009/D-011: `compile`, `compile:all` and `bun watch` share one compiler; `compile:all` builds all 23 binaries in one process into a temporary directory on the same filesystem as `bin/`, renames only after every build succeeds, and leaves `bin/` untouched on failure; there is no cross-process lock, `previous`/`next`/quarantine protocol or manifest validation — D-023 single-process publication is stop-and-escalate ratified ground
- [ ] #2 B-009/D-011: `--dry-run` reports what would be built and pruned without writing, `--no-prune` rebuilds and leaves orphans, and default prune removes every `bin/` entry outside the roster except binaries owned by other package `compile:*` scripts
- [ ] #3 B-009/D-017: migration mode discovers the union of Markdown and legacy non-test TypeScript, lets `.md` win a same-stem collision, treats a paired TS as extension-only when it statically exports `prepare`/`finish` and passes the top-level side-effect check, and keeps an unpaired TS as a legacy launcher entry
- [ ] #4 B-009/D-017: strict mode discovers Markdown only, requires the exact 23-name roster, rejects any non-test `.ts` under `agents/` that is not a same-stem sibling statically exporting `prepare`/`finish`, and builds generated entries only
- [ ] #5 B-009/D-011: single compile accepts only roster names (a name outside the roster fails); `agents/local/` is never discovered and a present directory produces one warning line; the watcher serializes its queue, rebuilds all agents on change, and watches exactly `agents/` and `system-prompts/` — no agents/local and D-027 are stop-and-escalate ratified ground
- [ ] #6 D-027: an include's realpath must fall under `agents/` or `system-prompts/` or compile fails naming file and field
- [ ] #7 `bun run typecheck` and the project's test step pass for the shared compiler
- [ ] #8 B-001/D-008: roster discovery and roster errors (a missing, extra or out-of-roster name) name the offending file and field and publish nothing; TASK-008 alone owns the tests for these
<!-- AC:END -->
