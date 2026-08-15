# Shared Agent Conventions

Every agent in this project reads this file **before doing anything else** and follows it. It is the single authoritative source for the rules below — the individual agent files deliberately don't repeat them, so don't work from memory or from an older copy you've seen elsewhere.

---

## 1. Resolving the module folder

All project documents live under `_docs/module/<kebab-name>/` — never at the repo root — so past work stays intact instead of getting overwritten by the next thing built.

**`business-analyst` is the only agent that may create a module folder.** Every other agent resolves an existing one:

- **Exactly one folder exists under `_docs/module/`** → use it.
- **More than one exists** → ask the user which module this work is for, listing the folder names as options. Never guess, and never infer it from which folder was modified most recently.
- **None exist** → stop and tell the user to run `business-analyst` first. Don't invent requirements, a design, or a plan to fill the gap.

`business-analyst` additionally: if nothing exists yet, pick a short kebab-case name from the idea the user described (ask them to confirm or rename it if it isn't obvious), then create the folder. If modules already exist, work out whether the user is starting something new or amending an existing one — ask explicitly if it isn't obvious.

Once resolved, **every** read and write for that run happens inside that folder.

### The files in a module folder

| File | Written by | Contains |
|---|---|---|
| `requirement.md` | `business-analyst` | business requirements, scope, declined features |
| `design.md` | `system-analyst` | feasibility verdicts, the confirmed Prisma schema, module breakdown |
| `plan.md` | `project-manager` (checkboxes: `qa-engineer`) | phased, tagged task list |
| `review.md` | `qa-engineer` | open issues (all phases) + the current verify round only |
| `review/phase-N.md` | `qa-engineer` | archived verify rounds for phases that are closed — read only on demand |
| `security.md` | `security` | findings, accepted risks |
| `deploy.md` | `devops` | environments, deploy/migration runbook, history |

---

## 2. Keeping `_docs/status.md` current

`_docs/status.md` is the project-wide index: which modules exist, how far each has got, and who should pick it up next. It saves every agent (and the user) from opening four files to answer "where are we?".

**Read it when you start** — it tells you which modules exist and what state they're in, which usually answers the module-resolution question before you have to ask.

**Update it when you finish**, as the last thing you do, with `Edit`. Change only the lines your run actually affected. If the file doesn't exist yet, create it with `Write` using the format below.

```markdown
# Project Status

## Scaffold
Not scaffolded yet — run the `setup` agent before Phase 1.
<!-- once scaffolded, replace with: Scaffolded — Next.js in `web/`, Express API in `api/`, Postgres via Docker Compose -->

## Modules

| Module | Stage | Next agent |
|---|---|---|
| sales-crm | Phase 2 implementation | backend-engineer |
| attendance | Accepted, deployed to staging | — |

## sales-crm

Docs: requirement ✅ · design ✅ · plan ✅
- Phase 1 — implemented ✅ · verified ✅ (FULL) · security ✅ · deployed ✅
- Phase 2 — implemented ✅ · verified ⚠️ (TARGETED) · security ⬜ · deployed ⬜

**Now**: Phase 2 `[backend]` tasks — 4 of 7 unchecked in `plan.md`
**Blocked on**: —
```

Use `✅` done · `⬜` not started/in progress · `⚠️` done with open issues · `n/a` not applicable.

**Record which mode the last verify round used** — `(FULL)` or `(TARGETED)`, exactly as `qa-engineer` reported it. That parenthesis is the difference between a phase `devops` can ship and one that needs a full pass first (`.claude/agents/qa-engineer.md` defines the two modes and the gate). `qa-engineer` writes it; everyone else reads it and never edits it to something more convenient.

**`status.md` is an index, not a source of truth.** If it ever disagrees with the actual documents or code, the documents and code win — correct `status.md` to match and mention the discrepancy to the user. Never make a decision based on `status.md` alone; open the real file.

Don't put dates in `status.md`. It records where things stand right now; dated history belongs in each document's own `## Change Log`.

---

## 3. Dates

You do not reliably know today's date, and most agents have no tool that can tell them. Before writing any dated entry (a `## Change Log` line, a declined feature, an accepted risk, a deploy record), **ask the user what today's date is** and use exactly what they give you, in `YYYY-MM-DD` format.

Ask once per session and reuse that date for the rest of the session. Never invent one, never estimate from context, and never copy the date off an existing entry in the file.

---

## 4. Amending existing documents

Once a document exists, you are amending it, not regenerating it.

- Update only the sections your change actually affects, **using `Edit`**. Never rewrite a whole document with `Write` in amend mode — that silently destroys history and other agents' work.
- Append a dated line to that document's `## Change Log`; never rewrite or prune existing entries.
- Confirm a changed section with the user before saving it.
- **Checkboxes in `plan.md` belong to `qa-engineer` alone.** It sets `[ ]` → `[x]` only after inspecting real code. No other agent may set, clear, or reorder a checkbox — and this is exactly why `project-manager` must amend `plan.md` with `Edit` rather than rewriting it.

### Keeping `review.md` small — it is the one document every agent pays for

"Amend, don't regenerate" applies to `review.md` too, but it must not be allowed to grow without limit. Every engineer, `security`, and `devops` run reads it in full, so once a phase is closed its per-task detail is pure cost to everyone downstream — nobody implementing Phase 6 needs to re-read what a Phase 1 bug was.

`review.md` holds exactly three things:

1. **`## Open Issues — all phases`, at the very top** — every unresolved item from *any* phase, as a table: what it is, which phase it came from, which agent it routes to, and whether it's blocking. This section is why nothing gets lost when a round is archived, and it's the first thing an engineer should be able to act on.
2. **The current verify round**, in full detail — including which mode it ran in, and, for a phase that still has open items, the `## Verified File Manifest` the next round needs in order to tell what moved.
3. **`## Archived rounds`** — one pointer line per archived round. A list of links, not content.

Plus the `## Change Log` every document in this pipeline carries — one line per round, with the archived rounds' full entries travelling to the archive file along with them.

When a phase's round is superseded, `qa-engineer` **moves** it — verbatim, never summarized or pruned — into `review/phase-N.md`, carries any still-open item up into `Open Issues`, and leaves a pointer under `## Archived rounds`. Moving is not the same as discarding; the history stays complete and readable, it just stops being loaded by every run.

The exact section layout, the two verify modes (FULL and TARGETED), and what the manifest is for belong to `qa-engineer` and are defined in `.claude/agents/qa-engineer.md`. It is the only agent that writes any of this; everyone else reads `Open Issues` first and the current round second.

**Do not read `review/phase-N.md` as part of your normal startup.** Read `review.md` only. Open an archive file solely when something specific sends you there — an `Open Issues` row you need the background on, a regression that looks like it's re-opening old work, or the user asking about past history.

---

## 5. Version control

**No agent runs git.** No `git init`, `add`, `commit`, `push`, `checkout`, branch or tag operations, and nothing that touches `.git/`. Version control is entirely the user's.

Writing a *file* that happens to relate to git — `.gitignore`, a CI workflow YAML — is allowed for the agents whose job that is (`setup`, `devops`). Writing a config file is not running git.

---

## 6. Handoffs

**No agent invokes the next agent.** Every run ends by telling the user what was produced, what state it leaves the module in, and which agent should pick it up — then stops. The user decides every handoff, including whether to accept a result at all.

Never assume your own output was accepted, never chain "and now I'll run QA on it", and never act on behalf of the user's decision about routing.

The normal flow, and the loops back:

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

---

## 7. The design is the contract

`design.md`'s Data Model section is the confirmed Prisma schema, agreed with the user by `system-analyst`. `backend-engineer` implements it verbatim, `frontend-engineer` derives its types from it, `qa-engineer` fails any drift from it.

No agent invents, renames, or "improves" a field, type, or relation. If a task needs something the schema doesn't cover, stop and route it back to `system-analyst` — don't improvise a schema change and don't work around the gap.

**Once `setup` has written the real `schema.prisma`, that file is the contract's working copy** — `design.md`'s Data Model stays the authority, but the engineers work from `schema.prisma`, which is the file their queries and types actually have to agree with, and which they have open anyway. Reading both is reading the same contract twice.

That only holds because one agent keeps them equal: **`qa-engineer` reads both and compares them field by field**, and any divergence is a ❌ — a field in `schema.prisma` that `design.md` doesn't have is exactly the improvised schema change this rule exists to catch. So:

- Before scaffold (`schema.prisma` doesn't exist yet): `setup`/`backend-engineer` read `design.md`'s Data Model. It's the only copy.
- After scaffold: engineers read `schema.prisma` for the models their task touches, and go to `design.md`'s Data Model only when they need the reasoning behind a field rather than its shape.
- `qa-engineer` always reads both, in full, for the phase it's verifying. It is the only agent that does, and that is deliberate — not a step to optimize away.

If `schema.prisma` and `design.md` disagree, **`design.md` wins and the code is wrong** — route it to `system-analyst` if the design turns out to be the thing that's wrong, never by editing `design.md` to match whatever got built.

**Only two agents ever write `schema.prisma`**: `setup` seeds it from `design.md`'s Data Model at scaffold time, and `backend-engineer` changes it afterwards — and only to bring it in line with a Data Model `system-analyst` has already amended and the user has already confirmed. A schema amendment isn't finished when `design.md` is saved; it lands when `backend-engineer` propagates it and `qa-engineer` confirms the two match again.

---

## 8. Right-sizing the pipeline

The full chain exists for building something new. **Running all of it for a small change is waste, not diligence** — every stage costs a model run, and a two-line copy fix does not need a requirements interview.

Match the entry point to the size of the change:

| The work is | Start at | Skip |
|---|---|---|
| Copy/styling tweak, or a bug where the requirement and schema are already clear | `frontend-engineer` / `backend-engineer` → `qa-engineer` | `business-analyst`, `system-analyst`, `project-manager` |
| A change that adds or alters a field/table/relation | `system-analyst` (amend mode) → engineer → `qa-engineer` | `business-analyst`, `project-manager` |
| A change to business rules, but no schema impact | `business-analyst` (amend) → `system-analyst` (amend) → engineer → `qa-engineer` | `project-manager` |
| A new feature, module, or project | `business-analyst`, full chain | nothing |

`project-manager` is only needed when there's enough work to need phasing and ordering. One or two tasks don't need a plan — the user can hand them straight to an engineer.

**If you were invoked for work clearly below your stage's threshold, say so before doing it.** Tell the user which agent would handle it more cheaply and let them decide. Don't silently run a full interview or a full re-analysis for a one-line change — but don't refuse either; if they confirm, proceed.

The reverse is also a rule: **don't skip a stage that the change actually needs**. A schema change that bypasses `system-analyst` is exactly the failure this pipeline exists to prevent. Right-sizing means matching the entry point to the work, not cutting corners on work that needs the full chain.

## 9. The stack is fixed and lives in two files

`.claude/agents/frontend-engineer.md` and `.claude/agents/backend-engineer.md` hold the authoritative "Fixed project stack" sections. Any agent that needs to know the stack **reads those files** rather than assuming — the user can change the stack, and those two files get updated in place when they do.

Only `frontend-engineer` and `backend-engineer` may edit their own stack sections, and only after the user explicitly confirms the change.

---

## 10. Read only the part of a document your run needs

Every agent runs with a fresh context and pays to read these documents again from scratch. That cost isn't one-off — it's the base that every turn of your run carries. Reading a whole document when you need one section of it is the single most repeated waste in this pipeline, so read deliberately.

This does **not** mean skimming or guessing. It means knowing which section answers your question and reading that section completely.

### `plan.md`

Read: the **`## Plan Summary`**, **your phase's block**, **`## Sequencing Notes`**, and **`## Unresolved Open Questions`**. Skip other phases' task lists and the `## Change Log`.

How, without reading the file to find out where things are:

1. **Which phase?** Take it from the user. If they didn't say, `_docs/status.md` names the phase in play — that's what the index is for. If it's still ambiguous, ask. Don't scan `plan.md` to work it out.
2. `Grep` for `^## ` with `-n` on `plan.md` — a dozen lines that give you every section's start line.
3. `Read` with `offset`/`limit` for each of the four ranges above.

Nothing is lost by skipping the other phases: cross-phase dependencies live in `Sequencing Notes`, which you always read, and unfinished work from an earlier phase surfaces in `review.md`'s `## Open Issues — all phases`, which you also always read. If the user asks you to work across several phases, read each of those phases' blocks — the rule is "the phases your run touches", not "exactly one".

`project-manager` is the exception: it owns `plan.md` and reads it in full when amending, because it has to place new work in the right order relative to everything already there.

### `design.md`

Same technique — `Grep` for `^## ` to get the section map, then `Read` the ranges you need.

**Always read**, whatever your phase is, because these carry decisions and prohibitions that don't repeat anywhere else:

- **`## Feature-by-Feature Feasibility`** — including its "การตัดสินใจที่ผู้ใช้ยืนยันแล้ว" table of confirmed decisions, and which dependencies the design actually sanctioned
- **`## Risks & Dependencies`** — several mitigations in there are implementation instructions, not commentary
- **`## Unresolved Open Questions`** — this is where "explicitly cut from scope, do not implement without amending first" lives

**Read the parts that match your phase:**

- the contract section your phase implements — `## Import Rules`, `## KPI & Scoring Rules`, or whatever the module's equivalents are named. Read it in full; these are contracts, not summaries.
- your module's entry under `## Modules` — not the other modules'

**Skip:** `## Feasibility Summary` (an executive summary of sections you're reading anyway), `## Change Log`, and `## Data Model` — read `schema.prisma` for that instead, per §7, once it exists.

`system-analyst` owns this document and reads it in full when amending. `qa-engineer` reads the Data Model in full every round — see §7 for why that one isn't optional. `project-manager` also reads the Data Model, because it writes one task per model/migration and needs the model list; it usually runs before scaffold, when `design.md` is the only copy anyway.

### `review.md`

Read **`## Open Issues — all phases`** first — it's at the top for that reason, and for most runs it's the only part you need to act on. Then the current round, for the phase you're working on.

Don't open `review/phase-N.md` as part of startup. Go there only when an `Open Issues` row doesn't give you enough to act on, when something looks like it's re-opening closed work, or when the user asks about history. §4 has the full rule.

### `requirement.md`

Read it in full. It's the shortest of the four, it has no per-phase structure to slice along, and the business rule you skipped is exactly the one you'd have implemented wrong.
