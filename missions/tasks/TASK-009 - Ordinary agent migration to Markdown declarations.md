---
id: TASK-009
title: Ordinary agent migration to Markdown declarations
status: To Do
priority: high
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-008
createdAt: '2026-09-30T17:40:31.543Z'
updatedAt: '2026-09-30T17:40:31.543Z'
---

## Description

Step 4 ordinary migration. Convert the non-extension agents to Markdown declarations with policies, reminders and snapshots, letting mixed mode shadow each same-stem legacy sibling atomically.

Ground: D-001 Format A, D-005 backend restriction, D-007 no hooks (echo hooks become prompt text), D-008 agents-only hub, D-025 orient conditionals, D-028 backend flags after `--`. Behavior owner for B-007. Design §8.

Ratified constraints (stop-and-escalate): backend flags follow `--` (D-028); seven specified agents are Claude-only; no `agents/local/` or utility agents. Prompt prose is reviewed for meaning, not sentence-asserted. Halt on a ratified-behavior collision or a failed build that alters `bin/`.

<!-- AC:BEGIN -->
- [ ] #1 B-007/D-001: the 12 ordinary agents (orient, builder, refactor, tdd, architect, designer, meta prompt, modes contain, plan planner, plan riff, rails backlog, resume tailor) are declared as `agents/<ns>/<name>.md` with body prompts and path-derived names, while their legacy `.ts` launchers stay functional until strict cutover
- [ ] #2 B-007: meaningful prompt/permission/MCP/mode behavior and body reminders are preserved; dead settings keys, empty `mcpServers`, `defaultMode:"default"`, `CLAUDE_PROJECT_DIR` and lifecycle echoes are dropped or moved into prompt text (D-007)
- [ ] #3 B-007/D-005: builder, tdd and rails:backlog are Claude-only (`backends: [claude]`); every other migrated ordinary agent declares Claude then Codex, and an undeclared explicit backend fails clearly
- [ ] #4 B-007/D-025: orient's template renders quick over focus, else each focus value, else full orientation, and adds `Additional context: {{args}}` only when args are present, pinned by `orient`, `orient --quick --focus tech` and `orient foo`
- [ ] #5 B-007/D-008: builder uses the real `chrome-devtools-mcp` package with Claude tool rules, and the hub contains agents only
- [ ] #6 D-028: the intended CLI change is that backend flags such as contain's `-p` now follow `--`, with no unknown-flag forwarding or alias added — stop-and-escalate ratified ground
- [ ] #7 `bun run typecheck` passes and mixed-mode `compile:all` builds all 23 names with the new ordinary declarations shadowing their same-stem legacy siblings while special agents stay functional legacy binaries
<!-- AC:END -->
