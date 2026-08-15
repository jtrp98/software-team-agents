# AgentClaude — Agent Pipeline

This repo defines a fixed, hand-off-based agent pipeline for building a project from a vague idea through to verified, security-reviewed, deployed code. Each stage is a subagent under `.claude/agents/`, each owns exactly one artifact, and **no agent ever invokes the next one** — the user decides every handoff.

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
| `business-analyst` | business requirements | `review.md`, `design.md` | `requirement.md` |
| `system-analyst` | feasibility + data model | `requirement.md`, `review.md`, stack files | `design.md` |
| `project-manager` | phased task list | `design.md`, `requirement.md`, stack files | `plan.md` |
| `frontend-engineer` | UI code | `plan.md`, `design.md`, `requirement.md`, `review.md` | app code |
| `backend-engineer` | API/DB code | `plan.md`, `design.md`, `requirement.md`, `review.md` | app code |
| `qa-engineer` | verification | all four docs + `schema.prisma` + real code | `review.md`, `review/phase-N.md`, `[x]` in `plan.md` |
| `security` | security audit | `requirement.md`, `design.md`, `review.md`, real code | `security.md` |
| `devops` | deploy, CI, migrations | `review.md`, `security.md`, `schema.prisma`, stack files | `deploy.md`, infra files |

`setup` runs once per project, before Phase 1. Everything after that loops per phase.

## Where things live

```
_docs/
├── status.md                    ← the index: what exists, how far it's got, who's next
└── module/
    └── sales-crm/
        ├── requirement.md       ← business-analyst
        ├── design.md            ← system-analyst
        ├── plan.md              ← project-manager  (checkboxes: qa-engineer)
        ├── review.md            ← qa-engineer  (open issues + current round only)
        ├── review/
        │   └── phase-N.md       ← qa-engineer  (archived rounds — read on demand only)
        ├── security.md          ← security
        └── deploy.md            ← devops

.claude/
├── shared/conventions.md        ← rules every agent follows
└── agents/*.md                  ← the nine agents
```

Nothing is written at the repo root. Every doc agent resolves its module folder first: one folder → use it; several → ask the user; none → send them back to `business-analyst`.

## Rules that hold across every agent

Full text in `.claude/shared/conventions.md`; the short version:

- **No agent chains to the next.** Each finishes by saying what's ready and who should get it, then stops.
- **No git, ever.** No agent runs git or touches `.git`. `setup`/`devops` may *write* a `.gitignore` or CI file — that's writing a file, not running git.
- **`design.md`'s Data Model is the contract.** `backend-engineer` implements it verbatim, `frontend-engineer` derives types from it, `qa-engineer` fails any drift. A gap goes back to `system-analyst`, never gets improvised. Once `setup` has written the real `schema.prisma`, the engineers work from that file — it's the contract's working copy and the one their queries must agree with — and `qa-engineer` is the agent that reads both and keeps them equal. If they ever disagree, `design.md` wins and the code is wrong. Only `setup` (at scaffold) and `backend-engineer` (propagating a confirmed amendment) ever write `schema.prisma`.
- **Only `qa-engineer` marks tasks done.** It sets `[x]` in `plan.md` after inspecting real code; nobody else touches a checkbox.
- **Amend, don't regenerate.** Existing docs are updated with `Edit`, section by section, with a dated line appended to their `## Change Log`. Never a full rewrite.
- **`review.md` stays small.** It holds `Open Issues — all phases` plus the current verify round only; `qa-engineer` moves closed rounds verbatim into `review/phase-N.md`. Every engineer/`security`/`devops` run reads `review.md` in full, so closed-phase detail left in it is a tax on the whole pipeline. Nobody opens an archive file as part of normal startup.
- **Dates come from the user.** No agent can reliably know today's date, so any agent writing a dated entry asks first and reuses that answer for the session.
- **`status.md` is an index, not a truth.** If it disagrees with the docs or the code, the docs and code win. It's also where an agent looks up which phase is in play, instead of scanning `plan.md` to work it out, and where `qa-engineer` stamps each phase's verify mode — `(FULL)` / `(TARGETED)` — for `devops` to gate on.
- **Read the section, not the file.** Every agent starts from a fresh context, so a whole-file read is a cost paid again on every run. `plan.md` → Plan Summary + your phase + Sequencing Notes + Open Questions. `design.md` → always Feature-by-Feature Feasibility, Risks, and Open Questions (they carry the confirmed decisions and the "don't implement this" list), plus your phase's contract section and your own module's entry. `conventions.md` §10 has the procedure. Exceptions by design: `project-manager` owns `plan.md`, `system-analyst` owns `design.md`, and `qa-engineer` reads the Data Model in full every round.
- **QA runs in one of two modes, and says which.** FULL covers every task in the phase and is the only mode that closes one; TARGETED re-checks named fixes plus their blast radius, the shared-code watchlist, the whole-project typecheck/lint/build, and the full schema contract. TARGETED is allowed only after a FULL round left a file manifest to compare against, and it must state what it didn't cover. `.claude/agents/qa-engineer.md` has the rules.
- **Nothing ships unverified.** `devops` refuses to deploy a phase `qa-engineer` hasn't accepted, one whose most recent round was TARGETED, or one with unresolved Critical/Important security findings, without an explicit user override. `security` isn't gated on the mode — it audits the code independently.

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
| `qa-engineer` | sonnet | high | comparison work, but it's the safety net — pay for the thinking, not the tier |
| `security` | opus | high | adversarial reasoning; what it misses, nobody catches |
| `devops` | sonnet | medium | little reasoning, high stakes — guarded by confirmation rules instead |

To change one, edit that agent's frontmatter. `inherit` follows the session's `/model`.

## Fixed stack (summary — the two engineer files are authoritative)

- **Frontend**: Next.js App Router · TypeScript · Tailwind · Zustand
- **Backend**: Node + Express · PostgreSQL · Prisma · REST · hand-rolled JWT · Zod
- **Package manager**: npm
- **Tests**: none set up — don't add a framework unless asked

Changing the stack means the user confirms it and `frontend-engineer.md`/`backend-engineer.md` get updated in place. Every other agent reads those two files rather than keeping its own copy.

## Coming back to a project

Read `_docs/status.md` first — it says which modules exist, how far each has got, and which agent should pick it up. Then open that module's docs in order: `requirement.md` → `design.md` → `plan.md` (unchecked boxes = remaining work) → `review.md` → `security.md` → `deploy.md`.
