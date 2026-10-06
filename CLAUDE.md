# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Troupe (formerly Claude Forge) is a collection of Markdown-declared agents compiled into binaries in `bin/`. The shared agent format supports Claude and Codex. See [docs/AGENT-FORMAT.md](docs/AGENT-FORMAT.md).

## Commands

### Development Commands
- `bun install` - Install dependencies
- `bun run compile -- <roster-name | agents/path.md>` - Compile one roster agent to `bin/`
- `bun run compile:all` - Rebuild every agent and prune orphaned binaries (`--dry-run`, `--no-prune`)
- `bun run watch` - Watch `agents/` and `system-prompts/` and rebuild the roster
- `bun lint` - Format and fix code with Biome
- `bun format` - Format code with Biome
- `bun check` - Run Biome checks without fixes
- `bun lint:fix` - Apply unsafe fixes with Biome

## Code Architecture

### Directory Structure
- `agents/` - Markdown declarations and optional same-stem TypeScript extensions, organized by namespace
- `lib/agent-format/` - Strict schema, templates, CLI, runner, and backend adapters
- `lib/shepherd/` - Shepherd workspace, maintenance, session, and launch helpers
- `system-prompts/` - Shared prompt fragments used by declarations and extensions
- `scripts/` - Build and development utilities
- `bin/` - Compiled binaries (generated)
- `docs/` - Documentation for framework features

### Agent Namespacing

Agents are namespaced via subdirectories. The directory structure determines the binary name:

| Source Path | Binary Name |
|-------------|-------------|
| `agents/plan/planner.md` | `plan:planner` |
| `agents/design/diagram/all.md` | `design:diagram:all` |

### Key Libraries
- `bun` - Runtime and package manager
- `biome` - Code formatter and linter
- `yaml` and `zod` - Declaration parsing and validation

### Core Patterns
- Agent settings, MCP servers, modes, models, access, and prompts are declared in Markdown frontmatter and bodies.
- A same-stem TypeScript extension may export `prepare` or `finish` for dynamic behavior.
- The generated runner finds `claude` and `codex` on `PATH`, owns child signals and cleanup, and removes an inherited project-directory variable before starting Claude.
- When working with containers, always merge changes back with `container-use merge <branch-name>`
- Container environments don't include uncommitted changes - commit first if needed

## Code Style

- Use tabs for indentation (configured in biome.json)
- Use double quotes for strings
- Organize imports automatically with Biome
- TypeScript and Markdown only, no plain JavaScript
- Avoid dashes in prose text
- Use `fd` for finding files, `rg` for searching contents

## Important Notes

- This is a Bun project - use `bun` not `npm` or `yarn`
- Biome excludes authored Markdown while checking TypeScript
- The project uses TypeScript with module syntax
- The strict compiler requires the fixed 22-agent roster and publishes standalone binaries through the shared compiler
