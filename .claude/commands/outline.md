---
description: Produce a fill-in skeleton outline before writing any requirement, design, or plan document.
argument-hint: [requirement|design|plan] [subject]
---
@_shared/guardrails.md

Outline before writing: $ARGUMENTS

Output a skeleton only — headings + placeholder slots `<...>` with one hint line per slot. Cap 25 lines.
- Requirement shape → follow the BA interview structure used in this repo (`contracts/business-analyst.yaml`).
- Design/plan shapes → mirror the module doc sections under `_docs/module/<name>/` conventions; cite the file you mirrored as file:line.
- Slots needing user input (dates, business rules) must be marked **[USER]**.

The result is a skeleton awaiting fill-in — never present it as a finished document.
Wrong doc type → ask exactly one question and stop.
