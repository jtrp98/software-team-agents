---
description: "Break work into ordered, verifiable steps anchored to the relevant workflow."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Step by step plan for: $ARGUMENTS

Output a numbered list of steps; cap 10 steps. Each step is one line: action + how to verify it is done.
- Name the matching `workflows/<name>.yml` (e.g. feature.yml, bugfix.yml, schema-change.yml) and follow its role order.
- Cite file:line for any existing code/doc a step touches.

Dates and business rules come from the user — never invent them. If the task does not map to a workflow or info is missing, ask exactly one question and stop.
