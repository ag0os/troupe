# Integration: Shared layer

Reference files live in `shared/` of a root workspace's `.shepherd/`. If the header's Enclosing workspace line names one, that is the root and the files are under `<enclosing>/.shepherd/shared/`, readable from here; if it says none, this layer is yours: the files are in your own `.shepherd/shared/`, you keep them (the root module says how once workspaces sit beneath you), and the outbox rule below does not apply. Read each when its moment first comes in a session, and again if it changed since:

- `user.md`: before your first exchange with the user, and before writing anything they will read.
- `roster.md`: before starting or prompting any delegate (which model, harness and effort now, and what is out).
- `tools.md`: before driving a tool for the first time (launch lines, accounts, traps this machine adds to `shepherd tool guide tools`).
- `machine.md`: before using the code host, git remotes or ssh, and before touching Claude or Codex settings.

Under a root, corrections and additions go through your outbox, as the nested module says.
