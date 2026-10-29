Generated from Troupe's source at install time (the Contract convention, section 1); read only when step 0 finds no Contract convention or test location, and proposed to the user at step 1 before any file is created.

# The Contract file: front matter and obligation shape

One file per component at `docs/contracts/<component>.md`; `<component>` is a lowercase slug with underscores, the same slug as its tests. A component is the unit the user would delete and rebuild as one thing, not a class and not a plan. A component with neither a file nor a legacy section has no Contract: claim no coverage for it.

## Front matter

YAML, these four fields and no others:

```yaml
---
component: agency_client_port
covers:
  - app/controllers/agency/
  - app/models/agency/
depends_on: []
tests:
  - test/contracts/agency_client_port/
---
```

- `component`: the slug, equal to the file name.
- `covers`: the paths this Contract is about, from the repo root: directories, files or globs. A directory named by two files is a finding; a shared file (`config/routes.rb`) may be named by several.
- `depends_on`: the slugs of components this one calls or reads. `[]` is a value.
- `tests`: the directories or files holding this component's contract tests. The repo's own layout is allowed: `test/contracts/<component>/`, `test/contract/<component>_contract_test.rb`, `tests/contract/`.

## The coverage line

The first line of the body, kept true in every PR that touches the file (by hand, or by pasting the contract tool's `coverage --line` where Troupe is installed):

```
Coverage: 19 obligations; 14 proved by test, 2 by PR evidence, 3 mixed, 0 unproved. Suite runs against this implementation.
```

Proved by test: the proof names a test that exists. By PR evidence: a recorded run, screenshot or inventory. Mixed: part each, split in two when next touched. Unproved: no test and no evidence yet, counted and never hidden. The last sentence says whether the suite runs against this implementation or against any implementation behind a named interface. The line counts active obligations only.

## Obligations

One `###` heading per obligation: the id, then a short name. Under it the statement, a reason paragraph, and one line with kind and proof:

```markdown
### MR-5 unsafe URLs lose their URL and keep their text

<the statement, as many sentences as it needs>

**Reason.** <why it must hold; the fence this obligation is> (D-6)

Kind: functional. Proof: test, `test/contract/markdown_renderer_contract_test.rb` ("MR-5 ...").
```

- `id`: `<PREFIX>-<n>`, one prefix per component, numbers never reused. A retired obligation keeps its heading with `Retired YYYY-MM-DD, <why>` and no proof.
- `statement`: what must hold. Membership test: would reimplementing the component in another language invalidate it? If yes, it is an implementation test and stays out; record a close call in the reason.
- `reason`: always present; an obligation with no reason is a finding. A decision pointer is a token in parentheses, a letter prefix and a number: `(D-6)`, `(ADR-002)`.
- `kind`: `functional` or `non-functional`; a non-functional obligation names its budget, where it is measured and how.
- `proof`: `test` with the file and the test's name or id; `pr-evidence` with the PR number or the record's path; `none`. Mixed proof is two clauses: `Proof: test, <id> in <file>; pr-evidence, #<pr>.`
- A reworded obligation keeps its id and gets a dated line under it: `Reworded YYYY-MM-DD by <the PR>.` A change to an established obligation is flagged in the PR for the user's acceptance.

## Decisions by pointer

The Contract never holds a derivation. Each pointer used in a reason is listed in a closing `## Decisions` section with its id, path, title and the obligations it bears on; a file with no pointers needs no section:

```markdown
## Decisions

- D-6, `docs/decisions/markdown_renderer.md`: raw HTML is omitted and unsafe URLs are emptied (MR-4, MR-5).
```

Decisions live in `docs/decisions/`, one file per ADR or per component.

## What else the file may hold

A short head paragraph saying what the component is; `##` headings grouping obligations ("Safety", "Tables"); the dated amendment lines. Nothing that belongs in a plan (delivery order, tasks) or a guide (how to run it).

## Migration on next touch

A Contract still kept as a section in a product doc moves to its file in the first PR that touches the component, ids unchanged, the product doc left with a one-line pointer, and its decisions moved the same way. Until then the section is accepted in place and coverage for that component is unknown.
