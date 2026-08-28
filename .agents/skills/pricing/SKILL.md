---
name: pricing
description: Pricing analysis skeleton with explicit options — RECOMMENDATION ONLY, never a price decision.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Pricing analysis: $ARGUMENTS

> ⚠️ RECOMMENDATION ONLY — prices, tiers, and discounts are always set by the user. This command never outputs a final price.

Output table (cap 5 rows): `| Model | Logic | Needs from user | Risk |`
Models to consider at most: cost-plus, value-based, tiered, usage-based, freemium.
Every figure is a placeholder `<USER>` until the user supplies numbers; cite file:line for any cost data from repo docs.
Missing inputs → ask exactly one question and stop.
