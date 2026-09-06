---
description: Request qa-engineer verification for the current implementation phase.
argument-hint: [module] [phase]
---
@_shared/guardrails.md

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