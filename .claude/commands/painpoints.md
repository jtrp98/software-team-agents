---
description: Extract user pain points as interview-ready hypotheses — recommendation awaiting user decision.
argument-hint: [product/feature/user group]
---
@_shared/guardrails.md

Pain-point hypotheses for: $ARGUMENTS

> Recommendation only — each pain point needs the user's confirmation in the requirement interview.

Output table (cap 8 rows): `| # | Pain point | Who feels it | Evidence so far | Interview question |`
- "Evidence so far" = repo doc citation (file:line) or "user said <...>" — nothing invented.
- Every row ends in one concrete interview question.

No evidence at all → list what to observe instead and ask exactly one question. Stop.
