---
description: "Show real examples from decisions/ and knowledge/ first — invent only when nothing exists."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Examples of: $ARGUMENTS

Search order — never skip to invention:
1. `decisions/` and `knowledge/` (if present in this workspace) for prior, decided cases; cite each as file:line.
2. This repo's code/tests for concrete usage; cite file:line.

Output: up to 5 examples as `| Example | What it shows | Source (file:line) |`. Cap 12 lines total.
Only if zero real examples exist: say so explicitly, then give one clearly-labeled hypothetical sketch.
If the topic is too vague to search, ask exactly one question and stop.
