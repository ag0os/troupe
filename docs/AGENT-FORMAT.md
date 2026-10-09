# Agent Format

Troupe agents are strict Markdown declarations under `agents/`. The path becomes the binary name: `agents/design/diagram/all.md` builds `bin/design:diagram:all`. A declaration may have a same-stem TypeScript extension that exports `prepare` or `finish`. The shared runner validates the declaration, composes prompts, selects a backend adapter, and owns execution and cleanup.

The compiler accepts only the fixed roster, the `ROSTER` list in `scripts/agent-compiler.ts`. This repository is not a registry for arbitrary extra binaries.

## Declaration schema

Every declaration starts with YAML frontmatter and uses its Markdown body as the system prompt.

```md
---
description: Review a change without editing it
backends: [claude, codex]
promptMode: append
mode: interactive
initialPrompt: "Review {{args}}"
model:
  claude: sonnet
effort:
  codex: high
access: read-only
flags:
  concise:
    type: boolean
    short: c
    description: Keep the review brief
---
Review the requested change. Report findings before summaries.
```

The frontmatter fields are:

| Field | Type and meaning |
| --- | --- |
| `description` | Required nonempty string used by generated help. |
| `backends` | Required nonempty ordered list containing `claude`, `codex`, or both. The first is the default. |
| `promptMode` | `append` or `replace`. Default: `append`. |
| `mode` | `interactive`, `print`, or `stream`. Default: `interactive`. |
| `initialPrompt` | Prompt template. Default: `{{args}}`. |
| `includes` | Ordered Markdown files under `agents/` or `system-prompts/`. The body comes first, with stable separators between parts. |
| `flags` | Named boolean, string, or enum flags. Each needs a description and may have a one-letter `short`. Boolean flags always default to `false`; `default: true` is rejected because there is no negated form. String flags may have a string default. Enum flags need a nonempty `values` list and may have a default from that list. |
| `model` | Optional model id for each declared backend. |
| `effort` | Claude: `low`, `medium`, `high`, or `max`. Codex: `minimal`, `low`, `medium`, or `high`. |
| `access` | `read-only`, `workspace-write`, or `full`. |
| `mcp` | Named stdio or HTTP MCP server declarations. |
| `native` | Backend-specific `args` and configuration. This is the escape hatch for behavior that the portable fields cannot express. |
| `passthrough` | Optional boolean. Default: `true`. When `false`, tokens after `--` become positional arguments and never reach the backend. |

Unknown keys fail validation, including unknown nested keys outside the intentionally opaque native configuration objects. Flag names use kebab case. A declaration cannot reuse framework flags or short names, repeat backends, mix stdio and HTTP fields in one MCP server, or provide settings for an undeclared backend.

Use `native.claude.args` and `native.claude.settings`, or `native.codex.args` and `native.codex.config`, only for backend-specific behavior. Native argument strings express valued flags, either as `--flag=value` or a `--flag`, `value` pair. An object such as `{ flag: "--verbose" }` inserts that valueless native CLI flag token. Its value must be a valid `--long` or `-s` flag. It does not refer to a declared agent flag. Native declarations cannot take over prompt transport or lifecycle fields owned by the runner.

## Prompts and templates

The system prompt is the declaration body followed by `includes` in order. Included files must resolve inside `agents/` or `system-prompts/`; symlink escapes fail compilation. The compiled binary embeds the result and does not read include files at launch.

`initialPrompt` supports:

- `{{args}}`, the positional arguments joined with spaces and trimmed.
- `{{cwd}}`, the effective working directory.
- `{{flag.name}}`, a resolved declared flag.
- One unnested conditional block using `{{#if condition}}`, optional `{{else if condition}}` branches, an optional `{{else}}`, and `{{/if}}`.

A condition is `args`, `flag.<boolean>`, or `flag.<enum> == "value"`. The `args` condition is true only when the space-joined, trimmed positional text is nonempty. An enum comparison value must be one of that flag's declared values.

Nested conditionals, expressions, commands, IO, and unknown or impossible references fail compilation.

`promptMode: append` adds the system prompt to the backend's instructions. `promptMode: replace` replaces them. On Codex, append mode sets `developer_instructions`; this replaces a user's own `developer_instructions` value, although Codex's built-in developer items remain. Replace mode uses an owner-only temporary model-instructions file.

## Command line

Every binary owns these framework options:

```text
--backend <declared-backend>
--cwd <dir>
--model <id>
--print
--show-prompt
-h, --help
```

`--backend` is the only backend selector. Without it, the first declared backend is used. There is no environment-based backend selection. Backend executables are found on `PATH`; `CLAUDE_PATH` is not read.

Options before a standalone `--` are parsed strictly. They must be framework options or flags declared by that agent. Positionals before `--` feed `{{args}}`. Backend flags go after `--` and are preserved byte for byte:

```bash
shepherd --backend claude -- --resume SESSION_ID
shepherd --backend codex -- resume --last
```

With `passthrough: false`, nothing is forwarded. Tokens after `--` are appended to the agent's positionals instead. Webfetch uses this form so a URL or prompt after `--` cannot become a Claude flag.

`-h` and `--help` print generated help without running preparation or a backend. `--show-prompt` also launches no backend. It runs preview-safe preparation and prints one selected backend in this envelope:

```text
Backend: <claude|codex>
--- System prompt ---
<text>
--- Initial prompt ---
<text>
--- Argv ---
["executable", ...]
```

Secrets are redacted in previews. Print mode captures and buffers backend output, then writes it when the backend exits. Stream mode decodes backend JSON lines as they arrive. Interactive mode inherits terminal IO.

For Claude children, the runner removes an inherited `CLAUDE_PROJECT_DIR`. It does not set `CLAUDE_FORGE_DIR`.

## Extensions

A declaration may have a same-stem `.ts` file that exports `prepare`, `finish`, or both. Both hooks may be synchronous or asynchronous. `prepare(ctx)` receives resolved flags, positionals, the verbatim backend passthrough, cwd, backend, whether the model came from `--model`, effective mode, preview state, the compiled spec, an abort signal, and a cancellable `runCommand` helper. `runCommand({ argv, cwd?, env? })` returns a promise for `{ exitCode, stdout, stderr }`. Preparation may return:

- extra system prompt fragments or a replacement initial prompt;
- Claude allow rules and additional directories;
- an interactive Claude session name;
- a launch model or effort, with an explicit framework `--model` taking precedence;
- an absolute Codex home, passed to Codex as `CODEX_HOME` and never put on argv;
- a new cwd or validated flag overrides;
- messages for before or after execution;
- an early exit with an exact message, stream, and code.

`finish(result, ctx)` runs only in print mode. `result` contains captured stdout, stderr, exit status, and any operational failure. The hook returns the final streams and exit code. Preparation commands and backend children are tracked by the runner so cancellation, waiting, listener removal, and temporary-resource cleanup have one owner.

Execution notices do not belong in print payloads. In particular, the PR review and Git fix agents do not emit a `Detected PR` notice under `--print`.

Extensions must not do work at module import time. Static inspection permits declarations and side-effect-free constants, imports from packages, builtins, `lib/agent-format/`, and `lib/shepherd/`, plus text imports of `.md` files under `system-prompts/`. The text-import exception lets an extension compose dynamic prompt layers without executing another module. In preview, preparation must not write files, start network work, or print.

Extensions return runner data, not raw backend commands. Use `runCommand` for git, `gh`, or another preparation child. Never spawn the backend from an extension.

## Backend mapping

| Portable concern | Claude | Codex |
| --- | --- | --- |
| Append prompt | `--append-system-prompt` | `-c developer_instructions=...` |
| Replace prompt | `--system-prompt` | `-c model_instructions_file=...` with an owner-only temporary file |
| Interactive mode | `claude [flags] -- prompt` with inherited IO | `codex [flags] -- prompt` with inherited IO |
| Print mode | `--print` | `codex exec`; stdin is ignored |
| Stream mode | `--print --output-format stream-json --verbose` | `codex exec --json`; stdin is ignored |
| Model | `--model` | `-m` |
| Effort | `--effort` | `-c model_reasoning_effort=...` |
| `read-only` access | `--permission-mode plan` | `-s read-only` |
| `workspace-write` access | `--permission-mode acceptEdits` | `-s workspace-write` |
| `full` access | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |
| MCP | Inline Claude JSON | Inline `mcp_servers` TOML configuration |
| User configuration | Inherited unless the declaration supplies native settings | Inherited unless the declaration supplies native configuration; print and stream skip the Git check only outside a worktree |

Native arguments are added before the user's post-`--` tail. The adapter owns final prompt placement. Empty settings and empty MCP configuration are omitted.

A stdio MCP `cwd` works only for a Codex-only declaration. Compilation rejects it if Claude is among the declared backends. Claude expands `${...}` in its MCP JSON, so for Claude-declared agents compilation also rejects a literal `${` that is not one of Troupe's supported secret references.

## MCP servers and secrets

An MCP server uses either stdio transport:

```yaml
mcp:
  search:
    command: npx
    args: [example-search-mcp]
```

If a stdio server reads a token from its inherited environment, export that token before launching the agent and keep it out of the declaration. Interpolated stdio `command`, `args`, `env`, and `cwd` values are rendered directly into backend MCP configuration on argv. Do not put a secret in those fields.

or HTTP transport:

```yaml
mcp:
  private-api:
    url: https://api.example.com/mcp
    headers:
      Authorization: "Bearer ${cmd:op item get 'Example MCP' --fields password --reveal}"
      X-Account: "${env:EXAMPLE_ACCOUNT}"
```

`${env:NAME}` reads the launch environment. `${cmd:...}` is split into an argv array with quote and backslash handling and is executed without a shell in the effective cwd. Shell operators, globbing, and variable expansion are rejected. The command must exit successfully and return nonempty output. Expansion is single-pass.

Interpolated HTTP header values are the protected case. They are passed as environment references: Claude receives `${VAR}` in its inline MCP JSON, and Codex receives `env_http_headers`. Literal Codex headers use `http_headers`. No roster agent currently uses secret interpolation; the mechanism remains available to declarations.

Only compiled declarations can name interpolation commands. Project files cannot inject them. Compilation, help, and preview never execute secret commands. Explicitly launching the agent is consent to execute them. Every interpolated value is redacted in previews. Interpolated stdio values still appear in the real backend configuration on argv and are visible to a same-user process listing. Interpolated HTTP header values stay out of argv and generated backend configuration, but they are exported to the child environment. A process owned by the same macOS user can see that environment with `ps eww`.

Troupe's interpolation boundary does not disable inherited backend configuration. Codex may automatically mark a Git project trusted in `~/.codex/config.toml`. Once trusted, that project's `.codex/` MCP servers, hooks, rules, and developer instructions are loaded by Codex itself. A first-run Codex TUI prompt can also consume an automatically submitted interactive prompt. Review backend configuration and project trust independently of Troupe declarations.

## Compilation and publication

The compiler is strict. Every discovered Markdown source for the supported roster is a declaration. It requires the exact roster and rejects a non-test `.ts` file unless it is a valid same-stem extension. Declaration, include, template, interpolation, extension, and roster failures name the source and field when possible.

Use:

```bash
bun run compile:all
bun run compile:all --dry-run
bun run compile:all --no-prune
bun run compile -- design:designer
bun run watch
```

`compile`, `compile:all`, and the watcher share one compiler. A full build validates all sources, builds every binary serially in a temporary directory on the same filesystem as `bin/`, verifies outputs, then renames them into place. A failure before publication leaves `bin/` untouched. A failure after renaming begins is reported as a partial update. A successful full build prunes binaries outside the roster unless `--no-prune` is used. `--dry-run` validates and reports without writing.

The watcher observes exactly `agents/` and `system-prompts/` and rebuilds the full roster after a change. Generated files in `bin/` are never edited by hand.

## Authoring checklist

1. Edit the roster declaration at `agents/<path>.md`.
2. Put portable behavior in frontmatter and the system prompt in the body.
3. Add a same-stem extension only for dynamic preparation or print result transformation.
4. Use `native.claude` or `native.codex` only when the portable schema cannot express the requirement.
5. Run the binary with `--help` and `--show-prompt` for each declared backend. These commands do not launch a backend.
6. Run `bun run check`, `bun run typecheck`, `bun test`, and `bun run compile:all`.
