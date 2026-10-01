---
description: "The interactive work loop — answer what is pending from real state, then start it on a governed route."
argument-hint: "[module]"
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

## 2. "Start task X" — begin this turn

The human saying start IS the instruction. Resolve everything yourself — task id, stage, role, and the Target workspace from `plan.md`, `sta status`, and the workspace's Target mapping — and begin in the same turn. Never hand the human a command to paste, and never ask which route to take: route choice is yours, in this order:

1. Route A — work here, governed: `sta grant issue <task-id> --stage <stage>`. Requires a launch that granted Target writes (`--writable-target`) AND verified native pre-tool enforcement — Codex interactive is unguarded even with a grant, so a Codex session goes straight to Route B. When either is missing, skip silently to Route B. When it issues, work under the contract's write/deny rules and end the attempt with `sta grant consume`.
2. Route B — the default: `sta execute --runtime <id> --task "<task>" --workspace <target-root> --write --role <role>`. The child carries its own identity and boundary, so it works from any session — including one opened with no launch grant — and it is the route for a refused grant or an unregistered task.
3. Route C — the full pipeline: `sta run --task-id <id> --module <module>`.

A task the store does not know is a fact to handle, not to self-register — registering plan tasks is `project-manager`'s; unregistered simply means Route B, this turn.

"Start/continue phase N" is the same instruction at phase scale: take that phase's pending tasks in `plan.md`'s dependency order and run them one at a time — each task follows the route rules above, with a short result report between tasks. Do not re-ask for permission between tasks; the human gates below are the only stops.

Stop and ask the human only for what is genuinely theirs: approvals/sign-offs, dates, business rules — or when every route has refused, each refusal relayed verbatim with its remedy. Never work around a refusal: no hand-set guard environment variables, no writing past a hook, no editing STA's runtime/governance state directories, no re-trying a refused route unchanged.

## 3. Closing the attempt

- Spend an issued grant with `sta grant consume` — it is single-use.
- Update only what the active role's contract allows: engineers never edit `plan.md`; Status cells belong to `qa-engineer`.
- Report deterministic results as they actually ran. A gate that never ran is "not run", never "passed".
