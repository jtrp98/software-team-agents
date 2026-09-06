# Policy — Architecture (§7, §14, §15)

One rule: `design.md`'s Data Model and
`schema.prisma` are a contract, not a draft either side may improvise around.

## 7. The design is the contract

`design.md`'s Data Model section is the confirmed schema contract, agreed with the user by `system-analyst`. `backend-engineer` implements it verbatim using the Target-resolved stack and its declared `schema_paths`, `frontend-engineer` derives its types from it, and `qa-engineer` fails any drift from it. For a Prisma profile, `schema.prisma` is that stack's working copy; it is not a universal stack choice.

No agent invents, renames, or "improves" a field, type, or relation. If a task needs something the schema doesn't cover, stop and route it back to `system-analyst` — don't improvise a schema change and don't work around the gap.

**Once `setup` has written the real `schema.prisma`, that file is the contract's working copy** — `design.md`'s Data Model stays the authority, but the engineers work from `schema.prisma`, which is the file their queries and types actually have to agree with, and which they have open anyway. Reading both is reading the same contract twice.

That only holds because one agent keeps them equal: **`qa-engineer` reads both and compares them field by field**, and an unexplained divergence is a ❌ — a field in `schema.prisma` that no module's `design.md` accounts for is exactly the improvised schema change this rule exists to catch. **Every model in this module's `design.md` Data Model must exist in `schema.prisma` and match field for field** — a missing model, a renamed field, a changed type, a dropped relation, all ❌, and that direction is absolute regardless of module count.

**If `_docs/module/` has more than one folder**, a model in `schema.prisma` that *this* module's `design.md` doesn't declare isn't automatically a ❌ — it may belong to another module, and deciding that needs an ownership check before you flag it. Read `.claude/shared/multi-module-schema-scoping.md` for the exact procedure the moment you're in that situation; skip it entirely on a single-module project, where every model in `schema.prisma` belongs to your one `design.md` by definition and the rule above already covers you completely.

So:

- Before scaffold (`schema.prisma` doesn't exist yet): `setup`/`backend-engineer` read `design.md`'s Data Model. It's the only copy.
- After scaffold: engineers read `schema.prisma` for the models their task touches, and go to `design.md`'s Data Model only when they need the reasoning behind a field rather than its shape.
- `qa-engineer` always reads both, in full, for the phase it's verifying. It is the only agent that does, and that is deliberate — not a step to optimize away.

If `schema.prisma` and `design.md` disagree, **`design.md` wins and the code is wrong** — route it to `system-analyst` if the design turns out to be the thing that's wrong, never by editing `design.md` to match whatever got built.

**Only two agents ever write `schema.prisma`**: `setup` seeds it from `design.md`'s Data Model at scaffold time, and `backend-engineer` changes it afterwards — and only to bring it in line with a Data Model `system-analyst` has already amended and the user has already confirmed. A schema amendment isn't finished when `design.md` is saved; it lands when `backend-engineer` propagates it and `qa-engineer` confirms the two match again.

**`node .claude/scripts/check-schema-contract.js` does this comparison mechanically.** It parses every module's `design.md` Data Model and the real `schema.prisma`, diffs `model` blocks field by field, and reports unclaimed models (in `schema.prisma`, declared by no module) as the improvised-change ❌ this section describes — the cross-module "who owns this" lookup included, instead of a per-module `Grep`. It's not a hook and blocks nothing; it's a script `qa-engineer` runs via `Bash` as an aid to the manual comparison this section requires, not a replacement for reading the phase's actual models — it's a regex-based parser, not a real Prisma parser, and says so when something didn't parse.

---

## 14. Quality attributes a design must answer for

Every `design.md` answers for each attribute below in one of two ways: how the design addresses it, or one line recording that it does not apply to this design's scope. An attribute silently absent is not neutral — it is discovered later, by `qa-engineer`, by an operator, or by production, in that order of expense. A change that touches none of them (a label fix, a copy tweak) records that in one line and moves on; the rule is *answer it or scope it out*, never an essay per attribute.

- **Scalability, performance, throughput, latency:** what the design does under realistic and peak load, and where it degrades first.
- **Resilience, failure modes, graceful degradation:** what happens when a dependency fails — retry, fall back, or fail visibly, decided rather than discovered.
- **Observability:** how someone can tell, from outside the running system, what it is doing and why it broke.
- **Deployment topology:** where the components run, and what a deploy of this design touches.
- **Interoperability, extensibility, maintainability:** what the design does to the interfaces others build against, and to the cost of the next change.
- **Operational complexity and cost:** the standing burden of running, debugging and upgrading what is proposed.
- **Vendor lock-in:** what this design makes harder or impossible to move away from later.
- **Technical debt:** which trade-offs are accepted now — recorded as debt with a direction, not left implicit.

---

## 15. When a decision leaves design.md and becomes an ADR

A decision stays in its module's `design.md` while it is reversible — contained in the module, undone by editing the design and the code that implements it. It escalates to `decisions/` when it is irreversible, or when reversing it costs more than deciding it properly once. Concretely, escalate when:

- it binds more than one module or outlives the phase that made it — stack, cross-cutting architecture, permission model, the classes `decisions/` already records;
- undoing it later means migrating data, breaking consumers of an interface, or re-verifying work already verified;
- it reverses, ends or amends an earlier accepted ADR — as ADR-025 ended ADR-023's freeze, by its own named record rather than by silence.

An escalated decision uses the existing ADR shape — frontmatter `id`, `title`, `status`, `date` per `orchestrator/schemas/adr.schema.json`, checked by `--check-decisions` — and carries a **review trigger**, the pattern ADR-022 and ADR-025 both demonstrate: a measurable condition ("After 10 implementation phases have run under a cast tier…"), what will be compared when it fires, and the consequence — superseded rather than quietly retained. An agent drafts; a person accepts, and supplies the date (`policies/documentation.md` §3).
