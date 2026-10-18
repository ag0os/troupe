# Guide: the software cycle, steps 6 and 7

The module keeps each step's name, completion criterion, the user's part and its safety rules, which a brief that sends a delegate here must state itself. This guide holds the rest of steps 6 and 7, in order.

## 6. Checks before done

Mutation and the health checks are what measure a change's real effect on the tests and the codebase; the method needs them. Where a project cannot run them yet, red tests are the fallback, the gap is named in every done report, and getting the tool is put to the user. Where runtime effects matter (migrations, jobs, imports), a safe dry run against real conditions beats another reading. Report whether the Contract is met and what it covers; coverage nobody measured is unknown, not a number. Say what remains unexercised.

## 7. Review by blast radius

A finding that the Contract was wrong or silent enters the Contract the way a bug does: the sentence, its test, then the fix. After a fix round, review again at the depth you chose.
