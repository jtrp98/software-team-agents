---
name: decide
description: Decision support with explicit stop clauses — recommend only; human gates stay human.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Decision support: $ARGUMENTS

Output:
1. **The decision** — one sentence, as framed by the user.
2. Table: `| Option | Upside | Downside | Reversibility |` — cap 6 rows.
3. **Recommendation** ≤2 lines + the assumption it most depends on.

STOP clauses — always stop at listing, these stay human: requirement interview sign-off, schema confirmation, third QA failure or any Critical, Critical/Important security finding, real deploy/migration. Recommend; never claim approval.
Dates and business rules come from the user only. Cite file:line for code claims. Cap 15 lines.
