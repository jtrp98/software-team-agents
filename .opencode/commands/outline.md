---
description: "Produce a fill-in skeleton outline before writing any requirement, design, or plan document."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Outline before writing: $ARGUMENTS

Output a skeleton only — headings + placeholder slots `<...>` with one hint line per slot. Cap 25 lines.
- Requirement shape → follow the BA interview structure used in this repo (`contracts/business-analyst.yaml`).
- Design/plan shapes → mirror the module doc sections under `_docs/module/<name>/` conventions; cite the file you mirrored as file:line.
- Slots needing user input (dates, business rules) must be marked **[USER]**.

The result is a skeleton awaiting fill-in — never present it as a finished document.
Wrong doc type → ask exactly one question and stop.
