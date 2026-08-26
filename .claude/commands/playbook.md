---
description: Turn a repeated procedure into a reusable runbook the team can execute identically every time.
argument-hint: [procedure]
---
@_shared/guardrails.md

Runbook for: $ARGUMENTS

Output a repeatable runbook, cap 18 lines:
- **Trigger** — when someone starts this runbook.
- **Steps** — numbered, imperative, each one line: command or exact edit + expected observable result. Copy-pasteable commands preferred; cite file:line for files involved.
- **Verify** — how to prove success in one line.
- **Rollback** — one line on undoing safely.

Assume a new teammate executes it literally. Ambiguous prerequisite → ask exactly one question and stop.
