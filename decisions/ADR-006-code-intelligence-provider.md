---
id: ADR-006
title: Graphify as an optional orchestrator-side Code Intelligence Provider — default OFF, fallback-first, machine-local cache
status: accepted
date: 2026-08-26
---

## Status
accepted · 2026-08-26

## Context

Graphify (PyPI `graphifyy`, pinned **v0.9.49** on this installation) can answer code-navigation
questions (relevant files, dependencies, dependents, paths, impact) from a prebuilt graph,
cheaply: on Target `sb-web-helper` @ `2b927dbd` it indexed 3,105 files in ~260s into a ~29MB
graph and answered queries in 1–2s at a measured **13.4× token reduction** vs reading the
corpus (evidence: `planning/v2/graphify-T-GR0-spike-results.md`).

The risks are equally real: the tool releases near-daily; its index ages silently (no TTL);
a stale graph that labels edges EXTRACTED can fool agents; and naive integration would touch
`.claude/settings.json`, hooks, or per-repo skills — surfaces whose drift the upgrade path
cannot reconcile.

## Decision

**1. The principle this feature exists under:**

> **Graphify discovers → Source confirms → Compiler checks → Tests verify.**

A graph result is discovery evidence, not implementation truth. Agents read real source before
editing (DEV), cross-check requirement/design docs plus source before conclusions (SA), and
verify source plus test results before any verdict (QA). The graph never decides pass/fail,
never routes workflows, never approves anything.

**2. Provider seam, orchestrator-side only.** `orchestrator/src/codeintel/provider.ts`
defines a Framework-owned interface (`isAvailable / getStatus / findRelevantCode /
getDependencies / getDependents / findPath / getImpact`) with DTOs that leak nothing from the
tool. `graphifyProvider.ts` is the single file allowed to know Graphify exists; transport is a
CLI subprocess (chosen from spike evidence — local, 1–2s/query; MCP stdio adds a process for no
gain). Version pinning lives in provider config; an untracked upgrade reads as "unavailable",
which falls back rather than changing behaviour mid-release.

**3. Every failure falls back; default OFF.** `resolver.ts` wraps all five query operations:
capability gate → freshness gate → scoped query → rank/top-N/dedupe → permission filter →
evidence block. Any failure (not installed, timeout, malformed, oversized, stale, missing,
empty) returns `{ used: false }` and the pipeline continues with plain search/read exactly as
before. With the feature disabled — the default — no provider is constructed at all, so
behaviour without Graphify installed is unchanged by construction.

**4. Capability matrix (rollout-level, contracts/\*.yaml untouched).**
system-analyst, backend-engineer, frontend-engineer, qa-engineer may use all five operations;
every other role is denied, and each denial writes an audit entry. Denial decides whether the
orchestrator *asks*; it never widens what comes back — see 5.

**5. No permission bypass (B6).** Returned candidates are filtered through the same floor as
every other read: the candidate's resolved path must sit inside an allowed workspace root and
must not match `UNIVERSAL_DENY` (.git, node_modules, .workflow, dist, knowledge/_roles).
Outside-root candidates are dropped before any prompt sees them.

**6. Freshness is enforced, never assumed.** Each index carries a metadata sidecar
(`provider / tool_version / target_id / target_revision / indexed_revision / indexed_at /
code_only`) next to the graph. Status is one of `fresh | stale | missing | error`; only fresh
may be queried. Stale means an older revision's index exists while HEAD moved on; refresh is a
human's explicit act (the orchestrator never builds on its own).

**7. Cache is machine-local (D-1).** Indexes live under
`%LOCALAPPDATA%\software-team-agents\cache\code-intelligence\<target-id>\<revision>\`
(XDG cache equivalent elsewhere; `STA_CODE_INTEL_CACHE_ROOT` overrides). Because the home is
outside every repository: nothing can be committed or bundled (`npm pack` verified clean),
no hook has to guard Bash-side writes, and `--check-layout` stays quiet. Prune supports
age-based retention and a total-size cap (oldest first); deleting an index is always safe —
it just reads as `missing`.

**8. Telemetry reuses the audit trail (B7-safe).** Events
`CODE_INTELLIGENCE_QUERY/HIT/FALLBACK/STALE/ERROR/DENIED/SOURCE_VERIFIED` render through
`sta audit <task-id>` like every other event. Payloads carry metadata only — counts, revisions,
reasons, at most a few file paths; never file contents or secrets.

## Setup / enable / disable

Nothing to install beyond `uv tool install graphifyy@<version>` on machines that opt in, plus
one explicit index build per target revision (human-initiated; ask-before-indexing is a hard
rule because indexing is heavy on low-RAM machines). Enabling is per-machine, env vars:
`STA_CODE_INTEL=on`, optionally `STA_CODE_INTEL_PIN=<version>` and `STA_CODE_INTEL_BIN=<path>`
(for machines where uv's tool bin dir is not on the spawning process's PATH); the run prompt
then gains the evidence block for allowed roles via `runtime/codeIntelAssembly.ts` — additive
by design, so any failure leaves the prompt byte-identical. Disabling is absence of the
variables; a checkout that is not a git repository resolves no revision and answers empty.
Rollout sequence: OFF → experimental opt-in → benchmark → SA/DEV/QA opt-in → default-on only
if metrics hold.

## Troubleshooting / fallback behaviour

| Symptom | Resolver result | Meaning |
|---|---|---|
| binary absent / wrong version | `not-installed` | install or fix pin |
| exit != 0 | `unavailable` | last stderr line kept in audit |
| timeout / byte cap | `timeout` / `oversized` | raise caps deliberately, not silently |
| HEAD moved past index | `stale` | rebuild explicitly (ask first) |
| no sidecar/graph | `missing-index` | index once |
| empty or fully filtered results | `empty-result` / `no-allowed-candidates` | normal search/read |

## Out of scope until metrics pass review

Contract/schema changes, hooks/settings edits, and any default-on rollout. **Local-only is
the agreed operating mode** (2026-08-26): `--code-only` AST indexing — the tool's LLM/semantic
mode is not used anywhere and no API key or network dependency exists in this integration.
Role wiring (Phase 4) is merged but stays OFF until the agent-level benchmark rounds run.

## Consequences

- Without Graphify, every workflow behaves exactly as before (verified by suite regression).
- The tool can be swapped or removed by touching one adapter file plus config.
- Index builds stay manual and user-approved; the orchestrator never spends machine resources
  on a rebuild by itself.
