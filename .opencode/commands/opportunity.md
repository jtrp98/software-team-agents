---
description: "Opportunity assessment scored on stated criteria — RECOMMENDATION ONLY, user decides pursuit."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Opportunity assessment: $ARGUMENTS

> ⚠️ RECOMMENDATION ONLY — pursuing or dropping an opportunity is always the user's decision. This output never authorizes work.

Output table (cap 6 rows): `| Criterion | Assessment | Basis |`
Minimum criteria: user need evidence, effort estimate shape, dependency on undecided rules, reversibility.
Basis = file:line, "user said", or **[UNVERIFIED]** — nothing else. Close ≤2 lines: top open question for the user.
Insufficient input → ask exactly one question and stop.
