---
description: "Break a goal into staged sub-goals — numbers and deadlines come from the user only."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Break down the goal: $ARGUMENTS

If target numbers, deadlines, or constraints were not supplied, ask exactly one question about them and stop — never invent them.

Otherwise output a staged table: `| Stage | Sub-goal | Evidence it is met | Depends on |` — cap 7 stages.
Each stage must be independently verifiable; cite file:line where verification reads code/docs.
Keep user-supplied figures verbatim — no rounding, no re-deriving. This is a proposal; the user owns the targets.
