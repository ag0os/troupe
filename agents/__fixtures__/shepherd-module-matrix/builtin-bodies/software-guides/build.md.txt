# Guide: the software cycle, steps 3 to 5

The module keeps each step's name, completion criterion, the user's part and its safety rules, which a brief that sends a delegate here must state itself. This guide holds the shape table's Contract timing and Checks rows, then the rest of steps 3 to 5, in order, and the rest of the skills rule.

## Shapes: the Contract and the checks

| | Bug | Feature | Chore |
|---|---|---|---|
| Contract timing | the missing obligation first, its test red on the unfixed code, then the fix | pin what the code does now; the builder writes each agreed obligation into the Contract during the inhale (rule 20); a pass of its own when the user reserved the obligations, or for foundational depth (step 7) | the pins stay green |
| Checks | gates; mutation as step 6, the new test killing the mutant that matches the bug | gates; mutation as step 6; health against the merge base | gates; health against the merge base |

Red first stays for bugs and for pins; a feature's new obligations are written and made executable as the build goes and checked against the agreement on the exhale.

## 3. The Contract

Grow it per change into the component's file, starting one where none exists; where scope or shape is a decision the user reserved, work it out with them in an editable document. The agreed obligations are listed with ids in the agreement and the backbrief; the builder writes each into the Contract as it builds, sentence and test, and what it discovers enters as it is found (step 4). A pass of its own before the build, each agreed obligation's test red against the unchanged code, is for the change whose obligations the user reserved to see before the work is spent, or the depth you chose for a foundational change (step 7). Where mutation cannot run, each new test is shown red against the base before merge, and the pull request says how. A refactor, changing no behavior, keeps its pinned tests green throughout; a pin the change is meant to break is rewritten as the new obligation's test, not deleted. The agreed feature authorizes the changes to obligations it clearly describes, and the builder makes them as it goes. Any other change to an established obligation or decision, one first accepted as a routine default included, is flagged in the pull request for the user's acceptance. Each change's reason traces to the agreed direction or to a proposal the pull request names.

## 4. Inhale: the delegate's brief and backbrief

Its brief names the base revision, constraints, checks, skills, the decisions the plan reserves and its assumptions, whether it may commit and push, the backbrief it opens with, and the Discoveries section its report must end with. The backbrief is the builder's first report, before any code: the outcome and done in its own words, the obligations it will write or build from, and its assumptions. Rule on each difference from the agreement. An interactive delegate sends it and continues, and gets the ruling as a Contract change; a one-shot run ends its first turn there and is resumed with the ruling; batched one-shot work takes rulings as a standing line added to the brief between batches. An S build restates done in one line at the head of its report instead. Where the shape of the change is a decision, or the builder meets an unresolved question of scope or behavior, it builds a proposed resolution on the branch and records it for the pull request to name and the user to settle before merge. A proposal never silently redefines the agreed outcome, marks itself accepted or widens the builder's authority; a departure from the agreed design is shown in the pull request with its reason and consequences. A routine choice goes into the Contract as it is made, a sentence with its test, and into the notes as a choice the user has not settled. Integrate often: no branch outlives the week, or the stretch when that is shorter, unless it waits on the user.

## 5. Exhale, same PR

The builder folds the build back into what exists: dead code and needless complexity out, copies out unless the Contract declares them with a reason, and the whole Contract, the sentences written during the build included, checked against what was agreed and against the behavior the change leaves. Delete tests one at a time, each only on mutation evidence, from the code as it will merge, that the tests that remain catch everything it catches; without that evidence, it stays.

## Skills are the delegate's craft

The delegate's output is still held to the Contract and the checks, and a design skill's audit may add obligations: accessibility, responsive behavior, states, performance budgets. Skills never get in the way of the cycle, and the cycle never replaces them: both run in full, so no skill step is trimmed for the cycle, and no cycle step is skipped because a skill said done.
