---
name: summarize
description: Summarize a file or topic as tight bullets, hard-capped at 30 lines.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Summarize: $ARGUMENTS

Default output: bullets only, cap **30 lines** — no prose paragraphs, no preamble, no closing remarks.
- One bullet = one fact; merge trivia; drop repetition.
- Claims about code need file:line. Numbers stay exactly as in the source.
- If the user asks for longer/deeper, say the cap and continue only on explicit confirm.

If the target is ambiguous (many matches), ask exactly one question and stop.
