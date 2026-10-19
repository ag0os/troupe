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

A master's own `.shepherd/packages/` is therefore seen by its children, not by the master itself.

A workspace sees a package only when its charter names it on the `Modules:` line, exactly as it names built-in
modules. That one selection decides all three things a package offers: its module text in the prompt, its tools and
its guides. A package found in no location is unknown; a package found in two is refused (see below).

Base packages are read from disk at run time, never compiled into the binary. A copied `shepherd` binary without its
checkout still launches; it composes without the base packages, and `shepherd tool doctor` reports `packages:base`.

## MODULE.md frontmatter

The frontmatter is strict YAML 1.2 between `---` lines, with the first key on the first nonblank line. A package uses
the fields of any Shepherd module and adds `contract`, `tools` and `guides`:

```yaml
---
name: mail                        # must equal the directory name
type: domain
description: Triage and answer email through hey
applies-when:
  charter-declares: mail          # required: loads only where the charter says "Modules: mail"
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

Every field a package's frontmatter may hold:

| Field | Meaning in a package |
|-------|----------------------|
| `name` | Required. Equals the package directory's name. |
| `type` | Required. One of `capability`, `method`, `role`, `domain` or `persona`; descriptive only. |
| `description` | Required. One nonblank line, used by checks and never put in the prompt. |
| `budget` | Required. A positive integer of prompt words. `shepherd tool check` warns `module-over-budget` when the module text has more words and, for a package in an enclosing workspace, reports the cost as `module-cost`; the text still loads whole. |
| `applies-when` | Required, with `charter-declares` equal to `provides` when the package has one, else to `name`: a package loads only where a charter names it, and a provider also where the charter names its slot. Without it, or with any other value, the package is a `module-schema` problem and loads nothing. `has-children` and `enclosing-modules` (booleans) may be added as further conditions. |
| `provides` | Optional. A slot the package fills, so a charter may name the slot instead of the package; the package then declares the slot in `charter-declares`. A slot may not share its name with an eligible module that provides nothing: where a charter requests that slot, it is a `module-slot-conflict`, no provider loads for it, and the module stays only where it is eligible on its own, which for a package means where the charter names it. |
| `default` | Optional boolean, false by default, only with `provides`: the provider a charter naming the slot gets when it names no provider. |
| `charter-keys` | Optional mapping of the charter keys the module reads (`<name>.<key>`, `<provides>.<key>`, or a core key: `core.mission`, `core.role`, `core.what-lives-where`, `core.way-of-working`, `core.cadence`, `core.done`, `core.toolset` or `core.structure`) to `required` or `optional`; `shepherd tool check` reports a required key the charter lacks. |
| `contract` | Required. The integer 1. |
| `tools` | Optional. The tools, as below. |
| `guides` | Optional. The guides, as below. |

"Module format" and "Predicates and provider selection" in [SHEPHERD.md](SHEPHERD.md) say how these fields behave for
every module; for a package, this table is enough.

Rules:

- `contract` is the integer 1. Any other value, or none, excludes the whole package (module, tools and guides) with a
  `package-contract` problem in the session header and a `shepherd tool check` error. The rest of the frontmatter is
  not read, so a newer package is refused for one reason, not a list of unknown keys.
- Unknown keys are errors, at the top level and inside a tool or guide declaration. A package with any frontmatter
  problem loads nothing and is reported.
- A package's problems reach the session header (`- Module problems:`) only in a workspace whose charter names the
  package, or its slot when its frontmatter is valid, so a broken package does not change every session's prompt.
  `shepherd tool check` reports every package the workspace can see, named or not.
- Tool and guide names match `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- A plain (unquoted) `description` that holds `: ` is a `module-schema` error; quote it. A semicolon needs no quoting.
- Every declared tool must exist as `tools/<tool>`, a regular file with the executable bit; every declared guide as
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

The variable decides which workspace authorizes a package run and a package guide, and nothing else: no core tool,
session name or identity reads it. A launcher variable is inherited by every process the session starts,
nested sessions and forks included. A nested Shepherd launch replaces it with its own directory, but a delegate agent, a
fork or a shell started from the session keeps the parent's value, and runs the parent workspace's package tools as that
workspace authorizes them. That is the intended reach for a delegate working on the session's behalf; it is also why the
variable is never used to tell which session is running.

## Guides

`shepherd tool guide` lists the core guides and then the guides of every package the workspace selects, as
`<package> <guide>: <description>`. `shepherd tool guide <package>` lists one package's guides.
`shepherd tool guide <package> <guide>` prints `guides/<guide>.md` whole to stdout, exit 0. Guides are found from the
workspace that authorizes a run, as above, so a session outside its workspace reads the guides its header lists.

The session header carries one line per kind, present only when a selected package declares one:

```
- Package tools: mail unread (read), mail send (write); run as shepherd tool <package> <tool> [args], --help for usage; read tools need no permission prompt on Claude
- Package guides: mail triage (How to triage the inbox, in order); read with shepherd tool guide <package> <guide>
```

## What is refused

Each refusal runs nothing, prints one line prefixed `shepherd:` on stderr and exits 2:

| Case | Message |
|------|---------|
| the charter does not name the package, or names it and selection refuses it | `package "mail" is not selected by this workspace's Modules: line; its tools are unavailable here; if the line names it, see Module problems in the session header` |
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
| `package-tool-not-executable` | error | a declared tool's path is not a regular file with the executable bit |
| `package-tool-undeclared` | info | a regular file in `tools/` is not declared; it is never run (dotfiles and directories are skipped) |
| `package-guide-missing` | error | a declared guide has no file |
| `package-requires-missing` | warn | a `requires` entry is not on PATH (a PATH lookup only) |
| `package-name-reserved` | error | the package takes a core command or guide name |
| `package-duplicate` | error | the name is found in two locations; neither loads |

Frontmatter errors are `module-schema` and `module-name`, as for any module.

## Harnesses

- **Claude Code.** For every read tool of a selected package the launcher adds `Bash(shepherd tool <package> <tool> *)`
  to the session's allow rules, passed inline with `--settings`. The rule matches the command as written, so run
  `shepherd tool ...`, not the binary's absolute path. Write tools get no rule. The launcher also adds
  `Bash(shepherd tool guide *)` once a selected package declares a guide; it covers the guide list and every guide
  read, since a guide read prints a file and writes nothing.
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

`packages/software` is the first package. Its module text is the software coordination module, a core of nine steps plus
bug, feature and chore shapes, with the method of steps 3 to 8 and the shape table's last two rows moved out word for
word: each step keeps its name, completion criterion, the user's part and its safety rules in the module, step 9 stays
whole there, and the rest is in three guides, read with `shepherd tool guide software <guide>`:

- `software build`: the shape table's Contract timing and Checks rows, steps 3 to 5 and the skills rule; read before
  briefing a builder;
- `software check`: steps 6 and 7;
- `software ship`: step 8, the grants' journal and a parked task.

A brief may tell a delegate to follow `shepherd tool guide software build`, since `SHEPHERD_WORKSPACE` reaches it from
any directory. A guide holds method only, so a brief that points a delegate at one still states the module's stop rule
(step 4) and the attribution rule.

The package carries one read tool:

```
shepherd tool software publish-check [--base <ref>] [--body <file>] [--terms <file>]
                                     [--ignore <prefix>]... [--forbid-attribution] [--json]
```

It scans the names of the files a branch adds, changes or renames, the lines it adds (`git diff -U0 <base>...HEAD`), the
branch's commit messages and an optional pull request body for the home path, the account name (whole word), the git
email, each line of `$SHEPHERD_CONFIG_DIR/packages/software/publish-check/terms`, em and en dashes, and harness
attribution lines. The caller's `diff.relative` and `diff.noprefix` settings change nothing it scans. The base defaults
to `origin/HEAD`, then `main`. Attribution lines are reported, and fail only under `--forbid-attribution`, so the agent
reads the charter's `software.attribution` slot and passes the flag. Path prefixes in `.publish-check-ignore` at the
repository root, and in `--ignore`, skip the dash check only, for a file's lines and its name; personal values are never
exempt. Findings name where and what, never the value found: a file name is reported as `path <n>`, never the name, and
a line of a file whose name holds a personal value as `path <n>:<line>`, where `<n>` counts the lines of
`git diff --name-only --diff-filter=d <base>...HEAD`. Exit 0 clean, 1 findings, 2 usage, not a git repository, or a base
with no merge base with `HEAD`.
