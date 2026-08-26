---
description: "Compare two or more options against one shared criteria table — same rows for every option."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Compare: $ARGUMENTS

One criteria table for ALL options — identical rows, never per-option criteria:

`| Criterion | Weight | Option A | Option B | … |`

- Include at least 4 criteria: correctness/risk, effort/cost, maintainability, operational fit.
- Score High/Med/Low with a one-line why per cell. Cap 10 rows.

Then verdict ≤2 lines: winner, main trade-off accepted, what evidence would flip it.
Cite file:line wherever a claim touches code. Missing info on any option → ask exactly one question and stop.
