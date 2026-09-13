# prompt-update-knowledge.md — AI-Assisted Knowledge Refresh Playbook

> **What this is:** a playbook for an AI coding assistant (Claude Code, Codex,
> OpenCode, Antigravity, or any agent that can read files and run shell commands)
> to incrementally refresh and reconcile canonical STA knowledge in an existing
> Knowledge repository against current project reality across all Targets.
>
> **How to use it:** give your assistant this file — e.g. paste its contents into
> the session, or point your assistant at it ("read prompt-update-knowledge.md
> and refresh knowledge"). The playbook is runtime-agnostic: it only assumes file
> access and a shell.
>
> **Companion playbook:** [`prompt-setup.md`](prompt-setup.md) handles initial
> onboarding, workspace bindings, CLI synchronization, and first-time canonical
> knowledge capture. Use this playbook for ongoing incremental updates as code evolves.

---

## Operating principles — read before doing anything

1. **Inspect before updating.** Read current project reality (source code,
   runtime behaviour, config, API/DB contracts) and existing canonical knowledge
   (`knowledge/<module>/<kind>/<ID>.yaml`, `_docs/module/<name>/design.md`,
   `targets.yaml`) before proposing any updates.
2. **Source Priority on Conflict (AD-12):**
   When evidence sources disagree, apply this strict precedence order:
   1. **Current source code and actual runtime behaviour**
   2. **Current configuration, API, database schemas, and contracts**
   3. **Current canonical STA knowledge** (`knowledge/`, `_docs/`)
   4. **Maintained current documentation**
   5. **Optional legacy / reference documentation**
   Current implementation wins over stale documentation. Exception: when
   evidence clearly marks an approved future, planned, or accepted-but-not-yet-implemented
   requirement, that future requirement is preserved.
3. **Current State vs Desired / Planned State (AD-13):**
   - Explicit approved planned/future/pending requirements remain distinct
     from current state.
   - Absence from code is **not** evidence that an explicitly approved future
     requirement should be deleted.
   - Retain valid business intent.
   - Remove stale statements presented as current state (e.g. outdated API
     endpoints, retired database columns, obsolete configurations).
4. **Incremental updates where practical (AD-13):**
   - Detect meaningful differences between current implementation and knowledge.
   - Update **only affected sections and items**; avoid wholesale regeneration
     of existing valid knowledge.
   - Preserve unaffected items and existing stable IDs.
5. **Reference documents are read-only evidence (CR-6, AD-11, AD-14):**
   - Never modify, move, rename, rewrite, normalize, convert, or validate
     legacy/reference documents.
   - Do not instruct the model to run legacy migration commands or rely on
     compatibility frameworks.
   - Optional reference documents are not subject to STA schemas or document validators.
6. **Multi-Target knowledge representation (CR-1, CR-3, AD-1, AD-3, T-V9-019):**
   - Supports 3 or more Targets cleanly.
   - Target types: `frontend`, `backend`, `fullstack`.
   - Target responsibilities, repository paths, and dependencies are declared.
   - Knowledge item scopes:
     - Module-wide / all targets: `target_ids: []` (or omitted in schema v1).
     - Target-specific: `target_ids: ["target-id", ...]` (schema v2).
7. **Safe by default & concise output:**
   - No deletions of project source, no state-changing git commands.
   - Lead with results, not narration. Report exact affected paths and items.

---

## Phase 1 — Multi-Target Inspection & Evidence Collection

Collect facts silently from the Knowledge root and all bound Target repositories:

1. **Resolve Targets and configuration:**
   - Read `<knowledgeRoot>/targets.yaml` for registered Targets, remote URLs,
     and declared `type` (`frontend` | `backend` | `fullstack`).
   - Read `<knowledgeRoot>/.workflow/targets.local.yaml` for local checkout paths.
   - Confirm all Target paths exist and are accessible.
2. **Read existing canonical knowledge:**
   - Walk `<knowledgeRoot>/knowledge/<module>/<kind>/<ID>.yaml`.
   - Read `<knowledgeRoot>/_docs/module/<name>/design.md` (specifically `## Targets`
     and feature sections) and `requirement.md`.
   - Note existing IDs, versions, and current `target_ids` bindings.
3. **Inspect current Target reality:**
   - Inspect source code entry points, routes, controllers, and services.
   - Inspect configuration files (`package.json`, `.env.example`, `application.yml`, etc.).
   - Inspect database schemas, migrations, Prisma schemas, or SQL definitions.
   - Inspect exported APIs, RPC endpoints, and inter-service contracts.
4. **Read maintained docs & optional reference evidence:**
   - Read project docs under `docs/` or module READMEs.
   - Read optional reference docs (e.g. historical specifications, design dumps)
     strictly as read-only background context. Do not touch or reformat them.

---

## Phase 2 — Difference Detection & Conflict Resolution

Compare current implementation against existing canonical knowledge:

| Condition | Resolution rule | Action |
|---|---|---|
| **Code / contract changed** (new API, changed schema, modified behaviour) | Current code & contracts win over existing knowledge and reference docs | Update affected knowledge item (`version` bumped); remove stale assertions |
| **Requirement unchanged** | Existing business intent remains valid | Retain existing item untouched |
| **New Target registered** | Multi-Target topology expanded | Add Target to `targets.yaml`, update module `## Targets`, set `target_ids` |
| **Stale reference doc contradicts code** | Code wins; reference docs are lowest priority | Update canonical knowledge to match code; leave reference doc untouched |
| **Explicit future requirement in docs** (approved, pending, planned) | Valid future intent distinct from current state | Retain item; mark as planned/pending; do NOT delete merely because code is absent |
| **Stale claim presented as current state** (e.g. removed endpoint claimed active) | Code reality outranks stale claims | Remove stale current-state statement from canonical knowledge |

---

## Phase 3 — Incremental Knowledge Update

Apply minimal, targeted changes to canonical files:

1. **Update affected knowledge items:**
   - Edit only items whose reality changed: `<knowledgeRoot>/knowledge/<module>/<kind>/<ID>.yaml`.
   - Set `schema_version: 2`.
   - Set `target_ids: []` for module-wide items (relevant to all targets).
   - Set `target_ids: ["target-a", ...]` for target-specific items (e.g. backend API or frontend view).
   - Increment `version` integer by 1 on modified items.
   - Set `updated_at` to the current session timestamp.
2. **Amend module documentation:**
   - If Target topology changed, update `_docs/module/<name>/design.md`'s
     `## Targets` section.
   - Amend existing sections section-by-section; **never regenerate** existing docs.
3. **Preserve untouched files:**
   - Do not touch items whose backing reality has not changed.
   - Do not touch, move, rename, or format optional reference documents.

---

## Phase 4 — Verification & Final Report

1. **Verify canonical knowledge structure:**
   - Run available checkers:
     ```bash
     sta --check-doc-structure
     sta --check-workspace --project-root .
     ```
   - Ensure all updated items conform to `orchestrator/schemas/knowledge-item.schema.json`.
2. **Verify reference documents remained untouched:**
   - Confirm `git status` in Target and Knowledge repos shows no modifications
     to optional reference documents.
3. **Produce concise report:**
   ```text
   Knowledge refresh complete
   Knowledge root : <path>
   Targets checked: <target-id> (<type>: <path>), ...
   Updated items  : <ID> (<kind> in <module>) — <reason>
   Preserved items: <n> unchanged, <m> explicit future requirements
   Stale removed  : <summary of removed stale current-state assertions>
   Reference docs : untouched (read-only evidence)
   Next           : cd <knowledge> && software-team-agents ba
   ```