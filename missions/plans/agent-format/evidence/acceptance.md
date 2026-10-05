# Whole-roster acceptance verification (TASK-019)

Build: `hub/agent-format-019` at `8cffff1`.
Recorded 2026-10-02.

The run stopped during AC #4 under the brief's deviation rule. The Shepherd (the coordinating agent) then directed a continuation with one fresh real Claude run and AC #5.

## AC #1: full previews and repository checks

Commands and outcomes:

- `bun run typecheck`: exit 0.
- `bun run check`: exit 0, 18 files checked, no fixes applied.
- `bun test`: exit 0, 774 pass, 0 fail, 58 snapshots, 4,272 expectations across 18 files. No skipped tests were reported.
- `bun run compile:all`: exit 0, 22 built, 0 pruned.
- `ls bin | wc -l`: 22.

The full declared-backend preview matrix is pinned as follows. Each named test section checks both the composed prompt and adapter argv.

| Agent | Declared backends | Pinning test and snapshot |
|---|---|---|
| `analyze:orient` | claude, codex | `agents/ordinary.test.ts`, `--show-prompt envelopes per declared backend (B-003)` |
| `build:builder` | claude | `agents/ordinary.test.ts`, same section |
| `build:comment-review` | claude, codex | `agents/git-review.test.ts`, `--show-prompt envelopes per declared backend (B-003)` |
| `build:refactor` | claude, codex | `agents/ordinary.test.ts`, same section |
| `build:tdd` | claude | `agents/ordinary.test.ts`, same section |
| `design:architect` | claude, codex | `agents/ordinary.test.ts`, same section |
| `design:audit` | claude, codex | `agents/design/diagram-audit.test.ts`, `--show-prompt envelopes per declared backend (B-003)` |
| `design:designer` | claude, codex | `agents/ordinary.test.ts`, same section |
| `design:diagram:all` | claude, codex | `agents/design/diagram-audit.test.ts`, same section |
| `design:diagram:consolidate` | claude, codex | `agents/design/diagram-audit.test.ts`, same section |
| `design:diagram:topic` | claude, codex | `agents/design/diagram-audit.test.ts`, same section |
| `git:fix` | claude, codex | `agents/git-review.test.ts`, `--show-prompt envelopes per declared backend (B-003)` |
| `meta:prompt` | claude, codex | `agents/ordinary.test.ts`, same section |
| `modes:contain` | claude | `agents/ordinary.test.ts`, same section |
| `plan:planner` | claude, codex | `agents/ordinary.test.ts`, same section |
| `plan:riff` | claude, codex | `agents/ordinary.test.ts`, same section |
| `rails:backlog` | claude | `agents/ordinary.test.ts`, same section |
| `resume:tailor` | claude, codex | `agents/ordinary.test.ts`, same section |
| `review:pr` | claude | `agents/git-review.test.ts`, `--show-prompt envelopes per declared backend (B-003)` |
| `shepherd` | claude, codex | `agents/shepherd.test.ts`, `--show-prompt envelopes (B-003, AC #4)` |
| `tools:webfetch` | claude | `agents/tools/webfetch.test.ts`, `--show-prompt envelopes (B-003)` |
| `tutors:coach` | claude, codex | `agents/tutors/coach.test.ts`, `--show-prompt envelopes (B-003, AC #5)` |

Result: PASS.

## AC #2: Codex canary and named regressions

`bun test lib/agent-format/canary.test.ts` ran against the installed Codex. It did not skip. Result: 24 pass, 0 fail. The real `codex debug prompt-input` test confirmed the canary is a developer message and the base developer items remain.

Built-binary preview commands and outcomes:

- `bin/analyze:orient --quick --show-prompt`: quick initial prompt present.
- `bin/analyze:orient --focus tech --show-prompt`: technology-focused initial prompt present.
- `bin/review:pr --comment 123 --show-prompt`: comment workflow present and `--comment` absent from backend argv. The named `review:pr --comment regression` tests also passed.
- `bin/plan:riff --model opus --show-prompt`: argv contains `--model`, `opus`.
- `bin/design:diagram:all --show-prompt auth`: system and initial prompts present.
- `bin/design:diagram:consolidate --show-prompt`: system and initial prompts present.
- `bin/design:diagram:topic --show-prompt Payments`: system prompt and Payments initial prompt present.
- `FORGE_BACKEND=codex bin/tools:webfetch --show-prompt https://example.com`: backend remains Claude, the Webfetch prompt remains present, and its Claude rules and fixed max turns remain in argv. The compiled-binary environment regression test also passed.

Result: PASS.

## AC #3: Shepherd workspace previews

For `/Users/cosmos/shepherds` and each requested child workspace, the current binary was run as `bin/shepherd --show-prompt --cwd <dir>`. The legacy comparison was run from the same directory as `/Users/cosmos/Projects/troupe/bin/shepherd --show-prompt`.

All nine prompts contain the flock module. Each prompt differs from the legacy preview only at permitted `core.md` line 69:

- `/Users/cosmos/shepherds`: differs at line 69.
- `absync`: differs at line 69.
- `ag0osPro`: differs at line 69.
- `ag0osW3b`: differs at line 69.
- `bright`: differs at line 69.
- `cosmonauts`: differs at line 69.
- `forge`: differs at line 69.
- `sportsengine`: differs at line 69.
- `test`: differs at line 69.

The master preview has no enclosing-workspace `additionalDirectories` entry and no double-slash `Read` rule. Every child preview has `/Users/cosmos/shepherds/.shepherd` in `additionalDirectories` and the matching `Read(//Users/cosmos/shepherds/.shepherd/**)` allow rule.

Result for the Shepherd portion: PASS.

## Interactive smokes (ACC-005)

Run on 2026-10-02 at about 20:20 by an observer agent (Codex 0.159.3, gpt-5.6-sol), at the maintainer's request as for
TASK-016, against `bin/` built from 38ed30c (the strict build without the legacy runtime; 8cffff1 changed only docs).
Same smoke workspace shape as `cutover-gate.md`, in `/tmp/af-smoke-019`.

| # | Backend | Agent | Cwd the session reported | Prompt seen | Exit |
|---:|---|---|---|---|---:|
| 1 | Claude | shepherd (`--cwd .../flock/child`) | `/private/tmp/af-smoke-019/flock/child` | yes: enclosing `flock` line, SMOKE-FLOCK and SMOKE-CHARTER | 0 |
| 2 | Codex | shepherd (`--cwd .../flock/child`) | `/private/tmp/af-smoke-019/flock/child` | yes: same three items | 0 |
| 3 | Claude | plan:riff | `/private/tmp/af-smoke-019` | yes: describes itself as the riff agent | 0 |
| 4 | Codex | plan:riff | `/private/tmp/af-smoke-019` | yes: describes itself as a design exploration partner | 0 |

Also run: `tools:webfetch https://example.com "What is the page title?"` printed `Example Domain`, exit 0.

Sign-off: the maintainer, 2026-10-05 ("yes"), on the outcomes above.

## AC #4: one real Claude stream launch

`bin/plan:riff --help` showed `--print` but no framework stream option. Design sections 3 and 5 confirm that the CLI exposes the print override and that Claude stream argv is `--print --output-format stream-json --verbose`. The requested print plus Claude passthrough form was therefore selected.

### Earlier mistaken launch

The preview attempt was entered incorrectly as:

`bin/plan:riff --print --model haiku 'Reply with the single word ok.' -- --output-format stream-json --verbose --show-prompt`

Because `--show-prompt` was after `--`, it was passed to the real Claude CLI. Claude rejected it with `error: unknown option '--show-prompt'`. It emitted no JSON, so there are no first or last JSON lines. The exit was nonzero, but the exact code was not retained by the combined command invocation. The run stopped and this failure was reported. The maintainer confirmed that this was a command error, not a product failure, and authorized one fresh real run.

### Corrected preview and authorized real run

The corrected preview command was:

`bin/plan:riff --show-prompt --print --model haiku 'Reply with the single word ok.' -- --output-format stream-json --verbose`

Its argv was:

`["claude","--print","--append-system-prompt","<the full Riff system prompt>","--model","haiku","--output-format","stream-json","--verbose","--","Reply with the single word ok."]`

The one newly authorized real run was made from `/var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.3DOuvS64M1`:

`/Users/cosmos/Projects/troupe-agent-format-019/bin/plan:riff --print --model haiku 'Reply with the single word ok.' -- --output-format stream-json --verbose > claude-stream.jsonl 2> claude-stream.stderr`

The next command was `echo $?` on its own. It printed `0`. The run produced seven JSON lines and zero stderr lines.

First JSON line:

```json
{"type":"system","subtype":"hook_started","hook_id":"94d230d8-457e-4e5f-bd5c-bb5f2a57e0c2","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"32544b78-a473-43a5-adad-eacfdb4de313","session_id":"2f331842-db36-4a3a-ad48-d5052a7402d4"}
```

Last JSON line:

```json
{"duration_api_ms":1559,"stop_reason":"end_turn","session_id":"2f331842-db36-4a3a-ad48-d5052a7402d4","total_cost_usd":0.0375945,"usage":{"input_tokens":10,"cache_creation_input_tokens":17981,"cache_read_input_tokens":13975,"output_tokens":45,"output_tokens_details":{"thinking_tokens":38},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":17981,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":10,"output_tokens":45,"cache_read_input_tokens":13975,"cache_creation_input_tokens":17981,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":17981},"type":"message"}],"speed":"standard","fallback_credit":null},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":10,"outputTokens":45,"cacheReadInputTokens":13975,"cacheCreationInputTokens":17981,"webSearchRequests":0,"costUSD":0.0375945,"contextWindow":200000,"maxOutputTokens":32000,"thinkingTokens":38,"canonicalModel":"claude-haiku-4-5","provider":"firstParty","costBasis":"list"}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},"is_error":false,"num_turns":1,"subtype":"success","api_error_status":null,"result":"ok","ttft_ms":1581,"type":"result","duration_ms":1628,"uuid":"ef582215-defb-452d-8b60-0129f007bebb","ttft_stream_ms":1198,"time_to_request_ms":58,"first_content_frame_ms":1198,"queued_turn_count":0,"result_index":0}
```

Result: PASS after the Shepherd-directed continuation. The earlier rejected launch remains recorded above.

## AC #5: Codex trust and prose review

### Credential-free Codex project-trust check

Installed CLI: `codex-cli 0.159.3`. `codex exec --help` documents `--skip-git-repo-check` as allowing execution outside a Git repository. It also exposes `--ephemeral`, `--ignore-user-config`, and dotted TOML overrides through `-c`. It exposes no flag described as suppressing a project-trust write.

The experiment root was `/var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS`. A new Git repository was initialized at its `repo` child. Six sibling `CODEX_HOME` directories were created. Before execution, each contained only a `config.toml` with this minimal content and no credentials:

```toml
# TASK-019 throwaway configuration. No credentials.
```

The commands were:

```sh
CODEX_HOME=/var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/home-baseline codex exec -C /var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/repo 'Reply with ok.'
CODEX_HOME=/var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/home-skip codex exec --skip-git-repo-check -C /var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/repo 'Reply with ok.'
CODEX_HOME=/var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/home-ephemeral codex exec --ephemeral -C /var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/repo 'Reply with ok.'
CODEX_HOME=/var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/home-ignore codex exec --ignore-user-config -C /var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/repo 'Reply with ok.'
CODEX_HOME=/var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/home-untrusted codex exec -c 'projects."/private/var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/repo".trust_level="untrusted"' -C /var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/repo 'Reply with ok.'
CODEX_HOME=/var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/home-trusted codex exec -c 'projects."/private/var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/repo".trust_level="trusted"' -C /var/folders/kq/1jrmsh1141b4x5cfd79qyq200000gn/T/tmp.BL0n4KoMlS/repo 'Reply with ok.'
```

The baseline visibly reached the expected credential-free `401 Unauthorized` and exited 1. The remaining cases completed in the same sequential command; their exact exit codes scrolled beyond the first capture window and were not retained. Every case did run and created only its own throwaway runtime state. No `auth.json` or other credential was present or copied.

After every run, all six `config.toml` files had the same SHA-1, `d3e5158692f0b62c483a300aa324015731a2db12`, as the initial minimal file. Direct diffs against the initial content were empty. No project trust entry was written before the credential failure in any case.

Conclusion: on installed Codex 0.159.3, baseline `codex exec` already performs no project-trust write before the credential failure. None of the tested flags is needed to prevent such an early write, and help documents no dedicated no-trust-write flag. The credential-free experiment cannot determine whether a successful authenticated run writes trust later. The real `~/.codex` and `~/.codex-work` were neither read nor written.

### Prompt prose review

TASK-016 recorded a comparison of all 22 prompts with the legacy files and found no lost or rewritten prose. TASK-017 showed all 76 previews identical before and after the legacy deletions.

Fresh `--show-prompt` output was read for `design:audit`, `analyze:orient`, `shepherd`, and `tools:webfetch`. The four prompts have no doubled separator and no empty leaf section. Orient, Shepherd, and Webfetch have no stray standalone label. Design Audit retains the previously accepted `[Expectations Quality Bar]` marker immediately before the include separator; it marks the transition into the expectations include and is not a new composition defect. No broken prose structure was found.

Result: PASS, with the authenticated post-success trust behavior explicitly undetermined as allowed by the credential-free check.

## AC #6: test ownership and behavior ownership

No test or production code was changed. Test files remain worker-owned and outside Files to Change. TASK-019 owns no behavior and no ratified constraint.

Result: PASS.
