---
name: roadmap
description: Draft a roadmap proposal — milestones and order only; all dates come from the user.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Roadmap proposal for: $ARGUMENTS

Before anything else: if dates, duration, or team capacity are not supplied, ask exactly one question about them and stop — never guess timelines.

With dates supplied, output:
`| Milestone | Contents | Depends on | Window (user-supplied) |` — cap 8 rows, then ≤3 lines of sequencing risks with file:line where code is referenced.
This is a proposal for PM review — writing plan.md stays PM-only.
