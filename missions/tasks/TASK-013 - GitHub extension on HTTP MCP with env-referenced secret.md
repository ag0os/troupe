---
id: TASK-013
title: GitHub extension on HTTP MCP with env-referenced secret
status: To Do
priority: medium
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-009
createdAt: '2026-09-30T17:41:12.879Z'
updatedAt: '2026-09-30T17:41:12.879Z'
---

## Description

Step 5 special extensions, commit family 4: github. Move personas:github off the Agent SDK to a prompt plus HTTP MCP in stream mode, with the 1Password token resolved via D-026 tokenization and D-029 env-referenced secrets.

Ground: D-019 exceptional migration contracts (required-single-prompt preparation), D-026 no-shell `${cmd:...}`, D-029 env-referenced header secrets, D-012 preview safety. Delivers the GitHub portion of B-007 (owned by TASK-009), the MCP portion of B-005 (owned by TASK-006) and extension mechanics of B-006 (owned by TASK-005); this task owns none of those behaviors. Design §8.

Ratified constraints (stop-and-escalate): D-029 secrets never appear in argv, backend config files or process listings; no shell; preview runs no `op` command. Land as its own same-stem commit with snapshots, regressions and an import-has-no-side-effects check.

<!-- AC:BEGIN -->
- [ ] #1 D-019: GitHub is Claude-only stream/replace with the `--verbose` stream argv; prepare requires only `args[0]` and runs `op signin --raw` through `runCommand` on execution only (never in preview), discarding its output
- [ ] #2 D-026/D-029: GitHub's strict declared HTTP MCP uses `${cmd:op item get "Github CLI Token" --fields password --reveal}` tokenized quote-aware with no shell, and the resolved secret travels by env reference, never literally on argv — D-029 is stop-and-escalate ratified ground
- [ ] #3 the Agent SDK is not used; GitHub runs from a prompt plus HTTP MCP with its declared tool list preserved
- [ ] #4 D-015: importing the extension spawns no process and does not exit, and the same-stem pair builds as declaration+extension
- [ ] #5 D-012/D-029: preview executes no `op` command and exposes no secret in argv or config, using stable redacted placeholders
- [ ] #6 `bun run typecheck` and the project's test step pass with snapshots for GitHub
<!-- AC:END -->
