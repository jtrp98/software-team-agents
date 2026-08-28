---
description: "Segment the target audience into interview-ready groups — recommendation awaiting user decision."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Audience segments for: $ARGUMENTS

> Recommendation only — segment priority is the user's call.

Output table (cap 6 rows): `| Segment | Defining trait | Need we serve | Where this shows up in requirements |`
Base traits on supplied context or repo docs (cite file:line) — no invented demographics or market sizes.
Then ≤2 lines: which single segment to validate first, and why.
Missing input → ask exactly one question and stop.
