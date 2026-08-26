---
name: businessmodel
description: Business-model canvas compressed to 9 short blocks — recommendation awaiting user decision.
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

Business-model sketch for: $ARGUMENTS

> Recommendation only — model choices are the user's decision.

Nine blocks, one line each, in canvas order: Customer Segments · Value Propositions · Channels · Customer Relationships · Revenue Streams · Key Resources · Key Activities · Key Partnerships · Cost Structure.
Fill only from user-supplied context or repo docs (cite file:line); unknown blocks get `<ask user>` — never invented.
Close by flagging the weakest block as the next interview topic.
