---
description: Compare two or more options against one shared criteria table — same rows for every option.
argument-hint: [option A vs option B ...]
---
@_shared/guardrails.md

Compare: $ARGUMENTS

One criteria table for ALL options — identical rows, never per-option criteria:

`| Criterion | Weight | Option A | Option B | … |`

- Include at least 4 criteria: correctness/risk, effort/cost, maintainability, operational fit.
- Score High/Med/Low with a one-line why per cell. Cap 10 rows.

Then verdict ≤2 lines: winner, main trade-off accepted, what evidence would flip it.
Cite file:line wherever a claim touches code. Missing info on any option → ask exactly one question and stop.
