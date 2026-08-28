---
description: "Map the customer profile before/inside a requirement interview — recommendation awaiting user decision."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Customer profile for: $ARGUMENTS

> Recommendation only — every conclusion waits for the user's confirmation during the requirement interview.

Output table (cap 8 rows): `| Aspect | Working assumption | Confidence | What to ask the user |`
Aspects to cover at minimum: who pays, who uses, trigger moment, success definition.
Assumptions come only from supplied context/repo docs (cite file:line when from repo); never invent market facts.
Missing context → ask exactly one question and stop.
