---
description: Draft a roadmap proposal — milestones and order only; all dates come from the user.
argument-hint: [scope or milestone list]
---
@_shared/guardrails.md

Roadmap proposal for: $ARGUMENTS

Before anything else: if dates, duration, or team capacity are not supplied, ask exactly one question about them and stop — never guess timelines.

With dates supplied, output:
`| Milestone | Contents | Depends on | Window (user-supplied) |` — cap 8 rows, then ≤3 lines of sequencing risks with file:line where code is referenced.
This is a proposal for PM review — writing plan.md stays PM-only.
