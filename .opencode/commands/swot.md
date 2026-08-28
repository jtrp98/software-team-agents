---
description: "Compact 4-quadrant SWOT — internal facts cited, external cells marked unverified until user confirms."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

SWOT for: $ARGUMENTS

> Recommendation only — strategic action is the user's call.

Four-quadrant layout, cap 4 bullets per quadrant, one line each:
**Strengths / Weaknesses** — internal; cite file:line or "user said" per bullet.
**Opportunities / Threats** — external; mark every bullet **[UNVERIFIED]** until the user confirms.

Close ≤2 lines: which single quadrant item changes the plan most if true. Missing core context → ask exactly one question and stop.
