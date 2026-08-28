---
name: blueprint
description: End-to-end blueprint of a change from origin to done, anchored to real workflow files.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Blueprint from start to done: $ARGUMENTS

Output sections, cap 20 lines total:
1. **Workflow anchor** — the specific `workflows/*.yml` that governs this (feature/bugfix/schema-change/security-fix/deploy/hotfix/refactor/incremental/triage/business-rule/typo) and why.
2. **Flow** — numbered stages from trigger to verified delivery, naming the owning role at each stage.
3. **Human gates** — which approvals this will stop for.
4. **Risks** — top 2, each with file:line evidence.

Dates and business rules are user-supplied. Missing input → ask exactly one question and stop.
