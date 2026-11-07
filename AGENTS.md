# Repository Guidelines

## Project Overview

Troupe is a Bun + strict TypeScript repository for Markdown-declared CLI agents, optional TypeScript extensions, and shared agent-format utilities. It was recently renamed from `claude-forge`; preserve rename context when updating older docs or generated artifacts. See [the agent-format guide](docs/AGENT-FORMAT.md) for the authoring contract.

## Project Structure & Module Organization

- `agents/`: Markdown declarations and optional same-stem TypeScript extensions; subdirectories determine colon-delimited binary names.
- `lib/agent-format/`: Schema, CLI, runner, Claude and Codex adapters, and the compiler (`compiler.ts`, `binary-name.ts`).
- `lib/entries/`, `lib/index.ts`: The package export map's public entries (`troupe`, `troupe/declaration`, `troupe/cli`, `troupe/runtime`, `troupe/compiler`, `troupe/provenance`, `troupe/testing`, `troupe/text-imports`).
- `lib/shepherd/`: Shepherd workspace, maintenance, session, and launch helpers.
- `extractions/shepherd/`: The extracted Shepherd package, a checked copy of the Shepherd tree with its own `package.json`, lockfile and gates (see below).
- `system-prompts/`: Shared prompt fragments used by declarations and extensions.
- `scripts/`: Build/watch utilities; `agent-compiler.ts` holds the fixed `ROSTER` and, with `binary-name.ts`, wraps the compiler; `stage-troupe.ts` stages the distribution; `setup-extractions.ts`, `check-extraction-gates.ts` and `shepherd-copy.test.ts` set up and check the extracted package.
- `bin/` — Generated binaries (do not edit manually).
- `docs/`: Documentation.

## Build, Test, and Development Commands

- `bun install` — Install dependencies.
- `bun run setup:extractions`: Stage Troupe into `extractions/.troupe-dist/troupe/`, run the extracted package's frozen install and check where its runtime dependencies resolve. A fresh checkout runs `bun install`, then this, before its first commit; root checks assume it ran. Rerun it after changing anything the stage copies.
- Use Bun commands, not npm/yarn/pnpm equivalents.
- `bun run watch`: Watch `agents/` and `system-prompts/`, then rebuild the fixed roster into `bin/`.
- `bun run compile:all` — Rebuild every agent into `bin/` and prune orphaned binaries.
- `bun test` — Run all tests.
- `bun run typecheck` — Run strict TypeScript checks without emitting files.
- `bun run check` — Run non-mutating Biome checks.
- `bun run check:all` — Run typecheck and Biome; used by CI and pre-commit hooks. The hook runs nothing else, so it does not install or stage.
- `bun scripts/check-extraction-gates.ts`: Prove each root and package gate fails on a planted type, lint and test error in a disposable copy.
- `bun test ./scripts/shepherd-copy.test.ts`: Check the extracted package against the original layout. Root `bun test <path>` filters by substring, so prefix root paths with `./`.
- Inside `extractions/shepherd/`: `bun run typecheck`, `bun run check`, `bun test`, the package's own gates, which CI runs after the root ones.
- `bun run lint`, `bun run lint:fix`, `bun run format` — Biome linting/formatting helpers; some mutate files.

## Extracted Shepherd Package

- `extractions/shepherd/` is a checked copy of Shepherd that builds and tests on its own against the staged Troupe distribution in the ignored `extractions/.troupe-dist/`. The original layout still builds `bin/shepherd`. Shepherd's documentation (`PACKAGES.md`, `SHEPHERD.md`, `SHEPHERD-EVALS.md`, `SETUP.md`, `STAMPS.md`) lives in `extractions/shepherd/docs/`; the first four keep transitional copies under `docs/`.
- Every Shepherd-owned change (agent, `lib/shepherd/`, `system-prompts/shepherd/`, `packages/software/`, `evals/shepherd/`, the v2 source policy and those four documents) lands in both trees in the same change until the package leaves this repository. `scripts/shepherd-copy.test.ts` enforces it: the trees must match in presence, bytes and executable status except for the rewrites `extractions/shepherd/ADAPTATIONS.json` records.
- A change that needs a package lockfile update refreshes and commits `extractions/shepherd/bun.lock` explicitly, then passes `bun run setup:extractions`, whose install is frozen.

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
