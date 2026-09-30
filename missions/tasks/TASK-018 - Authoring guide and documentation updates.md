---
id: TASK-018
title: Authoring guide and documentation updates
status: To Do
priority: medium
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-017
createdAt: '2026-09-30T17:41:21.973Z'
updatedAt: '2026-09-30T17:41:21.973Z'
---

## Description

Step 7 documentation task, separate from the cutover/deletions. Add the single authoring guide with the backend mapping table, remove the obsolete runtime proposal, and update the targeted docs, README, AGENTS.md and CLAUDE.md.

Ground: D-014 access mappings, D-021 FORGE_BACKEND dropped, D-028 backend flags after `--`, REQ-011. Behavior owner for B-011. Design §9.

Ratified constraints (stop-and-escalate): no doc mentions `FORGE_BACKEND`; passthrough guidance is the `--` form; `agents/local/` guidance is removed. No full README rewrite (rename is out of scope).

<!-- AC:BEGIN -->
- [ ] #1 B-011: `docs/AGENT-FORMAT.md` covers schema, prompts/templates, flags and `--` passthrough, extension data/cancellation, MCP trust including Codex project auto-trust, the Design §5/D-014 backend mapping table (append/replace, mode, model/effort, access, MCP, config inheritance), the `native.claude`/`native.codex` escape hatch, backend selection (`--backend` only; no env selection), strict compiler and publication, and examples
- [ ] #2 B-011: `docs/AGENT-RUNTIME.md` is removed; README, AGENTS.md and CLAUDE.md link to the one guide and contain no stale path, backend, CLI passthrough or private-agent guidance
- [ ] #3 B-011/D-021: `docs/SHEPHERD.md` no longer mentions `FORGE_BACKEND`; SHEPHERD/COACH passthrough sentences use the `--` form; `docs/WEBFETCH-SKILL.md` reflects the new runtime — no FORGE_BACKEND is stop-and-escalate ratified ground
- [ ] #4 B-011/D-028: active docs describe backend flags after `--` and remove `agents/local/` guidance from CLAUDE.md and AGENTS.md — no agents/local is stop-and-escalate ratified ground
- [ ] #5 `bun run check` passes and no active doc references a deleted file
<!-- AC:END -->
