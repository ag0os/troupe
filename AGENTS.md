# Repository Guidelines

## Project Overview

Troupe is a Bun + strict TypeScript repository for CLI agent launchers and shared runtime utilities. It was recently renamed from `claude-forge`; preserve rename context when updating older docs or generated artifacts. Agent integrations currently use `@anthropic-ai/claude-agent-sdk`.

## Project Structure & Module Organization

- `agents/` — TypeScript agent launchers; subdirectories determine colon-delimited binary names.
- `agents/local/` — Private/local-only agents; do not assume these should ship.
- `lib/` — Shared utilities and the backend runtime (`lib/runtime`).
- `forge/` — Historical plans (`forge/plans/`).
- `settings/`, `system-prompts/`, `prompts/` — Agent settings and prompt templates.
- `scripts/` — Build/watch utilities.
- `bin/` — Generated binaries (do not edit manually).
- `docs/`, `ai/` — Documentation and generated artifacts.

## Build, Test, and Development Commands

- `bun install` — Install dependencies.
- Use Bun commands, not npm/yarn/pnpm equivalents.
- `bun run watch` — Watch and auto-compile agents into `bin/`.
- `bun run compile:all` — Rebuild every agent into `bin/` and prune orphaned binaries.
- `bun test` — Run all tests.
- `bun run typecheck` — Run strict TypeScript checks without emitting files.
- `bun run check` — Run non-mutating Biome checks.
- `bun run check:all` — Run typecheck and Biome; used by CI and pre-commit hooks.
- `bun run lint`, `bun run lint:fix`, `bun run format` — Biome linting/formatting helpers; some mutate files.

## Coding Style & Naming Conventions

- TypeScript (ESM) with Biome formatting: tabs for indentation and double quotes.
- Never use default exports.
- Keep filenames in `kebab-case.ts`; tests use `*.test.ts`.
- Agent files in `agents/` should match settings files:
  - `agents/my-agent.ts`
  - `settings/my-agent.settings.json` (optional)
  - `settings/my-agent.mcp.json` (optional)
- Generated files in `bin/` must be produced by the compile scripts, not edited by hand.

## Testing Guidelines

- Test runner: `bun test`.
- Tests live next to the code they cover (e.g. `lib/runtime/*.test.ts`, `agents/tools/webfetch.test.ts`).
- Add or update tests for behavior changes; no explicit coverage target is enforced.
- Biome currently checks `agents/**/*`; run `bun run typecheck` for project-wide TypeScript validation.

## Commit & Pull Request Guidelines

- Commit subjects are typically imperative and concise (e.g. “Add …”, “Fix …”).
- Keep commits focused.
- PRs should include a brief summary, verification notes (commands run), and links to related docs.

## Security & Configuration Notes

- Store secrets in environment variables (e.g. API keys and tokens); never commit credentials.
- Agent behavior is controlled via `settings/`, `system-prompts/`, and `prompts/`; update those alongside agent code when necessary.
- When working with subprocesses or agent backends, handle termination and cleanup paths explicitly.
