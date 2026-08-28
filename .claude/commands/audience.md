---
description: Segment the target audience into interview-ready groups — recommendation awaiting user decision.
argument-hint: [product or service]
---
@_shared/guardrails.md

Audience segments for: $ARGUMENTS

> Recommendation only — segment priority is the user's call.

Output table (cap 6 rows): `| Segment | Defining trait | Need we serve | Where this shows up in requirements |`
Base traits on supplied context or repo docs (cite file:line) — no invented demographics or market sizes.
Then ≤2 lines: which single segment to validate first, and why.
Missing input → ask exactly one question and stop.
