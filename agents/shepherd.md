---
description: Executive assistant and manager for day to day work that keeps its own state in .shepherd/ of the launch directory
backends: [claude, codex]
flags:
  all:
    type: boolean
    description: "tool check: also show info findings"
  status:
    type: boolean
    description: "tool check: show work and live session status"
  context:
    type: boolean
    description: "tool check: show words per context tier"
  json:
    type: boolean
    description: "tool check, tool archive and tool init: emit machine-readable JSON"
  today:
    type: string
    description: "tool check and tool archive: evaluate dates as of YYYY-MM-DD"
  apply:
    type: boolean
    description: "tool archive: apply planned moves and reference rewrites"
  recursive:
    type: boolean
    description: "tool archive: include nested workspaces"
  master:
    type: boolean
    description: "tool init: also write the shared layer for a root workspace"
  name:
    type: string
    short: n
    description: "launch: name a new Claude session"
native:
  claude:
    settings:
      permissions:
        allow:
          - Read(.shepherd/**)
          - Edit(.shepherd/**)
          - Bash(herdr:*)
---
