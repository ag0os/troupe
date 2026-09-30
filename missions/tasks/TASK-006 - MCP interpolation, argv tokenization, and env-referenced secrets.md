---
id: TASK-006
title: 'MCP interpolation, argv tokenization, and env-referenced secrets'
status: To Do
priority: high
labels:
  - backend
  - testing
  - 'plan:agent-format'
dependencies:
  - TASK-005
createdAt: '2026-09-30T17:40:27.080Z'
updatedAt: '2026-09-30T18:30:00.000Z'
---

## Description

Step 2 execution lifecycle. Own MCP transport mapping, single-pass interpolation, shell-free `${cmd:...}` tokenization, redaction, and the D-029 env-reference secret path.

Ground: D-026 `${cmd:...}` tokenized without a shell, D-029 MCP header secrets by environment. Behavior owner for B-005. Design §5, §6. Chrome uses the real `chrome-devtools-mcp` package.

Ratified constraints (stop-and-escalate): D-029 — interpolated header values never appear in argv, backend config files or process listings; secrets travel as env references. No shell is used for `${cmd:...}`. The D-029 experiment must pass before adapters rely on it; failure halts for human resolution.

<!-- AC:BEGIN -->
- [ ] #1 B-005: stdio and HTTP MCP servers map correctly on both backends, and interpolation visits MCP string leaves only, resolving `${env:NAME}` from the launch environment and `${cmd:...}` through `runCommand` in the effective cwd at launch time only
- [ ] #2 B-005/D-026: `${cmd:...}` text is split shell-style (single/double quotes, backslash escapes) into an argv array and run with no shell, so `op item get "Github CLI Token" --fields password --reveal` reaches the process with the item name as one argument; pipes, redirection, globbing, `;`/`&&` and variable expansion fail compile
- [ ] #3 B-005/D-026: command resolution trims one trailing line ending and requires exit zero and nonempty output; missing, failed or interrupted resolution stops before the backend with cleanup
- [ ] #4 B-005/D-029: an interpolated header value is never placed literally in backend argv or a backend-read config file; the runner exports each secret under a generated `TROUPE_MCP_<server>_<header>` variable and the adapters emit Claude `${VAR}` and Codex `env_http_headers`/`bearer_token_env_var` references, while literal non-interpolated values still map literally — stop-and-escalate ratified ground
- [ ] #5 B-005/D-029: the env-reference experiment for Claude `${VAR}` header expansion and Codex `env_http_headers`/`bearer_token_env_var` runs on both installed CLIs and is recorded in `evidence/backend-matrix.md` before the adapters rely on it; a failed experiment halts for human resolution under "Backend drift"
- [ ] #6 B-005/D-029: negative checks prove interpolated header values never appear in argv, backend config files or process listings, and actual/display values stay paired for redaction
- [ ] #7 `bun run typecheck` and the project's test step pass for interpolation and tokenization
- [ ] #8 B-005: Claude emits inline MCP JSON carrying stdio `command`/`args`/`env`/`cwd` and HTTP `url`/`headers`; Codex emits `mcp_servers.<name>` config with stdio `command`/`args`/`env`/`cwd` and HTTP `url`/`http_headers` (interpolated values via `env_http_headers`/`bearer_token_env_var`); a negative/mutation check fails if any declared header (literal or env-referenced) or stdio field is missing from either adapter's argv
<!-- AC:END -->
