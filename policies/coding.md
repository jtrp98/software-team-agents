# Policy — Coding discipline (§5c, §9, §12)

Split from `.claude/shared/conventions.md` by T49. Rules about how an engineer produces and
verifies code, and how any agent treats what it thinks it already knows.

---

## 5c. An engineer doesn't hand off red code

The dev↔QA round trip is the most expensive thing in this pipeline: a type error `qa-engineer` finds costs a full fresh-context QA run plus a full fresh-context engineer run to fix — and the round after that costs the same again. So `typecheck`/`lint` (plus this repo's two drift scripts) run **before an engineer is allowed to finish**, not after: `.claude/hooks/require-green-before-stop.js` blocks the finish while they're red on a run that touched application code. It forces at most one in-context fix attempt and can never trap you — the next attempt is let through regardless. **It's not a licence to improvise**: if a failure isn't yours to fix (a schema gap, a contract question you must not invent an answer to per `policies/architecture.md` §7), say so in your handoff instead of editing around it. Full reasoning — including why "did app code change?" stands in for agent identity — is in the hook's own comments. `build`/`test` stay with `qa-engineer`: too slow to pay for on every stop.

---

## 9. The stack is fixed and lives in two files

`.claude/agents/frontend-engineer.md` and `.claude/agents/backend-engineer.md` hold the authoritative "Fixed project stack" sections. Any agent that needs to know the stack **reads those files** rather than assuming — the user can change the stack, and those two files get updated in place when they do.

Only `frontend-engineer` and `backend-engineer` may edit their own stack sections, and only after the user explicitly confirms the change.

---

## 12. Verify against real state, not memory

A recalled fact — from an earlier turn in the same run, from a summary, from "I remember this project does X" — is a hypothesis, not a fact. Every agent (and whoever is driving the session) reads the actual current file, schema, or code before stating something as true or acting on it.

This matters more than it looks: a recollection is never automatically revalidated the way a file is. An error made once at recall time can silently outlive the file it was drawn from — the file gets edited, the wrong belief doesn't.

There's also no good reason to lean on recall in the first place: this pipeline already keeps its own memory, in files — `status.md` for where things stand, `plan.md`/`design.md`/`review.md` for what was decided and why, each with a `## Change Log` — updated with discipline (`policies/documentation.md` §4) precisely so nobody has to hold state in their head. An agent's own recollection is a worse copy of something the project already tracks properly; reach for the file, not the memory. This is the same discipline `policies/documentation.md` §2 already applies to `status.md` ("an index, not a truth" — the real docs win on disagreement) and the one every agent invokes when it says "don't work from memory" about the policy files themselves; it generalizes to any recalled fact, not just those two. Whenever a stated fact and the current file/code disagree, the file/code wins, and the stale belief is corrected on the spot rather than carried forward.
