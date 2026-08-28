---
description: Show real examples from decisions/ and knowledge/ first — invent only when nothing exists.
argument-hint: [pattern or topic to exemplify]
---
@_shared/guardrails.md

Examples of: $ARGUMENTS

Search order — never skip to invention:
1. `decisions/` and `knowledge/` (if present in this workspace) for prior, decided cases; cite each as file:line.
2. This repo's code/tests for concrete usage; cite file:line.

Output: up to 5 examples as `| Example | What it shows | Source (file:line) |`. Cap 12 lines total.
Only if zero real examples exist: say so explicitly, then give one clearly-labeled hypothetical sketch.
If the topic is too vague to search, ask exactly one question and stop.
