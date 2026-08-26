---
description: Break work into ordered, verifiable steps anchored to the relevant workflow.
argument-hint: [task or goal]
---
@_shared/guardrails.md

Step by step plan for: $ARGUMENTS

Output a numbered list of steps; cap 10 steps. Each step is one line: action + how to verify it is done.
- Name the matching `workflows/<name>.yml` (e.g. feature.yml, bugfix.yml, schema-change.yml) and follow its role order.
- Cite file:line for any existing code/doc a step touches.

Dates and business rules come from the user — never invent them. If the task does not map to a workflow or info is missing, ask exactly one question and stop.
