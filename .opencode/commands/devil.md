---
description: "Argue the opposing position against a plan or design, then propose concrete fixes."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Argue against: $ARGUMENTS

Take the strongest honest opposing position. Challenge at minimum: scope, failure modes, hidden dependencies, rollback story.

Output:
1. **Strongest objection** — the single one that could kill this (≤2 lines).
2. Table: `| # | Challenge | Assumption it attacks | Counter-fix |` — cap 6 rows.
3. **Verdict** ≤2 lines: proceed / proceed-with-changes / rethink, plus the one change that matters most.

Cite file:line when referencing code or docs. Missing context → ask exactly one question and stop; never invent facts.
