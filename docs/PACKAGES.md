# Shepherd packages, contract 1

A package gives Shepherd three things for one kind of work: module text for the session prompt, tools the session
runs as `shepherd tool <package> <tool>`, and guides it reads on demand. This document is the whole contract. A
package written against it needs nothing from Troupe's source, so it can live in Troupe's `packages/`, in a shared
workspace, or in a repository of its own.

## Layout

A package is a directory named after the package:

```
<location>/<name>/
  MODULE.md          frontmatter, then the module text (the prompt body)
  tools/<tool>       one executable file per declared tool
  guides/<guide>.md  one Markdown file per declared guide
```

Nothing else in the directory is read, so a package may carry its own tests, a README or a license. `<name>` matches
`^[a-z]+(?:-[a-z]+)*$` (letters and hyphens, because the charter's `Modules:` line is tokenized that way) and is not a
reserved name: `check`, `archive`, `guide`, `init`, `doctor`, `start`, `journal`, `checkpoint`, `unlock`, `query`,
`charter`, `memory`, `tools`.

A location is a directory of packages. Shepherd reads two:

- the base location, `packages/` in the checkout that holds the running `shepherd` binary (`<bin>/../packages`);
- the enclosing location, `<enclosing workspace>/.shepherd/packages/`, the shared layer of the workspace above.

A workspace sees a package only when its charter names it on the `Modules:` line, exactly as it names built-in
modules. That one selection decides all three things a package offers: its module text in the prompt, its tools and
its guides. A package found in no location is unknown; a package found in two is refused (see below).

Base packages are read from disk at run time, never compiled into the binary. A copied `shepherd` binary without its
checkout still launches; it composes without the base packages, and `shepherd tool doctor` reports `packages:base`.

## MODULE.md frontmatter

The frontmatter is strict YAML 1.2 between `---` lines, with the first key on the first nonblank line. The module
fields keep the meaning they have for any Shepherd module (`name`, `type`, `description`, `budget`, `applies-when`,
`provides`, `default`, `charter-keys`; see "Module format" in [SHEPHERD.md](SHEPHERD.md)). A package adds `contract`,
`tools` and `guides`:

```yaml
---
name: mail                        # must equal the directory name
type: domain
description: Triage and answer email through hey
applies-when:
  charter-declares: mail          # loads where the charter says "Modules: mail"
budget: 400
charter-keys: {}
contract: 1                       # required; the version of this document
tools:                            # optional
  unread:
    description: List unread threads in the inbox   # one line, required
    access: read                  # read | write, required
    requires: [hey]               # optional; executables that must be on PATH
    network: true                 # optional, default false; informational
guides:                           # optional
  triage:
    description: How to triage the inbox, in order    # one line, required
---
# Integration: Mail
...the module text...
```

Rules:

- `contract` is the integer 1. Any other value, or none, excludes the whole package (module, tools and guides) with a
  `package-contract` problem in the session header and a `shepherd tool check` error. The rest of the frontmatter is
  not read, so a newer package is refused for one reason, not a list of unknown keys.
- Unknown keys are errors, at the top level and inside a tool or guide declaration. A package with any frontmatter
  problem loads nothing and is reported.
- Tool and guide names match `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- Every declared tool must exist as `tools/<tool>` with the executable bit; every declared guide as
  `guides/<guide>.md`. An executable in `tools/` that is not declared is never run.
- `contract`, `tools` and `guides` are errors in a module that is not a package (a file in `.shepherd/integrations/`).

`access: read` is a promise about every argument the tool accepts: it changes nothing in the repository, the workspace
or anywhere else, except temporary files under `$TMPDIR`. On Claude Code the launcher turns that promise into a
permission rule that approves the tool for all arguments, so a read tool with a write mode breaks the contract: make
the write mode a second tool with `access: write`. Write tools get no rule and prompt like any other command.

`network: true` says the tool reaches the network. It changes no rule; see "Harnesses" below for what it means on each.

## Invocation

Shepherd runs a tool as

```
shepherd tool <package> <tool> [args...]
```

and must see those words first on the command line: framework flags before `tool` (`shepherd --cwd X tool ...`) make
it an ordinary command, not a package run. Everything after `<tool>` belongs to the tool, including `--json` and
`--help`. Shepherd does not parse them.

- **argv.** The tool is executed directly, with no shell between: `argv[0]` is the tool's absolute path, the rest is
  `[args...]` unchanged. The file needs a shebang and the executable bit.
- **Working directory.** The caller's, unchanged. A tool acts on the directory the agent stands in, which may be a
  repository outside the workspace. The workspace is given in the environment.
- **Environment.** The caller's, plus:

  | Variable | Value |
  |----------|-------|
  | `SHEPHERD_CONTRACT` | `1` |
  | `SHEPHERD_PACKAGE` | the package name |
  | `SHEPHERD_PACKAGE_DIR` | the absolute path of the package directory |
  | `SHEPHERD_TOOL` | the tool name |
  | `SHEPHERD_WORKSPACE` | the workspace whose charter authorized the run |
  | `SHEPHERD_STATE_DIR` | `$SHEPHERD_WORKSPACE/.shepherd` |
  | `SHEPHERD_CONFIG_DIR` | `$XDG_CONFIG_HOME/shepherd`, or `~/.config/shepherd` |

  A tool that needs a private value reads it from a file under `$SHEPHERD_CONFIG_DIR/packages/<package>/`, never from
  the package, so the package can be published.
- **Streams.** stdin, stdout and stderr are inherited. Human-readable text by default. Under the tool's own `--json`,
  exactly one JSON object on stdout with `"contract": 1` and `"tool": "<tool>"`.
- **Exit codes.** The tool's code is returned unchanged; a signal gives 128 plus its number. Convention: 0 done or
  clean, 1 a negative result (findings), 2 usage or environment error. Tools should answer `--help` with usage on
  stdout and exit 0.
- **Runtime.** A tool may assume a POSIX `/bin/sh` and its utilities, `execve`, and the variables above. Anything else
  (git, bun, hey) goes in `requires`, which `shepherd tool check` verifies on PATH. Shepherd never runs a tool during a
  check.

### Which workspace authorizes a run

The workspace whose charter decides is `SHEPHERD_WORKSPACE` when it names a directory with a `.shepherd/`, else the
nearest directory with `.shepherd/` from the working directory upward, the working directory included. Every Shepherd
launch sets `SHEPHERD_WORKSPACE` to its own launch directory, so a session that `cd`s into a repository outside its
workspace can still run its packages' tools there.

The variable decides which workspace authorizes a package run, and nothing else: no core tool, session name or
identity reads it. A launcher variable is inherited by every process the session starts, nested sessions and forks
included. A nested Shepherd launch replaces it with its own directory, but a delegate agent, a fork or a shell started
from the session keeps the parent's value, and runs the parent workspace's package tools as that workspace authorizes
them. That is the intended reach for a delegate working on the session's behalf; it is also why the variable is never
used to tell which session is running.

## Guides

`shepherd tool guide` lists the core guides and then the guides of every package the workspace selects, as
`<package> <guide>: <description>`. `shepherd tool guide <package>` lists one package's guides.
`shepherd tool guide <package> <guide>` prints `guides/<guide>.md` whole to stdout, exit 0. Guides are found from the
workspace of the working directory, upward.

The session header carries one line per kind, present only when a selected package declares one:

```
- Package tools: mail unread (read), mail send (write); run as shepherd tool <package> <tool> [args], --help for usage; read tools need no permission prompt on Claude
- Package guides: mail triage (How to triage the inbox, in order); read with shepherd tool guide <package> <guide>
```

## What is refused

Each refusal runs nothing, prints one line prefixed `shepherd:` on stderr and exits 2:

| Case | Message |
|------|---------|
| the charter does not name the package | `package "mail" is not named on this workspace's Modules: line; its tools are unavailable here` |
| the tool is not declared, whether or not a file exists | `package "mail" declares no tool "send"; tools: unread` |
| no tool is given | `package "mail" needs a tool: shepherd tool mail <tool> [args]; tools: unread` |
| the declared file is missing | `package "mail" tool "unread" is missing: <path>` |
| the declared file is not executable | `package "mail" tool "unread" is not executable: <path>` |
| `contract` is missing or not 1, or the frontmatter has problems | `package "mail" is excluded: <MODULE.md>: package-contract: ...` |
| the package name is found in two locations | `package "mail" is found in 2 locations: <dir>, <dir>` |
| no workspace can be found | `no workspace for package "mail": SHEPHERD_WORKSPACE names none and no .shepherd/ is found from <cwd> upward` |

`tool guide` refuses the same way, with `its guides are unavailable here`, `no package named "<name>"` and
`package "mail" declares no guide "<guide>"`. A `<package>` that is a core command runs that command. A `<package>`
that no location holds falls through to the tool usage text, exit 2.

## Checking a package

`shepherd tool check`, run in a workspace, reports every package the workspace can see, selected or not. Package
files display as absolute paths.

| Code | Level | Means |
|------|-------|-------|
| `package-contract` | error | `contract` missing or not 1 |
| `package-tool-missing` | error | a declared tool has no file |
| `package-tool-not-executable` | error | a declared tool's file lacks the executable bit |
| `package-tool-undeclared` | info | a file in `tools/` is not declared; it is never run |
| `package-guide-missing` | error | a declared guide has no file |
| `package-requires-missing` | warn | a `requires` entry is not on PATH (a PATH lookup only) |
| `package-name-reserved` | error | the package takes a core command or guide name |
| `package-duplicate` | error | the name is found in two locations; neither loads |

Frontmatter errors are `module-schema` and `module-name`, as for any module.

## Harnesses

- **Claude Code.** For every read tool of a selected package the launcher adds `Bash(shepherd tool <package> <tool> *)`
  to the session's allow rules, passed inline with `--settings`. The rule matches the command as written, so run
  `shepherd tool ...`, not the binary's absolute path. Write tools get no rule.
- **Codex.** The launcher writes no rule. Codex takes no per-session rules, and an exec-policy `allow` would run the
  tool outside the sandbox, which is more than a read tool should get. Under `sandbox_mode = "workspace-write"` a tool
  that writes only inside the workspace and temp runs without a prompt; a tool with `network: true`, or one that writes
  elsewhere, is stopped by the sandbox and escalates. To prompt instead, add a `decision = "prompt"` rule for the
  command in `~/.codex/rules/` or `<repo>/.codex/rules/` by hand; Shepherd never writes those files. This is inferred
  from Codex's sandbox model and has not been observed in a session.

## The mail example

The frontmatter above, `tools/unread` as a `#!/bin/sh` wrapper around one read-only `hey` command, and
`guides/triage.md` are a complete package. Put it in `<master>/.shepherd/packages/mail/`, add `Modules: mail` to a
child workspace's charter, run `shepherd tool check` there, then `shepherd tool mail unread`. On Claude the launcher
writes `Bash(shepherd tool mail unread *)`; because `network: true`, Codex's sandbox may still prompt.

## Adding a location

The loader takes a list of locations; base and enclosing are the two it is given today. A location outside Troupe,
such as a checkout of a package repository, would be one more entry in that list, read from a `packages.locations`
key in the user config (`$XDG_CONFIG_HOME/shepherd/config.json`). That key does not exist yet: which locations are
trusted is the user's decision, since a read tool in any location gets a no-prompt rule on Claude. Charters would keep
naming packages exactly as now.

## The software package

`packages/software` is the first package. Its module text is the software coordination module, unchanged, and it
carries one read tool:

```
shepherd tool software publish-check [--base <ref>] [--body <file>] [--terms <file>]
                                     [--ignore <prefix>]... [--forbid-attribution] [--json]
```

It scans the lines a branch adds (`git diff -U0 <base>...HEAD`), the branch's commit messages and an optional pull
request body for the home path, the account name (whole word), the git email, each line of
`$SHEPHERD_CONFIG_DIR/packages/software/publish-check/terms`, em and en dashes, and harness attribution lines. The base
defaults to `origin/HEAD`, then `main`. Attribution lines are reported, and fail only under `--forbid-attribution`, so
the agent reads the charter's `software.attribution` slot and passes the flag. Path prefixes in
`.publish-check-ignore` at the repository root, and in `--ignore`, skip the dash check only; personal values are never
exempt. Findings name where and what, never the value found. Exit 0 clean, 1 findings, 2 usage or not a git
repository.
