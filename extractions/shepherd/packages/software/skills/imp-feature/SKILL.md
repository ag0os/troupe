---
name: imp-feature
description: Run one feature (behavior added or changed) through Impatient Programming's steps in order, leaving the same trace every run, in a repo whose AGENTS.md names a checks command. Use when the user says "imp feature" or "run the feature shape", or asks to build a feature in a repo on the method. Not for a bug (AGENTS.md's bug steps), a chore (no behavior change) or a planning-only ask. Complements Troupe's software module; where AGENTS.md or the module says more, they win.
---

# imp-feature: one feature, IMP's order, one trace

Each step ends with an artifact or a one-line reason, written where the step says. Keep the order.

**The trace.** One line per step: `<step> | <done, skipped, blocked, parked> | <artifact path or link, or the reason>`. Step 0 writes one line per value, in this order: `checks command` (with its prerequisite), `feature label` (label or title prefix), `contract location` (where each lives now and the move-on-touch rule), `test directory`, `attribution rule`, `merge rule`, `design location`, `showcase record`; each as `0 | <value name> | <value> (<file>:<line>)` or `0 | <value name> | missing`. The line is the summary; the full agreement, the spike evidence and the notes live beside it: in the work item's plan with a Shepherd, otherwise in your reply, then in the pull request body. Without a Shepherd, end each step with the trace so far in your reply; once opening a pull request is allowed, and not in pairing, a draft pull request holds it, and the body stays current after step 8. Replies do not survive a fresh session: a restarted run begins at step 0. Only the design record and the Contract enter the repo.

**Who acts.** You act unless a step says otherwise; the user settles what the story reserves, confirms a grant, and merges. A delegate is allowed only under the delegation permission and budget the story names; without it you do the work yourself, in sequence. With a Shepherd the module's guides apply, the hooks runbook before a Claude Code builder. Pairing, the user driving you directly: no delegates, no pull request required, no merge by you; the user merges in the session. Leave the user's checkout as you found it: work on a branch or worktree, and never stash, reset, clean or switch branches in it without a yes. Before any remote write (a push, a pull request, a comment, a showcase entry) confirm which code-host account you act as.

## 0. Read the repo

Read `AGENTS.md`, then every file it names for the step 0 values: a product doc, a decisions file, the CI config, `docs/contracts/` (README and front matter), `docs/decisions/`. Take the values from them, never from memory or another repo; the merge rule is a grant whose text you can read, or explicit permission per pull request. Produces: the step 0 lines.

A missing value is said, with what to add. No checks command: stop, the run has no "done"; separate test and lint commands are not one. No Contract convention or test location: continue, and at step 1 propose the shape in `references/contract-file.md` and the paragraph in `references/agents-paragraph.md`, agreed before any file is created; read them only then. No label rule: `refine:`, as the method says. No attribution rule: ask at step 1 and add none until answered. No merge rule: continue; the pull request is presented, and you merge nothing until the user's explicit permission for this pull request arrives (step 9).

## 1. Story straight

Agree with the user: outcome, scope, constraints, acceptance criteria, the period, the base revision, the decisions they reserve, blast radius and size, and the permissions, each on its own: local edits and commits, a branch or worktree, push, opening a pull request, delegation with its budget, merge. Push does not imply a pull request. A missing permission parks that action, not the independent work. The module's axes, quoted once for steps 4, 7 and 9: "Blast radius is small or large: large when the change touches a migration that destroys data, authentication or permissions, deploy configuration or secrets; otherwise judge it from what the change can break and what reacts once it ships (scheduled jobs, notifications, reports, downstream consumers). Size is S, M or L: S, a few lines or files with their tests, an agent's minutes; M, several files and new tests, an agent's hours; L, many files or screens, a day or more." A merge that deploys does not by itself make the radius large. Show the user any grant step 0 found; it stands for this run only once they confirm it here. Skip: never; a story that cannot be stated is not ready, say so and stop.

## 2. The One Question

Ask what we must still learn, and answer with evidence against the base revision: the code and, where data matters, authorized representative records, read only, in a safe environment, never production without the user's yes. Unclear: throwaway spikes in their own worktrees, in parallel as delegates where permitted, otherwise one at a time, then compared. Where scope or shape is reserved, work the design out with the user in an editable document that stays as the record; where a screen is reserved, a prototype in front of the user. Spike and prototype code is discarded. Produces: the answer, two lines per spike, the assumptions left (one the user would rule on if it fails joins the reserved decisions), the design or its link in `docs/design/<branch name>.md` on the branch (an outside Doc needs the user's yes), unless AGENTS.md names another place. Skip only when both hold: "2 | skipped | nothing to learn, <why>; nothing reserved".

## 3. The Contract

Pin what the code does now in the component's Contract where AGENTS.md says it lives, moving or starting its file as AGENTS.md says, ids unchanged, and find out why each fence stands. List the agreed obligations with ids. A red-first pass of its own only when the user reserved the obligations or the change is foundational; otherwise the builder writes each during the inhale. Where mutation cannot run, each new test is shown red against the base before merge and the pull request says how. Produces: the pins and the id list, in the Contract file and the repo's test directory; the ids in the trace. Skip: never; a change with no behavior change is a chore, not this skill.

## 4. Inhale

Brief the builder, or build: base revision, constraints, the checks command, reserved decisions, attribution rule, commit and push rights, skills, and a backbrief first for M and L, which you rule on. Discovered obligations enter the Contract as found, sentence and test; unreserved choices are built as proposals and listed in the notes; a departure from the agreed design is shown with its reason. The builder stops only for a reserved decision or for an act outside the branch (a deploy, a change to external data), each needing its own yes. Integrate in small checked pieces, rebased on the base before step 6. Produces: the branch, the Contract diff, the notes in the trace.

## 5. Exhale, same pull request

Dead code, needless complexity and undeclared copies out; the whole Contract, built sentences included, checked against the agreement and the behavior left. A test goes only on mutation evidence that the tests that remain catch everything it catches, one at a time, recomputed after each removal; without per-test evidence, name the gap and keep the tests. Removals follow the repo's own rule, owner approval where it requires one. Produces: the folded branch; open choices named in the trace.

## 6. Checks before done

Run the repo's checks command with its prerequisites, the one CI runs; add no tool. The module's gates stand within it: mutation on every subject where the repo runs it, survivors judged against the merge base as the repo's gate does, each new one equivalent with a reason or a missing sentence with its test; the health checks against the merge base, a finding the change adds fails. Update each touched Contract's coverage line by the repo's convention (paste the contract tool's `coverage --line` where Troupe is installed). After review or user changes, rerun the checks the revision affects. A required check that could not run blocks, named as a gap, never a pass. Produces: the result and each gap, in the trace; the coverage line in the repo.

## 7. Review by blast radius

Small: the checks and your own read, written as done: "7 | done | small, own read and checks complete". Large or foundational: two reviewers with different lenses or models who do not see each other's findings, then a synthesizer told to refute each finding; without delegation permission, name the gap, which bars a grant merge at step 9, and the pull request is presented. A finding that the Contract lacks an obligation adds it with its test in this pull request. Produces: the findings and what was done with each, in the trace.

## 8. The pull request

With permission to open one: label with the repo's feature label or title prefix as step 0 recorded it. Body: a preview or screenshots, what changed and why, choices and departures, the Contract's changes and coverage line, the open decisions, the checks and their gaps, the trace from step 0. Without that permission, or in a repo with no pull request flow, present the branch and the same body in your reply and park the publication. In pairing, no publication: "8 | done | pairing, the user merges in the session". Produces: the pull request, or the parked body.

## 9. Merge under a grant, otherwise present

A grant stands when its text is readable, names what it covers (which changes, which branch), the checks it requires and when it lapses, and the user confirmed it at step 1; it covers small blast radius only unless its text names the large kinds. When it covers this pull request and every condition holds, say so in the body, naming it and asserting that no reserved decision is pending and no reserved obligation changed; then let the machine merge, the repo's auto-merge where it allows one, otherwise merge yourself once the checks are green. An open choice, a departure, an unstaffed large review (step 7), a check that could not run or that the project lacks and the grant does not accept, or no grant: present, settle the choices with the user, and merge only on their explicit permission for this pull request. Green checks alone merge nothing. In pairing you merge nothing: "9 | done | pairing, merged by the user in the session". Who: the user, or the grant. Produces: the merge revision in the trace. Skip: "9 | parked | waiting on <decision or permission>".

Showcase, after a merge only; a parked step 9 leaves no showcase line. Where step 0 found a showcase record, add the feature to it within existing write permission: "showcase | done | <path or link>", or "showcase | parked | no write permission" with the entry in the trace; otherwise "showcase | skipped | none in this project".
