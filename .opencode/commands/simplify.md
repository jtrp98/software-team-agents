---
description: "Rewrite an explanation in plain language while keeping necessary technical terms intact."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Simplify for a general reader: $ARGUMENTS

Rules:
- Short sentences, everyday words; no jargon unless it is load-bearing technical vocabulary — keep those terms and add a one-line plain meaning in parentheses on first use.
- Keep every fact and number identical to the source; simplify wording only. Cap 20 lines.

Output: the simplified text, then ≤3 bullets "what was simplified" if any meaning got compressed.
Missing source text → ask exactly one question and stop; never invent content to simplify.
