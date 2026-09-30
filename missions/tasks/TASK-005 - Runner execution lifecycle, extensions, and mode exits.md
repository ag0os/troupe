---
id: TASK-005
title: 'Runner execution lifecycle, extensions, and mode exits'
status: To Do
priority: high
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-004
  - TASK-003
createdAt: '2026-09-30T17:40:24.967Z'
updatedAt: '2026-09-30T17:40:24.967Z'
---

## Description

Step 2 execution lifecycle. Own the `run.ts` lifecycle: CLI -> prepare -> render -> interpolation -> adapter/preview -> execute/decode -> finish/messages -> cleanup, plus process support.

Ground: D-010 command/stream adapters, D-015 extensions return runner data, D-016 prepare carries required behavior, D-018 runner owns child cancellation and decode failures. Behavior owner for B-006. Design §1, §4, §5.

Ratified constraints: extensions use runner-owned command execution and never spawn a backend or build argv; all preparation/interpolation/backend children share the runner signal and cleanup. Halt on any extension creeping into direct spawn.

<!-- AC:BEGIN -->
- [ ] #1 B-006/D-016: `PrepareContext` exposes flags, args, cwd, backend, effective `mode`, `preview`, spec, an `AbortSignal` and runner-owned `runCommand`; prepare may return invocation data (fragments, initial prompt, extraAllowRules, cwd, flagOverrides, before/after-run messages) or an early exit with message, code and named stream
- [ ] #2 B-006: an early exit writes exactly its message to the named stream with its code; a prepare throw or command failure is stderr/1 in interactive/stream and a failure `RunResult` to `finish` in print; before-run messages print after preparation and before spawn and after-run messages follow a successful run; both are execution-only
- [ ] #3 B-006/D-016: the runner revalidates flag overrides (including Webfetch's finite max-turns normalization to `max(1,floor(n))`, else 3), resolves and freezes cwd/data, merges Claude-only rules/directories once, and fails closed when a nonempty rule object is returned on Codex
- [ ] #4 B-006/D-018: preparation, interpolation and backend children are tracked and share the signal, are aborted/awaited/cleaned up on signal, and `finish` runs only in print mode with its `FinishResult` written verbatim; a `finish` throw cleans up then exits stderr/1
- [ ] #5 B-006/D-010: Claude and Codex `StreamDecoder`s map complete JSON lines to ordered stdout/stderr emissions; malformed JSON, a decoder throw, or an incomplete non-decodable final line exits stderr/1, terminates/awaits the backend, cleans resources/listeners and suppresses after-run completion messages
- [ ] #6 B-006/D-015: importing a converted extension spawns no process and does not exit, and extensions never parse framework flags, build argv or spawn a backend directly
- [ ] #7 `bun run typecheck` and the project's test step pass for the runner
<!-- AC:END -->
