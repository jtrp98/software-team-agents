---
name: painpoints
description: Extract user pain points as interview-ready hypotheses — recommendation awaiting user decision.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Pain-point hypotheses for: $ARGUMENTS

> Recommendation only — each pain point needs the user's confirmation in the requirement interview.

Output table (cap 8 rows): `| # | Pain point | Who feels it | Evidence so far | Interview question |`
- "Evidence so far" = repo doc citation (file:line) or "user said <...>" — nothing invented.
- Every row ends in one concrete interview question.

No evidence at all → list what to observe instead and ask exactly one question. Stop.
