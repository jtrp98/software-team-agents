---
name: delegate
description: Decide what to delegate to which agent role — roles, never person names.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Delegation map for: $ARGUMENTS

Output a table: `| Work item | Role (sta) | Why this role | Hands-off note |` — cap 10 rows.
- Map to pipeline roles only: setup, business-analyst, system-analyst, project-manager, test-planner, uxui-designer, backend-engineer, frontend-engineer, qa-engineer, security, devops — never person names.
- Respect contracts: engineers don't write plan.md; QA sets Status cells; approvals stay human.

Items outside the pipeline → mark "user decides". Unclear scope → ask exactly one question and stop.
