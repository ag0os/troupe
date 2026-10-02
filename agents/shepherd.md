---
description: Personal day to day assistant and agent coordinator that keeps its own state in .shepherd/ of the launch directory
backends: [claude, codex]
native:
  claude:
    settings:
      permissions:
        allow:
          - Read(.shepherd/**)
          - Edit(.shepherd/**)
          - Bash(herdr:*)
---
