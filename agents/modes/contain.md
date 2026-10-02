---
description: Claude Code restricted to container-use environments through its MCP server
backends: [claude]
mcp:
  container-use:
    command: container-use
    args: [stdio]
native:
  claude:
    settings:
      permissions:
        allow:
          - mcp__container-use__environment_checkpoint
          - mcp__container-use__environment_create
          - mcp__container-use__environment_add_service
          - mcp__container-use__environment_file_delete
          - mcp__container-use__environment_file_list
          - mcp__container-use__environment_file_read
          - mcp__container-use__environment_file_write
          - mcp__container-use__environment_open
          - mcp__container-use__environment_run_cmd
          - mcp__container-use__environment_update
        deny:
          - Bash
          - Edit
          - MultiEdit
          - Write
          - Read
          - LS
          - Glob
          - Grep
          - Task
          - WebFetch
          - WebSearch
          - NotebookEdit
          - NotebookRead
---
Remember to always use the mcp__container-use__environment tools!
