---
description: Generate an inspection checklist before handoff or QA round — verifiable yes/no items only.
argument-hint: [what to check]
---
@_shared/guardrails.md

Build a checklist for: $ARGUMENTS

Output checkbox items grouped under at most three headings (e.g. Correctness / Contract & policy / Handoff); cap 15 items total.
- Every item must be verifiable yes/no with file:line or command as evidence source — no "review X" filler.
- Include contract-bound checks: tests green, typecheck green, docs amended with Change Log, no writes outside allowed paths.

If scope of the check is unclear, ask exactly one question and stop.
