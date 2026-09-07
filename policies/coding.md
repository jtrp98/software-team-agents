# Policy — Coding discipline (§5c, §9, §12, §19, §20)

Rules about how an engineer produces and
verifies code, and how any agent treats what it thinks it already knows.

---

## 5c. An engineer doesn't hand off red code

The dev↔QA round trip is the most expensive thing in this pipeline: a type error `qa-engineer` finds costs a full fresh-context QA run plus a full fresh-context engineer run to fix — and the round after that costs the same again. So `typecheck`/`lint` (plus this repo's two drift scripts) run **before an engineer is allowed to finish**, not after: `.claude/hooks/require-green-before-stop.js` blocks the finish while they're red on a run that touched application code. It forces at most one in-context fix attempt and can never trap you — the next attempt is let through regardless. **It's not a licence to improvise**: if a failure isn't yours to fix (a schema gap, a contract question you must not invent an answer to per `policies/architecture.md` §7), say so in your handoff instead of editing around it. Full reasoning — including why "did app code change?" stands in for agent identity — is in the hook's own comments. `build`/`test` stay with `qa-engineer`: too slow to pay for on every stop.

---

## 9. The stack is project-resolved and declared in configuration

The Target workspace's `.agent-team/config.yaml` `stack:` block is authoritative for its profile, package manager/tool, commands, schema paths, and source roots. Synchronization renders the compact `.claude/shared/stack.md` digest from that block. Any agent that needs to know the stack reads `.claude/shared/stack.md` (or `.agent-team/config.yaml` `stack:`) rather than assuming or inventing conventions.

Engineer prompts implement the resolved stack without choosing replacements. Changing the stack remains an explicit human configuration decision.

---

## 12. Verify against real state, not memory

A recalled fact — from an earlier turn in the same run, from a summary, from "I remember this project does X" — is a hypothesis, not a fact. Every agent (and whoever is driving the session) reads the actual current file, schema, or code before stating something as true or acting on it.

This matters more than it looks: a recollection is never automatically revalidated the way a file is. An error made once at recall time can silently outlive the file it was drawn from — the file gets edited, the wrong belief doesn't.

There's also no good reason to lean on recall in the first place: this pipeline already keeps its own memory, in files — `status.md` for where things stand, `plan.md`/`design.md`/`review.md` for what was decided and why, each with a `## Change Log` — updated with discipline (`policies/documentation.md` §4) precisely so nobody has to hold state in their head. An agent's own recollection is a worse copy of something the project already tracks properly; reach for the file, not the memory. This is the same discipline `policies/documentation.md` §2 already applies to `status.md` ("an index, not a truth" — the real docs win on disagreement) and the one every agent invokes when it says "don't work from memory" about the policy files themselves; it generalizes to any recalled fact, not just those two. Whenever a stated fact and the current file/code disagree, the file/code wins, and the stale belief is corrected on the spot rather than carried forward.

---

## 19. The senior habits a typed, green diff doesn't prove

None of the nine is hook-enforced today; review reads a diff for these. Database mechanics are `policies/data.md` §16 (isolation levels, migrations); accessibility implementation is `policies/ux.md` §17.

- **Transaction boundaries** — writes that must succeed or fail as a unit get an explicit transaction at the entry point; the half-applied pair is an incident in production, one edit here.
- **Idempotency** — anything that can run twice (a retry, a re-run) leaves the same state as one run; duplicate side effects are indistinguishable from real ones.
- **Concurrency** — before adding shared mutable state, name who else touches it and why interleaving is safe; found here a race is a lock, in production an incident.
- **Error semantics** — propagate what failed, at which boundary, with what input; a swallowed error resurfaces downstream as another agent's fresh-context diagnosis.
- **Observability and logging** — a path that can fail in production emits what a reader needs at its decision points; retrofitting sight costs a redeploy a question.
- **Performance budget** — a new query, loop or payload in a hot path is weighed against the operation's existing cost; an N+1 costs a profiling session plus a migration.
- **Backward compatibility** — what others already consume (an exported API, a schema, a contract) extends rather than breaks, or carries the migration; a break costs two round trips, not one.
- **Blast-radius awareness** — before anything destructive or wide (delete, migration, bulk update), state what it touches and how to undo it; the irreversible mistake is what §12's file-reading cannot recover.
- **No unnecessary abstraction** — the second concrete case earns the generalization; the first makes every future reader pay for it.

An architectural decision escalates to `system-analyst`, not settled in the edit — engineers have no `AskUserQuestion` by enforced design, so it lands in the handoff both prompts already mandate.

---

## 20. A repeated, deterministic check with a stable oracle leaves judgment

When the same call has been made by hand repeatedly, and the answer is mechanical — same inputs, same verdict, by a rule a script can state — promote it out of LLM judgment into a hook, a `.claude/scripts/` checker, a `--check-*` verb, or a `test-pyramid.yaml` row. All three conditions hold together: a repeated check with a shifting oracle is not promotable. Every promotion carries a recorded rationale and a test that exercises the checker (`policies/security.md` §5d — a guard that fails open has shipped here twice). Promotion removes a decision from judgment because the answer is mechanical; it never lowers what a round must verify because a mechanical check passed.

Never promotable: UX quality, ambiguous requirements, unknown failure modes, first-pass exploratory investigation, and `## Unverified Behaviour` — QA's honest declaration that with no test suite it *read* a rule rather than *executed* it.
