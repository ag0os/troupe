---
id: TASK-012
title: Webfetch extension and safety preservation
status: Done
priority: medium
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-009
createdAt: '2026-09-30T17:41:11.138Z'
updatedAt: '2026-10-02T15:25:09.000Z'
---

## Description

Step 5 special extensions, commit family 3: webfetch. Add the Markdown declaration, convert the same-stem launcher to an extension, preserve print-mode safety rules and rewrite the existing tests.

Ground: D-016 prepare/finish behavior, D-021 FORGE_BACKEND dropped, D-028 backend flags after `--`. Delivers the webfetch portion of B-007 (owned by TASK-009) and extension mechanics of B-006 (owned by TASK-005); this task owns neither behavior. Design §8.

Ratified constraints (stop-and-escalate): no binary reads `FORGE_BACKEND`; backend flags follow `--`; Webfetch's native tool allow/deny safety is preserved verbatim. Land as its own same-stem commit with snapshots, regressions and an import-has-no-side-effects check.

<!-- AC:BEGIN -->
- [x] #1 D-016: Webfetch is Claude print mode; prepare does usage/task normalization, max turns is fixed at 3 as the native Claude arg `--max-turns=3` with no declared flag (D-037) *(Amended 2026-10-02, D-037)*, and a missing URL is a stdout `ERROR:` early exit with code 64; the typed `finish` rewrites print payload/ERROR
- [x] #2 native WebFetch allow and Bash/Edit/Write/Read/Glob/Grep/Task/WebSearch deny rules are preserved, and framework `--model` plus declared flags are consumed
- [x] #3 D-021: compiled Webfetch keeps its prompt and safety rules and ignores an exported `FORGE_BACKEND`, including `FORGE_BACKEND=codex` — no FORGE_BACKEND is stop-and-escalate ratified ground
- [x] #4 Webfetch declares `passthrough: false`; tokens after `--` are positional arguments and never reach Claude; no forwarding and no alias (D-039) *(Amended 2026-10-02, D-039)*
- [x] #5 existing Webfetch tests are rewritten around the extension helpers and preserved cases
- [x] #6 D-015: importing the extension spawns no process and does not exit, and the same-stem pair builds as declaration+extension
- [x] #7 `bun run typecheck` and the project's test step pass
- [x] #8 B-007/D-005: Webfetch declares `backends: [claude]` and an explicit Codex backend fails clearly
<!-- AC:END -->
