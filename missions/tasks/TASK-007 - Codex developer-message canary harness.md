---
id: TASK-007
title: Codex developer-message canary harness
status: To Do
priority: high
labels:
  - testing
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-005
createdAt: '2026-09-30T17:40:28.232Z'
updatedAt: '2026-09-30T18:30:00.000Z'
---

## Description

Step 2 execution lifecycle. Build the fake-CLI/canary harness that verifies Codex developer-message delivery through the real `codex debug prompt-input` path (skipped when Codex is absent).

Ground: ACC-003, D-003. Behavior owner for B-010. Design §5, §9.

Ratified constraint: prompt mode append maps to Codex `developer_instructions`, never `base_instructions`. Halt on a backend-mapping/evidence contradiction under "Backend drift".

<!-- AC:BEGIN -->
- [ ] #1 B-010: a prompt-debug canary using the adapter's Codex args shows the canary text as a developer message while the base developer instructions remain
- [ ] #2 B-010: when Codex is absent the canary test skips explicitly; when Codex is installed and the canary fails, the test fails rather than passing silently
- [ ] #3 Quality Contract: the canary asserts the real developer-message channel rather than a substring of composed prompt text
- [ ] #4 `bun test` passes with the canary included
- [ ] #5 Quality Contract: fake Claude and Codex CLIs on PATH record argv/env for runner tests, and the fake Claude rejects `--print --output-format stream-json` without `--verbose`
<!-- AC:END -->
