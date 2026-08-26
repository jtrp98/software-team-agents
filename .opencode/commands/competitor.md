---
description: "Structured competitor scan with a shared comparison grid — recommendation awaiting user decision."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Competitor comparison: $ARGUMENTS

> Recommendation only — strategic response is the user's decision.

One shared grid, cap 6 rows: `| Competitor | Strength | Weakness | Threat level |` plus one final row "Our option".
Use only facts the user supplied or verifiable sources; mark anything unverified **[UNVERIFIED]** — do not browse or invent.
Close ≤2 lines: the one differentiator worth pressing, phrased as a question back to the user.
Missing competitor info → ask exactly one question and stop.
