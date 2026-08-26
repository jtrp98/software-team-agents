---
name: checklist
description: Generate an inspection checklist before handoff or QA round — verifiable yes/no items only.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Build a checklist for: $ARGUMENTS

Output checkbox items grouped under at most three headings (e.g. Correctness / Contract & policy / Handoff); cap 15 items total.
- Every item must be verifiable yes/no with file:line or command as evidence source — no "review X" filler.
- Include contract-bound checks: tests green, typecheck green, docs amended with Change Log, no writes outside allowed paths.

If scope of the check is unclear, ask exactly one question and stop.
