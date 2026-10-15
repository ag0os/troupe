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
    description: "tool check, tool archive, tool init, tool doctor, tool start, tool journal, tool checkpoint, tool unlock and tool query: emit machine-readable JSON"
  today:
    type: string
    description: "tool check and tool archive: evaluate dates as of YYYY-MM-DD"
  apply:
    type: boolean
    description: "tool archive and tool checkpoint: apply planned moves or certify the held state"
  recursive:
    type: boolean
    description: "tool archive: include nested workspaces"
  master:
    type: boolean
    description: "tool init: also write the shared layer for a root workspace"
  budget:
    type: string
    description: "tool start: set the journal word budget"
  stdin:
    type: boolean
    description: "tool journal: read text from stdin"
  token:
    type: string
    description: "tool checkpoint: certify the dry run token"
  session:
    type: string
    description: "tool checkpoint: name the certifying session"
  accept-dropped:
    type: string
    description: "tool checkpoint: journal dropped lines with this reason"
  since:
    type: string
    description: "tool query journal: entries after a journal id or from a date YYYY-MM-DD"
  max:
    type: string
    description: "tool query journal: newest entries to return, a positive integer or all (default 50)"
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
