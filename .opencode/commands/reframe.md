---
description: "Reframe a problem from genuinely different angles before redesigning anything."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Reframe before redesigning: $ARGUMENTS

Produce 3 genuinely different framings of the problem — not three phrasings of one framing:

`| Framing | The real question it asks | What becomes easy | What becomes hard |`

For the most promising framing add ≤5 lines: the smallest experiment that tests it, citing file:line for current behavior.

No solutions, no redesign here — framings first; the user picks the direction.
Missing context → ask exactly one question and stop.
