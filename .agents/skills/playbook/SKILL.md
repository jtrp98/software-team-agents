---
name: playbook
description: Turn a repeated procedure into a reusable runbook the team can execute identically every time.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Runbook for: $ARGUMENTS

Output a repeatable runbook, cap 18 lines:
- **Trigger** — when someone starts this runbook.
- **Steps** — numbered, imperative, each one line: command or exact edit + expected observable result. Copy-pasteable commands preferred; cite file:line for files involved.
- **Verify** — how to prove success in one line.
- **Rollback** — one line on undoing safely.

Assume a new teammate executes it literally. Ambiguous prerequisite → ask exactly one question and stop.
