# Pipeline rationale — the reasoning behind `CLAUDE.md`

> Moved out of `CLAUDE.md` **verbatim** by T-V3TOK-011. Nothing here was rewritten or summarized.
>
> `CLAUDE.md` is auto-loaded into every session and every subagent on both the orchestrated and
> the interactive path, so every byte in it is paid again on every run. These sections explain
> machinery to a person reading the repository; no agent needs them to do its work. `docs/` is
> deliberately outside `TEMPLATE_SOURCES` (`orchestrator/src/packaging/templateSources.ts:31-47`),
> so nothing here ships into a workspace or is auto-loaded anywhere.

---

## Read this first

`policies/*.md` is the authoritative source for the rules every agent shares: module-folder resolution, the `_docs/status.md` index, dates, amend discipline, version control, handoffs, the design-as-contract rule, and where the stack is defined — split by area (`coding.md`, `git.md`, `architecture.md`, `documentation.md`, `security.md`, `agent-boundaries.md`) since T49. The agent files deliberately don't repeat those rules — they point at those files, so changing a rule means editing one place, not ten. (`.claude/shared/conventions.md` is now a short redirect to the table above — see `policies/README.md`.)

`orchestrator/` (a separate Node/TypeScript package, `npm install`/`npm test` inside it) automates the opt-in autonomous mode described above — its runtime adapter spawns `claude -p --agent <role>`, so it still runs the exact `.claude/agents/<role>.md` files this document defines, and it still stops at the same five human-approval points via its own gate/retry logic. It never invokes an agent by holding the `Agent` tool itself, and it never edits `.claude/` or `_docs/` directly. Run it as `node orchestrator/dist/cli.js <command>` (`sta` when installed from the npm package); every command is listed in its usage output, and team setup is in `TEAM_SETUP_V1.md`.

Since P0 finished, three of its behaviours are worth knowing when you read the agent files:

- **A failed round is routed by owner, not by position.** `qa-engineer` already writes which agent
  each open issue routes to; the orchestrator reads that column rather than guessing, and when the
  document names no owner — or names two — it stops for a person instead of picking one. A wrong
  owner costs two fresh-context runs and fixes the wrong thing.
- **Recovery is five choices, not one.** Retry (re-run the owner), Recover (go back to
  `system-analyst` at DESIGN or `business-analyst` at REQUIREMENT — the backward edge is guarded so
  it can only reach a state the task genuinely passed through), Rollback (a failure arriving after
  verification returns the task to its last verified state), Escalate (a person can unblock it), and
  Abort (the retry budget is spent). The budget outranks whatever the failure claims about itself.
- **Each agent writes only what its contract gives it.** `contracts/<role>.yaml` carries `write`,
  `deny` and `read` path globs, derived from the ownership table above. Enforcement is layered
  because a `PreToolUse` hook cannot see which subagent is acting: the orchestrator enforces it
  where identity is certain, and `.claude/hooks/block-path-permissions.js` reads the role from
  `AGENTCLAUDE_ROLE` (set by the orchestrator) — falling back, in an interactive session, to the
  floor no agent may cross at all (`.git/`, `node_modules/`, `.workflow/`, `dist/`). `read` is documentation rather than a
  block: reading is non-destructive, and a read guard that got one path wrong would trap an agent
  for no safety gain. It is still checked for one thing — everything a role may write, it must be
  able to read, because these documents are amended, not regenerated.
- **Tasks form a graph, not a queue.** `workflows/*.yml` say which roles run for a kind of change;
  `orchestrator/src/graph/taskGraph.ts` says which *tasks* may run together. §6a's
  backend-before-frontend rule is derived there from the API contracts a task produces and
  consumes, so the exception §6a grants — tasks sharing no contract may run in either order — is
  finally actionable instead of being knowledge someone had to hold. `--list` shows the batches.
  The orchestrator still runs one task at a time: executing a batch concurrently needs file-level
  locking (T35) first.
- **An approval is a record, not a flag.** Each of the five always-human points carries a type, a
  status, who answered and when. The one that mattered: a rejection is now stored as `rejected`, so
  it blocks the task — previously `false` and "never asked" were the same value, and a "no" quietly
  became a re-prompt until someone said yes.

---

## The pipeline — the full description

```
setup (once per project)
   ↓
business-analyst → system-analyst → project-manager → test-planner → backend-engineer → uxui-designer → frontend-engineer
                                                                                                          ↓
                                                                                                    qa-engineer
                                                                                          ↓            ↓            ↓
                                                                               implementation bug   schema gap   business gap
                                                                                          ↓            ↓            ↓
                                                                            frontend/backend-engineer  system-analyst  business-analyst
                                                                                                          ↓
                                                                                          security (sensitive phases) → devops
```

| Agent | Owns | Reads | Writes |
|---|---|---|---|
| `setup` | project skeleton | `design.md` (optional), stack files | scaffolding, `schema.prisma`, `.env`, `.gitignore` |
| `business-analyst` | business requirements | `review.md`, `design.md`, `requirement.md` (amend) | `requirement.md` |
| `system-analyst` | feasibility + data model | `requirement.md`, `review.md`, stack files | `design.md` |
| `project-manager` | work graph — phased task list as a validated dependency DAG (`sta --check-plan`) | `design.md`, `requirement.md`, `status.md`'s Scaffold line | `plan.md` |
| `test-planner` | test strategy | `requirement.md`, `design.md`, `plan.md` | `test-plan.md` |
| `uxui-designer` | UX/UI analysis + recommendations (read-only consultant; drafts only, a person signs off) | `requirement.md`, `design.md`, design sources under `knowledge/_sources/design/<module>/`, Figma via read-only MCP, Claude Design via fail-closed MCP (draft-only) | `_docs/module/*/uxui/**`, `knowledge/*/ux-design/**` (`UX-*` drafts) |
| `frontend-engineer` | UI code | `plan.md`, `design.md`, `requirement.md`, `test-plan.md`, `review.md`, the module's signed UX artifact | app code |
| `backend-engineer` | API/DB code | `plan.md`, `design.md`, `requirement.md`, `test-plan.md`, `review.md` | app code |
| `qa-engineer` | verification | all docs + `schema.prisma` + real code | `review.md`, `review/phase-N.md`, task Status cells and add-only `🔒 Security gate` in `plan.md` |
| `security` | security audit | `requirement.md`, `design.md`, `review.md`, `schema.prisma`, real code | `security.md` |
| `devops` | deploy, CI, migrations | `status.md`, `review.md`, `security.md`, `plan.md`, `design.md`, `schema.prisma`, stack files | `deploy.md`, infra files |

**Three-repo note (T-ROLE/T-WG7):** every path above that sits in the module folder (`_docs/module/<name>/…`) or under `knowledge/` is a **Knowledge-repository** location. Analysis-role Writes columns — requirement/design/plan/test-plan and everything the `business-analyst`…`uxui-designer` rows produce — are written only from the Knowledge workspace (`software-team-agents ba`). A DEV workspace reads those same paths as READ-ONLY context (its rendered CLAUDE.md banner names the root), writes app code plus its own engineer docs (`review.md`, `security.md`, `deploy.md`), and never carries a local `_docs/`. `qa-engineer` runs from the Target (DEV) workspace and cannot write `plan.md` directly there — `.claude/hooks/block-path-permissions.js` denies it unconditionally in a `role: dev` workspace, whatever its contract says. Its Status-cell decision still has to land where `plan.md` lives — the Knowledge repo — so it goes through two stages (T-LV3): `qa-engineer` writes its verdict into `review.md` (fully writable from Target) plus a `## Knowledge sync — three-repo mode` table naming each task's id and new Status, then a BA-workspace session applies that table to `plan.md`'s Status cells — a relay of a decision already made, not a second review, and using write access the BA workspace role already holds over its own `plan.md`. In single-repo/legacy mode (no `role: dev`), none of this applies and `qa-engineer` still edits the Status cell directly, as it always did.

**V3 ownership addendum:** “Three-Repo” names three repository types, not only three ownership domains. Local **Runtime State** is the fourth domain: `.workflow/state.db`, its generated view, execution packets, verification evidence, and run artifacts are machine-local/regenerable and gitignored. The ownership guard explicitly refuses to classify `packets/`, `evidence/`, or `runs/` as Knowledge-owned, even where compatibility paths place other `.workflow/` metadata under a Knowledge root.

**Lane visibility (T-LV1/T-LV2):** the read direction above also runs the other way, symmetrically and optionally. A BA workspace's `.agent-team/config.yaml` may set `target.target_id` — a Target identity from `targets.yaml`, resolved to this machine's checkout through `.workflow/targets.local.yaml` (T-V5-017; the committed `target.path` it replaced was removed by T-V5-042, and a config still carrying it loads with the problem reported). When it resolves, `software-team-agents ba` sets `AGENTCLAUDE_TARGET_ROOT` the same way a DEV launch sets `AGENTCLAUDE_KNOWLEDGE_ROOT`. Unset or unresolved, BA works exactly as before — Target stays optional, nothing about BA's own workflow depends on it. `system-analyst` is the one agent that reads it today: amending a module that's already implemented, with `AGENTCLAUDE_TARGET_ROOT` present, it reads the real schema off the Target using the Target-resolved stack metadata rather than a hardcoded path before treating a change as additive/breaking, and reports drift against `design.md` plainly instead of trusting `design.md`'s memory of what got built. No write channel opens either direction — this is read-only, same as `AGENTCLAUDE_KNOWLEDGE_ROOT` is for DEV.

Every agent also reads `_docs/status.md` when it starts and regenerates it (`node .claude/scripts/generate-status.js` — T51, `policies/documentation.md` §2) when it finishes, rather than hand-editing it — that's left out of the table above rather than repeated on all eleven rows. The BA-workspace agents have no `Bash` tool: they keep `status.md` correct by keeping its inputs (their own documents) accurate, and the agents that do hold `Bash` regenerate the file itself. Authority model, one line per layer: **PM = Work Graph · Graphify = Code Graph · Orchestrator = Runtime** — plan.md owns what-work/order/dependency/owner, code intelligence owns source-code relationships, the orchestrator derives runtime readiness and dispatch; no layer implements another's job.

`uxui-designer` runs immediately before `frontend-engineer`, but only in pipelines that carry a design phase — feature, business-rule, schema-change and incremental work (`workflows/typo.yml`-class small fixes rely on the module's existing signed artifact instead). It analyzes the module's design source — a Figma file over a read-only MCP connection, export/handoff files a person placed in `knowledge/_sources/design/<module>/`, or Anthropic's Claude Design server over its MCP (Path C: reads ingest a design; explicit write mode may seed a draft mockup on the canvas; the tool allowlist is frozen and fail-closed in `orchestrator/src/integration/claudeDesignMcp.ts`, ADR-005) — and produces draft `UX-*` recommendations plus `_docs/module/<name>/uxui/design.md`. Everything it writes is draft — a person reviews, approves, and records the UXUI lane sign-off (`sta roles signoff uxui --by <name>`), and frontend work does not start until that gate is current. The gate itself follows the same right-sizing: TRIVIAL/SMALL tasks skip the UX-artifact precondition (no design phase, no uxui round was scheduled), while MEDIUM+ — and any unknown level, fail-closed — still require it; the SA→DEV handoff checks apply at every level. It never scrapes a design URL and never calls a destructive canvas tool; the Figma connection is read-only, identity-gated, and Claude Design output stays draft-only (see README, "Design sources & identities"). A question that is not its to answer — is this UI worth building, or can it be built — is reported as structured data and routed back to `business-analyst`/`system-analyst` automatically; if this pipeline has no such stage, it stops for a person instead of guessing.

`test-planner` runs after `project-manager`, before the engineers — deciding what needs testing and at what level (unit/integration/API/E2E) so `backend-engineer`/`frontend-engineer` build against a stated strategy instead of each guessing their own, and `qa-engineer` verifies against it instead of inventing one per round. It participates in normal auto-chaining like every other stage — the only things that stop the chain are the five always-human points above. Right-sizing still applies: small work that skips `project-manager` skips `test-planner` too (see below).

`setup` runs once per project, before Phase 1. Everything after that loops per phase.

---

## Where things live — the full tree

```
_docs/
├── status.md                    ← the index: what exists, how far it's got, who's next
├── status-archive.md            ← (created on demand) superseded status.md narrative, moved verbatim
└── module/
    └── sales-crm/
        ├── requirement.md       ← business-analyst
        ├── design.md            ← system-analyst
        ├── design-archive.md    ← (created on demand) closed amend-round Q&A, moved out of design.md's always-read sections
        ├── plan.md              ← project-manager  (task Status cell + added security gates: qa-engineer, T52)
        ├── test-plan.md         ← test-planner
        ├── uxui/design.md       ← uxui-designer (the lane artifact a person signs off before frontend work)
        ├── review.md            ← qa-engineer  (open issues + current round + unverified behaviour)
        ├── review/
        │   └── phase-N.md       ← qa-engineer  (archived rounds — read on demand only)
        ├── security.md          ← security
        └── deploy.md            ← devops

.claude/
├── shared/
│   ├── conventions.md            ← short redirect to policies/ (T49 moved the rules there)
│   └── multi-module-schema-scoping.md ← schema.prisma vs design.md scoping procedure, read only once >1 module exists
├── agents/*.md                  ← the eleven agents
├── hooks/
│   ├── block-git.js              ← PreToolUse guard enforcing the no-git rule
│   ├── block-outside-repo.js     ← PreToolUse guard keeping every write inside the repo root
│   ├── block-doc-rewrite.js      ← PreToolUse guard forcing Edit (not Write) on existing module docs
│   ├── block-path-permissions.js ← PreToolUse guard: per-agent write/deny paths from contracts/*.yaml (T15)
│   ├── require-green-before-stop.js ← Stop guard: an engineer can't hand off red typecheck/lint
│   └── block-secret-leak.js      ← Stop guard: no hardcoded secret in a file this run changed (T25)
├── scripts/
│   ├── check-schema-contract.js  ← run by qa-engineer: diffs schema.prisma against every design.md
│   ├── check-status-sync.js      ← independent second opinion on an existing status.md (T50)
│   ├── generate-status.js        ← every agent runs this to (re)write status.md — no hand-edits (T51)
│   └── static-analysis-gate.js   ← run by qa-engineer before a FULL round: profile commands + source-root security/dependency scans
├── tests/
│   └── run.js                    ← self-test for every hook + script (both runtimes' copies, no deps)
└── settings.json                ← declares Framework hook registrations; sync merges missing entries into effective project settings
```

```
layout.yaml                      ← which concept owns which directory (checked by --check-layout)
contracts/*.yaml                 ← the machine-readable half of each agent
policies/                        ← conventions.md split per area (T49): coding, git, architecture,
                                   documentation, security, agent-boundaries
workflows/                       ← one YAML per kind of change (11 files, generated from taskClassifier.ts + workflowCatalog.ts, byte-checked by --check-workflows — ADR-007)
```

`layout.yaml` is the one answer to "where does this file go?". Five concepts, each answering
exactly one question — Agent (ใคร) · Skill (ทำอะไรได้) · Policy (ห้ามอะไร) · Workflow (ทำเมื่อไหร่) ·
Orchestrator (ใครทำต่อ) — plus runtime state and docs. `orchestrator/src/layout/repoLayout.ts`
checks the declaration against the real filesystem, which is the part that keeps it from
becoming a diagram that drifts: it catches an agent with a prompt but no contract, two concepts
claiming one directory, and a hook sitting in `.claude/hooks/` that the Framework settings source
never wires up. Run it with `node orchestrator/dist/cli.js --check-layout`. Installation alone is
not runtime wiring: workspace preflight's `Guards wired` check also compares the installed hook
registrations with the effective project `.claude/settings.json`; a missing registration blocks
launch, while an explicit settings override is reported as the user's choice.

Two paths are deliberately **not** moved by it. `.claude/agents/` is where Claude Code resolves
subagents from, so relocating the prompts would separate the concept by breaking the product;
the concept is separated instead by naming both halves of an agent — the prompt and the
contract. And `.workflow/` keeps the runtime state path T02 specified, since renaming it to
`runtime/` would break existing state to gain a synonym.

No *document* is written at the repo root — every module doc lives under `_docs/module/<name>/`. (Project files that belong at the root by convention are a different thing: `setup` writes `package.json`, `.env`, `.env.example`, and `.gitignore` there, and `devops` writes infra files.) Every doc agent resolves its module folder first: one folder → use it; several → ask the user; none → send them back to `business-analyst`.

A **module folder** is a delivery unit with its own doc set and phase numbering; the **Modules** inside `design.md` are feature groupings within one such unit. The test is whether the work would get its own business interview — if it's the same product being built out, it's one folder with several Modules, however large. Splitting folders is not a way to manage size. `policies/documentation.md` §1 has the full rule.

---

## Model and effort per agent

Set in each agent's frontmatter. The split puts the expensive model where a mistake propagates furthest, and the cheap one where the volume is:

| Agent | `model` | `effort` | Why |
|---|---|---|---|
| `setup` | sonnet | low | mechanical, runs once per project |
| `business-analyst` | opus | medium | short output, but an error here contaminates everything downstream |
| `system-analyst` | opus | high | hardest reasoning in the chain; a wrong schema is the costliest mistake available |
| `project-manager` | sonnet | medium | decomposition from an already-confirmed design |
| `test-planner` | sonnet | medium | derives test items from an already-confirmed design/plan — same tier as decomposition, not the same tier as the design decision itself |
| `uxui-designer` | sonnet | medium | analysis of an already-confirmed design against a design source; output is a draft a person reviews, so a miss costs one review round, not shipped UI |
| `frontend-engineer` | sonnet | medium | highest volume, highest output — where the savings actually are |
| `backend-engineer` | sonnet | medium | same |
| `qa-engineer` | sonnet | high | comparison work, so `effort: high` buys more here than the tier does — but note this is the highest-leverage cost decision in the table: with tests opt-in and usually absent, this agent is the *only* correctness guarantee in the chain and nothing re-checks it. `opus` is the upgrade to reach for first if verification starts missing things |
| `security` | opus | high | adversarial reasoning; what it misses, nobody catches |
| `devops` | sonnet | medium | little reasoning, high stakes — guarded by confirmation rules instead |

To change one, edit that agent's frontmatter. `inherit` follows the session's `/model`.

**Every agent's frontmatter also carries `version:` (T57)** — a plain integer, starting at 1, bumped by whoever edits that agent's prompt meaningfully. This is log-only: Claude Code resolves a subagent from exactly `.claude/agents/<role>.md`, so only the prompt currently at that path can ever run — nothing here lets a task pin or run an older version. `orchestrator/src/agents/agentModel.ts`'s `resolveAgentVersion()` reads it the same way `resolveAgentModel()` reads `model:`, and `orchestrator/src/runtime/runtimeExecutor.ts` logs it on every run (`RunRecord.promptVersion`) so a task's history says which prompt version actually ran it — via whichever `RuntimeAdapter` (T108) is configured, `claudeCodeAdapter.ts` (T109) today.

---

## Target-resolved stack

The Target's `.agent-team/config.yaml` `stack:` block is authoritative for its profile, package
manager/tool, commands, schema paths and source roots. Sync renders the compact
`.claude/shared/stack.md` digest from that block; engineer prompts implement the resolved stack and
repository conventions without choosing a replacement. Verification runs the declared commands,
and a skipped command is not a pass; an all-skipped profile is `unverified`.

Changing the stack remains a human decision. The authoritative configuration and detection behavior
are documented in `README.md` §Configuration Reference; the engineer rationale files only explain why
their prompts point there rather than repeating a universal stack.

---

## Coming back to a project

Read `_docs/status.md` first — it says which modules exist, how far each has got, and which agent should pick it up. Then open that module's docs in order: `requirement.md` → `design.md` → `plan.md` (unchecked boxes = remaining work) → `review.md` → `security.md` → `deploy.md`.
