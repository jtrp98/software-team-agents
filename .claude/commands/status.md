---
description: Show every module, its phase state, and what each is blocked on from status.md.
argument-hint: [optional module]
---
@_shared/guardrails.md

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