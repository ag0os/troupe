# Shepherd on herdr-core: what we know, what to spike, what to build

Status: analysis and spike plan, written 2026-11-02. Nothing in this document is built. Its purpose is to let a Shepherd plan the spikes that decide whether, and how, Shepherd's delegation, background agents and a custom front end move onto herdr-core (`hc`) and the Herdr desktop app. Section 1 records what we know and how well we know it. Section 2 maps that onto Shepherd as it exists in this repository. Section 3 lists the open questions, each with the spike that answers it. Section 4 proposes an order of work. Treat section 4 as a proposal and sections 1 to 3 as the ground.

Sources: the Herdr research report of 2026-11-01 (herdr.dev, the three READMEs, herdr-app issue #63, the launch thread, the TUI changelog, and third party issues and PRs that quote the official docs), and this repository at the commit this file was added. Where the report marks something as secondary or unverified, this document says so; a spike in section 3 confirms it before anything depends on it.

## 1. What herdr-core and the desktop app are

### 1.1 Three programs, two backends

| Program | Role | Backend | Status | Config |
|---|---|---|---|---|
| `herdr` (TUI) | agent multiplexer in the terminal, with workspaces, tabs and panes | its own server, newline delimited JSON socket at `~/.config/herdr/herdr.sock` | stable, 0.9.5 (2026-10-14) | `~/.config/herdr/config.toml` |
| Herdr desktop app (`herdr-app`) | native GPUI client for terminals and agents: spaces, tabs, panes, agents sidebar | herdr-core | preview, 0.1.x (0.1.10 seen 2026-10-31) | `~/.config/herdr-app/` |
| herdr-core (`hc`) | headless terminal runtime and daemon with an OpenRPC API; "core draws nothing" | itself | preview, 0.1.x (0.1.15 seen 2026-10-30) | socket under `$XDG_RUNTIME_DIR/herdr-core/` or `~/.local/state/herdr-core/` |

All three are Apache 2.0. The maintainer has said the TUI "stays and keeps getting updates" and that whether it will ever move onto herdr-core is "still open".

### 1.2 No interop between the TUI and the core line (confirmed)

The app does not attach to a TUI server. Agents started in one never appear in the other. Config, keybindings, status models and sockets are all separate. Both stacks can run on one machine at once, each with its own agents; that is an inference from the separate daemons, with no conflict reported. There is no migration tool.

For Shepherd this means a port, not a migration: a Shepherd that supports core supports it beside the TUI, not instead of it.

### 1.3 What core gives a program that runs inside it

Confirmed from the core README and the launch thread, with the exact CLI shapes from secondary sources:

- **Terminals, flat.** Core holds a list of terminals. Workspaces, tabs and panes exist only as app layout, stored in core `doc.*` documents (opaque JSON with compare and set). The IDs `w1:p2` and the sibling pane topology of the TUI do not exist.
- **Run and inspect.** `hc run [--bg] [--name] [--keep] [--on machine]`, `hc ls`, `hc attach`, `hc read --lines`, `hc send`, `hc get`, `hc keys`, `hc wait [--children all]`, `hc events`.
- **Environment.** A program inside a core terminal gets `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET`, not `HERDR_PANE_ID` or `HERDR_ENV`. `HC_SESSION` selects a session and `HC_SOCKET` overrides the socket path.
- **Parent and child agents.** An agent started from inside a core terminal becomes that terminal's child. Children report back with `hc send` to the parent's terminal id; the parent gets notes when a child needs attention or exits. Children die with their parent unless started with `--outlive-parent`.
- **Status comes from the program.** Core recognises no agent brands and reads no screens. A program reports `working`, `done`, `blocked` or `error` through OSC 7501 (the Program Status Protocol from the Ghostty ecosystem). A program that does not report has no status. `blocked` carries a reason. Nesting an agent inside tmux inside a core terminal breaks the reporting.
- **Holder processes.** Each PTY is guarded by a holder process so core can restart or update while programs keep running (secondary). A core restart or reboot still brings terminals back as fresh shells; there is no equivalent of the TUI's resume of a harness session through integrations.
- **API.** `hc schema` prints OpenRPC with JSON Schema; `hc connect` carries the protocol over stdin and stdout, including through SSH. Third parties count 32 methods in the namespaces `terminal.*`, `machine.*`, `file.*`, `doc.*`, `events.subscribe` and `rpc.discover` (secondary; not checked against the official schema). The protocol is "preview, protocol generation 1, version 0.x", with a test that blocks breaking changes within a generation. Whether that promise covers `hc ... --json` CLI output is an open issue (#33).
- **Remote.** `hc machine add` and `hc run --on <machine>` run terminals on other machines over SSH.
- **Security.** Anyone who can reach the socket as the same user can run commands. No API password, no per client permission, sessions are not security boundaries (secondary, citing `docs/security.md`).
- **Packaging.** Install script from `releases.herdr.dev`; static Linux builds; nothing on crates.io, npm or Homebrew; no GitHub Releases. Near daily releases at launch.

### 1.4 What the desktop app gives a front end

- Native Rust on GPUI, not Electron or Tauri. Terminal emulation through libghostty bindings. Linux needs a desktop session and Vulkan.
- Model: machine, space, tab, pane, terminal. An agents sidebar with Working, Blocked, Done and Idle, including workers started by other agents; workers without a pane open in "peek".
- **Everything is files** in `~/.config/herdr-app/`: `settings.json`, `keys.json`, `themes/`, layouts and mods, plus an `AGENTS.md` that tells an agent what it may edit. The window hot reloads edits and keeps the last good version when an edit breaks.
- **Layouts** (Herdr, Terminals, Herdr 98 ship) and **mods**: small JavaScript programs through gpui-kit that draw panels, menus and dialogs. "There's no DOM: the script describes, Rust draws." Mods are "trusted code, not sandboxed extensions."
- **Agent control of the window:** `herdr-app --skill`, `herdr-app ls|status|commands`, `herdr-app do layout.clone|mod.clone|...`. The README's division of labour: "Use herdr-core for running and coordinating programs; use the app to change what you see."
- Status in the app comes only from OSC 7501.
- Usage telemetry is on by default in release builds (Settings, Privacy turns it off). The TUI sends none.
- Platforms: macOS Apple Silicon (Intel builds from source), Linux x86_64 and arm64, Windows 10 1803 or later on x64. Installing the app installs core when it is missing.

What the report does not say about mods, and section 3 must find out: whether a mod can read arbitrary files, run a process, subscribe to core events, read core `doc.*` documents, or use timers.

## 2. How Shepherd touches Herdr today, and what each touchpoint becomes on core

Shepherd's coupling to the TUI is narrow. Every touchpoint is listed here with its file, so the port can be scoped from this table.

| Touchpoint | Where | On core |
|---|---|---|
| Herdr capability module | `system-prompts/shepherd/integrations/herdr.md`, loaded by `lib/shepherd/module-resolution.ts` | a sibling module `herdr-core.md`, gated on `HC_TERMINAL_ID`; both coexist |
| Coach's Herdr module | `system-prompts/coach/integrations/herdr.md` | same treatment, later; one use only (launch a sibling pane) |
| Session adapter | `herdrSessions()` in `lib/shepherd/sessions.ts`: runs `herdr agent list`, reads `agent`, `name`, `cwd`, `agent_status`, `agent_session.value` | an `hcSessions()` beside it, reading `terminal.list` over the socket or `hc ls --json`; harness session identity must come from the harness, not from core |
| Live sessions reconciliation | `lib/shepherd/query.ts` (`query sessions`, `check --status`) | consumes both adapters |
| Doctor | `lib/shepherd/doctor.ts`: `herdr` on PATH, `herdr integration install claude|codex` hooks (`herdr-agent-state.sh`) | adds `hc` on PATH, minimum version and protocol generation, and the OSC 7501 hook (section 2.3) |
| Permissions | `agents/shepherd.md`: `Bash(herdr:*)` preapproved | adds `Bash(hc:*)`; destructive operations stay forbidden by module prose, as now |
| Setup | `docs/SETUP.md` step 3 | a core step beside it |
| Delegation rules | `system-prompts/shepherd/core.md`: heavy work to "another pane, another agent, another session"; delegates tracked by session name, never by terminal location; briefs and reports on disk in the item; adversarial chaining | unchanged; see 2.1 and 2.4 |
| Channel choice | `system-prompts/shepherd/integrations/inter-agent.md`: messaging for same harness sessions, Herdr for anything in a pane | the same sentence with core added as a pane host |
| One shot builders | `packages/software/tools/builder-hooks`, `packages/software/guides/hooks.md`: `claude -p --max-turns --settings`, `hooks.log`, `recheck` | the first chain step a runner would drive (2.4) |

Nothing else in `lib/shepherd` knows about Herdr.

### 2.1 Background agents

Core fits Shepherd's background work better than the TUI does, with two rules to design in.

What gets simpler:

- Core draws nothing, so the module's `--no-focus` rule, the sibling pane default, the split direction from pane geometry, and the "do not create workspaces or tabs" rule all disappear. A delegate is `hc run --bg --name <name> ...` in the directory the work needs.
- `hc wait` and `hc events` replace `herdr agent wait` and `events.subscribe`. `blocked` carries a reason, which serves the module's existing rule "if a wait returns blocked, inspect the agent's state and screen before deciding what to send".
- The parent and child model is close to Shepherd's delegate model: a delegate reports back to `$HC_TERMINAL_ID` of the Shepherd that started it, and the Shepherd is notified when it needs attention or exits.
- Core runs headless and on remote machines (`hc connect`, `--on`), so the same mechanism works for a Shepherd on a server with no app.

What must be designed in:

- **Children die with their parent.** Core's rule "A delegate that outlives your turn is listed under Live sessions" meets core's default the wrong way round: a Shepherd handoff would kill its own fleet. Every delegate that may outlive the Shepherd is started with `--outlive-parent`. The module must say so, and the chain runner must do so.
- **No resume after a core restart.** Core brings terminals back as fresh shells. Shepherd survives this only because core.md already tracks delegates by harness session name and model, never by location. On core this rule is load bearing: record the harness name (Claude `-n`, the Codex rename) as well as the `hc --name`, and treat the core terminal as disposable. Resume is `claude --resume` or the Codex equivalent in a new terminal, driven from the recorded name.
- **`hc send` can deliver mid turn.** The TUI's agent commands know whether a pane is ready; `hc send` writes to the terminal. Core.md's "check state before acting" becomes a mechanical gate: read status with `hc get` before any send, and never send to a terminal reporting `working`.
- **Status is absent unless the program reports it.** See 2.3. Without it, delegates under core show no status, `hc wait` has nothing to wait on, and the app's agents sidebar is empty.

### 2.2 The module

`herdr.md` is a self gating capability module: it tests `HERDR_ENV=1`, defers to `herdr --skill` for syntax, and encodes rules of engagement and traps. A `herdr-core.md` module follows the same shape:

- Gate: `test -n "${HC_TERMINAL_ID:-}"`. If it fails, the module is inert. A Shepherd launched in the app today loads `herdr.md`, fails its gate, and falls back to "portable mechanisms", losing delegation silently; the new module closes that gap.
- Authority: `hc --skill` and `hc <group>` usage, never remembered syntax.
- Working model: run in the background by name, gate sends on status, wait on children, read with `hc read --lines`, ask a delegate to write long answers to a file when scrollback is not enough (as now).
- Rules of engagement: `--outlive-parent` for anything recorded under Live sessions; never `hc update` or stop the core daemon from a session; do not touch terminals you did not create; set the harness session name as well as the core name.
- Traps: `hc send` mid turn; `--keep` recovers only a fresh shell; the socket is a same user boundary, so a core session is not a sandbox; agents nested in tmux lose status.

Both modules load into every Shepherd (as `herdr.md` and `inter-agent.md` do now) and each checks its own availability. The `module-resolution.ts` list of built ins grows by one. Composition budgets: `herdr.md` declares 700 words; the new module should land near that.

### 2.3 Status: OSC 7501 is the cheapest hedge and the hardest dependency

Claude Code and Codex do not emit OSC 7501 (as far as the report establishes). The TUI compensates with screen detection and integration hooks; core refuses to guess. So on core, nothing about a Claude or Codex delegate is visible until something emits the sequence on the delegate's PTY.

Troupe has two seams for that:

1. **The generated runner.** `lib/agent-format/run.ts` owns the child process and its signals for every compiled agent, Shepherd and delegates alike. It can write `working` to the controlling terminal when the backend starts and `done` or `error` when it exits. This gives every troupe binary a status in core and in the app with no agent cooperation.
2. **Harness hooks.** Claude Code hooks can mark the transitions the runner cannot see: a Notification for a permission prompt or a question is `blocked` with the prompt as reason, Stop is `done` (or `idle`, depending on how the app treats a waiting agent), UserPromptSubmit is `working`. `doctor.ts` already checks for Herdr's SessionStart hook; it checks for this one the same way. Codex has fewer hook points; `herdr integration install codex` lost its turn hooks in 0.9.5 for that reason, so Codex may stay at runner level status.

The report also notes a draft TUI PR (#5172) for an OSC 7501 receiver, so emitting it positions Shepherd for both lines.

The dependency: a hook runs as a subprocess with JSON on stdin and its stdout captured. For the sequence to reach core it must be written to the terminal (`/dev/tty`), through whatever the foreground program is drawing. Core parses the PTY stream, so this should work regardless of alternate screen, but it is unverified; spike S1 settles it before anything is built on it. The sequence to write is of the form `\e]7501;state=blocked:app=shepherd:reason=...\e\\`; the exact grammar comes from the Program Status Protocol, which the spike reads from the ecosystem's specification rather than from the report.

### 2.4 Programmatic chains

Today a chain exists only in the Shepherd's context: it writes a builder brief, starts the builder, waits, checks, writes a verifier brief, and so on, following core.md's rules on adversarial chaining, briefs and reports on disk, and checking done itself. Shepherd's conventions already make a tool driven runner possible without changing them:

- The step interface exists: a `<role>-brief.md` in the item directory in, a `*report.md` ending in `## Discoveries` out.
- The gates exist in the software package: `builder-hooks prepare` and `recheck`, `publish-check`, `contract`.
- The log exists: `shepherd tool journal`.
- The escalation path exists: an **ASK** entry in `CURRENT.md`, `pending.md` for a warning without a destination.

A runner, say `shepherd tool chain run <item>` as a package tool under the package contract in `docs/PACKAGES.md`, would:

1. Read a chain declaration in the Markdown plus strict frontmatter style the repository already uses for agents, modules and packages: an ordered list of steps, each with a role, a brief template, the harness and model, a gate to run after it, and what to do on `blocked`.
2. Render each brief from the template and the previous step's report, passed as a hypothesis to test with provenance, as core.md requires.
3. Start the step with `hc run --bg --outlive-parent --name <item>-<role> -- <agent binary> ...`; for a one shot builder, the existing `claude -p --max-turns --settings` launch from the hooks guide.
4. Wait on `hc wait` and OSC 7501, or on the report file appearing, whichever the step declares; run the step's gate; journal the outcome; advance.
5. On `blocked`, or on a gate failure past the declared attempts, stop: write an ASK entry with the reason and the paths, and exit. The runner never answers a delegate itself. That keeps judgment with the Shepherd or the user and keeps the adversarial rule intact: the model judges, the runner sequences.

The runner has no dependency on the app and little on the TUI; it needs core (or, with a thinner backend, the TUI's `agent` commands). An abstraction over the two hosts is worth having only once both are used; the report notes herdr-mcp, ovis and driverr are each adding one.

### 2.5 A Shepherd front end

The app is a view layer by design ("use the app to change what you see"). Shepherd's state is already on disk in a fixed shape (`CURRENT.md` status words, `work/*/STATUS.md`, `journal.md`, `pending.md`, Live sessions), which is what a view needs. Two routes, decided by spike S2:

- **A Shepherd layout and mod in the app.** Panels for items by status word, Live sessions joined with the agents sidebar, the journal tail, `pending.md`, and the selected item's `STATUS.md` and reports. The mod lives in `~/.config/herdr-app/`, is hot reloaded, and the app's own `AGENTS.md` says what an agent may edit, so a Shepherd could maintain it. Orchestration logic does not belong in a mod. If a mod can read core `doc.*` documents but not the file system, the chain runner writes its state into a `doc` with compare and set, and the mod reads that; the app already keeps its layout the same way.
- **A thin client on the OpenRPC socket.** A Bun process speaks JSON-RPC over the core socket, generating a typed client from `hc schema`, and renders a web view or similar. Full control, the stack the repository already uses, and the price is reimplementing what the app does for terminals. This is the fallback if mods cannot reach what the view needs, and it is what the-eye and herdr-gpui did against their respective daemons.

Either route reads the `.shepherd/` tree; neither needs to write it.

### 2.6 Risks to keep visible

- Core and the app are 0.1.x with near daily releases. Pin a minimum `hc` version and protocol generation in the doctor; prefer the socket over `--json` output until issue #33 is answered.
- No resume after a core restart; a macOS holder deadlock on 0.1.15 (issue #47); a reported jitter attributed to event flushing (unverified).
- The socket is a same user boundary. A core session is not a sandbox; the software package's builder hooks remain the guard for builders.
- App telemetry is on by default.
- Known TUI bugs for custom agents' resume commands (#4755, #5464) do not affect Shepherd today because it does not use `report-agent`, but they are the TUI side of the status problem.
- A public project named "shepherd" builds on the TUI socket API and will surface in searches. Unrelated.

## 3. Open questions and the spikes that answer them

Each spike runs in an isolated core session (`HC_SESSION=spike`) on a machine with `hc` and, for S2, the app installed. Each ends with a short note in the item that records the answer and the `hc` and app versions used. None changes the repository's source.

| Id | Question | Spike | Decides |
|---|---|---|---|
| S1 | Can a Claude Code hook, and the troupe runner, write OSC 7501 to the controlling tty so that core registers `working`, `blocked` and `done` for a Claude session, including while Claude is in its alternate screen? | Start `claude` under `hc run --bg --name s1`; from a hook script, and from a wrapper around the binary, write the sequence to `/dev/tty`; read status with `hc get` and watch the app's sidebar. Read the Program Status Protocol specification for the exact grammar. Repeat with Codex at runner level only. | whether 2.3 is viable, and whether Codex gets more than start and exit status |
| S2 | What can a mod do: read files, run a process, subscribe to core events, read `doc.*`, use timers? What does `herdr-app --skill` offer? | Clone a layout with `herdr-app do layout.clone`, read `~/.config/herdr-app/AGENTS.md` and the shipped mods, attempt each capability in a throwaway mod, note what hot reload accepts. | route in 2.5: mod, thin client, or mod plus a `doc` written by the runner |
| S3 | Does `--outlive-parent` behave as described across a Shepherd exit, a core restart (`hc update` or killing the daemon) and a reboot? Does the holder keep the program alive through a core restart? | Start a long running child with and without the flag; exit the parent; restart core; reboot. Record what survives and what `hc ls` shows. | the `--outlive-parent` rule and the resume story in 2.1 |
| S4 | What does `hc ls --json` or `terminal.list` return, and is it enough for `hcSessions()`: name, cwd, status, reason, children? Is the harness session id anywhere? | Run a named Claude session and a Codex session; read `hc ls --json`, `hc get`, `hc schema`; compare with what `herdrSessions()` reads. | the adapter's fields and whether identity must come from the harness side (expected yes) |
| S5 | Does `hc send` reach a Claude session mid turn, and does `hc get` expose enough to gate it? Does the ghost text trap from the TUI module exist? | Start a session on a long task; send during it; observe. | the send gate rule in the module and the runner |
| S6 | Can the whole TUI module be expressed over `hc`: start, prompt, wait until blocked, read screen, send keys, and a worktree per delegate? | Walk `herdr.md` and `herdr --skill` line by line and find the `hc` equivalent or its absence. The-eye reports every call had one. | the content of `herdr-core.md` and what the runner can rely on |
| S7 | Does the OpenRPC schema from `hc schema` generate a usable TypeScript client under Bun, and does the socket path logic hold on macOS and Linux? | Generate types from the schema; call `terminal.list` and `events.subscribe` from a Bun script. | whether the adapter and runner use the socket (preferred) or the CLI |

S1 and S2 come first; they decide the shape of everything else. S3 to S5 are each under an hour once a core session exists. S6 is reading. S7 is only needed if S4 shows the CLI output is not enough or issue #33 stays open.

## 4. Proposed order of work

Keep production Shepherd on the TUI throughout. Each step is small enough to abandon if its spike says no.

1. **Run S1 and S2.** Nothing below is scheduled until these have answers.
2. **Emit OSC 7501 from the runner and hooks** (2.3), if S1 passes. Harmless on the TUI, required on core. Add the hook to the doctor's checks and to `docs/SETUP.md`. Verify in the app's sidebar.
3. **Add `herdr-core.md` and `hcSessions()`** (2.2, S4, S6). Add `Bash(hc:*)` to `agents/shepherd.md`, `hc` to the doctor with a minimum version and protocol generation, and the core sentence to `inter-agent.md`. Extend `query sessions` and `check --status` to show core terminals. Snapshot tests for the module matrix follow the pattern in `agents/shepherd-module-matrix.test.ts`.
4. **Build the chain runner** (2.4) as a package tool, starting with the builder then verifier chain the software package already describes, since its gates exist. Declaration format first, with `shepherd tool check` findings for it; runner second.
5. **Build the front end** (2.5) on the route S2 chose: a Shepherd layout and mod reading `.shepherd/` and, if needed, a runner written `doc`; or the thin client.
6. **Coach.** Port `system-prompts/coach/integrations/herdr.md` last; its single use is launching one session with focus, which on core is `hc run` plus opening it in the app.

What this plan does not do, deliberately: it does not abstract over the TUI and core before both are in use, it does not move daily work to the app before core restarts preserve agent sessions and the 0.1.x issues settle, and it does not let a runner answer a blocked delegate.
