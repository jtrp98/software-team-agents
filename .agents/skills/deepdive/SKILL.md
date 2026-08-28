---
name: deepdive
description: Multi-angle deep dive where every claim cites file:line evidence.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Deep dive: $ARGUMENTS

Examine from at least three angles (e.g. behavior, data flow, failure modes / business, technical, operational). For each angle:
`### <angle>` + 2–4 bullets, **every bullet ends with file:line** — uncited claims are dropped.

Close with `**Open questions**`: what only the user can answer (cap 3).
Cap 40 lines total. If sources are insufficient for real depth, say so and ask exactly one question instead of padding.
