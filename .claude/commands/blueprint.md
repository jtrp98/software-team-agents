---
description: End-to-end blueprint of a change from origin to done, anchored to real workflow files.
argument-hint: [change or initiative]
---
@_shared/guardrails.md

Blueprint from start to done: $ARGUMENTS

Output sections, cap 20 lines total:
1. **Workflow anchor** — the specific `workflows/*.yml` that governs this (feature/bugfix/schema-change/security-fix/deploy/hotfix/refactor/incremental/triage/business-rule/typo) and why.
2. **Flow** — numbered stages from trigger to verified delivery, naming the owning role at each stage.
3. **Human gates** — which approvals this will stop for.
4. **Risks** — top 2, each with file:line evidence.

Dates and business rules are user-supplied. Missing input → ask exactly one question and stop.
