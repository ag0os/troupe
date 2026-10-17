# Guide: the software cycle, steps 8 and 9

The module keeps each step's name, completion criterion, the user's part and its safety rules, which a brief that sends a delegate here must state itself. This guide holds the rest of steps 8 and 9, in order, then automatic merging and the task that waits on the user.

## 8. Present the PR

The pull request lets the user assess the result without reading code: a working preview or demonstration fit to the change, with screenshots where they help, since a description of promised behavior does not replace seeing the software work; what changed and why, with the consequential choices and every departure from the agreed design; the Contract's changes and the decisions still open for acceptance; and verification, with unresolved findings and each check that could not run. Keep the account concise and link the technical detail.

## 9. Revise and merge

Address the feedback, settle each open choice with the user, and run again the checks the revision affects.

## Automatic merging

Broader automatic merging, for any pull request that keeps to the agreed design and passes the agreed checks, may come once experience earns it, on criteria still to be agreed with the user and then written as a grant; until then, nothing merges automatically beyond what a written grant covers. Meanwhile journal what bears on that agreement: interruptions that were not needed, choices that deserved earlier attention, and how easily the user could assess each pull request.

## A task that waits on the user

A task that waits on the user, for a reserved decision or for authority beyond preparing the change, parks at whatever step it reached: record the decision and the branch (name, base, what it holds; pushed where the plan allows) in the plan, give it an ASK line in `CURRENT.md`, and carry on with the plan's independent work. Before a parked branch moves again, bring it up to the current base; a conflict resolved on the way is a proposal the pull request names.
