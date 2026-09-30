---
id: TASK-012
title: Webfetch extension and safety preservation
status: To Do
priority: medium
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-009
createdAt: '2026-09-30T17:41:11.138Z'
updatedAt: '2026-09-30T18:30:00.000Z'
---

## Description

Step 5 special extensions, commit family 3: webfetch. Add the Markdown declaration, convert the same-stem launcher to an extension, preserve print-mode safety rules and rewrite the existing tests.

Ground: D-016 prepare/finish behavior, D-021 FORGE_BACKEND dropped, D-028 backend flags after `--`. Delivers the webfetch portion of B-007 (owned by TASK-009) and extension mechanics of B-006 (owned by TASK-005); this task owns neither behavior. Design §8.

Ratified constraints (stop-and-escalate): no binary reads `FORGE_BACKEND`; backend flags follow `--`; Webfetch's native tool allow/deny safety is preserved verbatim. Land as its own same-stem commit with snapshots, regressions and an import-has-no-side-effects check.

<!-- AC:BEGIN -->
- [ ] #1 D-016: Webfetch is Claude print mode; prepare does usage/task/max-turn normalization (finite max turns become `max(1,floor(n))`, else 3) and a missing URL is a stdout `ERROR:` early exit with code 64; the typed `finish` rewrites print payload/ERROR
- [ ] #2 native WebFetch allow and Bash/Edit/Write/Read/Glob/Grep/Task/WebSearch deny rules are preserved, and framework `--model` plus declared flags are consumed
- [ ] #3 D-021: compiled Webfetch keeps its prompt and safety rules and ignores an exported `FORGE_BACKEND`, including `FORGE_BACKEND=codex` — no FORGE_BACKEND is stop-and-escalate ratified ground
- [ ] #4 D-028: backend flags such as Claude's `-p` follow `--`, with no forwarding or alias added
- [ ] #5 existing Webfetch tests are rewritten around the extension helpers and preserved cases
- [ ] #6 D-015: importing the extension spawns no process and does not exit, and the same-stem pair builds as declaration+extension
- [ ] #7 `bun run typecheck` and the project's test step pass
- [ ] #8 B-007/D-005: Webfetch declares `backends: [claude]` and an explicit Codex backend fails clearly
<!-- AC:END -->
