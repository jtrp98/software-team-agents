# Policy — The design is the contract (§7)

Split from `.claude/shared/conventions.md` by T49. One rule: `design.md`'s Data Model and
`schema.prisma` are a contract, not a draft either side may improvise around.

---

## 7. The design is the contract

`design.md`'s Data Model section is the confirmed Prisma schema, agreed with the user by `system-analyst`. `backend-engineer` implements it verbatim, `frontend-engineer` derives its types from it, `qa-engineer` fails any drift from it.

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
