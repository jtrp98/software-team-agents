---
id: ADR-025
title: End the V4 freeze for a fourth runtime and operator-level routing order; quota exhaustion falls back on UNAVAILABLE only
status: accepted
date: 2026-09-06
---

## Status

**accepted — 2026-09-06.** Drafted by `T-V6-009` (`planning/v6/V6-TASKS.md`); signed off by the
owner on the date above.

> **`T-V6-011` and `T-V6-014` may now start** — this record is the accepted ADR `ADR-023`'s freeze
> condition 3 required before either capability could begin.

`REQ-17` justification gate: **4 of 5 questions answered.** Q3 (measurable reduction) is again a
hypothesis with a measurement plan; Q4 (existing evidence) is answered for the defect half and
"none" for the capability half. See § REQ-17 disclosure — a recorded exception, not a passed gate.

## Context

Three facts, each verified against the repository rather than recalled.

**1. `ADR-023`'s V4 capability freeze is in force and has never been lifted.** Its condition 3
requires *"a later accepted ADR [that] explicitly states that this freeze has ended and names the
post-V4 scope it authorizes."* No such record exists — `ADR-024` is about `_docs` versus `knowledge`,
and states its own dependency on the freeze lifting (§ *"`ADR-023`'s feature freeze has lifted, since
incremental derivation is new capability"*). V6 needs two capabilities the freeze covers: a runtime
adapter, and a routing behaviour.

**2. `ADR-022` deferred automatic quota-exhaustion fallback by name, on a premise that has changed.**
Its Consequences section: *"This record does **not** introduce automatic quota-exhaustion fallback:
camp switching here is a human decision made at phase start, which is why it needs neither quota
detection nor mid-run handoff."* That was correct in August 2026, when there was no configured
ordering to consult and no fourth camp to reach. `routing.order` is that ordering, and it sits
exactly where `ADR-022` itself placed the decision: *"those remain `resolveRuntimeRoute`'s and the
operator's, resolved from live state."*

The operational need is `ADR-022`'s own context #1, unchanged: *"Subscription quota is consumed by
the analysis stages, before implementation starts… By the time implementation begins, the same camp's
quota may be gone."* The owner reports this as the daily failure mode: the quota runs out mid-work,
and the only options are to wait or to stop.

**3. A quota outage is currently misclassified, and the misclassification predates V6.**

```ts
// orchestrator/src/runtime/claudeCodeAdapter.ts:410-411
const cliFailed = proc.status !== 0 || cli.is_error === true;
return { status: cliFailed ? "ERROR" : "OK", … }
```

`claudeCodeAdapter` returns `UNAVAILABLE` on exactly two conditions — a spawn throw and `ENOENT`.
`codexAdapter` is the same. Only `openCodeAdapter` classifies provider refusals, via
`PROVIDER_FAILURE_PATTERN` (`openCodeAdapter.ts:70`). So a usage-limit response is recorded as a task
failure, which is precisely what `runtime/runtimeAdapter.ts` documents the split to prevent:
*"Collapsing it into a plain FAIL would spend the task's retry budget and could trigger recovery for
something the task did nothing to cause."*

**And one fact about what is being restored, not invented.** `routing.order` is a config key that
already exists and is deliberately dead: `packaging/staConfig.ts:69` declares
`INERT_ROUTING_KEYS = ["strategy", "order"]`. `T-V5-040` removed precedence level 3 on 2026-09-04 and
recorded why — *"levels 3 (`routing.strategy`/`routing.order` candidate ordering) and 5 … **had no
live caller** and are gone"*, because `.sta/config.yaml` *"exists in neither real repository."* It
was removed for absence of a caller, not for being wrong. The run-log fields survived the removal
(`observability/runLog.ts:37-41`: `routing_basis`, `fallback_reason`, `fallback_count`), written as
`null`/`0` on every run since.

## Decision

**The freeze ends for two named capabilities. A provider that will not serve is `UNAVAILABLE`, and
only `UNAVAILABLE` may move a stage to another camp.**

1. **`ADR-023`'s V4 capability freeze has ended.** The post-V4 scope it authorized is exactly two
   things, and nothing else is authorized by this record:
   - **a fourth runtime adapter, `antigravity`**, filling the `google` camp that
     `runtime/tierRouting.ts:7` has reserved since `ADR-022` and that no adapter has ever served;
   - **operator-level routing order** — reactivating `routing.order` at precedence level 4.

   `ADR-023` is **ended, not superseded**: its reasoning about unfalsifiable release gates stands, and
   its status stays `accepted`. A later capability proposal still needs its own record.

2. **`ADR-022`'s deferral of automatic quota-exhaustion fallback is lifted.** Camp switching may now
   be automatic, because there is a configured ordering to switch along. Everything else in
   `ADR-022` is unchanged — most importantly its ownership split (`project-manager` casts a tier; the
   operator chooses the camp) and its "Ruled out" section: **`plan.md` still carries no runtime, no
   model, and no fallback ordering.** The ordering lives in the operator's configuration, resolved
   from live state, which is where `ADR-022` said it belonged.

3. **`UNAVAILABLE` is the only trigger. `ERROR` never moves a stage.**

   | Status | Meaning | May fall back? |
   |---|---|---|
   | `UNAVAILABLE` | the runtime could not be used — binary missing, auth refused, **quota exhausted** | **yes** |
   | `ERROR` | the agent ran and the work failed | **no** |
   | `TIMEOUT` | the run exceeded its budget | no |

   Re-running an `ERROR` in another camp hides a defect instead of routing around an outage. This is
   a decision, not an implementation detail, so that a later refactor cannot widen it by accident.

4. **A camp switch inside a `🔒 Security gate` phase invalidates prior verification for that phase.**
   `ADR-022` #6 already says code produced after a switch *"does not inherit a `security` or
   `qa-engineer` pass from before it."* Restated here because automation changes who notices:
   when the switch is a human act at phase start, the human knows. When it is automatic, **the run
   log must record it and the invalidation must be written into `review.md`.** Automation must not
   launder a verdict.

5. **Quota classification must be observed, never guessed.** Each adapter's provider-refusal
   fingerprints come from a real recorded response. An adapter whose refusal response has not been
   observed is left unchanged and says so. A pattern that claims to recognise a rate limit it has
   never seen is the same overclaim `runtime/runtimeSupport.ts` exists to prevent, and an over-broad
   pattern is worse than today's bug: it would convert real defects into silent infrastructure blame.

6. **`fallback_on: error` is refused at configuration load.** Not ignored. An inert-looking key that
   silently does nothing is how `routing.order` became dead in the first place.

7. **Exhaustion is a stop, not a loop.** When every entry in the order is unavailable, the task stops
   with a reason naming each attempt.

8. **A stage that must ask a person a question skips a runtime that cannot.** `business-analyst`
   interviews a human; `RuntimeCapability.INTERACTIVE_PROMPTS` already states that a runtime without
   it *"cannot run that stage as designed."* Under an automatic order this becomes reachable, so it
   is enforced: BA skips such a runtime rather than running degraded. `system-analyst`,
   `project-manager` and `test-planner` are **not** excluded — their human gates are `sta approve`,
   not in-run prompts.

## What this record does not authorize

Named explicitly, because a lifted freeze invites scope.

- **Agent Orchestrator, in any form.** Not adopted (`V6-DECISIONS.md` D1).
- **Fallback ordering in `plan.md`.** `ADR-022`'s "Ruled out" stands.
- **Per-task tier casting or sub-phase execution rounds.** `ADR-022` #3 (per phase, never per task)
  is untouched; the `V5-EXECUTION-PROMPT.md` pattern remains a separate, evidence-first question.
- **Tier selection coupled to token budget.** No evidence supports it; `ADR-022`'s own 10-phase
  review trigger has not fired.
- **Mid-run handoff.** A hop starts a new run of a stage; it does not migrate one in flight. Still
  deferred, as `ADR-022` left it.
- **Any new agent, planner, graph layer, memory layer, or workflow abstraction.**
- **Raising `antigravity` above `experimental`** on anything but conformance evidence.

## REQ-17 disclosure

| Question | Answer |
|---|---|
| 1 — real pain | **Answered.** The owner's reported daily failure: one camp's quota is exhausted mid-work, and the session must either wait or stop. `ADR-022` context #1 predicted exactly this and deferred the fix. |
| 2 — why existing components cannot | **Answered.** `resolveRuntimeRoute` *"resolves at most ONE candidate … it never substitutes another runtime"* (`runtimeRouting.ts:24-26`); the `google` camp has no adapter, so `campForRuntime` can never return it; and quota exhaustion is classified `ERROR`, so nothing downstream could route around it even if a route existed. Three independent blocks, none configurable away. |
| 3 — measurable reduction | **Hypothesis, with a plan.** Cost reduction is not the goal; *continuity* is. Stated as: after N quota events, the count of stages that stopped for quota falls, and `fallback_count` accounts for the difference. Measurable from existing `RunRecord` fields — no new instrumentation. |
| 4 — existing evidence | **Split.** For the defect half (#3 of Context), the evidence is the code, quoted above, and it is unambiguous. For the capability half, **none** — no run has ever been recorded in either live workspace, and no tiered phase has executed. |
| 5 — maintenance cost | **Answered, and it is the honest weak point.** One adapter (~330–470 lines by precedent), plus three string unions that must stay in sync (`WorkspaceRuntime`, `RuntimeName`, `targetMeta`'s zod enum) and ~18 non-test touchpoints. The routing half adds no file: it reactivates a declared key and reuses run-log fields that already exist. |

**Review trigger.** After 10 recorded `UNAVAILABLE` hops, compare the stages that completed after a
hop against those that stopped. If hops do not correlate with completion — if a stage that hops
mostly fails anyway — the ordering is routing around the wrong thing and this record is superseded
rather than quietly retained. Same discipline as `ADR-022`'s own trigger.

## Consequences

**Easier.** Quota exhaustion stops being a dead end: the stage moves to the next camp in an order the
operator chose, at the quality level the plan cast, and the run log says where it went and why. The
`google` column of `model-tiers.yaml` — six tiers, reserved since August — becomes reachable. And
`--effort` on `agy` is the first place a cast tier's effort actually reaches a model; Claude Code has
no effort flag and records a diagnostic instead, so that column has been intent, not configuration.

**Harder.** Enforcement gets looser in one narrow place, and that trade is the reason this record
exists rather than a comment in a diff. `T-V5-040` gave up the handoff chain on an explicit
principle: *"Every one of them replaced a hop with a stop, so enforcement is strictly stricter, never
looser."* Restoring a hop reverses that for `UNAVAILABLE` alone. The containment is decisions 3, 6
and 7 — one trigger, a refused misconfiguration, and a stop at exhaustion — and if any of the three
is weakened later, this trade no longer holds.

There is also a new way to be wrong that did not exist before: **a quota-classification pattern that
matches too much.** A regex that swallows a genuine task failure turns a real defect into an
infrastructure excuse, silently, and the retry budget it protects is the thing that would otherwise
have surfaced it. Decision 5 is the guard, and it is a discipline rather than a mechanism — which is
stated here so that it is a known risk rather than a discovered one.

**Ruled out.** No agent maintains the runtime order. No quota is predicted, reserved, or budgeted
across camps. No stage migrates in flight. `plan.md` gains nothing. And nothing here weakens the
Target-write guard: a runtime that cannot enforce a pre-tool guard is still refused for those stages
by `runtime/runtimeExecutor.ts:531`, whether it was reached directly or by falling back.
