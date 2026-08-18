# AgentClaude — Agent Pipeline

This repo defines a fixed, hand-off-based agent pipeline for building a project from a vague idea through to verified, security-reviewed, deployed code. Each stage is a subagent under `.claude/agents/`, each owns exactly one artifact, and **no agent ever invokes the next one** — structurally true in every mode, since none of them holds the `Agent` tool. By default the user decides every handoff explicitly; an opt-in autonomous mode lets the session chain them instead, but five points (requirement interview, schema confirmation, a failed QA round, a Critical/Important security finding, an actual deploy/migration) always wait for a person regardless. **`qa-engineer` and `security` are never auto-chained in any mode — they run only when the user explicitly asks for them, every time.** See "Rules that hold across every agent" below.

## Read this first

`.claude/shared/conventions.md` is the authoritative source for the rules every agent shares: module-folder resolution, the `_docs/status.md` index, dates, amend discipline, version control, handoffs, the design-as-contract rule, and where the stack is defined. The agent files deliberately don't repeat those rules — they point at that file, so changing a rule means editing one place, not nine.

## The pipeline

```
setup (once per project)
   ↓
business-analyst → system-analyst → project-manager → frontend-engineer / backend-engineer
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
| `frontend-engineer` | UI code | `plan.md`, `design.md`, `requirement.md`, `review.md` | app code |
| `backend-engineer` | API/DB code | `plan.md`, `design.md`, `requirement.md`, `review.md` | app code |
| `qa-engineer` | verification | all four docs + `schema.prisma` + real code | `review.md`, `review/phase-N.md`, `[x]` and add-only `🔒 Security gate` in `plan.md` |
| `security` | security audit | `requirement.md`, `design.md`, `review.md`, `schema.prisma`, real code | `security.md` |
| `devops` | deploy, CI, migrations | `status.md`, `review.md`, `security.md`, `plan.md`, `design.md`, `schema.prisma`, stack files | `deploy.md`, infra files |

Every agent also reads `_docs/status.md` when it starts and updates its own lines when it finishes (`conventions.md` §2) — that's left out of the table above rather than repeated on all nine rows.

`setup` runs once per project, before Phase 1. Everything after that loops per phase.

## Where things live

```
_docs/
├── status.md                    ← the index: what exists, how far it's got, who's next
└── module/
    └── sales-crm/
        ├── requirement.md       ← business-analyst
        ├── design.md            ← system-analyst
        ├── plan.md              ← project-manager  (checkboxes + added security gates: qa-engineer)
        ├── review.md            ← qa-engineer  (open issues + current round + unverified behaviour)
        ├── review/
        │   └── phase-N.md       ← qa-engineer  (archived rounds — read on demand only)
        ├── security.md          ← security
        └── deploy.md            ← devops

.claude/
├── shared/conventions.md        ← rules every agent follows
├── agents/*.md                  ← the nine agents
├── hooks/
│   ├── block-git.js              ← PreToolUse guard enforcing the no-git rule
│   ├── block-outside-repo.js     ← PreToolUse guard keeping every write inside the repo root
│   ├── block-doc-rewrite.js      ← PreToolUse guard forcing Edit (not Write) on existing module docs
│   └── require-green-before-stop.js ← Stop guard: an engineer can't hand off red typecheck/lint
├── scripts/
│   ├── check-schema-contract.js  ← run by qa-engineer: diffs schema.prisma against every design.md
│   └── check-status-sync.js      ← run before trusting status.md: diffs it against every plan.md
├── tests/
│   └── run.js                    ← self-test for every hook + script (69 cases, no deps)
└── settings.json                ← wires all four hooks up (checked in, applies to everyone)
```

No *document* is written at the repo root — every module doc lives under `_docs/module/<name>/`. (Project files that belong at the root by convention are a different thing: `setup` writes `package.json`, `.env`, `.env.example`, and `.gitignore` there, and `devops` writes infra files.) Every doc agent resolves its module folder first: one folder → use it; several → ask the user; none → send them back to `business-analyst`.

A **module folder** is a delivery unit with its own doc set and phase numbering; the **Modules** inside `design.md` are feature groupings within one such unit. The test is whether the work would get its own business interview — if it's the same product being built out, it's one folder with several Modules, however large. Splitting folders is not a way to manage size. `conventions.md` §1 has the full rule.

## Rules that hold across every agent

Full text in `.claude/shared/conventions.md`; the short version:

- **No agent chains to the next — structurally, none of the nine has the `Agent` tool.** By default (manual mode) each finishes by saying what's ready and who should get it, then the user decides. When the user explicitly asks for a continuous/unattended run ("รันข้ามคืนได้เลย"), the session orchestrating the pipeline may chain the handoffs itself, opt-in per run — but five points always stop and wait for a person regardless of mode: `business-analyst` any time it runs, `system-analyst`'s schema confirmation, `qa-engineer` on any ⚠️/❌ result, `security` on any 🔴/🟠 finding, and `devops` before an actual deploy/migration. **`qa-engineer` and `security` are further exempt from auto-chaining altogether, in every mode** — the pipeline never invokes them on its own just because an engineer or a QA round finished; the user must ask for them by name every time. `.claude/shared/conventions.md` §6 has the full rule.
- **No git, ever.** No agent runs git or touches `.git`. `setup`/`devops` may *write* a `.gitignore` or CI file — that's writing a file, not running git. This is enforced by a `PreToolUse` hook (`.claude/hooks/block-git.js`), not left to the prompt: state-changing git commands are blocked at the tool call, read-only ones (`status`/`log`/`diff`/`show`) still run.
- **No agent writes outside this repo.** Every write resolves under the project root, whatever the reason. Enforced by a second `PreToolUse` hook (`.claude/hooks/block-outside-repo.js`) on `Write`/`Edit`/`MultiEdit`/`NotebookEdit` — the one exception is Claude Code's own scratchpad convention under the OS temp dir, which isn't an agent going off scope.
- **`design.md`'s Data Model is the contract.** `backend-engineer` implements it verbatim, `frontend-engineer` derives types from it, `qa-engineer` fails any drift. A gap goes back to `system-analyst`, never gets improvised. Once `setup` has written the real `schema.prisma`, the engineers work from that file — it's the contract's working copy and the one their queries must agree with — and `qa-engineer` is the agent that reads both and keeps them equal. If they ever disagree, `design.md` wins and the code is wrong. Only `setup` (at scaffold) and `backend-engineer` (propagating a confirmed amendment) ever write `schema.prisma`. **The comparison is scoped per module**: every model in a module's Data Model must exist in `schema.prisma` and match, but a model `schema.prisma` has and this `design.md` doesn't may belong to another module — `Grep` `model <Name>` across `_docs/module/*/design.md` before calling it drift. Only a model no module declares is an improvised change.
- **Only `qa-engineer` marks tasks done.** It sets `[x]` in `plan.md` after inspecting real code; nobody else touches a checkbox.
- **Amend, don't regenerate.** Existing docs are updated with `Edit`, section by section, with a dated line appended to their `## Change Log`. Never a full rewrite.
- **`review.md` stays small.** It holds `Open Issues — all phases`, the current verify round, and `Unverified Behaviour` for phases that haven't deployed yet; `qa-engineer` moves closed rounds verbatim into `review/phase-N.md`. Those first and third sections outlive their round on purpose — a later stage reads them after the round that produced them stopped being current. Every engineer/`security`/`devops` run reads `review.md` in full, so closed-phase detail left in it is a tax on the whole pipeline. Nobody opens an archive file as part of normal startup.
- **Dates come from the user.** No agent can reliably know today's date, so any agent writing a dated entry asks first and reuses that answer for the session.
- **Engineers never decide a rule — they implement or they stop.** Neither engineer has `AskUserQuestion`, deliberately: a rule settled in a chat with an engineer never reaches `requirement.md` or `design.md`, so the next phase and the next session don't inherit it. Unclear logic goes back to `system-analyst` (which routes on to `business-analyst` if it's a business question), and `design.md`'s contract sections carry the bar — an engineer must never have to decide. Anything not covered is either written into a contract section or listed as explicitly out of scope; leaving it unmentioned is neither.
- **The guards are themselves tested — run `node .claude/tests/run.js` after touching any of them.** The hooks and scripts are the only rules here that don't rely on an agent remembering them, so they're the load-bearing part of the design. A hook that throws a `SyntaxError` exits 1, and `PreToolUse` only blocks on exit 2 — so a typo makes a guard **fail open**: still wired up, still looking installed, enforcing nothing. That happened once for real. `.claude/shared/conventions.md` §5d has the rule; a red run is blocking.
- **An engineer doesn't hand off red code.** `typecheck`/`lint` run *before* an engineer is allowed to finish, not after — enforced by a `Stop`/`SubagentStop` hook (`.claude/hooks/require-green-before-stop.js`) that blocks the finish while they fail on a run that touched app code. This is a token-cost rule as much as a quality one: a type error found by `qa-engineer` costs two fresh-context agent runs to fix, the same error found here costs one edit. It forces at most one in-context fix attempt and can never trap an agent, and it is never a reason to improvise around a contract gap — say so in the handoff instead. `.claude/shared/conventions.md` §5c has the full rule.
- **Verify against real state, not memory.** A recalled fact from an earlier turn, a summary, or "I remember this does X" is a hypothesis, not a fact — read the actual current file/schema/code before stating or acting on it. If it disagrees with what's recalled, the file/code wins and the stale belief is corrected on the spot. `.claude/shared/conventions.md` §12 has the full rule.
- **`status.md` is an index, not a truth.** If it disagrees with the docs or the code, the docs and code win. It's also where an agent looks up which phase is in play, instead of scanning `plan.md` to work it out, and where `qa-engineer` stamps each phase's verify mode — `(FULL)` / `(TARGETED)` — for `devops` to gate on.
- **Read the section, not the file.** Every agent starts from a fresh context, so a whole-file read is a cost paid again on every run. `plan.md` → Plan Summary + your phase + Sequencing Notes + Open Questions. `design.md` → always Feature-by-Feature Feasibility, Risks, and Open Questions (they carry the confirmed decisions and the "don't implement this" list), plus your phase's contract section and your own module's entry. `conventions.md` §10 has the procedure. Exceptions by design: `project-manager` owns `plan.md`, `system-analyst` owns `design.md`, and `qa-engineer` reads the Data Model in full every round.
- **QA runs in one of two modes, and says which.** FULL covers every task in the phase and is the only mode that closes one; TARGETED re-checks named fixes plus their blast radius, the shared-code watchlist, the whole-project typecheck/lint/build, and the full schema contract. TARGETED is allowed only after a FULL round left a file manifest to compare against, and it must state what it didn't cover. `.claude/agents/qa-engineer.md` has the rules.
- **Nothing ships unverified.** `devops` refuses to deploy a phase `qa-engineer` hasn't accepted, one whose most recent round was TARGETED, one marked `🔒 Security gate` that `security` never audited, or one with unresolved Critical/Important security findings, without an explicit user override. `security` isn't gated on the mode — it audits the code independently.
- **Only `security` closes a `security` finding.** Each finding carries a `Status` — 🔵 Open, 🟣 Fix claimed, ✅ Fixed (re-audited), ⚪ Accepted. An engineer's fix moves it to 🟣 and no further; `qa-engineer`'s pass is functional and says so itself, so it cannot close one. `devops` blocks on 🔵 and 🟣 alike.
- **No test suite means nothing ever executes the logic.** Tests are opt-in and default to none, so `qa-engineer` verifies by reading code plus `typecheck`/`lint`/`build` — which cannot tell a right answer from a wrong one. When there's no suite, QA lists the specific rules it could only read under `## Unverified Behaviour — undeployed phases`, and `devops` puts that list in front of the user before deploying.
- **Sensitive phases are flagged in writing, not remembered.** `project-manager` marks any phase touching auth, personal data, payments, uploads, or untrusted input as `## Phase N: <name> 🔒 Security gate`; `qa-engineer` can add one PM didn't foresee — writing it into the phase heading itself (its one non-checkbox write to `plan.md`, add-only) as well as listing it in `review.md`; `devops` gates on it. Nobody removes a flag except the user.
- **An unsourced number is an assumption, in writing.** `business-analyst` has no web access by design; external facts come from the user and land in `requirement.md`'s `## References` table with their source. Anything used as a fact without a row there is written `(สมมติฐาน — ยังไม่ยืนยัน)`, and `system-analyst` must resolve it with the user before designing around it instead of promoting it to fact by using it.
- **A fix that fails twice gets escalated, not re-sent.** After the second failed re-check of the same item, `qa-engineer` stops routing it back and hands it to the user — an item that survives two fixes is usually misrouted (a design or business question), not badly implemented.

## Right-size the pipeline — don't run all of it for small work

The full chain is for building something new. Running nine stages for a copy fix is waste, not diligence. Pick the entry point by the size of the change:

| The work is | Start at | Skip |
|---|---|---|
| Copy/styling tweak, or a bug where requirement + schema are already clear | `frontend-engineer` / `backend-engineer` → `qa-engineer` | BA, SA, PM |
| Adds or alters a field/table/relation | `system-analyst` (amend) → engineer → `qa-engineer` | BA, PM |
| Changes a business rule, no schema impact | `business-analyst` (amend) → `system-analyst` (amend) → engineer → `qa-engineer` | PM |
| A new feature, module, or project | `business-analyst`, full chain | nothing |

`project-manager` only earns its run when there's enough work to need phasing. One or two tasks go straight to an engineer.

But **don't skip a stage the change actually needs** — a schema change that bypasses `system-analyst` is the exact failure this pipeline exists to prevent.

## Model and effort per agent

Set in each agent's frontmatter. The split puts the expensive model where a mistake propagates furthest, and the cheap one where the volume is:

| Agent | `model` | `effort` | Why |
|---|---|---|---|
| `setup` | sonnet | low | mechanical, runs once per project |
| `business-analyst` | opus | medium | short output, but an error here contaminates everything downstream |
| `system-analyst` | opus | high | hardest reasoning in the chain; a wrong schema is the costliest mistake available |
| `project-manager` | sonnet | medium | decomposition from an already-confirmed design |
| `frontend-engineer` | sonnet | medium | highest volume, highest output — where the savings actually are |
| `backend-engineer` | sonnet | medium | same |
| `qa-engineer` | sonnet | high | comparison work, so `effort: high` buys more here than the tier does — but note this is the highest-leverage cost decision in the table: with tests opt-in and usually absent, this agent is the *only* correctness guarantee in the chain and nothing re-checks it. `opus` is the upgrade to reach for first if verification starts missing things |
| `security` | opus | high | adversarial reasoning; what it misses, nobody catches |
| `devops` | sonnet | medium | little reasoning, high stakes — guarded by confirmation rules instead |

To change one, edit that agent's frontmatter. `inherit` follows the session's `/model`.

## Fixed stack (summary — the two engineer files are authoritative)

- **Frontend**: Next.js App Router · TypeScript · Tailwind · Zustand
- **Backend**: Node + Express · PostgreSQL · Prisma · REST · hand-rolled JWT · Zod
- **Package manager**: npm
- **Tests**: opt-in — `setup` offers Vitest once and defaults to none. `qa-engineer` runs every check that exists (`typecheck`/`lint`/`build`/`test`) and must state in `review.md` when there are no automated tests, so a ✅ is never mistaken for a tested ✅

Changing the stack means the user confirms it and `frontend-engineer.md`/`backend-engineer.md` get updated in place. Every other agent reads those two files rather than keeping its own copy.

## Coming back to a project

Read `_docs/status.md` first — it says which modules exist, how far each has got, and which agent should pick it up. Then open that module's docs in order: `requirement.md` → `design.md` → `plan.md` (unchecked boxes = remaining work) → `review.md` → `security.md` → `deploy.md`.
