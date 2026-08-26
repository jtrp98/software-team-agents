---
description: Decompose a problem to verifiable fundamentals before accepting any business rule as given.
argument-hint: [problem or feature]
---
@_shared/guardrails.md

Decompose to first principles: $ARGUMENTS

Output four numbered sections:
1. **Facts** — provable today; each with file:line or "user stated".
2. **Assumptions** — beliefs currently treated as facts; mark each SAFE or RISKY.
3. **Unknowns** — questions only the user can answer (business rules, dates, priorities).
4. **Rebuild** — the minimal solution implied by facts alone (≤5 lines).

Business rules are never invented here: unknowns go back to the user verbatim.
Cap 20 lines total. Insufficient input → ask exactly one question and stop.
