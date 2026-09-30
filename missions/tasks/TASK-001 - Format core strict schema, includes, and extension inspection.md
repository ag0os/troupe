---
id: TASK-001
title: 'Format core: strict schema, includes, and extension inspection'
status: To Do
priority: high
labels:
  - backend
  - 'plan:agent-format'
dependencies: []
createdAt: '2026-09-30T17:40:16.676Z'
updatedAt: '2026-09-30T18:30:00.000Z'
---

## Description

Step 1 contract/preview vertical. Build the pure AgentSpec contract and strict source validation that every later slice depends on.

Ground: D-001 Format A, D-008 fixed 23-agent roster, D-009 compiler-owned IO with pure schema, D-017 static extension inspection, D-027 includes limited to watched roots, D-026 no-shell `${cmd:...}`. Behavior owner for B-001. Design §1, §2, §4.

Ratified constraint: the hub holds agents only (D-008) — utilities are not compiled. Includes outside `agents/` or `system-prompts/` are compile errors, not warnings. Do not add behavior outside the plan. A ratified-ground collision, an unrepresentable behavior, or a failed build that alters `bin/` halts under the deviation protocol.

<!-- AC:BEGIN -->
- [ ] #1 B-001: a valid `agents/<ns>/<name>.md` compiles to a path-derived binary id with the body followed by stable-separated includes, and the AgentSpec defaults promptMode append, mode interactive, and `{{args}}`
- [ ] #2 B-001: malformed, unknown-key, cross-field and include errors name the offending file and field and produce no binary
- [ ] #3 B-001/D-027/D-026: an include whose realpath leaves `agents/` or `system-prompts/`, `${cmd:...}` text that needs a shell, and a paired extension with top-level side effects each fail compile with file and line
- [ ] #4 D-009/D-014: `parseAgentMarkdown` plus pure materialization validate the Design §2 AgentSource shape with strict `yaml`/`zod` (zod ^4) declared in `package.json` and `bun.lock`; duplicate/reserved flags, shorts and backends, enum-default mismatch, mixed MCP transports, undeclared native backend and bad template references error with file/field
- [ ] #5 D-017: the minimal single compiler compiles one fixture and statically inspects its paired TypeScript exports without importing executable siblings; roster discovery and publication belong to TASK-008
- [ ] #6 `bun run typecheck` passes and no source outside `lib/agent-format/`, `scripts/binary-name.ts`, `scripts/agent-compiler.ts`, `package.json` and `bun.lock` is modified
- [ ] #7 D-013: each `native.claude.args`/`native.codex.args` entry is structurally validated as a long `--flag=value` token, a two-token `--flag value` pair or a `{flag}` NativeArg, and each Codex `-c` entry must have a well-formed `key=value` key; reserved prompt-transport flags (`--system-prompt`, `--append-system-prompt`, `developer_instructions`, `model_instructions_file`), lifecycle hooks and `base_instructions` fail compile with file and field
<!-- AC:END -->
