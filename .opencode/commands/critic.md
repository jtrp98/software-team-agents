---
description: "Critique a file, design, or topic — surface weaknesses, risks, and unjustified assumptions with cited evidence."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Critique target: $ARGUMENTS

Find real weaknesses only — flawed logic, missing failure handling, unverified assumptions, conflicts with contracts/policies. No praise, no restating the input.

Output as one table: `| # | Weakness / risk | Evidence (file:line) | Why it matters | Fix direction |`
- Sort by severity (Critical first). Cap 10 rows.
- Every row needs file:line evidence; claims without evidence are dropped.

If the target is unclear or unreadable, ask exactly one question and stop — never guess.
