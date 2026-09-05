---
id: ADR-024
title: _docs is the authoritative knowledge system; knowledge/ stops mirroring it
status: accepted
date: 2026-09-04
---

## Status

accepted — 2026-09-04

Gates `T-V5-025`, `T-V5-027`, `T-V5-028` and `T-V5-041` in `planning/v5/V5-TASKS.md`.

## Context

Two knowledge systems coexist and neither is declared authoritative (`F-13`).
`knowledge/_sources/SRC-_docs-module-*.yaml` records `_docs/module/**` markdown as the
*source* of `knowledge/**` items, so the second layer is derived from the first — but
nothing re-derives it, and no document anywhere says which one wins when they disagree.

### Measured evidence

All numbers re-measured against `knowledge-schoolbright` at commit `133efe3`
(framework `dev/golf`, `1.0.0-rc.3`). Baselines were recorded at `5726885` in
`planning/v5/v5-baseline-evidence.md`; where the two differ, both are shown, because the
*movement between them* is itself the finding.

| Quantity | Command | Value |
|---|---|---|
| Committed files under `knowledge/` | `git ls-files knowledge` | 355 (3.4 MB) |
| Of those, real items | `git ls-files 'knowledge/*/*/*.yaml'` minus `_adoption/contracts` | 327 |
| Items whose `sources[].locator` points at `_docs/**` | `grep -h 'locator:'` over the same set | 318 |
| Items whose locator points at a **Framework** file (`CLAUDE.md`, `README.md`, `policies/*`) | same | 9 (this is `F-12`, removed by `T-V5-025`) |
| Items authored in place, with no file source | same | **0** |
| Registered sources whose digest no longer matches | `sta --check-knowledge --project-root C:\src\schoolbright-knowledge` | **14 of 21 (67%)** — was 12 of 21 (57%) two days earlier at `5726885` |
| Exit code of that check | same | **0** — staleness is emitted as a `note` |
| Share of the assembled BA prompt supplied by the store | `sta context business-analyst --module sb-compass --phase 1 --json` | `knowledge_chars` 2,583 of 228,994 = **1.13%** |
| Commits that ever wrote `knowledge/**` | `git log --oneline -- knowledge` | 5, of which 3 added every file (`ea80085`, `525e2e0`, `e6f502f` — the last is a `sta adopt` run) |

Two sources decayed between `5726885` (2026-09-02) and `133efe3` (2026-09-04) because two
ordinary `_docs` edits landed. That is the decay rate of a derived layer with no derivation:
measured, not predicted.

### Fidelity of the derived layer

`knowledge/sb-compass/architecture/DES-001.yaml` — an `approved` item owned by
`system-analyst` — carries as its `title` a truncated raw markdown table row
(`"| **DES-001** | REQ-001, REQ-002 | **ไม่ต้องทำ…"`) and, as `payload.risks`, a list of raw
table lines including the `|---|---|---|---|` separator. The derived record is larger than,
and less readable than, the markdown it was derived from.

### What `knowledge/` is besides the mirror

`knowledge/README.md` describes a store that is only partly a mirror. `_roles/` holds human
sign-offs and acknowledgements and is in `UNIVERSAL_DENY` precisely so no agent can forge
one; `_conflicts/` holds a person's decision between two contradicting facts; `_human-input/`
holds what a person supplied because no file could be read for it; `_sources/design/` holds
Figma/Claude Design exports a *person* placed for the `uxui-designer` lane; and
`contracts/uxui-designer.yaml:34` grants that lane a live authoring path at
`knowledge/*/ux-design/**`. None of those records anything that `_docs/**` also holds, and
none of them is derived from anything.

## Decision

**`_docs/**` is the single authoritative knowledge system. Where `_docs/**` and
`knowledge/**` disagree about a fact, `_docs/**` is right.**

`knowledge/**` stops being a derived mirror of `_docs/**`. Specifically:

1. **The derivation pipeline is retired.** The adoption importer, the `sta adopt` verb, and
   the `SRC-*` / digest-freshness machinery *as a governance signal over `_docs` and
   Framework files* stop being live subsystems (`T-V5-041`).
2. **Framework-authored files are never ingested again.** The importer refuses paths that
   `threeRepo/ownership.ts` classifies as Framework-owned, so the nine `DES-RULES-*` items
   cannot be recreated (`T-V5-025`).
3. **The store itself is kept**, for the records above that `_docs` cannot hold: `_roles/`,
   `_conflicts/`, `_human-input/`, `_sources/design/`, and the `uxui-designer` `UX-*` lane.
   `--check-knowledge` continues to validate it.
4. **No fact is sourced from a derived item.** An agent that needs a requirement, design
   decision, task or rule reads `_docs/module/<name>/**`. The knowledge brief remains a
   bounded navigation aid, never the substance.

This is option **(a)** of `T-V5-024`, taken in the narrow form the rest of the V5 plan
already assumes: `T-V5-041`'s own verification requires `--check-knowledge` to keep working,
and `T-V5-026`'s acceptance forbids removing authored `knowledge/<module>/**`. A literal
reading of "retire `knowledge/**`" would delete the `_roles/` sign-off gate, which V5 may not
do — no V5 change may weaken a safety guarantee. `planning/v5/V5-TASKS.md` was amended to
say this precisely; the amendment is recorded in `planning/v5/v5-4a-evidence.md`.

### The four conditions option (b) requires, each accepted or rejected

The audit document is not in this repository; the conditions below are the ones `F-13`'s
summary in `T-V5-024` states, plus `F-13`'s own headline gap, each re-verified against the
code before being ruled on.

**B1 — Incremental re-derivation on every `_docs` write. REJECTED.**
Verified unmet: the only writers of `knowledge/<module>/**` are `sta adopt`
(`orchestrator/src/adoption/adoptionRunner.ts`, a bulk one-shot) and the `uxui-designer`
contract lane. `sta knowledge` offers `get`, `migrate-v2` and `reconcile` only
(`orchestrator/src/cli/verbs/knowledge.ts:26`); no path re-derives an item when its source
document changes. Meeting it means building a derivation service — new framework capability,
excluded by `ADR-023`'s freeze and by V5's non-goals. Rejected.

**B2 — Staleness fails rather than notes. Finding accepted; the fix REJECTED as a (b) gate.**
Verified unmet: `orchestrator/src/knowledge/knowledgeBase.ts:497` pushes `cross.staleSources`
into `notes`, so `--check-knowledge` reports 14 stale sources and exits 0. The finding is
accepted as true and is not disputed. Promoting it to a failure is nonetheless rejected here,
because a failing gate over a layer that nothing maintains (B1) fails permanently for a
reason no one has scheduled. `T-V5-028` is therefore closed as **superseded** by this ADR and
`T-V5-041` — not silently dropped.

**B3 — Retrieval moves onto items. REJECTED.**
Verified unmet: `orchestrator/src/runtime/knowledgeBriefAssembly.ts` renders a bounded
≤16,384-byte index *beside* the sliced documents; the documents carry the substance
(226,411 doc chars against 2,583 knowledge chars for one BA stage). Moving retrieval onto
items requires items to carry document-grade content, and the measured fidelity is the
opposite of that (see `DES-001` above). Rejected.

**B4 — A stated rule for which layer is authoritative. ACCEPTED.**
Verified unmet: `grep -rn 'authoritative' policies/ CLAUDE.md docs/` returns four hits, none
about `_docs` versus `knowledge`. This is the one condition V5 both can and must meet, and
**this ADR is the discharge of it.**

Three of four conditions are rejected as out of V5's scope and beyond what the evidence
justifies building. The fourth is met here. Option (b) is therefore not chosen — and,
per V5's rule against half-finished transitions, nothing is built toward it.

### Fate of the existing `knowledge/**` content

| Content | Count | Fate | Who acts |
|---|---|---|---|
| `_project/architecture/DES-RULES-*` (Framework `CLAUDE.md` + 7 `policies/*`) | 8 | **Deleted** — Framework rules duplicated into a project graph, attributed to `system-analyst`, already divergent | `T-V5-025` |
| `_project/architecture/DES-DOC-README.yaml` | 1 | **Inspect its source first**; deleted only if it is the Framework `README.md` | `T-V5-025` |
| `_sources/SRC-CLAUDE.md`, `SRC-README.md`, `SRC-policies-*` | 9 | **Deleted** with the items above | `T-V5-025` |
| `_adoption/` (`MANIFEST.yaml`, `STATE.yaml`, 5 contracts) | 7 | **Removed** after the importer goes; `MANIFEST.yaml` preserved outside the repository if the record is wanted | `T-V5-026`, `T-V5-041` |
| Module items under `knowledge/<module>/<kind>/` | 318 | **Frozen, not deleted by V5.** They stop being regenerated and stop being authoritative for any fact. Their removal is a `knowledge-schoolbright` backlog item that a named BA/SA carries out | Knowledge-repo team, not V5 |
| `_sources/SRC-_docs-module-*` | 12 | Frozen with the items they back; removed together with them | Knowledge-repo team |
| `_roles/`, `_conflicts/`, `_human-input/`, `_sources/design/`, `UX-*` items | 0 present in `knowledge-schoolbright` today | **Kept**, and the mechanisms stay supported | — |

**Nothing authored by a person is deleted without a person reviewing it.** The 327 items in
`knowledge-schoolbright` were all machine-derived — every one carries a file `source`, none
was authored in place, and all were introduced by three generated commits — but that is
evidence for a reviewer, not a substitute for one. The 318 module items are therefore frozen
in place by V5 and removed only by a Knowledge-repo change that a person makes and reviews.
`T-V5-026`'s acceptance criterion already states that nothing under `_docs/**` or authored
`knowledge/<module>/**` is removed.

## Consequences

**Easier.** There is one place to look for a fact and one answer to "where does this belong":
`_docs/module/<name>/**`, resolved by `sta context`. The largest measured cost in the system —
document size — is governed where the documents actually are (`T-V5-033`, `T-V5-034`,
`T-V5-027`), instead of by a second store holding 1.1% of the prompt. Roughly 4,700 lines of
adoption code and its tests stop being maintained (`T-V5-041`), and "adoption / source digest /
freshness verdict" stops being a concept a user has to learn.

**Harder.** The one-time legacy import is no longer repeatable: `knowledge-schoolbright`
commit `e6f502f` was produced by `sta adopt`, and removing the verb removes the ability to
redo it. **This ADR accepts that explicitly.** A project adopted in future imports its
documents into `_docs/**` by hand or not at all.

**Ruled out.** Cross-kind querying over items ("which tasks implement the API this
requirement needs") is not available for content that lives only in `_docs`. That capability
was never load-bearing — it supplied 1.1% of an assembled prompt — and rebuilding it is a
project, not a cleanup.

**Residue, stated rather than hidden.** Until the Knowledge-repo team removes the frozen
items, `--check-knowledge` keeps reporting stale sources as notes, and the knowledge brief
keeps injecting ~2,583 characters of frozen material marked with its freshness verdict. The
verdict is truthful — it says the material moved — so the residue is visible, bounded, and
owned. `F-03`'s *decay* is closed the moment derivation stops; the *existing* stale records
are closed by the team's cleanup, tracked from `T-V5-045`'s evidence.

## Revisiting this decision

Reopen it when **all** of the following are true, not before:

1. A concrete use case exists that `_docs/**` plus `sta context` demonstrably cannot serve —
   named, with the query it needs and the run that failed without it.
2. The knowledge brief's measured share of an assembled prompt exceeds 10% for a real stage,
   which would mean items had become substance rather than an index.
3. `ADR-023`'s feature freeze has lifted, since incremental derivation is new capability.

Absent all three, an agent implements this decision and does not re-ask.
