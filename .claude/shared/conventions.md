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
| `review.md` | `qa-engineer` | per-task verification results, issues, routing |
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
- Phase 1 — implemented ✅ · verified ✅ · security ✅ · deployed ✅
- Phase 2 — implemented ⬜ · verified ⬜ · security ⬜ · deployed ⬜

**Now**: Phase 2 `[backend]` tasks — 4 of 7 unchecked in `plan.md`
**Blocked on**: —
```

Use `✅` done · `⬜` not started/in progress · `⚠️` done with open issues · `n/a` not applicable.

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
