---
description: Rank items by stated logic with reasons — proposal only; writing plan.md is PM-only.
argument-hint: [items to prioritize]
---
@_shared/guardrails.md

Prioritize: $ARGUMENTS

State the ranking rule once above the table (e.g. impact × urgency ÷ effort, or a user-supplied rule), then output:
`| Rank | Item | Why here | Unblocks | Cost if delayed |` — cap 12 rows.

Dates, deadlines, and business weights come from the user — never invent them; ask if absent.
Include this note in the output: writing items into plan.md is PM-only — this ranking is a proposal for handoff.
Ambiguous items → ask exactly one question and stop.
