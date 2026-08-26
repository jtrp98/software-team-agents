---
description: Decide what to delegate to which agent role — roles, never person names.
argument-hint: [workload or task set]
---
@_shared/guardrails.md

Delegation map for: $ARGUMENTS

Output a table: `| Work item | Role (sta) | Why this role | Hands-off note |` — cap 10 rows.
- Map to pipeline roles only: setup, business-analyst, system-analyst, project-manager, test-planner, uxui-designer, backend-engineer, frontend-engineer, qa-engineer, security, devops — never person names.
- Respect contracts: engineers don't write plan.md; QA sets Status cells; approvals stay human.

Items outside the pipeline → mark "user decides". Unclear scope → ask exactly one question and stop.
