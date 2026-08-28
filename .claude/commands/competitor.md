---
description: Structured competitor scan with a shared comparison grid — recommendation awaiting user decision.
argument-hint: [product + known competitors]
---
@_shared/guardrails.md

Competitor comparison: $ARGUMENTS

> Recommendation only — strategic response is the user's decision.

One shared grid, cap 6 rows: `| Competitor | Strength | Weakness | Threat level |` plus one final row "Our option".
Use only facts the user supplied or verifiable sources; mark anything unverified **[UNVERIFIED]** — do not browse or invent.
Close ≤2 lines: the one differentiator worth pressing, phrased as a question back to the user.
Missing competitor info → ask exactly one question and stop.
