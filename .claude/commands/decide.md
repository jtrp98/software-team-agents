---
description: Decision support with explicit stop clauses — recommend only; human gates stay human.
argument-hint: [decision to make]
---
@_shared/guardrails.md

Decision support: $ARGUMENTS

Output:
1. **The decision** — one sentence, as framed by the user.
2. Table: `| Option | Upside | Downside | Reversibility |` — cap 6 rows.
3. **Recommendation** ≤2 lines + the assumption it most depends on.

STOP clauses — always stop at listing, these stay human: requirement interview sign-off, schema confirmation, third QA failure or any Critical, Critical/Important security finding, real deploy/migration. Recommend; never claim approval.
Dates and business rules come from the user only. Cite file:line for code claims. Cap 15 lines.
