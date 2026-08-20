# Policy — Agent boundaries (§6, §6a, §8)

Split from `.claude/shared/conventions.md` by T49. What no agent may decide for itself: whether
to invoke the next stage, in what order two engineers run, and when a stage is too heavy for the
work in front of it.

---

## 6. Handoffs

**No agent invokes the next agent.** This is structural, not just a rule: none of the ten agents has the `Agent` tool in its own toolset, so none of them can call another one even if it wanted to. Every run ends the same way — telling the user (or the session driving the pipeline) what was produced, what state it leaves the module in, and which agent should pick it up next — then stops. What differs between the two modes below is **who decides to make that next call**, not whether an agent is allowed to make it itself. It never is.

### Manual mode (the default)

The user reads each agent's report and decides, explicitly, whether and when to invoke the next stage. Never assume your own output was accepted, never act as if "and now QA runs on it" was decided for you, and never act on behalf of the user's decision about routing. This stays the default because it's the safest one — nothing moves without a person having seen it.

### Autonomous mode (opt-in, per run)

When the user explicitly asks for a continuous or unattended run — e.g. "รันข้ามคืนได้เลย", "เชื่อมต่อเนื่องไปเลยไม่ต้องถามทุกจุด", "let this run overnight" — the session orchestrating the pipeline (not the subagents themselves; see above, they still can't call each other) invokes each next stage itself as soon as the current one finishes cleanly, following the same routing table below, instead of waiting for the user to ask for every single stage by name.

This is opt-in per run, not a standing setting. Say it again next time you want it; a green light for one overnight run isn't a standing green light for every run after it.

**Exception, standing in every mode: `qa-engineer` and `security` are never auto-chained.** They only run when the user explicitly asks for them by name or by an equivalent request ("ตรวจงานหน่อย", "verify ให้หน่อย", "security review", ฯลฯ) — not automatically just because `frontend-engineer`/`backend-engineer` finished a phase, and not automatically just because a QA round finished on a sensitive module, even in autonomous mode. This is the opposite direction from the five points below (which are "pipeline drives itself, but stops here for a person"): here the pipeline never drives itself into these two stages at all — a person has to name them, every time. Once the user has explicitly asked for one, everything else about it (its own internal FULL/TARGETED gating, its own escalation rules) still applies unchanged.

**Five points always stop and wait for a real person, in both modes — autonomous mode does not remove them, it just means the pipeline drives itself up to them instead of a person driving it there:**

1. **`business-analyst`, any time it runs.** Whether it's the first interview on a blank project or a business-logic dead end routed to it mid-pipeline, its job is asking a human questions it cannot answer itself. There is no autonomous version of that — the run pauses here and picks back up once a person answers.
2. **`system-analyst`'s schema/feasibility confirmation.** `policies/architecture.md` §7 calls the Data Model a contract precisely because a person confirmed it — a schema nobody looked at is not a contract, it's a guess that everything downstream will treat as settled. This step waits for confirmation in both modes.
3. **`qa-engineer`, the moment a phase comes back ⚠️ Partial or ❌ Failed.** Autonomous mode may drive an automatic fix-and-reverify cycle back through the responsible engineer — but only up to the re-check ceiling already defined in `qa-engineer.md` (two rounds). Hitting that ceiling, or hitting a routing decision that needs `system-analyst`/`business-analyst`, stops the run and reports rather than continuing to loop. A phase where every task is ✅ Verified in a FULL round may continue automatically without a separate accept/reject prompt — see `qa-engineer.md` for exactly when that applies.
4. **`security`, any 🔴 Critical or 🟠 Important finding.** Accepting a security risk is a business decision, not an engineering one, and this pipeline doesn't make that call unattended. 🟡 Minor findings may be logged as deferred and the run continues past them.
5. **`devops`, the actual deploy or migration command, against any environment.** Generating a Dockerfile, a CI workflow, or a migration dry-run may proceed automatically; running it against something real never does — this is the same "confirm before a hard-to-reverse, outward-facing action" rule the top-level instructions already require, and autonomous mode doesn't waive it.

Outside those five, a stage that genuinely can't proceed without a human decision — `project-manager` hitting a sequencing ambiguity it can't resolve from `design.md`, `system-analyst` hitting an ambiguity mid-analysis — still stops, in either mode. That's not a mode setting; it's just an agent that has run out of things it can decide for itself.

The normal flow, and the loops back:

```
setup (once per project)
   ↓
business-analyst → system-analyst → project-manager → backend-engineer → frontend-engineer
                                                                    ↓
                                                              qa-engineer
                                                    ↓            ↓            ↓
                                         implementation bug   schema gap   business gap
                                                    ↓            ↓            ↓
                                      frontend/backend-engineer  system-analyst  business-analyst
                                                                    ↓
                                                  security (sensitive phases) → devops
```

---

## 6a. `backend-engineer` before `frontend-engineer`, never at the same time

A phase's `[frontend]` tasks are not an independent track from its `[backend]` tasks — the frontend reads its types and API calls off what the backend *actually built* (a route's real request/response shape), not off `design.md`'s Data Model alone, which describes storage, not wire format. Running both engineers at once on the same phase means `frontend-engineer` has nothing real to read yet and has to guess the contract. That guess is exactly what produced the `staff-roles/sync` response-shape mismatch in `hkt`'s `crm-ai-support` module (`created`/`reactivated`/`deactivated`/`unchanged` guessed by the frontend session while the backend session — running concurrently — actually shipped `processed`/`failed`) — caught only after the fact, and it cost a dedicated fix round on top of both engineer runs.

**Within a phase, always run `backend-engineer` to completion first, then `frontend-engineer`.** This applies in both manual and autonomous mode — it isn't one of the five points that stop for a person (§6 above), because it isn't a decision at all, it's an ordering rule like any other in this file: the pipeline (or the user) simply invokes them in that order instead of together.

The one exception: tasks in the same phase that share no API contract — a frontend-only styling task and an unrelated backend task — can run in either order or the same session, since there's no contract to guess at. The rule is about tasks that share a contract within one phase, not a blanket ban on touching both halves in one sitting.

---

## 8. Right-sizing the pipeline

The full chain exists for building something new. **Running all of it for a small change is waste, not diligence** — every stage costs a model run, and a two-line copy fix does not need a requirements interview.

Match the entry point to the size of the change:

| The work is | Start at | Skip |
|---|---|---|
| Copy/styling tweak, or a bug where the requirement and schema are already clear | `backend-engineer` (if it touches the API) → `frontend-engineer` → `qa-engineer` | `business-analyst`, `system-analyst`, `project-manager` |
| A change that adds or alters a field/table/relation | `system-analyst` (amend mode) → engineer → `qa-engineer` | `business-analyst`, `project-manager` |
| A change to business rules, but no schema impact | `business-analyst` (amend) → `system-analyst` (amend) → engineer → `qa-engineer` | `project-manager` |
| A new feature, module, or project | `business-analyst`, full chain | nothing |

`project-manager` is only needed when there's enough work to need phasing and ordering. One or two tasks don't need a plan — the user can hand them straight to an engineer.

**If you were invoked for work clearly below your stage's threshold, say so before doing it.** Tell the user which agent would handle it more cheaply and let them decide. Don't silently run a full interview or a full re-analysis for a one-line change — but don't refuse either; if they confirm, proceed.

The reverse is also a rule: **don't skip a stage that the change actually needs**. A schema change that bypasses `system-analyst` is exactly the failure this pipeline exists to prevent. Right-sizing means matching the entry point to the work, not cutting corners on work that needs the full chain.
