---
id: ADR-027
title: Graph provider selection for D-V8-04 (Graphify vs GitNexus vs none) — Graphify accepted on preliminary evidence
status: accepted
date: 2026-09-11
---

## Status

**accepted · 2026-09-11 · decided by: dev.** Option A ("Graphify, on this preliminary evidence")
was selected by the human owner directly in chat and transcribed here verbatim — see "Decision"
below. This closes D-V8-04 on the informal single-task evidence described in this record, not on
a completed T-V8-024 spike; the caveats in "Recommendation" below still apply and were not
withdrawn by this decision.

## Context

D-V8-04 (`V8-TASKS.md:53`) is the last unresolved V8 architecture decision: whether V8 ships with
Graphify, GitNexus, or no graph-backed code-intelligence provider. `T-V8-024` was supposed to
supply the evidence via a controlled, blinded, oracle-scored three-arm spike (native search/LSP,
Graphify, GitNexus) on identical SA/DEV/QA tasks (`V8-TASKS.md:1105-1143`).

**That formal spike did not run.** Round 15 (`planning/v8/evidence/round-15.md`) recorded three
missing human-owned prerequisites: GitNexus was not installed and this agent would not install a
previously-unused third-party tool itself; neither candidate repository (`sb-web-student`,
`sb-web-helper`) was a disposable clone at a pinned revision — both were live, dirty, user-owned
checkouts; and no paid live-agent run had ever been authorized against the corpus (`paidRuns: 0`).
All seven of T-V8-024's checklist sub-criteria are still unchecked for that reason.

**Since Round 15, two of those three prerequisites changed, informally:**

1. The user installed GitNexus themselves (`npx gitnexus --version` → `1.6.11`, confirmed
   independently in-session).
2. At the user's direction, a single illustrative task was run against a disposable clone of
   `sb-web-student` (`C:\tmp\v8-spike\sb-web-student-spike`, HEAD `82757d0`, not pinned to any
   `corpus.json` `sourceRevision`) — one hand-picked bug-fix prompt, one query per tool, no
   repeats, no blinded scoring, no oracle/QA-defect measurement, no paid DEV/QA agent run. Results
   are published at `https://claude.ai/code/artifact/d59d8450-d9a0-4020-a411-87275013ba63`
   ("Signal vs Sweep").

**This is evidence, but it is explicitly not T-V8-024's evidence.** None of T-V8-024's acceptance
criteria are met: no identical-task paired arms with repeats, no blinded adjudication, no oracle
pass/fail, no seeded-defect QA detection, no held-out split. The paragraph below is a recommendation
built on a single-task discovery-quality signal, not the release-grade comparison D-V8-04 was meant
to rest on.

### What the informal demo showed (one task: "truncate GPA instead of rounding it")

| | Native grep | Graphify `query` | GitNexus `query` |
|---|---|---|---|
| Found the right lines (`Grade.cs:383,388`)? | only after manually narrowing keywords | yes, ranked first | yes, but not ranked first |
| Precision of what came back | 5 of 13 matched files relevant | 4 of 4 returned nodes relevant | 6 of 20 returned definitions relevant |
| Top-ranked results on-topic? | no ranking | yes | no — top 3 "flows" all off-topic |
| One-time index cost (138 files) | none | ~40s, no LLM | 98.3s, no LLM |
| Index size | — | 3,465 nodes / 7,473 edges | 6,834 nodes / 18,170 edges |

Caveat on the GitNexus row: only its generic `query` command was tried (no `--embeddings`); its
more targeted commands (`context`, `trace`, `impact`) were not tested and may rank differently.

## Options

**Option A — Graphify**, behind the existing thin provider (`ADR-006`, already `accepted` and
already integrated as opt-in/default-OFF). Already installed and version-matched here (`0.9.49`,
matching `graphifyProvider.ts`'s pin). Cheaper to index in this one sample; came back clean with no
observed noise.

**Option B — GitNexus**, would need a new provider adapter (nothing in
`orchestrator/src/codeintel/` reads its CLI/JSON today). It answered the same question correctly
but noisily under default settings in this one sample; unclear whether its more targeted commands
close that gap, and it costs more to index.

**Option C — no graph provider**, native search/LSP only (`NativeSearchProvider` +
`createFallbackChainProvider`, already shipped in T-V8-023 as the always-available fallback
regardless of this decision).

## Recommendation (non-binding — a person decides)

**Option A, conditionally.** On the one task tried, Graphify returned only relevant results with no
manual filtering, at lower index cost, and it is already the accepted, integrated, opt-in provider
per `ADR-006` — choosing it changes nothing about production wiring. GitNexus found the same answer
but requires a person to filter noise and separately rank-sort it themselves before trusting it, at
least under the untuned settings tried here.

This recommendation should **not** be read as satisfying D-V8-04's evidence bar. The honest options
for the human decision below are: (1) accept Option A on this preliminary evidence and treat a full
T-V8-024 spike as optional going forward, (2) accept Option A provisionally and still require the
full spike before any default-on rollout step in `ADR-006`'s "Rollout sequence," or (3) require the
full spike before deciding at all, and leave `D-V8-04` **BLOCKED** exactly as `V8-TASKS.md:56`
currently states.

## Decision

- [x] Option A — Graphify, on this preliminary evidence
- [ ] Option A — Graphify, provisional pending the full T-V8-024 spike before default-on
- [ ] Option B — GitNexus
- [ ] Option C — no graph provider
- [ ] Require the full T-V8-024 spike before deciding; `D-V8-04` stays BLOCKED

Decided by: dev  Date: 11/09/2026

## Consequences (of Option A, if chosen)

- No new production code: Graphify is already the sole graph provider `codeIntelAssembly.ts`
  constructs (T-V8-023's fallback chain tries it first, then native search).
- `T-V8-026` ("integrate the selected retrieval path and delete losing provider code") would have
  nothing to delete for GitNexus, since no GitNexus provider was ever built.
- If GitNexus is later revisited, `ADR-006`'s existing seam (`provider.ts`/`resolver.ts`) is the
  place a new adapter would go — no architecture change is implied by choosing Graphify now.

## Production path, roles, fallback, assumptions, maintenance, reconsideration

- **Production path:** unchanged from `ADR-006` — `runtime/codeIntelAssembly.ts` constructs
  `createFallbackChainProvider([GraphifyProvider, NativeSearchProvider])`; Graphify is tried first,
  behind `STA_CODE_INTEL=on` (default OFF).
- **Roles benefiting:** system-analyst, backend-engineer, frontend-engineer, qa-engineer (per
  `ADR-006`'s capability matrix — unchanged by this decision).
- **Fallback:** `NativeSearchProvider` (T-V8-023) on any `missing`/throw status; `stale`/`error`
  remain a hard stop, not a silent fall-through, per `freshness.ts`'s existing policy.
- **Assumptions carried from this decision:** it rests on one hand-picked task's discovery-quality
  signal (see "Context"), not a completed oracle/QA-scored spike. It does not establish that
  Graphify improves DEV/QA correctness or reduces escaped defects — only that its candidate list
  was more precise than GitNexus's default `query` and native grep on that one task.
- **Maintenance owner:** system-analyst (owns the codeintel provider seam per the Roles table in
  `CLAUDE.md`); version pin/upgrades tracked in `graphifyProvider.ts` config per `ADR-006` §2.
- **Reconsideration trigger:** re-open this decision if (a) a completed T-V8-024 spike later shows
  Graphify failing its predeclared recall/QA-detection threshold, (b) Graphify's upstream CLI moves
  past the pinned `v0.9.49` output shape and breaks the adapter, or (c) GitNexus's targeted commands
  (`context`/`trace`/`impact`, untested here) are evaluated and outperform Graphify on a real task
  set — any of these reopens D-V8-04 rather than silently overriding this ADR.

## Addendum — T-V8-026 benchmark-replay criterion waived (2026-09-11)

`T-V8-026`'s acceptance criteria require "the selected integration meets the T-V8-024 outcome
threshold in a replay." Round 17 (`planning/v8/evidence/round-17.md`) confirmed this replay cannot
run: no threshold was ever predeclared or measured, because T-V8-024's formal spike never ran (see
"Context" above — Round 15 stayed blocked; the informal demo that followed does not supply a
threshold either).

Presented with exactly that choice — run the full T-V8-024 spike first, or waive T-V8-026's
replay criterion and accept this ADR's preliminary evidence as sufficient — the human owner chose
directly in this session:

- [x] Waive T-V8-026's "meets the T-V8-024 outcome threshold in a replay" criterion; accept this
      ADR's preliminary evidence as sufficient to close T-V8-026.
- [ ] Run the full T-V8-024 spike before T-V8-026 can close.

Decided by: dev  Date: 11/09/2026

This addendum resolves only T-V8-026's replay requirement. It does not reopen, widen, or change the
Option A provider selection above, and it does not retroactively claim T-V8-024's acceptance criteria
are met — the "Assumptions carried" and "Reconsideration trigger" text above stands unchanged and
still governs when this whole decision should be revisited.
