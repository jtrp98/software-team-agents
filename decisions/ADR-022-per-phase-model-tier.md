---
id: ADR-022
title: Per-phase model tier for implementation and QA, camp chosen at execution time
status: accepted
date: 2026-08-31
---

## Status

accepted — 2026-08-31

`REQ-17` justification gate: **3 of 5 questions answered.** Q3 (measurable reduction) is
recorded as a hypothesis with a measurement plan; Q4 (existing evidence) is answered "none".
The owner authorized proceeding on that basis. See § REQ-17 disclosure — this is a deliberate,
recorded exception, not a passed gate.

## Context

Three facts forced this decision.

**1. Subscription quota is consumed by the analysis stages, before implementation starts.**
`business-analyst`, `system-analyst` and `project-manager` run on the strongest model available
because a wrong schema or a wrong task graph is expensive across the entire pipeline. By the
time implementation begins, the same camp's quota may be gone. The plan those stages produced
is detailed enough that another camp's strongest model can carry the implementation — the two
models do not need to be equivalent, only adequate for work that has already been specified.

**2. Difficulty varies per phase; the existing binding is per role.**
`.sta/config.yaml`'s `routing.by_role` binds runtime and model to a *role*, and
`backend-engineer` is a single role that executes every implementation phase. A plan whose
Phase 2 rewrites a payments contract and whose Phase 5 adds a list endpoint receives identical
model treatment. `--runtime <id>` per invocation selects a camp but carries no statement about
the quality the work requires. **Neither mechanism can express per-phase difficulty**, and that
is the gap this record closes.

**3. `project-manager` already assesses difficulty and risk per phase and the assessment is
discarded.** It flags sensitive phases in writing (`contracts/project-manager.yaml`,
`flags_sensitive_phases`) and batches tasks by shared risk boundary
(`.claude/agents/project-manager.md`). That judgment never reaches model selection.

An earlier proposal (`planning/v4/newreq.md` R3/R4, analysed in `planning/v4/V4-ANALYSIS.md` §9)
was rejected because it wrote **runtime, model and fallback ordering** into `plan.md` — durable
environment state that goes stale the moment a subscription resets — and because it made an
agent responsible for maintaining a 120-field cross-vendor equivalence matrix with a test that
could only prove self-consistency. This record adopts neither of those.

## Decision

**A tier is the quality level a phase requires. A camp is where that level is obtained. The plan
states the tier; the operator chooses the camp at execution time.**

1. **Six tiers, meaning fixed, bindings human-owned.** A framework file maps each tier to a
   concrete model and effort per camp (Anthropic / OpenAI / Google / Z.ai). The tier *meaning*
   is stable and lives here; the *bindings* live in that file and are maintained by a person.

   | Tier | Means | Typical use |
   |---|---|---|
   | **T1** | max reasoning — **reserved, never cast in the pipeline** | a debug that is genuinely stuck; an architecture call |
   | **T2** | planning / security grade — **the ceiling a plan may cast** | SA, PM, security, catch-up |
   | **T3** | analysis grade | BA, test-planner, QA verify, risky backend work (🔒) |
   | **T4** | implementation, hard or risky | work touching a contract or several modules |
   | **T5** | implementation, light | straightforward single-task work, uxui, devops |
   | **T6** | fast / mechanical | setup, typo, lint fix |

   Cross-camp cells are **approximations, not equivalences.** The file asserts "this is the
   adequate choice in this camp for this level of work", never "these models are equal". No test
   asserts cross-camp parity, because no evidence supports one.

2. **The file is created once and owned by a person.** It carries no `verified_at` obligation,
   no per-release update duty, and no agent is responsible for refreshing it. A stale binding is
   the owner's to fix, the same way a stale `project.yaml` is.

3. **`project-manager` casts a tier per phase — not per task — and only for implementation and
   QA phases.** Analysis phases are not cast. A cast tier may be T2 through T6; **T1 is refused.**

4. **The camp is chosen when implementation starts, not when the plan is written.** `plan.md`
   contains no runtime, no model, and no fallback list. On starting a dev phase the operator
   either follows the plan's cast in the camp already configured, or names a different camp; the
   tier then resolves to that camp's cell for the same tier.

5. **Agent frontmatter remains the default.** `.claude/agents/*.md` keeps `model:` and `effort:`.
   They govern any run with no plan tier to apply — which includes every workflow that skips
   `project-manager` entirely (`workflows/bugfix.yml`, `workflows/typo.yml`). A plan tier
   overrides the frontmatter for the phases it covers; it does not replace the mechanism.

6. **Crossing camps on sensitive work is allowed and forces re-verification.** A 🔒 phase may run
   in a different camp than planned, but code produced after the switch does not inherit a
   `security` or `qa-engineer` pass from before it.

7. **Non-interactive runs never block on the camp question.** An explicit flag or configured camp
   always wins. The prompt appears only when a terminal is attached and no camp was specified.
   A headless run with neither uses the configured default.

8. **Validation is minimal.** `sta --check-plan` verifies only that a cast tier exists in the
   table and is not T1. It does not validate model names, camp availability, or cross-camp
   coverage — those are runtime facts, not plan facts.

## REQ-17 disclosure

| Question | Answer |
|---|---|
| 1 — real pain | **Answered.** Camp quota is exhausted by analysis stages before implementation begins; and one role executes phases of very different difficulty with one binding. |
| 2 — why existing components cannot | **Answered.** `routing.by_role` is per-role and `backend-engineer` spans all phases; `--runtime` selects a camp but states no quality requirement. Neither can express per-phase difficulty. |
| 3 — measurable reduction | **Hypothesis only.** Cost reduction is explicitly *not* the goal; appropriateness is. Stated as: a phase cast at its actual difficulty shows lower `retry_count` and fewer QA rounds than a phase cast wrong. Measurable from existing `RunRecord` fields after N phases. |
| 4 — existing evidence | **None.** No data supports question 3 today. |
| 5 — maintenance cost | **Answered.** One file, authored once, owned by a person, no refresh duty, no equivalence test, no `verified_at`. |

**Review trigger.** After 10 implementation phases have run under a cast tier, compare
`retry_count` and QA rounds for phases cast at each tier. If casting shows no relationship to
retries, this record is superseded rather than quietly retained.

## Consequences

**Easier.** A plan can say "this phase is hard" once and have it mean something at execution
time. Running out of quota in one camp stops being a dead end — the operator picks another camp
and the phase runs at the same intended level. Phases that are genuinely trivial stop consuming
the pipeline's most expensive model by default.

**Harder.** There is now one more thing a person owns and can get wrong: the tier table's
bindings. A wrong binding degrades work silently, because the system reports "T4 as requested"
regardless of whether that camp's T4 cell is actually adequate. That risk is accepted knowingly
and is the reason the table is human-owned rather than agent-maintained — a person who edits it
knows what they changed.

**Ruled out.** `plan.md` never carries a runtime, a model, or a fallback ordering — those remain
`resolveRuntimeRoute`'s and the operator's, resolved from live state. No agent maintains the tier
table. No test asserts cross-camp model parity. This record does **not** introduce automatic
quota-exhaustion fallback: camp switching here is a human decision made at phase start, which is
why it needs neither quota detection nor mid-run handoff (both still deferred —
`planning/v4/model-casting-TASKS.md` § D-R5). It also does not change the frontmatter values of
`business-analyst`, `system-analyst`, `project-manager` or `test-planner`; those remain deferred
pending evidence (§ D-R7 in the same file).
