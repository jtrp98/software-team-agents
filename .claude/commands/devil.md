---
description: Argue the opposing position against a plan or design, then propose concrete fixes.
argument-hint: [plan/design/proposal]
---
@_shared/guardrails.md

Argue against: $ARGUMENTS

Take the strongest honest opposing position. Challenge at minimum: scope, failure modes, hidden dependencies, rollback story.

Output:
1. **Strongest objection** — the single one that could kill this (≤2 lines).
2. Table: `| # | Challenge | Assumption it attacks | Counter-fix |` — cap 6 rows.
3. **Verdict** ≤2 lines: proceed / proceed-with-changes / rethink, plus the one change that matters most.

Cite file:line when referencing code or docs. Missing context → ask exactly one question and stop; never invent facts.
