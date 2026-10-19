---
name: software
type: method
description: Coordinate code changes through the software cycle
applies-when:
  charter-declares: software
provides: software
default: true
budget: 2200
charter-keys:
  software.grants: optional
  software.merge-grant: optional
  software.plans: optional
  core.done: optional
  software.attribution: optional
contract: 1
tools:
  publish-check:
    description: Scan a branch's file names, added lines, commit messages and PR body for personal values, dashes and attribution lines
    access: read
    requires: [git]
guides:
  build:
    description: the shape table's Contract timing and Checks rows, steps 3 to 5 and the skills rule; read before briefing a builder
  check:
    description: steps 6 and 7
  ship:
    description: step 8, the grants' journal and a parked task
---
# Integration: Software coordination

Your charter declares `Modules: software`: this workspace's work changes code. Core's rules apply as written; this adds what is specific to code, around Impatient Programming's cycle: a core every change takes, and three shapes (bug, feature, chore) that say how much of it each change needs.

This module reads charter slots `software.grants`, `software.merge-grant`, `software.plans`, `core.done` and `software.attribution`. Until the charter is renegotiated, use its existing agreed prose for these values. An absent or empty slot grants nothing; where no value is agreed, keep this module's existing defaults. `None` is an agreed value, not an absent slot.

## Two axes: blast radius and size

Judge both before the work is spent, and record them with each change in the plan. Blast radius is small or large: large when the change touches a migration that destroys data, authentication or permissions, deploy configuration or secrets; otherwise judge it from what the change can break and what reacts once it ships (scheduled jobs, notifications, reports, downstream consumers). Size is S, M or L, set in the agreement: S, a few lines or files with their tests, an agent's minutes; M, several files and new tests, an agent's hours; L, many files or screens, a day or more. Blast radius sets review depth (step 7) and whether a grant may merge the change (step 9); size sets the backbrief (M and L) and the budgets the method eval records. The cycle scales with both and with the deadline: a minutes long change skips delegation, not its obligation, the checks or its pull request.

## The agreement and the freedom inside it

Each stretch of work opens with an agreement (step 1). Within it, agents own implementation and verification: they investigate alternatives, make implementation choices, resolve ordinary ambiguity, and may demonstrate a proposed architectural change, each as a proposal on the branch that the user settles in the pull request. The exceptions are the decisions the user reserved for earlier participation. Version control makes that freedom affordable: a proposal can be inspected, revised or discarded before it enters the accepted codebase. The user can change their involvement as the work goes; a decision they claim mid stretch joins the plan's reserved ones.

The permissions the user grants in the plan draw core's line on acting outside the machine for that stretch, as charter slot `software.grants` draws it for the project's code changes; none covers a merge except a merge grant (step 9).

## Shapes

Every change takes one shape, chosen by rule 9's definition and by whether behavior changes. When the choice is unclear, ask the user.

- **Bug:** a defect in code that is live in production. Label `fix:`, naming the obligation it adds or amends. A defect not yet live (found after merge, before release) takes this shape labelled `refine:`.
- **Feature:** behavior is added or changed. Label `refine:`.
- **Chore:** no behavior changes: dependencies, CI, configuration, docs, a refactor; a test-only fix, which shows its test fails without the fix; a bot's dependency pull request, which you retitle and assert where a grant covers it. Label `refine:`.

| | Bug | Feature | Chore |
|---|---|---|---|
| Agreement | the defect, the obligation it shows missing, the fix's scope: one line | the full agreement | one line: outcome and deadline |
| One Question | only why the fence stands; no spike, no artifact | evidence first; spikes in parallel when unclear; an artifact when scope or shape is reserved; a prototype in front of the user when a screen is reserved | none |

The table's Contract timing and Checks rows are in `shepherd tool guide software build`, read before briefing a builder. Review depth and the merge follow the axes, not the shape.

## The core

Each step ends at its completion criterion and names the user's part. Neither is an approval gate: the work moves on when the criterion is met, and the user enters at their part and at the decisions the plan reserves. Greater freedom lowers no standard of done. The plan records the step the work has reached; keep it current.

The rest of steps 3 to 8 is in guides, read when the plan reaches the step and before any brief for it: `shepherd tool guide software build` holds the shape table's Contract timing and Checks rows, steps 3 to 5 and the skills rule; `software check` steps 6 and 7; `software ship` step 8, the grants' journal, and a task that waits on the user, read also when a task parks or resumes.

1. **Story straight.** Agree with the user, for the stretch (a plan or roadmap segment, a week, a take home): the outcome, scope, constraints, acceptance criteria sized to it, the period or milestone it covers, the decisions they reserve to shape before implementation, and the permissions agents need to prepare and present the work, such as pushing a branch and opening a pull request. Record it in the plan, kept at charter slot `software.plans` when set, otherwise beside the Contract in the repo or in the item's directory; each change's shape, blast radius and size go with its entry. A chore's or a bug's one line (Shapes, above) in `CURRENT.md` serves as its plan. Complete when the direction is clear enough to begin. The user's part: agree the direction and where they want to take part.
2. **The One Question.** Before building, ask what we still need to learn, as the shape asks it. Answer with evidence against the intended base revision, and record which: the code involved and, where data matters, authorized representative records, read only, in a safe environment. If the answer is unclear, run spikes in parallel as delegates and compare the results; where the question is one the user reserved, put throwaway prototypes in front of them instead of guessing. Spike and prototype code is discarded; the build starts from the Contract. Complete when there is evidence enough to build and the remaining assumptions are recorded in the plan; one the user would want to rule on if it fails is listed with the reserved decisions. The user's part: the decisions the plan reserves; other choices go ahead as proposals for review in the pull request.
3. **The Contract.** The project's own docs, in the repo's Contract convention: what the code must do, functional and non functional; obligations, each with its reason; decisions by pointer, with their derivation where they live. Before changing code, pin what it does now and find out why each fence stands. A production bug enters first: its sentence, its test failing on the unfixed code, then the fix. Complete when what the code does now is pinned and the agreed obligations are listed with ids; for a bug, or where a pass of its own was chosen, when each has its test red. The user's part: none beyond what the plan reserves.
4. **Inhale.** A delegate builds the story complete, no more, from the Contract. The builder stops only for a decision the plan reserves, or where going on needs authority beyond preparing the change: a branch cannot contain a deploy, a change to external data or any other action outside it, and each needs its own yes. Complete when the story is built, the Contract holds what the build discovered, and every proposed choice is recorded. The user's part: none; agents proceed within the agreement.
5. **Exhale, same PR.** Complete when the change is simplified, the Contract accounts for its behavior and every choice the user has not settled is named as open for the pull request. The user's part: none; choices they did not reserve stay proposed until the pull request.
6. **Checks before done.** The project's gates (tests, types, lint, build), run the one way the repo defines for you and for CI; mutation wherever the project can run it, on every subject where that runs in reasonable time, otherwise scoped to the changed code and naming what a scoped run misses (removed or renamed subjects, a weakened kill elsewhere), each survivor either equivalent with its reason or a sentence the Contract lacks, written with its test, and for a bug the new test kills the mutant that matches the defect; plus the health checks against the merge base: a finding the PR adds fails, wherever it sits (the workspace's checks table) and whatever else charter slot `core.done` requires. A check that could not run, or that the project lacks, is a gap to name, not a pass; charter slot `core.done` says whether it blocks, and where it is silent a gate that could not run blocks and nothing else does. Complete when the required checks have run, their findings are addressed, and each check that could not run is named. The user's part: none; passing checks approve no proposed decision.
7. **Review by blast radius.** Small: the checks plus your own read. Large, or foundational: two reviewers with different lenses or models who do not see each other's findings, then a synthesizer told to refute each finding before it reaches you. Complete when review at that depth leaves no finding unaddressed or unreported. The user's part: none.
8. **The pull request.** Every automated implementation change reaches the codebase through a pull request, or, where the repo has no pull request flow, a branch presented the same way and merged on the same permission. That includes your own minutes long fixes; only pairing keeps its own path (below). Complete when the change is ready for the user's assessment or for the grant's conditions to be checked. The user's part: none yet.
9. **Merge under a grant, otherwise present.** A merge grant the user wrote, in the plan or in charter slot `software.merge-grant`, names what it covers (which changes, which branch), the checks it requires, and when it lapses, a date or no end date; it ends when the user withdraws it, and when its own text says a lapse condition has been met. A grant covers small blast radius only, unless its text names the large kinds it covers. When a grant covers this pull request and every condition it names holds, say so in the body, naming the grant and asserting that no reserved decision is pending and no reserved obligation changed; make the merge a machine act, the repo's auto-merge on the required check where the repo allows it, otherwise merge it yourself once the checks are green; record the merge in the plan and `CURRENT.md`. A pull request no grant covers, or with an open choice, a departure from the agreed design, a check that could not run, or a check the project lacks that the grant's text does not name as accepted, is presented: address the feedback, settle each open choice with the user, run again the checks the revision affects, and merge only with the user's explicit permission for this pull request, its open choices settled and the project's required checks satisfied. Green checks alone authorize no merge. A grant written before this rule stands only once the user has confirmed it in that form. Complete when it is merged, or closed with its open decisions kept in the plan. The user's part: the grant, or acceptance and the merge decision.

## Rules of engagement

- **Worktrees when the work needs one.** Give a delegate, a spike or your own investigation its own worktree when work runs in parallel, would collide with a checkout in use, or needs a base revision the checkout does not have; not by default.
- **Leave the user's checkout as you found it.** Otherwise your own changes and the One Question happen there; never commit work that is theirs, nor stash, reset, clean or switch branches in it without a yes.
- **Skills are the delegate's craft.** The brief names the skills a delegate follows, such as a design skill for front end work.
- **Label pull requests honestly.** `fix:` only for a defect live in production, naming its obligation; everything else `refine:`, inside the repo's own prefixes where it enforces them.
- **Pairing mode.** When the user drives one agent directly, brief no delegate; stay out of that session and keep the record: decisions, Contract changes, what is left. The required pull request is for automated implementation: in pairing the user is in the session, sees the result as it is made and makes the merge there; pairing on one feature changes nothing else in the plan.
- **Attribution follows the workspace.** Charter slot `software.attribution` records who a commit or pull request is attributed to and whether an agent may be named. Delegates add their harness's attribution by default, so put the rule in every brief.
- **Estimate agent time and human time separately.** Agents compress the implementation, not the review, QA and deploy.
- **Check your identity on the code host.** Before any write (a push, a pull request, a comment) and before you believe a 404, confirm which account the CLI is acting as.
