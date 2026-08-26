---
description: "Decompose a problem to verifiable fundamentals before accepting any business rule as given."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Decompose to first principles: $ARGUMENTS

Output four numbered sections:
1. **Facts** — provable today; each with file:line or "user stated".
2. **Assumptions** — beliefs currently treated as facts; mark each SAFE or RISKY.
3. **Unknowns** — questions only the user can answer (business rules, dates, priorities).
4. **Rebuild** — the minimal solution implied by facts alone (≤5 lines).

Business rules are never invented here: unknowns go back to the user verbatim.
Cap 20 lines total. Insufficient input → ask exactly one question and stop.
