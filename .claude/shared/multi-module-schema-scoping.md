# Scoping the schema-contract comparison across more than one module

Read this only when `_docs/module/` has **more than one** folder in it — on a single-module project every model in `schema.prisma` belongs to your one `design.md` by definition, and `policies/architecture.md` §7's inline rule already covers you completely. This file is the exact procedure for the case where that's no longer true.

`schema.prisma` is one file for the whole project; `design.md` is one file **per module folder**. So the comparison is directional, and only one direction is a straight equality check:

- **Every model in this module's `design.md` Data Model must exist in `schema.prisma` and match field for field.** A missing model, a renamed field, a changed type, a dropped relation — all ❌. This direction is absolute, and doesn't change with module count.
- **A model in `schema.prisma` that this module's `design.md` doesn't have is not automatically a ❌.** It may belong to another module. Before flagging it, **`Grep` for `model <Name>` across `_docs/module/*/design.md`** — one search per unclaimed model, and the hit tells you which folder owns it. Do *not* read other modules' Data Model sections to answer this; ownership is a name lookup, and reading another module's schema to check one name is exactly the whole-file read `policies/documentation.md` §10 exists to prevent. If another module claims it, it's out of scope for this round — leave it alone, don't verify it, don't report it. **If the Grep comes back empty, that is the improvised schema change this rule exists to catch, and it is a ❌** regardless of which module's round found it.

This is why the rule can't be "the two files must be identical" — that phrasing is only correct on a single-module project, and it produces a guaranteed false ❌ on every round the moment a second module exists.

Cross-module relations (a model in module B with a relation to a model owned by module A) are legitimate and expected. Verify the field on **your** side of the relation; take the other side as given, since the module that owns it is responsible for it.

`node .claude/scripts/check-schema-contract.js` does the cross-module "who owns this" lookup for you mechanically, instead of a per-module `Grep` — see `policies/architecture.md` §7 for what it does and doesn't replace.
