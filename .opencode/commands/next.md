---
description: "Resolve module and phase from status, and name the next agent and exact step."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

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
