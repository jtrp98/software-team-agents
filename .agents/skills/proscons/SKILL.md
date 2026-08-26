---
name: proscons
description: List pros, cons, and mandatory trade-offs of an option — what you give up even in the good case.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Pros & cons of: $ARGUMENTS

Output three bullet lists, cap 6 bullets each:
- **Pros** — concrete gains; cite file:line where a claim touches code.
- **Cons** — concrete costs and risks.
- **Trade-offs you must accept** — mandatory section: what is given up even in the best case.

Close with ≤2 lines: net recommendation plus its single decisive factor. The recommendation is advisory — the user decides.
Insufficient context → ask exactly one question and stop.
