<!-- sta:bootstrap -->
# software-team-agents bootstrap
- Lane/role: resolved at sync (`ba` / `dev`) — writes only artifacts allowed by that lane.
- Workspace root (writable): **resolved at sync**
- Bound Knowledge/Target root (read-only): **resolved at sync or UNBOUND**
- Human gates: requirements interview; schema confirmation; third QA failure or Critical; Critical/Important security finding; real deploy or migration.
- Hard boundary: no state-changing git.
- Hard boundary: write only inside resolved writable workspace roots.
- Hard boundary: write only paths allowed by the active role contract.
- Hard boundary: Confirm workspace ↔ lane before writing anything.
- Hard boundary: amend existing module docs section-by-section; never regenerate them.
- Hard boundary: approvals/sign-offs are human acts; agents never forge them.
- Hard boundary: dates and unclear business rules come from a person; never improvise them.
- Context: run the command named by `AGENTCLAUDE_CONTEXT_CMD` with `<your-role> --module <name> --phase <n>`.
- Everything else: read only the needed section with `sta policy <area> <section>`.
<!-- /sta:bootstrap -->

# AgentClaude — Agent Pipeline

Eleven agents, each owning one artifact. No agent invokes the next — none holds the `Agent` tool.
Rationale: `docs/`. Shared conventions live in `policies/` — read the section you need with
`sta policy <area> [<section>]`, never the whole file.

## Roles

| Agent | Owns | Reads | Writes |
|---|---|---|---|
| `setup` | project skeleton | `design.md` (optional), stack files | scaffolding, `schema.prisma`, `.env`, `.gitignore` |
| `business-analyst` | business requirements | `review`, `design`, `requirement` (amend) | `requirement.md` |
| `system-analyst` | feasibility + data model | `requirement`, `review`, stack files | `design.md` |
| `project-manager` | work graph — phased tasks as a validated DAG (`sta --check-plan`) | `design`, `requirement`, `status.md`'s Scaffold line | `plan.md` |
| `test-planner` | test strategy | `requirement`, `design`, `plan` | `test-plan.md` |
| `uxui-designer` | UX/UI analysis (read-only consultant; drafts only, a person signs off) | `requirement`, `design`, `knowledge/_sources/design/<module>/`, Figma/Claude Design via MCP | `_docs/module/*/uxui/**`, `knowledge/*/ux-design/**` (`UX-*` drafts) |
| `backend-engineer` | API/DB code | `plan`, `design`, `requirement`, `test-plan`, `review` | app code |
| `frontend-engineer` | UI code | same, plus the module's signed UX artifact | app code |
| `qa-engineer` | verification | all docs + `schema.prisma` + real code | `review.md`, `review/phase-N.md`, `plan.md` Status cells and add-only 🔒 gates |
| `security` | security audit | `requirement`, `design`, `review`, `schema.prisma`, real code | `security.md` |
| `devops` | deploy, CI, migrations | `status`, `review`, `security`, `plan`, `design`, `schema.prisma`, stack files | `deploy.md`, infra files |

`setup` runs once per project. `uxui-designer` precedes `frontend-engineer` only where there is a design
phase. `test-planner` runs after `project-manager`. Every agent reads `_docs/status.md` on start and
regenerates it (`node .claude/scripts/generate-status.js`) on finish.
Authority: **PM = Work Graph · Graphify = Code Graph · Orchestrator = Runtime**.

## Rules nothing enforces — yours alone

- **Dates come from the user.** No agent can reliably know today's date, so any agent writing a dated entry asks first and reuses that answer for the session.
- **Verify against real state, not memory.** A recalled fact from an earlier turn, a summary, or "I remember this does X" is a hypothesis, not a fact — read the actual current file/schema/code before stating or acting on it. If it disagrees with what's recalled, the file/code wins and the stale belief is corrected on the spot. `policies/coding.md` §12 has the full rule.
- **Handoff messages are concise.** The chat message an agent ends with — status updates and the "here's what's ready, here's who's next" handoff — leads with the result, not a restated plan or step-by-step narration; explain reasoning only where the next reader must decide something from it. This governs the chat message, not the documents themselves. `policies/documentation.md` §12 has the full rule.
- **Nothing reaches a FULL QA round without the full static-analysis sweep, not just typecheck/lint.** `qa-engineer` runs `node .claude/scripts/static-analysis-gate.js` before verifying — lint, format, typecheck, build, and test from the Target-resolved `stack.commands` (falling back to the legacy per-package scripts only when no profile exists), plus `security_scan` over the profile's source roots/extensions and an offline `dependency_scan`. A skipped check is not a pass; if every verification command is skipped the gate reports `unverified` and exits distinctly instead of producing a green round. The gate stays deterministic and offline; it never installs tools or calls a registry.
- **No test suite means nothing ever executes the logic.** Tests are opt-in and default to none, so `qa-engineer` verifies by reading code plus `typecheck`/`lint`/`build` — which cannot tell a right answer from a wrong one. When there's no suite, QA lists the specific rules it could only read under `## Unverified Behaviour — undeployed phases`, and `devops` puts that list in front of the user before deploying.
- **An unsourced number is an assumption, in writing.** `business-analyst` has no web access by design; external facts come from the user and land in `requirement.md`'s `## References` table with their source. Anything used as a fact without a row there is written `(สมมติฐาน — ยังไม่ยืนยัน)`, and `system-analyst` must resolve it with the user before designing around it instead of promoting it to fact by using it.
- **`review.md` stays small.** It holds `Open Issues — all phases`, the current verify round, and `Unverified Behaviour` for phases that haven't deployed; `qa-engineer` moves closed rounds verbatim into `review/phase-N.md`. The first and third sections outlive their round on purpose — a later stage reads them after the round that produced them stopped being current, so they are never archived. Every engineer/`security`/`devops` run reads `review.md` in full, so closed-phase detail left in it taxes the whole pipeline. Nobody opens an archive file at normal startup.
- **Read the section, not the file.** `plan.md` → Plan Summary + your phase + Sequencing Notes + Open Questions. `design.md` → always Feature-by-Feature Feasibility, Risks and Open Questions (they carry the confirmed decisions and the "don't implement this" list), plus your phase's contract section and your own module's entry. Exceptions by design: `project-manager` owns `plan.md`, `system-analyst` owns `design.md`, `qa-engineer` reads the Data Model in full every round. When a document's structure isn't the one `policies/documentation.md` §10 describes, read it whole — slicing is an optimization, completeness is a correctness requirement. Because those three `design.md` sections are mandatory on *every* run, `system-analyst` keeps them small on a concrete trigger, not a size check: **the moment an amend round's decision is settled** — its rule now lives in a Contract section, the Data Model or `## Modules` — the question-and-answer record moves verbatim into `design-archive.md`, **as part of that same amend**, not as later cleanup. If a document grew bloated before this discipline was ever applied to it, whichever run would otherwise pay to read the bloat does a one-time catch-up instead of waiting. `policies/documentation.md` §4 has both procedures (`sta policy documentation §4`).

## Where documents live

Every module doc lives under `_docs/module/<name>/`; nothing is written at the repo root. Use `sta context`
to resolve the module deterministically; do not glob and guess. Its actionable many/none result either names
the exact candidates or routes missing requirements to `business-analyst`. A module folder is a delivery unit;
`design.md`'s **Modules** are feature groupings inside one (`policies/documentation.md` §1).

Who owns which file is the Roles table's Writes column. `design.md`, `review.md` and `status.md` each
have an archive companion; nobody opens one at normal startup.

**Three-repo mode.** Every `_docs/module/<name>/**` and `knowledge/**` path is a *Knowledge-repository*
location, written only from the Knowledge workspace (`software-team-agents ba`). A DEV workspace reads
those paths read-only, writes app code plus `review.md`/`security.md`/`deploy.md`, and carries no local
`_docs/`. `qa-engineer` runs from the Target and cannot write `plan.md` there — `role: dev` denies it
unconditionally — so its verdict lands in `review.md` plus a `## Knowledge sync — three-repo mode` table
naming each task id and new Status, which a BA-lane session then applies to `plan.md` (**T-LV3**: a relay
of a decision already made, never a second review). In single-repo mode none of this applies and
`qa-engineer` edits the Status cell directly. `AGENTCLAUDE_KNOWLEDGE_ROOT` and `AGENTCLAUDE_TARGET_ROOT`
are read-only in both directions; no write channel opens either way.

## Runtime entry points

`sta run --task-id <id> --module <name> …` orchestrated pipeline (`sta status`/`approve`/`retry`) ·
`software-team-agents ba|dev` interactive lanes · `sta policy [<area>] [<section>]` one policy section ·
`sta tokens` context composition per run · `sta --check-prompt-budget` this file's budget.

**Stack** (Target-resolved): `.agent-team/config.yaml` `stack:` declares the Target profile, package manager/tool,
commands, source roots, and schema paths. Engineer prompts implement that resolved stack without choosing a
replacement; changing the stack remains a human decision.

## Right-size the pipeline

Pick the entry point by the size of the change — but **don't skip a stage the change needs**: a schema
change bypassing `system-analyst` is the exact failure this pipeline exists to prevent.

| The work is | Start at | Skip |
|---|---|---|
| Copy/styling tweak | `backend-engineer` (if it touches the API) → `frontend-engineer` — no QA stage by design (`workflows/typo.yml`; `--check-review-separation` reports this on purpose, it does not fail) | BA, SA, PM, test-planner, `qa-engineer` |
| A bug where requirement + schema are already clear | engineer → `qa-engineer` | BA, SA, PM, test-planner |
| Adds or alters a field/table/relation | `system-analyst` (amend) → `test-planner` → engineer → `qa-engineer` (+`security`) | BA, PM |
| Changes a business rule, no schema impact | `business-analyst` (amend) → `system-analyst` (amend) → `test-planner` → engineer → `qa-engineer` | PM |
| A new feature, module, or project | `business-analyst`, full chain — even when it also needs new tables: the interview comes first, the schema confirmation after it | nothing |

`project-manager` earns its run only when there is enough work to phase; one or two tasks go straight
to an engineer, and `test-planner` goes with it.
