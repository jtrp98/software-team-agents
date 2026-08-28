---
description: Draft offer candidates (value proposition shape) as recommendations awaiting user decision.
argument-hint: [product/service + target segment]
---
@_shared/guardrails.md

Offer draft for: $ARGUMENTS

> Recommendation only — pricing, promises, and scope commitments are decided by the user.

Output up to 3 offer variants, each ≤3 lines; cap 15 lines total: **For** <segment> **who** <need> **this delivers** <outcome> **unlike** <alternative>.
Each variant lists its riskiest assumption underneath.
Constraints/pricing/rules come from the user; cite file:line if grounded in repo docs.
Missing segment or need → ask exactly one question and stop.
