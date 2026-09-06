---
name: status
description: Show every module, its phase state, and what each is blocked on from status.md.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Report project progress from `_docs/status.md`:

1. Locate and read `_docs/status.md`:
- If the file does not exist, report that `_docs/status.md` is absent and tell the user to generate it via the status generator script or inspect `_docs/module/`.

2. Summarize overall status:
- If `## Scaffold` is present, state the scaffolding status.
- Reproduce the `## Modules` summary table showing Module, Stage, and Next agent.

3. Module details:
- If $ARGUMENTS specifies a module, show only that module's section.
- If no argument is given, show each module's phase progress:
  - List each phase's implemented, verified, security, and deployed state.
  - Show the `**Now**:` line.
  - Show the `**Blocked on**:` line.

Keep the output concise, verifiable, and faithful to `_docs/status.md`. Do not invent or omit details.
