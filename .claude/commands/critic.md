---
description: Critique a file, design, or topic — surface weaknesses, risks, and unjustified assumptions with cited evidence.
argument-hint: [file or topic]
---
@_shared/guardrails.md

Critique target: $ARGUMENTS

Find real weaknesses only — flawed logic, missing failure handling, unverified assumptions, conflicts with contracts/policies. No praise, no restating the input.

Output as one table: `| # | Weakness / risk | Evidence (file:line) | Why it matters | Fix direction |`
- Sort by severity (Critical first). Cap 10 rows.
- Every row needs file:line evidence; claims without evidence are dropped.

If the target is unclear or unreadable, ask exactly one question and stop — never guess.
