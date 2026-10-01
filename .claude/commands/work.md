---
description: The interactive work loop — answer what is pending from real state, then start it on a governed route.
argument-hint: [module]
---
@_shared/guardrails.md

The human drives this session in natural language. This command is the operating loop: questions about pending work are answered from real state only, and "start" picks a governed execution route — a refusal is relayed, never worked around.

## 1. "What is pending?" / "What's next?"

Answer from real state only (the same rules /status and /next follow):

1. Read `_docs/status.md`; resolve the module from $ARGUMENTS, or ask when several modules exist — never guess among candidates.
2. Report the active phase, `**Now**:` and `**Blocked on**:` lines faithfully, and name the next agent role.
3. Pending plan tasks come from `plan.md`'s phase tables — read the plan's summary plus the phase's section, never the whole file. Report task ids with their state (implemented ⬜ / ✅).
4. When the session carries `STA_CONTEXT_CMD`, offer the exact context command for the next stage (e.g. `sta context <role> --module <module> --phase <n>`).

## 2. "Start task X" — pick the route, in this order

1. Resolve the task id and its stage from `plan.md` and `sta status`. A task the store does not know is a fact to report, not something to self-register — registering plan tasks is `project-manager`'s.
2. Route A — work here, governed: `sta grant issue <task-id> --stage <stage>`. When it issues, the per-role layer is on for this attempt: work under the contract's write/deny rules, in the Targets this session may write (granted at launch via `--writable-target`; a write outside them is refused by name). End the attempt with `sta grant consume`. This route requires verified native pre-tool enforcement: Codex interactive is unguarded even after a grant, so any Codex write must use Route B with `--runtime codex` (or the Codex headless pipeline in Route C). Direct interactive writes are not certified.
3. Route B — delegate one bounded task: `sta execute --runtime <id> --task "<task>" --workspace <target-root> --write --role <role>`. Use it when the grant is refused or the task is not registered.
4. Route C — the full pipeline: `sta run --task-id <id> --module <module>`.
5. Any refusal is relayed verbatim with its remedy. Never work around it: no hand-set guard environment variables, no writing past a hook, no editing `.workflow/` state, no re-trying a refused route unchanged.

## 3. Closing the attempt

- Spend an issued grant with `sta grant consume` — it is single-use.
- Update only what the active role's contract allows: engineers never edit `plan.md`; Status cells belong to `qa-engineer`.
- Report deterministic results as they actually ran. A gate that never ran is "not run", never "passed".
