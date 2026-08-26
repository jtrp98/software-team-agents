---
description: Break a goal into staged sub-goals — numbers and deadlines come from the user only.
argument-hint: [goal]
---
@_shared/guardrails.md

Break down the goal: $ARGUMENTS

If target numbers, deadlines, or constraints were not supplied, ask exactly one question about them and stop — never invent them.

Otherwise output a staged table: `| Stage | Sub-goal | Evidence it is met | Depends on |` — cap 7 stages.
Each stage must be independently verifiable; cite file:line where verification reads code/docs.
Keep user-supplied figures verbatim — no rounding, no re-deriving. This is a proposal; the user owns the targets.
