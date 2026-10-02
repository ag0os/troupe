# Repository Guidelines

## Project Overview

Troupe is a Bun + strict TypeScript repository for Markdown-declared CLI agents, optional TypeScript extensions, and shared agent-format utilities. It was recently renamed from `claude-forge`; preserve rename context when updating older docs or generated artifacts. See [the agent-format guide](docs/AGENT-FORMAT.md) for the authoring contract.

## Project Structure & Module Organization

- `agents/`: Markdown declarations and optional same-stem TypeScript extensions; subdirectories determine colon-delimited binary names.
- `lib/agent-format/`: Schema, CLI, runner, and Claude and Codex adapters.
- `system-prompts/`: Shared prompt fragments used by declarations and extensions.
- `scripts/` — Build/watch utilities.
- `bin/` — Generated binaries (do not edit manually).
- `docs/`: Documentation.

## Build, Test, and Development Commands

- `bun install` — Install dependencies.
- Use Bun commands, not npm/yarn/pnpm equivalents.
- `bun run watch`: Watch `agents/` and `system-prompts/`, then rebuild the fixed roster into `bin/`.
- `bun run compile:all` — Rebuild every agent into `bin/` and prune orphaned binaries.
- `bun test` — Run all tests.
- `bun run typecheck` — Run strict TypeScript checks without emitting files.
- `bun run check` — Run non-mutating Biome checks.
- `bun run check:all` — Run typecheck and Biome; used by CI and pre-commit hooks.
- `bun run lint`, `bun run lint:fix`, `bun run format` — Biome linting/formatting helpers; some mutate files.

## Coding Style & Naming Conventions

- TypeScript (ESM) with Biome formatting: tabs for indentation and double quotes.
- Never use default exports.
- Keep filenames in kebab case; tests use `*.test.ts`.
- Agent declarations use `agents/<path>.md`. A dynamic agent may pair it with `agents/<path>.ts` that exports `prepare` or `finish`.
- Put backend-neutral configuration in declaration frontmatter and the system prompt in the Markdown body.
- Generated files in `bin/` must be produced by the compile scripts, not edited by hand.

## Testing Guidelines

- Test runner: `bun test`.
- Tests live next to the code they cover (e.g. `lib/agent-format/*.test.ts`, `agents/tools/webfetch.test.ts`).
- Add or update tests for behavior changes; no explicit coverage target is enforced.
- Biome currently checks `agents/**/*`; run `bun run typecheck` for project-wide TypeScript validation.

## Commit & Pull Request Guidelines

- Commit subjects are typically imperative and concise (e.g. “Add …”, “Fix …”).
- Keep commits focused.
- PRs should include a brief summary, verification notes (commands run), and links to related docs.

## Security & Configuration Notes

- Store secrets in environment variables (e.g. API keys and tokens); never commit credentials.
- Agent behavior is controlled by declaration frontmatter and bodies, same-stem extensions, and shared fragments under `system-prompts/`.
- Extensions use the runner's `runCommand` helper. Backend termination and cleanup belong to the shared runner.
