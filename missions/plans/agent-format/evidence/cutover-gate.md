# Cutover entry gate (TASK-016)

Build: `hub/agent-format` at 38e643b (step 6 complete), mixed mode, `bin/` rebuilt from that commit: 22 binaries.
Recorded 2026-10-02.

## Repository checks (AC #3)

On the same tree (the TASK-015 worktree before its fast-forward, run by the Shepherd alone): `bun run typecheck` and
`bun run check` clean; `bun test` three runs, 842 pass, 10 skip, 0 fail each; `bun run compile:all` 22 built, 0
pruned. All 22 names exist in `bin/`.

## Interactive smokes, ACC-005 (AC #1, #5)

Run on 2026-10-02 between 18:28 and 18:38 by an observer agent (Codex 0.159.3, gpt-5.6-sol), at the maintainer's
request, each in its own terminal pane. The observer recorded outcomes only; sign-off is the maintainer's (below).
Smoke workspace: `/tmp/af-smoke-016`, with `flock/.shepherd/integrations/00-smoke.md` (marker SMOKE-FLOCK) and
`flock/child/.shepherd/charter.md` (marker SMOKE-CHARTER). Claude runs used `--model claude-opus-5-5`; Codex runs used
`--model gpt-5.6-sol` with `-- -c model_reasoning_effort=low`.

| # | Backend | Agent | Cwd the session reported | Prompt seen | Exit |
|---:|---|---|---|---|---:|
| 1 | Claude | shepherd (`--cwd .../flock/child`) | `/private/tmp/af-smoke-016/flock/child` | yes: enclosing `flock` line with `00-smoke.md`, SMOKE-FLOCK and SMOKE-CHARTER | 0 |
| 2 | Codex | shepherd (`--cwd .../flock/child`) | `/private/tmp/af-smoke-016/flock/child` | yes: same three items | 0 |
| 3 | Claude | plan:riff | `/private/tmp/af-smoke-016` | yes: describes itself as the Riff agent | 0 |
| 4 | Codex | plan:riff | `/private/tmp/af-smoke-016` | yes: describes itself as the design exploration specialist | 0 |

Also run, outside ACC-005: `tools:webfetch https://example.com "What is the page title?"` printed `Example Domain`,
exit 0. This is the real-CLI check of the D-040 native arg `--setting-sources=user`: Claude accepted the flag form.

Seen and not caused by the build: Claude's and Codex's folder-trust prompts for the new temp folder; Codex's hook-review
prompt; a Codex update notice; Codex's "embedded mode" startup warning (Codex prints it whenever `-c` overrides are
passed); a WebSockets-to-HTTPS fallback on this machine's network.

Sign-off: the maintainer, 2026-10-02 ("yes"), on the outcomes above.

## Prose review (AC #2)

Each migrated declaration (and extension) prompt was compared with the still-present `system-prompts/*.md` composed the
way the legacy launchers at bbdf19e composed them, using `bin/<name> --show-prompt` for the new side. Result: no prose
is lost or rewritten in any of the 22 agents.

| Result | Agents |
|---|---|
| byte-identical | git:fix, tutors:coach |
| whitespace only (the compiler trims a body's outer whitespace) | build:comment-review, build:refactor, design:architect, design:diagram:all, design:diagram:consolidate, design:diagram:topic, meta:prompt, plan:planner, plan:riff, resume:tailor, review:pr, tools:webfetch |
| differs, justified | analyze:orient, build:builder, build:tdd, design:designer, modes:contain, rails:backlog, design:audit, shepherd |

Justified differences, accepted:
- build:builder, build:tdd, design:designer, modes:contain, rails:backlog (D-007, Design §8 "reminder in body"): the
  legacy `UserPromptSubmit` echo text now ends the body under `## Reminder`, verbatim.
- analyze:orient: its legacy hook was a `PostToolUse` status echo (`[orient] Search completed, analyzing results...`),
  which could not move verbatim as an instruction; the body's reminder reads "After each search completes, analyze the
  results before continuing." (D-007).
- design:audit: the `[Expectations Quality Bar]` label now ends the audit body, before the include separator `---`,
  instead of opening the expectations section. A consequence of the include separator (Design §2); meaning unchanged.
  Accepted.
- shepherd: only `system-prompts/shepherd/core.md:69`, the source-reference line TASK-015 AC #8 changes.
- design:diagram:all, consolidate and topic: whitespace only against their prompt files, but the legacy binaries sent
  no system prompt at all (defect D1); the body is now delivered (spec acceptance, Design §8 "restored bodies").
- tools:webfetch: the prompt is whitespace only; its `--describe` usage text changed as D-037 and D-039 require.

Full table and method: the Shepherd's workspace report `TASK-016-prose-review.md` (not in this repository).

## Handed to the cutover task (AC #4)

TASK-017 may start: the maintainer signed off above. Carried to it: remove the `CLAUDE_PATH` note from
`.env.example` with `lib/runtime` (D-041), and delete the migration-check tests that read legacy prompt and settings
files (each names TASK-017 in a comment).
