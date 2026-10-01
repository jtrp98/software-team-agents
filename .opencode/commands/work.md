---
description: "The interactive work loop — answer what is pending from real state, then start it on a governed route."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

The human drives this session in natural language. This command is the operating loop: questions about pending work are answered from real state only, and "start" picks a governed execution route — a refusal is relayed, never worked around.

## 1. "What is pending?" / "What's next?"

Answer from real state only (the same rules /status and /next follow):

1. Read `_docs/status.md`; resolve the module from $ARGUMENTS, or ask when several modules exist — never guess among candidates.
2. Report the active phase, `**Now**:` and `**Blocked on**:` lines faithfully, and name the next agent role.
3. Pending plan tasks come from `plan.md`'s phase tables — read the plan's summary plus the phase's section, never the whole file. Report task ids with their state (implemented ⬜ / ✅).
4. When the session carries `STA_CONTEXT_CMD`, offer the exact context command for the next stage (e.g. `sta context <role> --module <module> --phase <n>`).

## 2. "Start task X" — pick the route, in this order

1. Resolve the task id and its stage from `plan.md` and `sta status`. A task the store does not know is a fact to report, not something to self-register — registering plan tasks is `project-manager`'s.
2. Route A — work here, governed: `sta grant issue <task-id> --stage <stage>`. When it issues, the per-role layer is on for this attempt: work under the contract's write/deny rules, in the Targets this session may write (granted at launch via `--writable-target`; a write outside them is refused by name). End the attempt with `sta grant consume`.
3. Route B — delegate one bounded task: `sta execute --runtime <id> --task "<task>" --workspace <target-root> --write --role <role>`. Use it when the grant is refused or the task is not registered.
4. Route C — the full pipeline: `sta run --task-id <id> --module <module>`.
5. Any refusal is relayed verbatim with its remedy. Never work around it: no hand-set guard environment variables, no writing past a hook, no editing `.workflow/` state, no re-trying a refused route unchanged.

## 3. Closing the attempt

- Spend an issued grant with `sta grant consume` — it is single-use.
- Update only what the active role's contract allows: engineers never edit `plan.md`; Status cells belong to `qa-engineer`.
- Report deterministic results as they actually ran. A gate that never ran is "not run", never "passed".
