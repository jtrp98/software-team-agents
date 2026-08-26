---
description: Map the customer profile before/inside a requirement interview — recommendation awaiting user decision.
argument-hint: [product or feature]
---
@_shared/guardrails.md

Customer profile for: $ARGUMENTS

> Recommendation only — every conclusion waits for the user's confirmation during the requirement interview.

Output table (cap 8 rows): `| Aspect | Working assumption | Confidence | What to ask the user |`
Aspects to cover at minimum: who pays, who uses, trigger moment, success definition.
Assumptions come only from supplied context/repo docs (cite file:line when from repo); never invent market facts.
Missing context → ask exactly one question and stop.
