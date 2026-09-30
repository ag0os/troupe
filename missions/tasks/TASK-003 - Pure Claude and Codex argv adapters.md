---
id: TASK-003
title: Pure Claude and Codex argv adapters
status: To Do
priority: high
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-001
createdAt: '2026-09-30T17:40:20.598Z'
updatedAt: '2026-09-30T18:30:00.000Z'
---

## Description

Step 1 contract/preview vertical. Build the pure per-backend argv adapter boundary beside the untouched legacy runtime.

Ground: D-002 one AgentSpec with per-backend adapters, D-003 append default, D-004 inherit user config, D-006 portable core/native escape hatch, D-010 command and stream adapters, D-013 declaration guards, D-014 access mappings, D-024 adapters in a new namespace. Behavior owner for B-004. Design §1, §5.

Ratified constraints: prompt mode defaults to append and `base_instructions` is never emitted; undeclared backend policy is absent; a Claude-only rule is not emulated on Codex. The legacy runtime stays compiled until strict cutover (D-024). Halt on a backend-mapping/evidence contradiction under "Backend drift".

<!-- AC:BEGIN -->
- [ ] #1 D-002: `BackendAdapter`, `CommandPlan`, and `StreamDecoder` contracts live under `lib/agent-format/adapters/` with Claude and Codex implementations and an id-based selector; adapters receive resolved values plus resource paths and never probe the filesystem or spawn
- [ ] #2 B-004: only declared promptMode/mode/model/effort/access/MCP/cwd/native concerns become argv; undeclared policy and isolation stays absent — no sandbox/approval/effort/MCP/model overrides, no `--strict-mcp-config` or `--setting-sources` (D-004)
- [ ] #3 B-004/D-003: append maps to Claude `--append-system-prompt` and Codex `-c developer_instructions=<JSON.stringify(text)>`; replace maps to Claude `--system-prompt` and Codex `-c model_instructions_file=<path>`; `base_instructions` is never emitted and an empty body emits no prompt flag
- [ ] #4 B-004/D-014: access read-only/workspace-write/full map to Claude plan/accept-edits/bypass and Codex read-only/workspace-write/bypass; absence emits nothing
- [ ] #5 B-004: Claude stream mode emits `--print --output-format stream-json --verbose`; Codex exec ignores stdin and adds `--skip-git-repo-check` only when the runner's `insideGitWorktree` input says the cwd is outside a worktree; adapter argv never uses exec `-a` or `base_instructions`
- [ ] #6 B-004/D-006/D-013: forbidden lifecycle and prompt keys in authored `native` declarations are rejected, and adapters never synthesize or rewrite reserved post-`--` user tokens
- [ ] #7 D-024: `lib/runtime/**`, `lib/flags.ts`, `lib/claude.ts` and `lib/index.ts`'s runtime re-export remain unchanged and typechecked; `bun run typecheck` passes
- [ ] #8 Design §5: argv is composed as adapter-generated flags, then native args, then the verbatim post-`--` user tail, with the prompt placed last by the adapter (Claude interactive `claude [flags] -- prompt`, Codex interactive `codex [flags] prompt`); Claude native settings are merged with prepared rules exactly once, and empty settings or MCP objects emit no flag
<!-- AC:END -->
