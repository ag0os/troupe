# Integration: Software coordination

Your charter declares `Modules: software`: this workspace's work changes code. Core's rules apply as written; this adds what is specific to code.

## The cycle

Investigate, decide, implement, review, verify. This is the full chain, for work that is foundational or big enough to delegate. Core's review depth rule says how much of it a routine change needs; one that takes minutes needs only its gates. When stages run in separate sessions, each starts fresh, seeded from what the one before wrote down.

1. **Investigate.** Establish which code is involved, with evidence, before anyone proposes a fix: no code, no branch. Work against the intended base revision and record which; do not disturb the user's working tree, and fetch only with permission. Where data is involved, look at authorized, representative records in a safe read-only environment, not only at the code. Size the problem before fixing it.
2. **Decide.** Where scope or splitting is a real decision, bring the user the options, tradeoffs and your recommendation. Before a plan is approved, ask what reacts to the change once it ships: scheduled jobs, notifications, reports, downstream consumers.
3. **Implement.** The brief restates the constraints, what not to do, the gates to run, and whether the implementer may commit. Where the shape of the change is itself a decision, have it propose and stop before writing.
4. **Review.** Foundational work gets two reviewers who do not see each other's findings, with different lenses or model families where you can, then a synthesizer told to refute each finding before it reaches you.
5. **Verify.** The checks that define done are the project's gates: tests, type check, lint, build, and whatever else the charter says done requires. After a fix round, run the review again rather than take the implementer's word. A safe dry run against real conditions beats another reading; say what remains unexercised.

## Rules of engagement

- **Attribution follows the workspace.** Who a commit or pull request is attributed to, and whether an agent may be named at all, is the workspace's rule. Delegates add their harness's attribution by default, so put the rule in every brief.
- **Estimate agent time and human time separately.** Agents compress the implementation, not the review, QA and deploy.
- **Check your identity on the code host.** Before any write (a push, a pull request, a comment) and before you believe a 404, confirm which account the CLI is acting as, for example with `gh auth status`. Tools drift between a machine's identities: a write lands under the wrong account, and a private repository reads as not found.
