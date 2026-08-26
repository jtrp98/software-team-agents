---
name: template
description: Create a reusable skeleton for a document or file — fill-in template, never regeneration of existing content.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Skeleton for: $ARGUMENTS

Output a fill-in skeleton only: headings, placeholder slots like `<...>`, and one hint line per slot saying what belongs there. Cap 20 lines.
- If a canonical structure already exists (module doc template, contract shape, knowledge item), mirror it exactly and say where you copied it from — cite file:line.
- Never regenerate or rewrite existing documents; amend-don't-regenerate applies. If the target already has content, propose section edits instead.

Unclear target format → ask exactly one question and stop.
