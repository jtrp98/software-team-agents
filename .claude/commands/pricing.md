---
description: Pricing analysis skeleton with explicit options — RECOMMENDATION ONLY, never a price decision.
argument-hint: [product + cost/context inputs]
---
@_shared/guardrails.md

Pricing analysis: $ARGUMENTS

> ⚠️ RECOMMENDATION ONLY — prices, tiers, and discounts are always set by the user. This command never outputs a final price.

Output table (cap 5 rows): `| Model | Logic | Needs from user | Risk |`
Models to consider at most: cost-plus, value-based, tiered, usage-based, freemium.
Every figure is a placeholder `<USER>` until the user supplies numbers; cite file:line for any cost data from repo docs.
Missing inputs → ask exactly one question and stop.
