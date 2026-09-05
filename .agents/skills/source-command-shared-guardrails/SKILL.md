---
name: "source-command-shared-guardrails"
description: "Shared guardrails imported by every /command in this repo — rules that outrank any command body."
---

# source-command-shared-guardrails

Use this skill when the user asks to run the migrated source command `_shared-guardrails`.

## Command Template

Shared guardrails for every slash command below (imported via `@_shared/guardrails.md`):

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.
