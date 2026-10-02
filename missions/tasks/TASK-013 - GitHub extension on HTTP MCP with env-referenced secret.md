---
id: TASK-013
title: Remove personas:github from the hub
status: Done
priority: medium
labels:
  - backend
  - 'plan:agent-format'
dependencies:
  - TASK-009
createdAt: '2026-09-30T17:41:12.879Z'
updatedAt: '2026-10-02T00:00:00.000Z'
---

## Description

Remove personas:github from the hub instead of migrating it (D-036, decided by the user 2026-10-02; amended from "GitHub extension on HTTP MCP with env-referenced secret"). The legacy launcher, the files only it used and its binary go away; the roster becomes 22 and strict mode requires exactly those 22. The Agent SDK dependency goes with it if nothing else imports it.

Ground: D-036, D-008 (amended roster), D-011, D-017. The MCP secret-interpolation mechanism in `lib/agent-format/` (`${env:...}`, `${cmd:...}`, D-026, D-029, D-032 to D-034) stays unchanged with no current user.

<!-- AC:BEGIN -->
- [x] #1 `agents/personas/github.ts` and every file only it used (`system-prompts/github-examples.md`) are deleted; shared files that merely listed it lose the entry
- [x] #2 `ROSTER` in `scripts/agent-compiler.ts` holds the 22 names without `personas:github`, and strict mode requires exactly those 22
- [x] #3 no test, message or script pins 23 or names `personas:github` outside history (reviews, evidence, Done tasks); `@anthropic-ai/claude-agent-sdk` is removed from `package.json` and `bun.lock` when nothing imports it
- [x] #4 `plan.md` (D-036 and the amended sections), `spec.md` (count and agent mentions) and TASK-016/017/019 are amended, each edit marked with D-036 (TASK-018 has no GitHub or count clause)
- [x] #5 `bun run compile:all` builds 22 binaries and prunes `bin/personas:github`
- [x] #6 `bun run typecheck`, `bun run check` and `bun test` pass
<!-- AC:END -->
