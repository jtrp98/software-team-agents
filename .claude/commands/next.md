---
description: Resolve module and phase from status, and name the next agent and exact step.
argument-hint: [module]
---
@_shared/guardrails.md

Determine the next step from `_docs/status.md`:

1. Resolve the module:
- If a module name is provided in $ARGUMENTS, use that module.
- If $ARGUMENTS is empty:
  - Read `_docs/status.md`.
  - If exactly one module is listed under `## Modules`, use it.
  - If multiple modules exist or none exist, DO NOT guess among candidates. Ask the user which module to proceed with and list the available candidates.

2. Inspect the resolved module in `_docs/status.md`:
- Locate the module heading `## <module-name>`.
- Find the current active phase and its status:
  - Check the phase list `- Phase N — implemented X · verified Y · security Z · deployed W`.
  - Check the `**Now**:` line and `**Blocked on**:` line.
  - Identify the next agent responsible for this stage (e.g. `business-analyst`, `system-analyst`, `project-manager`, `backend-engineer`, `frontend-engineer`, `qa-engineer`, `security`).

3. Report findings:
- State the module name, active phase number, and stage clearly.
- Name the exact next agent role to invoke.
- State the exact next command or action (e.g. `sta context <role> --module <module> --phase <phase>`).
- If blocked, state the blocker explicitly. Never improvise deadlines, dates, or missing business rules.