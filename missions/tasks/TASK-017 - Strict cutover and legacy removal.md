---
id: TASK-017
title: Strict cutover and legacy removal
status: To Do
priority: high
labels:
  - backend
  - devops
  - 'plan:agent-format'
dependencies:
  - TASK-016
createdAt: '2026-09-30T17:41:20.404Z'
updatedAt: '2026-09-30T18:30:00.000Z'
---

## Description

Step 7 strict cutover and deletions. After the gate, remove the 12 ordinary launchers, enable strict mode and prove the exact roster, then remove the legacy runtime, prompts, settings, assets, helpers and the Agent SDK. No artifact may reference a deleted seam.

Ground: D-011 shared compiler, D-017 strict mode, D-020 legacy artifact waiver/test ownership, D-021 FORGE_BACKEND dropped, D-023 single-process publication, D-024 adapters beside legacy runtime. Delivers the strict-roster/removal portion of B-009 (owned by TASK-008); this task owns no behavior. Design §7, §9.

Ratified constraints (stop-and-escalate): no binary reads `FORGE_BACKEND`; `agents/local/` is not compiled; publication stays single-process (D-023). A failed build that alters `bin/` halts.

<!-- AC:BEGIN -->
- [ ] #1 D-017: the 12 ordinary `.ts` launchers are removed and strict mode is enabled; the compiler proves the exact 23-name roster with no non-extension `.ts` (paired or unpaired) or fallback remaining
- [ ] #2 D-024: obsolete paths are removed — `lib/runtime/**` with its colocated tests, `lib/claude.ts`, `lib/flags.ts`, `lib/claude-flags.types.ts`, `lib/assets.ts`, `lib/assets.gen.ts`, `lib/forge-root.ts`, `scripts/gen-assets.ts`, per-agent `settings/*.json`, migrated `system-prompts/*.md`, the Codex SDK and the `@anthropic-ai/claude-agent-sdk` dependency — and `lib/index.ts` exports new contracts only with no artifact referencing a deleted seam
- [ ] #3 D-011: `agents/local/` is not compiled and pruning removes any `local:*` binary; `package.json` scripts and `biome.json` scope reflect the shared compiler and exclude authored Markdown from unsupported-file checks — no agents/local is stop-and-escalate ratified ground
- [ ] #4 D-021: `getBackend` and every `FORGE_BACKEND` read are removed with the legacy launchers — no FORGE_BACKEND is stop-and-escalate ratified ground
- [ ] #5 D-020: test files remain worker-owned and are not listed in Files to Change
- [ ] #6 D-011/D-023: publication remains the single-process temp-dir build then rename; `bun run typecheck`, `bun run check`, `bun test` and `bun run compile:all` pass with exactly 23 binaries after strict cutover
- [ ] #7 before any deletion, `evidence/cutover-gate.md` shows all four smokes and the prose review passed, and strict-mode `compile:all` proves the exact 23-name roster with the legacy runtime still present; only then are the AC#2 paths removed
<!-- AC:END -->
