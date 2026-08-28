---
description: Summarize a file or topic as tight bullets, hard-capped at 30 lines.
argument-hint: [file or topic]
---
@_shared/guardrails.md

Summarize: $ARGUMENTS

Default output: bullets only, cap **30 lines** — no prose paragraphs, no preamble, no closing remarks.
- One bullet = one fact; merge trivia; drop repetition.
- Claims about code need file:line. Numbers stay exactly as in the source.
- If the user asks for longer/deeper, say the cap and continue only on explicit confirm.

If the target is ambiguous (many matches), ask exactly one question and stop.
