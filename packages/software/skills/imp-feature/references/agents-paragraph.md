Generated from Troupe's source at install time (the Contract convention, section 3); read only when step 0 finds no Contract convention, and proposed to the user at step 1, never applied on your own.

# The AGENTS.md paragraph a repo on the method adopts

Under a heading the repo already has for conventions or testing. Slots in angle brackets are filled per repo: `<tests dir>`, `<mutation tool>`, `<ci command>`, `<health tools>`. Where the repo has a no-attribution rule, add it as a line after the paragraph.

```markdown
## The Contract and the checks

Each component's obligations live in `docs/contracts/<component>.md`: an id, a statement, a reason, and its proof (a test in `<tests dir>`, named by the id, or recorded PR evidence). A component with no Contract file and no section left in the product doc has no Contract; claim no coverage for it. A PR that touches a component still kept in the product doc moves its section to its file, and its decisions with it. **A PR that adds or changes behavior updates the component's Contract in the same PR.** Decisions and their derivations are in `docs/decisions/`; the Contract points to them and never repeats them.

A bug in code that is live in production goes into the Contract first: add the missing obligation, write its test red against the unfixed code (the unfixed code is the mutant that matches the bug, so red is the proof the test kills it), then fix the code, then run `<mutation tool>` where it runs and check that no mutant survives or goes uncovered on the lines you fixed, then run `<ci command>`. Label that PR `fix:`, naming the obligation id. Everything else is `refine:`.

Before you say done, run `<ci command>`: it is the same set CI runs, and a check that could not run is a gap to name, never a pass. Health checks (`<health tools>`) and mutation fail only on findings your PR adds against its merge base; do not edit a baseline to pass. Where a committed baseline still gates, a fix that kills a recorded survivor re-records it in the same PR, with its reason; a snapshot that does not gate re-anchors weekly.
```

One real filling, ag0osW3b: `<tests dir>` is `test/contract/`, `<mutation tool>` is mutant, `<ci command>` is `bin/ci` (fetch first), `<health tools>` is exhale.
