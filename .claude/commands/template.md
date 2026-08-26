---
description: Create a reusable skeleton for a document or file — fill-in template, never regeneration of existing content.
argument-hint: [document/file type]
---
@_shared/guardrails.md

Skeleton for: $ARGUMENTS

Output a fill-in skeleton only: headings, placeholder slots like `<...>`, and one hint line per slot saying what belongs there. Cap 20 lines.
- If a canonical structure already exists (module doc template, contract shape, knowledge item), mirror it exactly and say where you copied it from — cite file:line.
- Never regenerate or rewrite existing documents; amend-don't-regenerate applies. If the target already has content, propose section edits instead.

Unclear target format → ask exactly one question and stop.
