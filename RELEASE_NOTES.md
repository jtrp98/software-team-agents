# Release Notes — software-team-agents v1.0.0-rc.2

> Product version `1.0.0-rc.2` (semver; follows `v1.0.0-rc.1`) · 2026-08-26
> This release closes the framework's internal **v2 improvement cycle** (`planning/v2/`) —
> "v2" there is a planning-generation label, not the product version.

## Highlights

**Command rendering chain (source-of-truth)**
`.claude/commands/*.md` is the single truth; opencode/codex surfaces are generated renderings,
rebuilt via `scripts/regenerate-renderings.mjs` ("already in sync" gate) — never hand-edited.
31 commands ship across all three runtimes; sync/verify covered by `--check-bindings`.

**uxui-designer Claude Design integration**
Figma/Claude-Design access is allowlist-based and fail-closed (`orchestrator/src/integration/claudeDesignMcp.ts`):
9 read tools; write tools only in explicit write mode; canvas output is a **draft** pending human sign-off.
Deferred with reason: T-CD5 two-directional smoke needs the `sb-compass` workspace (machine-local blocker).

**pm-improvements — Project Manager as execution planner (in-scope, D-V2R-4)**
PM now owns a validated work graph: `plan.md` tables parse into a task DAG with deterministic
validation of duplicate IDs, missing/self/duplicate dependencies, cycles, invalid owners/statuses,
DES traceability and wave ordering — plus derived waves and orchestrator-computed readiness.
New CLI flag `--check-plan [--module <name>]`, wired into CI.
Boundary locked in prompts/contracts across all three runtimes:
**PM = Work Graph · Graphify = Code Graph · Orchestrator = Runtime**.
Generated status files are no longer PM-writable (`contracts/project-manager.yaml`).

**Optional code-intelligence provider (ADR-006) — default OFF**
Graphify can be opted in per machine (`STA_CODE_INTEL=on`) as a discovery-only provider behind a
fallback-first resolver; without it every workflow behaves exactly as before (suite-proven).
Cache is machine-local outside every repo; nothing graph-related ships in the package beyond the
compiled provider module. Deferred rollout item: agent-level benchmark rounds + go/no-go opt-in
(human-run) before any default-on consideration — see `decisions/ADR-006`.

**New packaged surface: `prompt-update-knowledge.md`**
Knowledge-repo reconciliation playbook shipped in the package root (added to `files[]`),
cross-linked from `prompt-setup.md` ↔ `TEAM_SETUP_V1.md` #10; verified present and readable from
a fresh install by the packaged E2E (22/22 steps, Windows real-path/quoting coverage).

## New / changed flags

| Flag | Purpose |
|---|---|
| `sta --check-plan [--module <name>]` | validate every module's plan.md as a task DAG (new) |
| `sta --check-bindings` | covers all four mirror families (opencode commands, codex skills, agents, commands payload) |

CI runs 16 validation flags including `--check-plan`.

## Validation summary (tree @ `2647b48` + version bump)

- orchestrator suite: 2132 tests / 141 files · typecheck ✓ · build ✓
- hook/script self-test: 891 cases
- 16 validation flags exit 0
- templates snapshot rebuild byte-identical (97 files + manifest, framework_version `1.0.0-rc.2`)
- packaged distribution E2E: 22/22 steps on Windows (fresh install → configure → init → status →
  sync conflict/force → fail-closed launch surface), payload includes both prompt playbooks

## Deferred (explicit)

| Item | Reason |
|---|---|
| graphify agent-level benchmark rounds & default-on rollout | human-run sessions required (API cost, supervision) — ADR-006 rollout sequence |
| uxui T-CD5 two-directional smoke | requires `sb-compass` Target workspace cloned locally |
| `doctor` per-artifact mirror warnings | enhancement, not release-blocking |
| `prompt-update-knowledge.md` consistency test (`promptSetup.test.ts` analogue) | deferred-with-note; add before next edit of that file |

## Install

```bash
npm pack   # software-team-agents-1.0.0-rc.2.tgz
# then in a target project:
npm install -D <path>/software-team-agents-1.0.0-rc.2.tgz
```

No breaking changes to existing plan.md/knowledge layouts; plans without waves derive them
deterministically from declared dependencies.
