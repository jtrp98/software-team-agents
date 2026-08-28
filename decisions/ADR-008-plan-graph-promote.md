---
id: ADR-008
title: Promote the plan graph to a read-only advisor for context and runs; runtime readiness stays the orchestrator's
status: accepted
date: 2026-08-27
---

## Status

accepted — 2026-08-27

## Context

`orchestrator/src/docs/planGraph.ts` and `orchestrator/src/graph/taskGraph.ts` model the
Work Graph: `plan.md`'s task table parsed into rows, validated as a DAG, layered into waves,
and answered for "what may start now". The V3 audit found the layer had no runtime consumer
and called it "a lint pretending to be an authority layer", proposing either promotion into
the dispatcher or deletion.

T-V3TOK-111 re-ran the consumer grep against the tree as it stands today, and the audit's
evidence is stale — P6 (Structured Handoff / context selection) promoted most of it while
this task was still open:

| Export | Consumers outside its own file and tests |
|---|---|
| `parsePlanTasks` | `agents/moduleDocs.ts`, `context/contextManager.ts`, `context/contextCommand.ts`, `runtime/agentRunAssembly.ts`, `cli.ts` |
| `buildPlanGraph` | `agents/moduleDocs.ts` (handoff `contract_refs`), `cli.ts` (QA affected-task derivation) |
| `validatePlanTasks` | `checkPlanGraphForModule` |
| `deriveWaves` | `validatePlanTasks`, `readinessOf` |
| `checkPlanGraphs` | `cli.ts` (`--check-plan`) |
| `readinessOf` | **nothing** |

So the two exports the audit named as dead are in different states. `buildPlanGraph` is
exactly what T-V3TOK-090's handoff `contract_refs` is built from — deleting it would have
meant rebuilding it a task later. Only `readinessOf` (and `deriveWaves`, which it and
`validatePlanTasks` both call internally) had no consumer.

The constraint on promoting it is the authority model: **PM owns the Work Graph, the
orchestrator owns Runtime.** `plan.md` is an LLM-authored document. It can be stale, it can
omit a task, and it can disagree with the store. Letting it decide what may execute would
move a gate into the layer least able to hold one.

## Decision

**PROMOTE, as an advisory only.**

- `planReadinessAdvisory(planMd, taskId)` is added to `planGraph.ts`. It runs `readinessOf`
  over the module's plan and returns one operator-readable line when the plan does not
  consider the task startable — naming the unfinished dependencies and their statuses.
- `sta run` prints it when creating a task, then **runs the task anyway**. It sets no exit
  code, writes nothing to the store, and never throws: an unreadable plan is `--check-plan`'s
  problem to report, not a reason to stop a run that would otherwise work.
- It stays silent whenever the plan has nothing useful to say — no `--module`, no `plan.md`,
  an unparseable plan, a task id the plan never lists, or a ready row. Ad-hoc work that was
  never a plan row is the ordinary case, and warning on it would train the operator to ignore
  the line that matters.
- `taskRegistry.graph()` / `readyLayers()` are untouched. Those build a `TaskGraph` from
  **store-level** tasks — the whole pipeline of one task — not from `plan.md` rows. They are
  a different layer with a different input, and merging them would be the exact authority
  confusion this ADR exists to avoid.
- `parsePlanTasks` + `buildPlanGraph` stay where P6 already put them: `sta context --task`
  resolves the task's phase through `parsePlanTasks`, and the PROJECT_MANAGER handoff's
  `contract_refs.produces`/`consumes` come from `buildPlanGraph`.

**Separately, three genuinely dead production APIs were removed** from `TaskGraph`:
`edgesInto()`, `parallelLayersCapped()` and `topologicalOrder()`. Each had zero callers of
any kind — no production code, no other method in the class, no script, no document — only
their own tests. They were built for a concurrent scheduler that `taskRegistry.readyLayers()`
says in its own comment does not exist ("It does not run anything concurrently … needs
file-level locking (T35)"). The assertions those tests carried about edge *kinds* are really
assertions about `resolveEdges`, so they were kept and re-pointed at the public `edges` array.

## Consequences

- An operator who runs a task ahead of its dependencies is told, on the line before the
  pipeline prints. Nothing about what runs changed.
- `readinessOf` and `deriveWaves` now have a production path, so the plan graph is no longer
  a layer that only lints.
- **The advisory must stay an advisory.** Turning it into a refusal would put an
  LLM-authored document in charge of execution. If a real gate is ever wanted there, it
  belongs in the orchestrator's store against store state, not in `plan.md`.
- `--check-plan` and `sta --list` are unchanged; neither reads the new function.
- `TaskGraph` is three methods smaller. A future scheduler that wants capped layers or a
  topological order writes them then, against a caller that exists.
