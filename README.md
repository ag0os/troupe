# Troupe

A troupe of agents: each one declared once in this repo, compiled into a binary in `bin/`, and run from the terminal. The shared format supports Claude Code and Codex, so an agent is written once and runs on either backend it declares. Shepherd, the day to day assistant and manager, is built here too.

Formerly `claude-forge`; the repo was renamed in place on 2026-09-29.

## How it is organized

- **Agent declarations**, `agents/`: one Markdown file per agent. The frontmatter holds backend neutral configuration and the body is the system prompt. A same-stem `.ts` extension adds dynamic behavior only when an agent needs it. Subdirectories become the binary name: `agents/plan/planner.md` builds `bin/plan:planner`.
- **Shared prompts**, `system-prompts/`: fragments that several declarations or an extension pull in, including Shepherd's layered prompt.
- **Compiler and runner**: `scripts/` holds the compile and watch scripts; `lib/agent-format/` holds the schema, generated CLI, shared runner, and the Claude and Codex adapters. `lib/shepherd/` holds Shepherd's workspace and launch helpers.
- **Binaries**, `bin/`: standalone binaries produced by the compile scripts. Never edit them by hand; git ignores them.
- **Docs**, `docs/`: the guides listed below.

The compiler builds a fixed roster, the `ROSTER` list in `scripts/agent-compiler.ts`; a new declaration is compiled only once its name is there. To see the current agents, look in `agents/` or `bin/`, or run `bun run compile:all --dry-run`.

## Setup

Install [Bun](https://bun.sh) and Claude Code, Codex, or both, with their executables on `PATH`. Then:

```bash
git clone https://github.com/ag0os/troupe.git
cd troupe
bun install
bun run compile:all
export PATH="$PATH:/path/to/troupe/bin"   # add to your shell profile
```

[docs/SETUP.md](docs/SETUP.md) covers a fresh machine in full, including Shepherd's settings, Codex homes and Herdr.

## Running an agent

Every binary shares the same command line. Positionals form the prompt; backend flags go after a standalone `--`.

```bash
shepherd "triage my morning"
shepherd --help                     # this agent's flags and supported backends
shepherd --show-prompt              # print the prompt and argv, launch nothing
shepherd --backend codex            # run on another declared backend
shepherd -- --resume SESSION_ID     # pass a flag through to the backend
```

## Development

```bash
bun run watch                 # rebuild the roster whenever agents/ or system-prompts/ change
bun run compile -- <agent>    # rebuild one agent
bun test
bun run check:all             # typecheck and Biome, as CI and the pre-commit hook run it
```

## Docs

- [docs/AGENT-FORMAT.md](docs/AGENT-FORMAT.md): read before writing or changing a declaration or extension. It owns the schema, command line, backend mapping and compilation.
- [docs/SHEPHERD.md](docs/SHEPHERD.md): read to use, configure or extend Shepherd.
- [docs/SETUP.md](docs/SETUP.md): read when setting up a new machine.
- [docs/COACH.md](docs/COACH.md): read to use `tutors:coach` or write a subject pack for it.
- [docs/WEBFETCH-SKILL.md](docs/WEBFETCH-SKILL.md): read when an agent should call `tools:webfetch`.
- [AGENTS.md](AGENTS.md): conventions for coding agents and contributors working in this repo.

## Origins

This project was originally forked from [johnlindquist/claude-workshop-live](https://github.com/johnlindquist/claude-workshop-live), a workshop collection of Claude Code agents. It has since been reshaped into a backend-agnostic hub of declared agents; the git history records how.
