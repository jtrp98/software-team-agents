---
name: verify
description: Request qa-engineer verification for the current implementation phase.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Guide verification for module phase implementation:

1. Target phase identification:
- If module and phase are provided in $ARGUMENTS, target them.
- Otherwise, inspect `_docs/status.md` to identify the phase currently waiting on verification (`implemented ✅ · verified ⬜`).
- If ambiguous or unspecified, ask the user to specify the target module and phase.

2. Role and workspace verification rail:
- This command is a shortcut to invoke or prepare verification; it does NOT perform QA verification itself.
- QA verification is owned by `qa-engineer` comparing code against requirements and design contract.
- QA verification must run in the DEV workspace (Target repository), never in a BA workspace (Knowledge repository).

3. Instruct next step:
- Run `sta context qa-engineer --module <module> --phase <phase>`.
- Remind the engineer or operator that only `qa-engineer` updates Status cells in review outcomes.
