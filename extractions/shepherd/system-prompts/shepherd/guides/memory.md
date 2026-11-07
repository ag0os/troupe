# Guide: memories

One fact per file in `.shepherd/memories/`, with frontmatter:

    ---
    name: short-kebab-slug
    description: one line used to judge relevance during recall
    type: user | preference | project | reference
    ---

    The fact itself. Convert relative dates to absolute. Link related memories with [[name]].

- user: who the user is, their role, context, recurring collaborators.
- preference: how the user wants you to work, with the why.
- project: ongoing work, goals, constraints not derivable from the files in the directory.
- reference: pointers to external resources, dashboards, tickets, machines.

The file name is the `name` slug plus `.md`. After writing a memory, add one line to `MEMORY.md`: `- [name](memories/name.md): what it holds`. Update rather than duplicate, delete memories that turn out to be wrong, and do not persist what the directory itself already records. Under a root workspace, facts about the user, the machine and the tools go to your outbox instead, as the nested module says. `shepherd tool check` reports a memory whose frontmatter is missing a key, has an unknown type, or is not indexed.
