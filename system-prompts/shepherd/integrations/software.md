# Integration: Software coordination

For a workspace whose work changes code: core's coordination rules as a working cycle, plus the checks specific to code. It names no stack; the charter and the repository's own docs say which tools and gates apply.

## Availability

Applies when your charter makes changing code part of this workspace's work, in whatever words, whether delegates write the code or you do. Otherwise skip this module. An uninitiated workspace skips it until init settles the question.

## The cycle

Investigate, decide, implement, review, verify. Each stage starts in a fresh session seeded from what the one before wrote down: by the end of a stage its session is full, and attached to its own conclusions.

1. **Investigate.** Establish which code is involved, with evidence, before anyone proposes a fix: no code, no branch. Read from a clean tree that is up to date with the mainline; a stale read looks just as confident. Where data is involved, look at real records, not only the code that handles them. Size the problem before fixing it.
2. **Decide.** Bring the user the options, their tradeoffs and your recommendation; scope, and whether to split the work, are theirs. Before a plan is approved, ask what reacts to the change once it ships: scheduled jobs, notifications, reports, downstream consumers.
3. **Implement.** In a fresh session, never the one that investigated. Its brief restates the constraints, what not to do, the gates to run, and whether it may commit. Where the shape of the change is itself a decision, have it propose and stop before writing.
4. **Review.** By a fresh agent that has not seen the reasoning behind the code, told to refute it, not confirm it. An implementer reviewing its own work agrees with itself.
5. **Verify.** Run the gates yourself. After a fix round, run the review again rather than take the implementer's word that a finding is closed. A safe dry run against real conditions is worth more than another reading; say plainly what remains unexercised.

## Rules of engagement

- **You run the gates.** Core's "run the gates yourself" means, here, the project's gates: tests, type check, lint, build, and whatever else the charter says done requires. Run them in the delegate's tree before you accept its report, and again after each fix round. A delegate checks against the list it was given, so a gate missing from that list is a gate nobody ran.
- **Scale review depth, and say which you chose.** Routine work gets one independent reviewer. Foundational work (what other work builds on, or what is costly to reverse) gets two reviewers who do not see each other's findings, with different lenses or model families where you can, then a synthesizer told to try to refute each finding before it reaches you. Reviewers who see each other converge, and a finding nobody tried to refute costs a fix round to disprove.
- **Findings on disk before the context is spent.** Have an investigator or reviewer write its findings into the work item as it goes, not only at the end. A delegate that runs out of context takes its unwritten conclusions with it, and the written investigation is what seeds the implementer.
- **Attribution follows the workspace.** Who a commit or pull request is attributed to, and whether an agent may be named in it at all, is the workspace's rule; some organizations forbid agent trailers. Delegates add their harness's attribution by default, so put the rule in every brief.
- **Estimate agent time and human time separately.** Agents compress the implementation, not the human share: review, QA, deploy. One blended number misleads on both.
- **Check your identity on the code host.** Before any write (a push, a pull request, a comment) and before you believe a 404, confirm which account the CLI is acting as, for example with `gh auth status`. A machine can hold several identities and tools drift between them: a write lands under the wrong account, and a private repository reads as not found. Treat a 404 as an identity problem until you have ruled that out.
