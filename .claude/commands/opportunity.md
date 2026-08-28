---
description: Opportunity assessment scored on stated criteria — RECOMMENDATION ONLY, user decides pursuit.
argument-hint: [opportunity idea]
---
@_shared/guardrails.md

Opportunity assessment: $ARGUMENTS

> ⚠️ RECOMMENDATION ONLY — pursuing or dropping an opportunity is always the user's decision. This output never authorizes work.

Output table (cap 6 rows): `| Criterion | Assessment | Basis |`
Minimum criteria: user need evidence, effort estimate shape, dependency on undecided rules, reversibility.
Basis = file:line, "user said", or **[UNVERIFIED]** — nothing else. Close ≤2 lines: top open question for the user.
Insufficient input → ask exactly one question and stop.
