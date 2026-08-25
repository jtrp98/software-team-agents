# AgentClaude — Agent Pipeline

This repo defines a fixed, hand-off-based agent pipeline for building a project from a vague idea through to verified, security-reviewed, deployed code. Each stage is a subagent under `.claude/agents/`, each owns exactly one artifact, and **no agent ever invokes the next one** — structurally true in every mode, since none of them holds the `Agent` tool. By default the user decides every handoff explicitly; an opt-in autonomous mode lets the session chain them instead, but five points (requirement interview, schema confirmation, a failed QA round, a Critical/Important security finding, an actual deploy/migration) always wait for a person regardless. **In orchestrated runs, `qa-engineer` closes every pipeline that changed code and `security` joins whenever a sensitive area or the data model is touched — they are part of what the workflow chains, not extras a caller must remember**; their *verdicts* are where the always-human points bite. See "Rules that hold across every agent" below.

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

## The pipeline

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
| `project-manager` | phased task list | `design.md`, `requirement.md`, stack files | `plan.md` |
| `test-planner` | test strategy | `requirement.md`, `design.md`, `plan.md` | `test-plan.md` |
| `uxui-designer` | UX/UI analysis + recommendations (read-only consultant; drafts only, a person signs off) | `requirement.md`, `design.md`, design sources under `knowledge/_sources/design/<module>/`, Figma via read-only MCP | `_docs/module/*/uxui/**`, `knowledge/*/ux-design/**` (`UX-*` drafts) |
| `frontend-engineer` | UI code | `plan.md`, `design.md`, `requirement.md`, `test-plan.md`, `review.md`, the module's signed UX artifact | app code |
| `backend-engineer` | API/DB code | `plan.md`, `design.md`, `requirement.md`, `test-plan.md`, `review.md` | app code |
| `qa-engineer` | verification | all docs + `schema.prisma` + real code | `review.md`, `review/phase-N.md`, task Status cells and add-only `🔒 Security gate` in `plan.md` |
| `security` | security audit | `requirement.md`, `design.md`, `review.md`, `schema.prisma`, real code | `security.md` |
| `devops` | deploy, CI, migrations | `status.md`, `review.md`, `security.md`, `plan.md`, `design.md`, `schema.prisma`, stack files | `deploy.md`, infra files |

**Three-repo note (T-ROLE/T-WG7):** every path above that sits in the module folder (`_docs/module/<name>/…`) or under `knowledge/` is a **Knowledge-repository** location. Analysis-role Writes columns — requirement/design/plan/test-plan and everything the `business-analyst`…`uxui-designer` rows produce — are written only from the Knowledge workspace (`software-team-agents ba`). A DEV workspace reads those same paths as READ-ONLY context (its rendered CLAUDE.md banner names the root), writes app code plus its own engineer docs (`review.md`, `security.md`, `deploy.md`), and never carries a local `_docs/`. `qa-engineer` runs from the Target (DEV) workspace and cannot write `plan.md` directly there — `.claude/hooks/block-path-permissions.js` denies it unconditionally in a `role: dev` workspace, whatever its contract says. Its Status-cell decision still has to land where `plan.md` lives — the Knowledge repo — so it goes through two stages (T-LV3): `qa-engineer` writes its verdict into `review.md` (fully writable from Target) plus a `## Knowledge sync — three-repo mode` table naming each task's id and new Status, then a BA-lane session applies that table to `plan.md`'s Status cells — a relay of a decision already made, not a second review, and using write access the BA lane already holds over its own `plan.md`. In single-repo/legacy mode (no `role: dev`), none of this applies and `qa-engineer` still edits the Status cell directly, as it always did.

**Lane visibility (T-LV1/T-LV2):** the read direction above also runs the other way, symmetrically and optionally. A BA workspace's `.agent-team/config.yaml` may set `target.path`, mirroring `knowledge.path` on the DEV side; when it resolves, `software-team-agents ba` sets `AGENTCLAUDE_TARGET_ROOT` the same way a DEV launch sets `AGENTCLAUDE_KNOWLEDGE_ROOT`. Unset or unresolved, BA works exactly as before — Target stays optional, nothing about BA's own workflow depends on it. `system-analyst` is the one agent that reads it today: amending a module that's already implemented, with `AGENTCLAUDE_TARGET_ROOT` present, it reads the real schema off the Target (via `backend-engineer.md`'s "Fixed project stack" section, never a hardcoded path) before treating a change as additive/breaking, and reports drift against `design.md` plainly instead of trusting `design.md`'s memory of what got built. No write channel opens either direction — this is read-only, same as `AGENTCLAUDE_KNOWLEDGE_ROOT` is for DEV.

Every agent also reads `_docs/status.md` when it starts and regenerates it (`node .claude/scripts/generate-status.js` — T51, `policies/documentation.md` §2) when it finishes, rather than hand-editing it — that's left out of the table above rather than repeated on all eleven rows.

`uxui-designer` runs immediately before `frontend-engineer`, but only in pipelines that carry a design phase — feature, business-rule, schema-change and incremental work (`workflows/typo.yml`-class small fixes rely on the module's existing signed artifact instead). It analyzes the module's design source (a Figma file over a read-only MCP connection, or export/handoff files a person placed in `knowledge/_sources/design/<module>/`) and produces draft `UX-*` recommendations plus `_docs/module/<name>/uxui/design.md`. Everything it writes is draft — a person reviews, approves, and records the UXUI lane sign-off (`sta roles signoff uxui --by <name>`), and frontend work does not start until that gate is current. The gate itself follows the same right-sizing: TRIVIAL/SMALL tasks skip the UX-artifact precondition (no design phase, no uxui round was scheduled), while MEDIUM+ — and any unknown level, fail-closed — still require it; the SA→DEV handoff checks apply at every level. It never scrapes a design URL and never calls a canvas-write tool; the Figma connection is read-only and identity-gated (see README, "Design sources & identities"). A question that is not its to answer — is this UI worth building, or can it be built — is reported as structured data and routed back to `business-analyst`/`system-analyst` automatically; if this pipeline has no such stage, it stops for a person instead of guessing.

`test-planner` runs after `project-manager`, before the engineers — deciding what needs testing and at what level (unit/integration/API/E2E) so `backend-engineer`/`frontend-engineer` build against a stated strategy instead of each guessing their own, and `qa-engineer` verifies against it instead of inventing one per round. It participates in normal auto-chaining like every other stage — the only things that stop the chain are the five always-human points above. Right-sizing still applies: small work that skips `project-manager` skips `test-planner` too (see below).

`setup` runs once per project, before Phase 1. Everything after that loops per phase.

## Where things live

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
│   └── static-analysis-gate.js   ← run by qa-engineer before a FULL round: lint/format/typecheck/build/test/security_scan/dependency_scan across every package (T22/T23/T24)
├── tests/
│   └── run.js                    ← self-test for every hook + script (both runtimes' copies, no deps)
└── settings.json                ← wires every hook up (checked in, applies to everyone)
```

```
layout.yaml                      ← which concept owns which directory (checked by --check-layout)
contracts/*.yaml                 ← the machine-readable half of each agent
policies/                        ← conventions.md split per area (T49): coding, git, architecture,
                                   documentation, security, agent-boundaries
workflows/                       ← one YAML per kind of change (11 files, live — the classifier is checked against them by --check-workflows)
```

`layout.yaml` is the one answer to "where does this file go?". Five concepts, each answering
exactly one question — Agent (ใคร) · Skill (ทำอะไรได้) · Policy (ห้ามอะไร) · Workflow (ทำเมื่อไหร่) ·
Orchestrator (ใครทำต่อ) — plus runtime state and docs. `orchestrator/src/layout/repoLayout.ts`
checks the declaration against the real filesystem, which is the part that keeps it from
becoming a diagram that drifts: it catches an agent with a prompt but no contract, two concepts
claiming one directory, and a hook sitting in `.claude/hooks/` that `settings.json` never wires
up. Run it with `node orchestrator/dist/cli.js --check-layout`.

Two paths are deliberately **not** moved by it. `.claude/agents/` is where Claude Code resolves
subagents from, so relocating the prompts would separate the concept by breaking the product;
the concept is separated instead by naming both halves of an agent — the prompt and the
contract. And `.workflow/` keeps the runtime state path T02 specified, since renaming it to
`runtime/` would break existing state to gain a synonym.

No *document* is written at the repo root — every module doc lives under `_docs/module/<name>/`. (Project files that belong at the root by convention are a different thing: `setup` writes `package.json`, `.env`, `.env.example`, and `.gitignore` there, and `devops` writes infra files.) Every doc agent resolves its module folder first: one folder → use it; several → ask the user; none → send them back to `business-analyst`.

A **module folder** is a delivery unit with its own doc set and phase numbering; the **Modules** inside `design.md` are feature groupings within one such unit. The test is whether the work would get its own business interview — if it's the same product being built out, it's one folder with several Modules, however large. Splitting folders is not a way to manage size. `policies/documentation.md` §1 has the full rule.

## Rules that hold across every agent

Full text in `policies/*.md`; the short version:

- **Confirm workspace ↔ lane before writing anything (T-WG5).** Every analysis/doc-writing run starts with `software-team-agents status` — a run in the wrong repository (BA-lane work landing in a Target, not the Knowledge repo) is exactly how the sb-compass incident happened, and nothing caught it until it was too late. If `status` warns that a bound Knowledge root was never `init --role ba`'d there, stop and ask the user before writing a single doc file, even into a folder that already exists. `policies/documentation.md` §0 has the full rule; `setup` and `business-analyst` carry it explicitly since they're the two agents that can create a module folder from nothing.
- **`backend-engineer` runs before `frontend-engineer`, never in parallel, within a phase.** The frontend reads its types/API calls off what the backend actually built, not off `design.md` alone — running both at once means frontend has to guess the contract, which is exactly what produced a real `staff-roles/sync` response-shape mismatch that cost an extra fix round. Exception: tasks in the same phase that share no API contract can run in either order. `policies/agent-boundaries.md` §6a has the full rule.
- **No agent chains to the next — structurally, none of the eleven has the `Agent` tool.** By default (manual mode) each finishes by saying what's ready and who should get it, then the user decides. When the user explicitly asks for a continuous/unattended run ("รันข้ามคืนได้เลย"), the session orchestrating the pipeline chains the handoffs itself — and the chain is whatever `workflows/*.yml` declares: **every code-changing pipeline closes with `qa-engineer`, and `security` joins when a sensitive area or the schema is touched**, so verification is part of the automation rather than a step a caller must remember. Five points stop the chain and wait for a person regardless of mode: the requirements interview (`business-analyst` never runs headless past its interview without an answer), `system-analyst`'s schema confirmation, `qa-engineer` on any ⚠️/❌ result (rounds 1–2 route back to the engineer automatically; the third failure — or any Critical-severity failure — escalates to a person immediately), `security` on any 🔴/🟠 finding, and `devops` before an actual deploy/migration. Both reviewers stay invokable by name outside any pipeline too. `policies/agent-boundaries.md` §6 has the full rule.
- **No git, ever.** No agent runs git or touches `.git`. `setup`/`devops` may *write* a `.gitignore` or CI file — that's writing a file, not running git. This is enforced by a `PreToolUse` hook (`.claude/hooks/block-git.js`), not left to the prompt: state-changing git commands are blocked at the tool call, read-only ones (`status`/`log`/`diff`/`show`) still run.
- **No agent writes outside this repo.** Every write resolves under the project root, whatever the reason. Enforced by a second `PreToolUse` hook (`.claude/hooks/block-outside-repo.js`) on `Write`/`Edit`/`MultiEdit`/`NotebookEdit` — the one exception is Claude Code's own scratchpad convention under the OS temp dir, which isn't an agent going off scope.
- **`design.md`'s Data Model is the contract.** `backend-engineer` implements it verbatim, `frontend-engineer` derives types from it, `qa-engineer` fails any drift. A gap goes back to `system-analyst`, never gets improvised. Once `setup` has written the real `schema.prisma`, the engineers work from that file — it's the contract's working copy and the one their queries must agree with — and `qa-engineer` is the agent that reads both and keeps them equal. If they ever disagree, `design.md` wins and the code is wrong. Only `setup` (at scaffold) and `backend-engineer` (propagating a confirmed amendment) ever write `schema.prisma`. Every model in a module's Data Model must exist in `schema.prisma` and match — that direction is absolute regardless of module count. **If more than one module folder exists**, a model `schema.prisma` has that this `design.md` doesn't may belong to another module rather than being drift — `.claude/shared/multi-module-schema-scoping.md` has the exact ownership-check procedure (read it only once that situation applies; a single-module project is fully covered by the rule above already).
- **Only `qa-engineer` marks tasks done.** It sets a task's Status cell to `verified` (or `blocked`) in `plan.md`'s task table (T52) after inspecting real code. Engineers don't edit `plan.md` at all — their contracts deny `_docs/module/**` — so an engineer starting a row says so in its handoff instead of flipping the cell itself, and `project-manager`/`qa-engineer` are the only writers the table ever sees. Nobody else touches Status. **In three-repo mode this decision still originates only with `qa-engineer`** — a BA-lane session applies the Status-cell write mechanically from `review.md`'s sync table (T-LV3, see the Three-repo note above), it never re-judges the verdict.
- **Amend, don't regenerate.** Existing docs are updated with `Edit`, section by section, with a dated line appended to their `## Change Log`. Never a full rewrite.
- **Handoff messages are concise.** The chat message an agent ends with — status updates and the "here's what's ready, here's who's next" handoff — leads with the result, not a restated plan or step-by-step narration; explain reasoning only where the next reader must decide something from it. This governs the chat message, not the documents themselves. `policies/documentation.md` §12 has the full rule.
- **`review.md` stays small.** It holds `Open Issues — all phases`, the current verify round, and `Unverified Behaviour` for phases that haven't deployed yet; `qa-engineer` moves closed rounds verbatim into `review/phase-N.md`. Those first and third sections outlive their round on purpose — a later stage reads them after the round that produced them stopped being current. Every engineer/`security`/`devops` run reads `review.md` in full, so closed-phase detail left in it is a tax on the whole pipeline. Nobody opens an archive file as part of normal startup.
- **Dates come from the user.** No agent can reliably know today's date, so any agent writing a dated entry asks first and reuses that answer for the session.
- **Engineers never decide a rule — they implement or they stop.** Neither engineer has `AskUserQuestion`, deliberately: a rule settled in a chat with an engineer never reaches `requirement.md` or `design.md`, so the next phase and the next session don't inherit it. Unclear logic goes back to `system-analyst` (which routes on to `business-analyst` if it's a business question), and `design.md`'s contract sections carry the bar — an engineer must never have to decide. Anything not covered is either written into a contract section or listed as explicitly out of scope; leaving it unmentioned is neither.
- **The guards are themselves tested — run `node .claude/tests/run.js` after touching any of them.** The hooks and scripts are the only rules here that don't rely on an agent remembering them, so they're the load-bearing part of the design. A hook that throws a `SyntaxError` exits 1, and `PreToolUse` only blocks on exit 2 — so a typo makes a guard **fail open**: still wired up, still looking installed, enforcing nothing. That happened once for real. `policies/security.md` §5d has the rule; a red run is blocking. **`.github/workflows/agent-framework-ci.yml` (T54) runs this self-test plus the 15 release-gate `--check-*` flags on every PR** — the same list a person would run by hand before trusting a change to this framework, not a separate set of rules. (`--check-bindings` exists in the CLI but is not wired into CI.)
- **An engineer doesn't hand off red code.** `typecheck`/`lint` run *before* an engineer is allowed to finish, not after — enforced by a `Stop`/`SubagentStop` hook (`.claude/hooks/require-green-before-stop.js`) that blocks the finish while they fail on a run that touched app code. This is a token-cost rule as much as a quality one: a type error found by `qa-engineer` costs two fresh-context agent runs to fix, the same error found here costs one edit. It forces at most one in-context fix attempt and can never trap an agent, and it is never a reason to improvise around a contract gap — say so in the handoff instead. `policies/coding.md` §5c has the full rule.
- **No agent hands off a hardcoded secret, either (T25).** Same `Stop`/`SubagentStop` cadence as the rule above, a separate hook (`.claude/hooks/block-secret-leak.js`) because it catches a different mistake: it scans every file a run changed for AWS keys, private-key blocks, connection strings with a real embedded password, and hardcoded `api_key`/`secret`/`token`/`password` literals. `.env` is exempt (the convention-approved, gitignored place for real values); `.env.example` is not (committed by convention, placeholders only). Same never-trap guarantee — one blocked attempt, then release. `policies/security.md` §5c-1 has the full rule.
- **Nothing reaches a FULL QA round without the full static-analysis sweep, not just typecheck/lint.** `qa-engineer` runs `node .claude/scripts/static-analysis-gate.js` before verifying — lint, format, typecheck, build, and test across every package that defines the script, in one command instead of five remembered separately (T22), plus a repo-wide `security_scan` (T23 — see below) and `dependency_scan` (T24 — an offline match of every `package.json`'s declared dependencies against a small bundled list of known-vulnerable version floors; deliberately not a live `npm audit`/registry call, since a check `qa-engineer` runs every FULL round has to stay deterministic and work offline).
- **Security is a continuous check, not one phase before deploy.** Four checkpoints, each catching what the others can't: (1) **Design** — `system-analyst` writes a `Security Considerations:` note (threat surface, sensitive data, failure mode) on every feature it flags sensitive, not just the boolean flag `project-manager` reads for the `🔒 Security gate`; (2) **Code** — `static-analysis-gate.js`'s `security_scan` (T23) sweeps app code for a curated list of constructs that are wrong in essentially every context (eval, unsafe shell exec, raw SQL interpolation, disabled TLS verification, hardcoded secret fallbacks, wildcard CORS + credentials) and fails the gate on a hit; (3) **QA** — `qa-engineer`'s functional pass reads the code against `design.md`/`requirement.md`, which a pattern sweep can't judge; (4) **Pre-deploy** — the `security` agent's adversarial audit, still the only agent that can close a finding, still gated by `devops` before any deploy. None of the first three is a substitute for (4): a clean `security_scan` is a mechanical check passing, not a security sign-off.
- **Verify against real state, not memory.** A recalled fact from an earlier turn, a summary, or "I remember this does X" is a hypothesis, not a fact — read the actual current file/schema/code before stating or acting on it. If it disagrees with what's recalled, the file/code wins and the stale belief is corrected on the spot. `policies/coding.md` §12 has the full rule.
- **`status.md` is an index, not a truth.** If it disagrees with the docs or the code, the docs and code win. It's also where an agent looks up which phase is in play, instead of scanning `plan.md` to work it out, and where `qa-engineer` stamps each phase's verify mode — `(FULL)` / `(TARGETED)` — for `devops` to gate on. It's read on *every* run of *every* module, so each module's section stays to exactly four things: `Docs:`, the per-phase table, `**Now**:`, and `**Blocked on**:` — no round-by-round narrative. **The trigger is qualitative, not a line-count threshold: the moment a module's section holds anything beyond those four** (a decision's reasoning, a fixed bug's mechanism, a past round's findings), it's already outgrown the limit. There's no agent assigned to catch this on a schedule — **whoever notices it first** (any agent reading `status.md` that run) moves the superseded material verbatim into `status-archive.md` and leaves a one-line pointer, the same discipline `qa-engineer` applies to `review.md`. Leaving it unarchived costs every other module's run too, not just the offending one. `policies/documentation.md` §2 has the rule.
- **Read the section, not the file.** Every agent starts from a fresh context, so a whole-file read is a cost paid again on every run. `plan.md` → Plan Summary + your phase + Sequencing Notes + Open Questions. `design.md` → always Feature-by-Feature Feasibility, Risks, and Open Questions (they carry the confirmed decisions and the "don't implement this" list), plus your phase's contract section and your own module's entry. `policies/documentation.md` §10 has the procedure. Since T05 the orchestrator applies that same rule itself before invoking a stage (`orchestrator/src/context/contextManager.ts`), so an agent driven by it is handed the slice rather than asked to remember to take one — and is told which sections were withheld, so a filter can never silently edit its inputs. When a document's structure isn't the one §10 describes, the whole file is sent instead: slicing is an optimization, completeness is a correctness requirement. Exceptions by design: `project-manager` owns `plan.md`, `system-analyst` owns `design.md`, and `qa-engineer` reads the Data Model in full every round. Because those three `design.md` sections are mandatory reading on *every* run, `system-analyst` keeps them small the same way, and the trigger there is a concrete event, not a size check: **the moment an amend round's decision is settled** — its rule now lives in a Contract section, the Data Model, or `## Modules` — the question-and-answer record that produced it has stopped being load-bearing and moves verbatim into `design-archive.md`. This is specifically `system-analyst`'s job (unlike `status.md`'s "whoever notices"), and it happens **as part of the same amend that closes the decision** — not batched up as separate cleanup later. `policies/documentation.md` §4 has the rule. **If a document already grew bloated before this archiving discipline was ever applied to it** (no per-round archiving happened, so there's nothing to catch up on incrementally), whichever agent's run would otherwise pay to read the bloat does a one-time catch-up round instead of waiting: read the whole document once, move everything already closed by that document's own rule verbatim into its archive file, leave a pointer, keep the current/open material behind. After that one correction, the normal per-round discipline is enough. `policies/documentation.md` §4 ("Catching up a document that grew bloated before it was ever archived") has the procedure.
- **QA runs in one of two modes, and says which.** FULL covers every task in the phase and is the only mode that closes one; TARGETED re-checks named fixes plus their blast radius, the shared-code watchlist, the whole-project typecheck/lint/build, and the full schema contract. TARGETED is allowed only after a FULL round left a file manifest to compare against, and it must state what it didn't cover. `.claude/agents/qa-engineer.md` has the rules.
- **Nothing ships unverified.** `devops` refuses to deploy a phase `qa-engineer` hasn't accepted, one whose most recent round was TARGETED, one marked `🔒 Security gate` that `security` never audited, or one with unresolved Critical/Important security findings, without an explicit user override. `security` isn't gated on the mode — it audits the code independently.
- **Only `security` closes a `security` finding.** Each finding carries a `Status` — 🔵 Open, 🟣 Fix claimed, ✅ Fixed (re-audited), ⚪ Accepted. An engineer's fix moves it to 🟣 and no further; `qa-engineer`'s pass is functional and says so itself, so it cannot close one. `devops` blocks on 🔵 and 🟣 alike.
- **No test suite means nothing ever executes the logic.** Tests are opt-in and default to none, so `qa-engineer` verifies by reading code plus `typecheck`/`lint`/`build` — which cannot tell a right answer from a wrong one. When there's no suite, QA lists the specific rules it could only read under `## Unverified Behaviour — undeployed phases`, and `devops` puts that list in front of the user before deploying.
- **Sensitive phases are flagged in writing, not remembered.** `project-manager` marks any phase touching auth, personal data, payments, uploads, or untrusted input as `## Phase N: <name> 🔒 Security gate`; `qa-engineer` can add one PM didn't foresee — writing it into the phase heading itself (its one write to `plan.md` beyond a task's Status cell, add-only) as well as listing it in `review.md`; `devops` gates on it. Nobody removes a flag except the user.
- **An unsourced number is an assumption, in writing.** `business-analyst` has no web access by design; external facts come from the user and land in `requirement.md`'s `## References` table with their source. Anything used as a fact without a row there is written `(สมมติฐาน — ยังไม่ยืนยัน)`, and `system-analyst` must resolve it with the user before designing around it instead of promoting it to fact by using it.
- **A fix that fails twice gets escalated, not re-sent.** After the second failed re-check of the same item, `qa-engineer` stops routing it back and hands it to the user — an item that survives two fixes is usually misrouted (a design or business question), not badly implemented.

## Right-size the pipeline — don't run all of it for small work

The full chain is for building something new. Running eleven stages for a copy fix is waste, not diligence. Pick the entry point by the size of the change:

| The work is | Start at | Skip |
|---|---|---|
| Copy/styling tweak | `backend-engineer` (if it touches the API) → `frontend-engineer` — no QA stage by design (`workflows/typo.yml`; `--check-review-separation` reports this on purpose, it does not fail) | BA, SA, PM, test-planner, `qa-engineer` |
| A bug where requirement + schema are already clear | engineer → `qa-engineer` | BA, SA, PM, test-planner |
| Adds or alters a field/table/relation | `system-analyst` (amend) → `test-planner` → engineer → `qa-engineer` (+`security`) | BA, PM |
| Changes a business rule, no schema impact | `business-analyst` (amend) → `system-analyst` (amend) → `test-planner` → engineer → `qa-engineer` | PM |
| A new feature, module, or project | `business-analyst`, full chain — even when it also needs new tables: the interview comes first, the schema confirmation after it | nothing |

`project-manager` only earns its run when there's enough work to need phasing. One or two tasks go straight to an engineer, and `test-planner` goes with it — a change too small for a phased plan is also too small for a separate test strategy pass; the engineer and `qa-engineer` reason about it directly.

But **don't skip a stage the change actually needs** — a schema change that bypasses `system-analyst` is the exact failure this pipeline exists to prevent.

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

## Fixed stack (summary — the two engineer files are authoritative)

- **Frontend**: Next.js App Router · TypeScript · Tailwind · Zustand
- **Backend**: Node + Express · PostgreSQL · Prisma · REST · hand-rolled JWT · Zod
- **Package manager**: npm
- **Tests**: opt-in — `setup` offers Vitest once and defaults to none. `qa-engineer` runs every check that exists (`typecheck`/`lint`/`build`/`test`) and must state in `review.md` when there are no automated tests, so a ✅ is never mistaken for a tested ✅

Changing the stack means the user confirms it and `frontend-engineer.md`/`backend-engineer.md` get updated in place. Every other agent reads those two files rather than keeping its own copy.

## Coming back to a project

Read `_docs/status.md` first — it says which modules exist, how far each has got, and which agent should pick it up. Then open that module's docs in order: `requirement.md` → `design.md` → `plan.md` (unchecked boxes = remaining work) → `review.md` → `security.md` → `deploy.md`.
