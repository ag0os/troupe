---
id: TASK-004
title: Deterministic secret-safe preview envelope
status: To Do
priority: high
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-001
  - TASK-002
  - TASK-003
createdAt: '2026-09-30T17:40:22.224Z'
updatedAt: '2026-09-30T21:00:00.000Z'
---

## Description

Step 1 contract/preview vertical. Build the deterministic, secret-safe preview path and its placeholder model.

Ground: D-012 deterministic secret-safe preview. Behavior owner for B-003. Design §3. Preview never launches a backend and is safe for agents whose prepare creates directories or calls `gh`.

Ratified constraint: preview performs no `${cmd:...}` substitution and no filesystem writes; secrets use stable redacted placeholders. Halt if preview/error disclosure cannot be prevented ("Secrets/trust").

<!-- AC:BEGIN -->
- [ ] #1 B-003: `--show-prompt` prints exactly the fixed envelope (Backend, System prompt, Initial prompt, Argv) for one compiled fixture on both declared backends, then exits 0 without launching a backend
- [ ] #2 B-003/D-012: preview runs preparation with `ctx.preview === true`, performs no backend or `${cmd:...}` substitution, uses stable redacted placeholders for secrets and temp prompt paths, and emits no before/after-run messages
- [ ] #3 B-003/D-012: preview-mode preparation writes no files, runs no network children and prints nothing, and the runner absorbs any preparation stdout so nothing beyond the envelope reaches stdout
- [ ] #4 B-003: an unknown backend or failing preview request exits nonzero with diagnostics on stderr and no partial envelope
- [ ] #5 Quality Contract: negative checks prove no secret command executes, no filesystem write occurs, and no banner reaches stdout in preview
- [ ] #6 D-016 (step 1): define the `PrepareContext` type (flags, args, cwd, backend, effective `mode`, `preview`, spec, `AbortSignal`) with a basic runner-owned `runCommand`, plus the runner's prepare-to-preview call path used by the fixture; child tracking/abort, early exits, flagOverrides revalidation and execution are left to TASK-005
- [ ] #7 B-002/Design §3 (moved from TASK-002 AC #7): a `--model opus` preview on a declared-model agent and on an agent with no declared model shows Claude `--model opus` / Codex `-m opus` in the argv; a `--print` preview shows print-mode argv (Claude `--print`, Codex `exec`), and that mode is what `ctx.mode` and the adapter receive
<!-- AC:END -->
