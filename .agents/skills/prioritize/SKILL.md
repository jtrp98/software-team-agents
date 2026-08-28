---
name: prioritize
description: Rank items by stated logic with reasons — proposal only; writing plan.md is PM-only.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Prioritize: $ARGUMENTS

State the ranking rule once above the table (e.g. impact × urgency ÷ effort, or a user-supplied rule), then output:
`| Rank | Item | Why here | Unblocks | Cost if delayed |` — cap 12 rows.

Dates, deadlines, and business weights come from the user — never invent them; ask if absent.
Include this note in the output: writing items into plan.md is PM-only — this ranking is a proposal for handoff.
Ambiguous items → ask exactly one question and stop.
