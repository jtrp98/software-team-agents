---
name: positioning
description: Positioning statement drafts against named alternatives — recommendation awaiting user decision.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Positioning draft for: $ARGUMENTS

> Recommendation only — positioning is chosen by the user.

Output up to 3 candidate statements, one line each:
"For <segment>, <product> is the only <category> that <differentiator>, unlike <alternatives>."
Under each: ≤1 line of what must be true for it to hold (with file:line if it rests on repo facts).
Claims about competitors stay **[UNVERIFIED]** unless user-supplied. Missing frame → ask exactly one question and stop.
