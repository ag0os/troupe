---
id: TASK-002
title: 'CLI parsing, generated help, and declared-flag consumption'
status: To Do
priority: high
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-001
createdAt: '2026-09-30T17:40:18.329Z'
updatedAt: '2026-09-30T17:40:18.329Z'
---

## Description

Step 1 contract/preview vertical. Build strict pre-`--` CLI parsing, generated help, and the D-025 template grammar.

Ground: D-005 backend restriction, D-013 declaration guards and verbatim user passthrough, D-021 no env selection, D-025 conditional grammar, D-028 backend flags after `--`. Behavior owner for B-002. Design §3.

Ratified constraints (stop-and-escalate): no generated binary reads `FORGE_BACKEND` or legacy aliases; backend flags (`--resume`, `--permission-mode`, Claude `-p`) follow `--`; no unknown-flag forwarding or alias is added. Halt on any ratified-ground collision.

<!-- AC:BEGIN -->
- [ ] #1 B-002: every generated binary consumes framework and declared bool/enum/string flags with defaults and both `--flag value` and `--flag=value` forms before a standalone `--`, preserving positionals in order
- [ ] #2 B-002/D-028: unknown pre-`--` input fails with a clear nonzero error so backend flags must follow `--`; tail tokens after `--` remain verbatim and are never inspected or rewritten (D-013)
- [ ] #3 B-002/D-021: backend resolution is explicit `--backend` then the first declared backend, and an explicit `--backend` naming an undeclared backend fails hard (D-005); no binary reads `FORGE_BACKEND` or its legacy aliases (`claude-cli`, `codex-cli`, `codex-sdk`) — stop-and-escalate ratified ground
- [ ] #4 B-002: `--help` is generated from the spec (description, default backend, mode, framework flags, agent flags/defaults/passthrough); parse, cwd and backend errors go to stderr nonzero without running prepare
- [ ] #5 D-025: template validation accepts `{{args}}`, `{{cwd}}`, `{{flag.name}}` and one level of `if/else if/else` over boolean flags, enum equality and `args` truthiness; nesting, malformed and unknown/impossible references fail compile
- [ ] #6 `bun run typecheck` and the project's static-analysis step pass, and `lib/agent-format/cli.ts` imports no adapter
<!-- AC:END -->
