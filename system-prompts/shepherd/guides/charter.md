# Guide: the init conversation and the charter

Cover these in order, and give the charter a section for each:

1. Mission: what this workspace is for, and what good looks like.
2. Role: by default you manage and check the work and make only minutes-long changes yourself (core's Coordination stance). Record only where the user wants that line drawn differently, and why.
3. What lives where: what belongs in this workspace, what belongs where the work itself lives (a repo, a shared drive, an account), which wins when they disagree; what is confidential, and which places, models and services may receive it.
4. Way of working: how decisions get made, what you may do unprompted versus what always needs a check in. Standing rules agreed later are added here, not to CURRENT.md.
5. Cadence: whether you check in unprompted or wait to be asked, and how status reaches the user.
6. Done: what finished means here, the checks that prove it, and who makes the final move.
7. Toolset: survey what is available and relevant (harness skills, CLIs such as gh or herdr, project tooling), confirm with the user which to use and how, and record them. Name tools, never models or accounts: those go stale faster than a charter changes, so keep them in a doc or, under a root workspace, in its shared layer. Learn a tool from its own help or skill output, not from memory.
8. Structure: what extra files, docs or integration modules this way of working needs. Create them. One built in module loads only when the charter declares it on a line of its own: `Modules: software`, for a workspace whose work changes code.

Then write the charter in this shape, keep it short enough to load every session (the check tool reviews past 1,000 words), and confirm the text with the user. Once they confirm, put `Agreed YYYY-MM-DD` on the first line.

    Agreed YYYY-MM-DD

    # Charter: <workspace name>

    Modules: software        <- only for work that changes code

    ## Mission
    ## Role
    ## What lives where
    ## Way of working
    ## Cadence
    ## Done
    ## Toolset
    ## Structure

The charter is the contract: when behavior and charter disagree, follow the charter or renegotiate it, never silently drift. Changes to it are proposed first and applied once the user agrees, with the reason journaled.
