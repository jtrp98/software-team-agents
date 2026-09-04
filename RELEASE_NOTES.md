# Release Notes

## Unreleased — V5 (simplification release, in progress)

V5 adds no features. It closes half-finished transitions and makes existing enforcement honest.
Behaviour changes users will feel are listed here as each task lands.

### Breaking changes

- **Guard coverage is now a launch requirement for every runtime** (`T-V5-008`, audit finding `F-05`).
  Until now, `status` printed `Codex: READY` after counting `.codex/agents/*.toml` with no guard check
  of any kind, and `dev`/`ba` preflight inspected guard wiring only when the launching runtime was
  Claude. `software-team-agents ba --runtime codex` therefore started a session with none of the six
  guards active.

  **What changes:** every runtime now gets one guard verdict, consulted by both readiness and
  preflight.
  - `codex` has no guard mechanism — the payload ships no Codex hook wiring and Codex's hook loading
    has never been verified on a real install — so it reports `NOT READY — UNGUARDED` and **launches
    that succeed today now stop**.
  - `opencode` reports its coverage as *partial* and names both halves: `.opencode/plugin/sta-guards.js`
    enforces `block-outside-repo` and `block-path-permissions`, each binding's permission block
    enforces `block-git`; `block-doc-rewrite`, `block-secret-leak` and `require-green-before-stop`
    have no OpenCode mechanism and do not run. A workspace missing the plugin is `unguarded` and
    stops, because OpenCode's default posture is allow-all.
  - `claude` behaviour is unchanged: the same registrations are required and the same messages are
    printed.

  **How to proceed deliberately:** `software-team-agents dev|ba --runtime <name> --allow-unguarded-runtime`
  launches an unguarded session on purpose; the launch line records it as
  `[UNGUARDED SESSION — acknowledged]`. The flag never applies to a *broken* Claude guard wiring —
  a missing or unregistered hook stays a hard failure with or without it.

  Building a Codex guard mechanism is deliberately out of V5's scope (`ADR-023` feature freeze).

### Update and status

- **`software-team-agents status` now derives freshness from the on-disk sync plan** (`T-V5-011`,
  audit finding `F-02`). Workspaces whose Framework version string matches but whose managed payload
  is stale now report `OUTDATED` and name the pending managed paths. A cross-major mismatch remains
  `INCOMPATIBLE` and takes precedence over ordinary drift. `status` remains read-only.
- `status` and `doctor` show the managed paths that `sync` would change and the repair command.
  When `ba` or `dev` auto-syncs before launch, its preflight line now announces the paths it wrote;
  `--no-auto-sync` stops with the same path list instead of a generic outdated message (`T-V5-012`).
- `sta list-backups` and `sta rollback` now use the `.agent-team/backups/` snapshots written by the
  live sync lifecycle. New snapshots pair changed files with the pre-sync manifest; rollback restores
  both while leaving `.agent-team/config.yaml` and its overrides untouched. Legacy `.sta/` snapshots
  remain readable during the transition, and `sta upgrade` aliases the live sync path for an
  `.agent-team` workspace (`T-V5-013`).
- Template and workspace manifests now carry an optional payload digest derived from their existing
  file hashes. This lets `status` identify two Framework checkouts that share a version string but
  ship different bytes. A pre-V5 workspace without the field remains valid and reports the digest as
  unknown until its next sync; absence is never treated as a mismatch (`T-V5-015`).
- Synced `policies/` remains present on disk and continues to power `sta policy`, but new workspaces
  list it in the managed `.gitignore` block because the Framework repository owns those files.
  **Ignoring does not untrack files already committed:** existing repositories keep their committed
  copies until a person runs `git rm -r --cached policies/` and commits that version-control change.
  Sync itself never runs git and never removes the working copies (`T-V5-016`).

### Distribution

- **The real install channel is documented as what it is: `npm link` onto a Framework checkout**
  (`T-V5-030`, audit finding `F-23`). There has never been a published `.tgz` release — `npm run
  release` produces a packing *script's* output, not a distributed artifact — and the README/
  `TEAM_SETUP_V1.md` named a version (`1.0.0-rc.1.tgz`) that never shipped. Getting Started now leads
  with `npm link`; the `.tgz` path stays documented as the route for someone who has not cloned the
  Framework, produced by `npm run release` on demand.
- **`software-team-agents --version` now reports the payload digest alongside the version string**
  (`<version>+<digest12>`, e.g. `1.0.0-rc.3+3f9a1c2b7e4d`), so two Framework checkouts on the same
  linked-checkout channel — and therefore the same version string — are distinguishable the moment
  their payload differs. `--version`'s regex shape (`\d+\.\d+\.\d+…`) is unchanged; the digest is
  semver build metadata appended, not a restructured string, and ordinary version comparisons
  (`sameMajor`, `classifySyncState`) ignore it exactly as they ignore any other build-metadata suffix.

## Internal V1 Stable

**Internal V1 Stable = P0 → P1 → P2 → P3 → P4 each executed and reported,
with the release gate green.** It is not a claim that P3 produced a favourable
result. A benchmark showing that the harness does not help in some or all
categories still satisfies the milestone, and that negative result is valid,
publishable evidence.

## software-team-agents v1.0.0-rc.3

> Product version `1.0.0-rc.3` (semver; follows `v1.0.0-rc.2`) · 2026-08-28
> This release closes the framework's internal **V3 architecture cycle** (`planning/v3/`) —
> "V3" there is a planning-generation label, not the product version. It stays an `rc` on purpose:
> only `claude-code` is `supported`; `codex` is `preview` and `opencode`/`paid-api` are
> `experimental`, and automatic routing to any of them still requires explicit consent.

V3 is additive and preserves pre-V3 behavior when its optional configuration is absent: `sta run`
uses Single mode on `claude-code`, deterministic verification remains enabled, test-pyramid
enforcement remains warning-only, QA `skip` is not exposed to production CLI/config, and
`execution.allow_paid_fallback` resolves to `false`.

### Runner and routing behavior

- `sta run --mode <single|auto|manual>` is the new orchestrated execution selector.
  `--runtime <claude-code|codex|opencode|paid-api>` still exists; used alone, it means Single.
- `sta context <role> --task <id> --packet [--json]` reads the latest validated V3 execution
  packet from Local Runtime State.
- Auto is opt-in and hands off only after `UNAVAILABLE`, never after `ERROR` or `TIMEOUT`. Preview
  and Experimental runners require explicit `routing.allow_below_supported` consent for automatic
  routing.
- Manual requires a per-role runner and model in `routing.by_role` (legacy `model_routing` remains
  readable). There is no user-facing `--model` flag.
- Paid API is Experimental, has no bundled credential lookup, requires an injected official
  transport, is refused for Target writes without the required guard capability, and is unreachable
  until `execution.allow_paid_fallback: true`. If no eligible runner remains, execution stops for a
  person with the recorded reason.

### Ownership and upgrades

- Three-Repo now names four ownership domains: Framework, Knowledge, Target, and Local Runtime
  State. `.workflow/packets/`, `.workflow/evidence/`, `.workflow/runs/`, and the task DB are local,
  regenerable, gitignored state; runtime artifacts never become Knowledge-owned.
- Existing `.agent-team/config.yaml` and `.sta/config.yaml` files remain valid. V3 defaults resolve
  in memory and upgrade does not insert behavior-changing config.
- The packed migration fixtures prove existing Knowledge unchanged, existing Target sync with
  overrides preserved, fresh init/bind/sync/status, and legacy upgrade with DB v11 → v13+, same-stage
  resume, and byte-identical rollback of upgrade-owned files. Runtime DB migration is forward-only;
  `sta rollback` restores managed install files/manifest, not the DB.

Deferred V3.1 ideas such as dynamic optimization, quota/usage-aware routing, parallel agents,
provider benchmarking, and adaptive QA are not implemented or documented as available.

### Validation summary (V3 release gate, 2026-08-28)

- `npm run release:check` → exit 0, `RELEASABLE — all 30 steps passed`; transcript archived at
  `release/evidence/v3-release-gate-2026-08-28.log`
- orchestrator suite: 2,493 tests / 169 files (1 skipped) · typecheck ✓ · build ✓
- hook/script self-test: 900/900 cases · 16 `--check-*` validation flags exit 0
- three new named V3 property gates (T-V3R-110), each independently runnable and each pinning its
  required assertions by name so a deleted assertion fails the gate: `npm run test:guardrails`
  (6/6 guardrail invariants), `npm run test:modes` (9/9 Single/Auto/Manual against mock runners),
  `npm run test:paid-fallback` (6/6 paid-path unreachability)
- four packed migration fixtures: 34 assertions — existing Knowledge unchanged, existing Target
  zero conflicts with overrides preserved, fresh install `UP_TO_DATE`, upgrade v11 → v14 with
  same-stage resume and 102 byte-identical rollback paths
- packaged distribution E2E: 23/23 steps on Windows, including fail-closed launch with the runtime
  binary absent
- prompt characters did not regress: 761,407 → 763,108 (+0.2234%, gate ≤3%), and the pre-packet
  baseline is 2,609 characters lower than the Phase 2 measurement
- no real runner login and no dogfood run is required by any gate step

### Install

```bash
npm pack   # software-team-agents-1.0.0-rc.3.tgz
# then in a target project:
npm install -D <path>/software-team-agents-1.0.0-rc.3.tgz
```

---

## software-team-agents v1.0.0-rc.2

> Product version `1.0.0-rc.2` (semver; follows `v1.0.0-rc.1`) · 2026-08-26
> This release closes the framework's internal **v2 improvement cycle** (`planning/v2/`) —
> "v2" there is a planning-generation label, not the product version.

### Highlights

**Compatibility-affecting instruction setup changes**

- Existing project-owned `.claude/settings.json` files are now merged: project hooks, permissions,
  and unknown keys remain, while missing Framework guard registrations are appended. Sync backs up
  before writing, blocks on malformed/unmergeable JSON, and launch preflight verifies installed vs
  registered hooks with the `Guards wired` check.
- Existing project-owned root `CLAUDE.md` and `AGENTS.md` files now receive only the delimited
  `<!-- sta:bootstrap -->` block; bytes outside the markers remain project-owned. Malformed markers
  block sync, every write is backed up, and `overrides` still opts a path out. A missing `AGENTS.md`
  receives the rendered pointer to `CLAUDE.md`; no project-owned `AGENTS.md` is automatically deleted
  or reduced without the dedicated confirmation.

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

**Packaged layout playbook: `prompt-reconcile-knowledge-layout.md`**

The former `prompt-update-knowledge.md` path remains a one-release compatibility
pointer. Evidence reconciliation is the read-only `sta knowledge reconcile
--target <id>` command.
Knowledge-repo reconciliation playbook shipped in the package root (added to `files[]`),
cross-linked from `prompt-setup.md` ↔ `TEAM_SETUP_V1.md` #10; verified present and readable from
a fresh install by the packaged E2E (22/22 steps, Windows real-path/quoting coverage).

### New / changed flags

| Flag | Purpose |
|---|---|
| `sta --check-plan [--module <name>]` | validate every module's plan.md as a task DAG (new) |
| `sta --check-bindings` | covers all four mirror families (opencode commands, codex skills, agents, commands payload) |

CI runs 16 validation flags including `--check-plan`.

### Validation summary (tree @ `2647b48` + version bump)

- orchestrator suite: 2132 tests / 141 files · typecheck ✓ · build ✓
- hook/script self-test: 891 cases
- 16 validation flags exit 0
- templates snapshot rebuild byte-identical (97 files + manifest, framework_version `1.0.0-rc.2`)
- packaged distribution E2E: 22/22 steps on Windows (fresh install → configure → init → status →
  sync conflict/force → fail-closed launch surface), payload includes both prompt playbooks

### Deferred (explicit)

| Item | Reason |
|---|---|
| graphify agent-level benchmark rounds & default-on rollout | human-run sessions required (API cost, supervision) — ADR-006 rollout sequence |
| uxui T-CD5 two-directional smoke | requires `sb-compass` Target workspace cloned locally |
| `doctor` per-artifact mirror warnings | enhancement, not release-blocking |
| layout reconciliation prompt consistency test (`promptSetup.test.ts` analogue) | deferred-with-note; add before its next structural edit |

### Install

```bash
npm pack   # software-team-agents-1.0.0-rc.2.tgz
# then in a target project:
npm install -D <path>/software-team-agents-1.0.0-rc.2.tgz
```

No breaking changes to existing plan.md/knowledge layouts; plans without waves derive them
deterministically from declared dependencies.
