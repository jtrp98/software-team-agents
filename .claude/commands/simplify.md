---
description: Rewrite an explanation in plain language while keeping necessary technical terms intact.
argument-hint: [text/file/topic]
---
@_shared/guardrails.md

Simplify for a general reader: $ARGUMENTS

Rules:
- Short sentences, everyday words; no jargon unless it is load-bearing technical vocabulary — keep those terms and add a one-line plain meaning in parentheses on first use.
- Keep every fact and number identical to the source; simplify wording only. Cap 20 lines.

Output: the simplified text, then ≤3 bullets "what was simplified" if any meaning got compressed.
Missing source text → ask exactly one question and stop; never invent content to simplify.
