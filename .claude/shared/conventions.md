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

### Two things are called "module" — here's which one you mean

- A **module folder** (`_docs/module/sales-crm/`) is a *delivery unit*: its own requirement, design, plan, and review cycle, with its own phase numbering. Only `business-analyst` creates one.
- A **Module** under `design.md`'s `## Modules` is a *sub-grouping of features inside one delivery unit* — `system-analyst` produces these in STATE: GAP_ANALYSIS, and `project-manager` usually turns each into a phase.

They are not interchangeable, and picking the wrong one is expensive in opposite directions: too many folders fragments one product into documents that can't see each other, and too few buries unrelated work in one plan that never finishes.

**The test is whether it has its own business conversation.** A separate module folder is right when the work would get its own requirement interview — a different business purpose, a different set of users, and a scope that could ship (or be cancelled) without the other one changing. If it's the same product being built out feature by feature, it's one folder with several Modules inside `design.md`, however large it gets.

Two consequences worth stating plainly, because they're what makes the choice matter:

- Splitting into folders is **not** a way to manage size. A big product is a big `plan.md` with many phases, not five folders.
- Module folders share one codebase and one `schema.prisma` (§7), so cross-folder work needs care: each `design.md` owns its own models, and a relation reaching into another folder's model is allowed but is never redesigned from this side.

When it's genuinely ambiguous, ask the user — and record the reason in `requirement.md` so the next person doesn't re-litigate it.

### The files in a module folder

| File | Written by | Contains |
|---|---|---|
| `requirement.md` | `business-analyst` | business requirements, scope, declined features, references for any external fact |
| `design.md` | `system-analyst` | feasibility verdicts, the confirmed Prisma schema, module breakdown |
| `plan.md` | `project-manager` (checkboxes: `qa-engineer`) | phased, tagged task list |
| `review.md` | `qa-engineer` | open issues (all phases) + the current verify round + undeployed phases' `Unverified Behaviour` |
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
<!-- once scaffolded, replace with: Scaffolded — Next.js in `web/`, Express API in `api/`, Postgres via Docker Compose · tests: none (verification is code inspection only) -->

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

A phase whose heading in `plan.md` carries `🔒 Security gate` keeps `security ⬜` until `security` has actually audited it. Never mark that one `n/a` — the flag exists precisely because someone already judged that it isn't.

**Record which mode the last verify round used** — `(FULL)` or `(TARGETED)`, exactly as `qa-engineer` reported it. That parenthesis is the difference between a phase `devops` can ship and one that needs a full pass first (`.claude/agents/qa-engineer.md` defines the two modes and the gate). `qa-engineer` writes it; everyone else reads it and never edits it to something more convenient.

**`status.md` is an index, not a source of truth.** If it ever disagrees with the actual documents or code, the documents and code win — correct `status.md` to match and mention the discrepancy to the user. Never make a decision based on `status.md` alone; open the real file.

**`node .claude/scripts/check-status-sync.js` finds that disagreement mechanically.** It counts real checkboxes per phase in every module's `plan.md` and compares them against what `status.md` claims — the `implemented` symbol on each `- Phase N` line, and the `**Now**: ... X of Y unchecked` line — and reports every mismatch. Not a hook, blocks nothing; run it via `Bash` whenever you're about to trust `status.md` for a routing decision, or as a cheap first pass before deciding a phase needs a full `qa-engineer` round.

Don't put dates in `status.md`. It records where things stand right now; dated history belongs in each document's own `## Change Log`.

### Keeping `status.md` small — it's read on every single run, project-wide

Same reasoning as `review.md` in §4, only wider: `review.md` taxes every run *on that module*; `status.md` taxes every run on *every* module, since it's the first thing read to get oriented. A module's section that grows round-by-round narrative becomes a cost every other module's runs pay too.

Each module's section holds exactly:

1. **`Docs:`** — one line, doc status only (✅/⬜, a short "last amended" note if useful)
2. **The per-phase table** — one line per phase, current symbols only (§2's `implemented`/`verified`/`security`/`deployed` row)
3. **`**Now**:`** — the current actionable state, a few sentences
4. **`**Blocked on**:`** — current blockers only, or `—`

Anything more than that — how a decision was reached, a fixed bug's mechanism, a past round's findings, a judgment call's reasoning — belongs in that module's own documents (`design.md`'s `## Change Log`, `review.md`, `security.md`), which already carry it with more authority. Don't duplicate it into `status.md` as running narrative; a status update is a fact about *current state*, not a diary entry about how the run went.

**When a module's section has outgrown this** — superseded "Next step" paragraphs, resolved judgment calls, round-by-round history — move the superseded material verbatim into an archive file next to `status.md` (e.g. `status-archive.md`), the same way `qa-engineer` archives `review.md` rounds into `review/phase-N.md` (§4): move, don't summarize, don't discard, leave a one-line pointer under the module's section. This isn't only `qa-engineer`'s or the pipeline-driver's job — whoever notices the file has grown this way trims it, since every agent that reads `status.md` is who pays for leaving it untrimmed.

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
- **`qa-engineer` may also *add* a `🔒 Security gate` to a phase heading in `plan.md`, never remove one.** `project-manager` can only flag what the design predicted; QA is looking at the code that got built, and `devops` gates on the heading. This is the only other write any agent but `project-manager` makes to `plan.md`.

### Keeping `review.md` small — it is the one document every agent pays for

"Amend, don't regenerate" applies to `review.md` too, but it must not be allowed to grow without limit. Every engineer, `security`, and `devops` run reads it in full, so once a phase is closed its per-task detail is pure cost to everyone downstream — nobody implementing Phase 6 needs to re-read what a Phase 1 bug was.

`review.md` holds exactly four things:

1. **`## Open Issues — all phases`, at the very top** — every unresolved item from *any* phase, as a table: what it is, which phase it came from, which agent it routes to, and whether it's blocking. This section is why nothing gets lost when a round is archived, and it's the first thing an engineer should be able to act on.
2. **The current verify round**, in full detail — including which mode it ran in, and, for a phase that still has open items, the `## Verified File Manifest` the next round needs in order to tell what moved.
3. **`## Unverified Behaviour — undeployed phases`** — only on a project with no test suite: per phase, the rules QA could read but not execute. Kept until the phase is *deployed*, not until its round is archived, because `devops` reads it at deploy time — which is after the phase closed.
4. **`## Archived rounds`** — one pointer line per archived round. A list of links, not content.

Plus the `## Change Log` every document in this pipeline carries — one line per round, with the archived rounds' full entries travelling to the archive file along with them.

When a phase's round is superseded, `qa-engineer` **moves** it — verbatim, never summarized or pruned — into `review/phase-N.md`, carries any still-open item up into `Open Issues`, keeps the phase's `Unverified Behaviour` block behind until it deploys, and leaves a pointer under `## Archived rounds`. Moving is not the same as discarding; the history stays complete and readable, it just stops being loaded by every run.

Sections 1 and 3 are both **outlive-your-round** sections, and they exist for the same failure: something a *later* stage needs, produced by a round that stops being current before that stage runs. Archiving one of those on schedule looks tidy and silently disarms a gate. When in doubt about whether something has been consumed yet, it stays.

The exact section layout, the two verify modes (FULL and TARGETED), and what the manifest is for belong to `qa-engineer` and are defined in `.claude/agents/qa-engineer.md`. It is the only agent that writes any of this; everyone else reads `Open Issues` first and the current round second.

**Do not read `review/phase-N.md` as part of your normal startup.** Read `review.md` only. Open an archive file solely when something specific sends you there — an `Open Issues` row you need the background on, a regression that looks like it's re-opening old work, or the user asking about past history.

### Keeping `design.md`'s always-read sections small

The same reasoning applies to `design.md`, and it hits harder here because §10 makes three of its sections — `## Feature-by-Feature Feasibility`, `## Risks & Dependencies`, `## Unresolved Open Questions` — mandatory reading on *every single run*, not just `system-analyst`'s own. A module that goes through several amend rounds naturally accumulates one question-and-answer table per round in those sections; left alone, each round adds its full reasoning and rejected alternatives on top of the last, and every future run — engineer, `qa-engineer`, `security`, `devops` — pays to read all of it just to find out today's rule.

Once a decision in one of those three sections is closed (the question is answered and the resulting rule now lives in a Contract section, the Data Model, or `## Modules`), its role in the always-read section is done — the *rule* stays in a Contract section where it belongs, but the *question-and-answer record* of how it was reached is done being load-bearing. Move it, verbatim, into a `design-archive.md` next to `design.md`, the same way `qa-engineer` moves a closed round into `review/phase-N.md`: move, don't summarize, don't discard, leave a one-line pointer where it was ("mati ของแต่ละรอบย้ายไปเก็บที่ `design-archive.md` แล้ว — กติกาที่ใช้จริงอยู่ที่ § ... ด้านล่าง"). A decision's reasoning is still fully available, it just stops being loaded by every run that doesn't need it.

This is `system-analyst`'s responsibility on the amend round that closes the decision, the same way archiving a `review.md` round is `qa-engineer`'s job — do it as part of the amend that resolves the question, not as separate cleanup work later. `.claude/agents/system-analyst.md`'s Output section has the template.

### Catching up a document that grew bloated before it was ever archived

The three rules above (`review.md`, `design.md`'s always-read sections, and `status.md` in §2) all assume archiving has been happening round by round. Nothing here retroactively splits a document — if `review.md`, `design.md`, or a `status.md` module section has simply never been archived and is now carrying rounds of history it shouldn't, the agent that notices does a one-time **catch-up round** instead of leaving it for "later":

1. Read the whole document once — the cost is paid once, here, instead of paid partially by every future run that keeps reading the bloat.
2. Decide what's actually closed by that document's own rule: a `review.md` round that's superseded (a later round covers the same phase, or the phase deployed); a `design.md` decision whose rule now lives in a Contract section, the Data Model, or `## Modules`; a `status.md` module section holding anything beyond its four fields (§2).
3. Move the closed material **verbatim** into that document's archive file (`review/phase-N.md`, `design-archive.md`, `status-archive.md`) — never summarize, never prune, exactly the same move as the steady-state rule makes each round.
4. Leave a one-line pointer where the material was, and keep whatever the steady-state rule says must stay behind (`review.md`'s `Open Issues` and `Unverified Behaviour`; `design.md`'s current, still-open decisions; `status.md`'s current four fields).
5. After the catch-up round, the normal per-round discipline (`qa-engineer` for `review.md`, `system-analyst` for `design.md`, whoever notices for `status.md`) is enough to keep it small going forward — catch-up is a one-time correction, not a new recurring job.

This isn't gated behind any specific agent owning the fix: whichever agent's run would otherwise pay to read the bloat is the one authorized to do the catch-up, the same "whoever notices" principle §2 already uses for `status.md`.

---

## 5. Version control

**No agent runs git** — no `init`/`add`/`commit`/`push`/`checkout`/branch/tag, nothing touching `.git/`. Version control is entirely the user's. Writing a git-*related file* (`.gitignore`, a CI workflow) is fine for the agents whose job that is (`setup`, `devops`) — writing a config file isn't running git.

**Enforced, not just requested**: `.claude/hooks/block-git.js` blocks state-changing git commands and any `.git/` access before the call runs; read-only inspection (`status`/`log`/`diff`/`show`) still works. Full reasoning is in the hook's own comments — read it if you're touching the hook, not on every agent run. If you get blocked, don't look for a way around it: tell the user what you wanted to do and let them run it.

## 5a. Stay inside the repo

Every write resolves under this project's root. No agent writes elsewhere, whatever the reason.

**Enforced** by `.claude/hooks/block-outside-repo.js` on `Write`/`Edit`/`MultiEdit`/`NotebookEdit`. Two narrow exceptions exist, both the harness's own mechanisms rather than an agent going off scope (the OS-temp scratchpad, and Claude Code's cross-session memory store) — see the hook's own comments for the exact scoping. If blocked, tell the user what you were trying to write and where, and let them decide.

---

## 5b. Amend, don't regenerate — the mechanical half

§4 says existing docs are amended with `Edit`, never replaced with `Write`. **Enforced** by `.claude/hooks/block-doc-rewrite.js`, which blocks a `Write` to one of the seven per-module docs once it already exists on disk — `Edit`/`MultiEdit` are unaffected, and so is a doc's first creation (file doesn't exist yet). If blocked, use `Edit` on the section that needs to change. (The hook can't tell which agent is calling it — see its comments for why the file-exists check is the right proxy anyway.)

## 5c. An engineer doesn't hand off red code

The dev↔QA round trip is the most expensive thing in this pipeline: a type error `qa-engineer` finds costs a full fresh-context QA run plus a full fresh-context engineer run to fix — and the round after that costs the same again. So `typecheck`/`lint` (plus this repo's two drift scripts) run **before an engineer is allowed to finish**, not after: `.claude/hooks/require-green-before-stop.js` blocks the finish while they're red on a run that touched application code. It forces at most one in-context fix attempt and can never trap you — the next attempt is let through regardless. **It's not a licence to improvise**: if a failure isn't yours to fix (a schema gap, a contract question you must not invent an answer to per §7), say so in your handoff instead of editing around it. Full reasoning — including why "did app code change?" stands in for agent identity — is in the hook's own comments. `build`/`test` stay with `qa-engineer`: too slow to pay for on every stop.

## 5c-1. An agent doesn't hand off a hardcoded secret

Same shape and same cadence as §5c, a separate hook because it catches a different mistake: `.claude/hooks/block-secret-leak.js` scans every file a run changed (git diff/ls-files, read-only) for a curated set of secret-shaped patterns — AWS access key IDs, private-key blocks, database connection strings with a real (non-placeholder) embedded password, and hardcoded `api_key`/`secret`/`token`/`password` literal assignments — and blocks the Stop if it finds one. `.env` is excluded (it's the convention-approved, gitignored place for real values); `.env.example` is not (it's committed by convention and must hold only placeholders). `.claude/` itself is excluded too — its hooks/scripts/self-test deliberately contain secret-shaped literals as their own test fixtures, so scanning it would be self-referential. Same never-trap guarantee as §5c: `stop_hook_active` releases the block on the second attempt.

## 5d. The guards are themselves tested

§5–5c-1 are the only rules here that don't depend on an agent remembering them — the load-bearing part of the design. `node .claude/tests/run.js` exercises every hook and every checker script.

**Run it after editing anything under `.claude/hooks/` or `.claude/scripts/`.** A hook with a syntax error exits 1, not 2 — and `PreToolUse` only blocks on exit 2 — so a typo makes a guard **fail open**: still wired up, still looking installed, enforcing nothing. That happened once for real. A failing guard is worse than no guard, because it buys false confidence — treat a red run as blocking.

## 6. Handoffs

**No agent invokes the next agent.** This is structural, not just a rule: none of the ten agents has the `Agent` tool in its own toolset, so none of them can call another one even if it wanted to. Every run ends the same way — telling the user (or the session driving the pipeline) what was produced, what state it leaves the module in, and which agent should pick it up next — then stops. What differs between the two modes below is **who decides to make that next call**, not whether an agent is allowed to make it itself. It never is.

### Manual mode (the default)

The user reads each agent's report and decides, explicitly, whether and when to invoke the next stage. Never assume your own output was accepted, never act as if "and now QA runs on it" was decided for you, and never act on behalf of the user's decision about routing. This stays the default because it's the safest one — nothing moves without a person having seen it.

### Autonomous mode (opt-in, per run)

When the user explicitly asks for a continuous or unattended run — e.g. "รันข้ามคืนได้เลย", "เชื่อมต่อเนื่องไปเลยไม่ต้องถามทุกจุด", "let this run overnight" — the session orchestrating the pipeline (not the subagents themselves; see above, they still can't call each other) invokes each next stage itself as soon as the current one finishes cleanly, following the same routing table below, instead of waiting for the user to ask for every single stage by name.

This is opt-in per run, not a standing setting. Say it again next time you want it; a green light for one overnight run isn't a standing green light for every run after it.

**Exception, standing in every mode: `qa-engineer` and `security` are never auto-chained.** They only run when the user explicitly asks for them by name or by an equivalent request ("ตรวจงานหน่อย", "verify ให้หน่อย", "security review", ฯลฯ) — not automatically just because `frontend-engineer`/`backend-engineer` finished a phase, and not automatically just because a QA round finished on a sensitive module, even in autonomous mode. This is the opposite direction from the five points below (which are "pipeline drives itself, but stops here for a person"): here the pipeline never drives itself into these two stages at all — a person has to name them, every time. Once the user has explicitly asked for one, everything else about it (its own internal FULL/TARGETED gating, its own escalation rules) still applies unchanged.

**Five points always stop and wait for a real person, in both modes — autonomous mode does not remove them, it just means the pipeline drives itself up to them instead of a person driving it there:**

1. **`business-analyst`, any time it runs.** Whether it's the first interview on a blank project or a business-logic dead end routed to it mid-pipeline, its job is asking a human questions it cannot answer itself. There is no autonomous version of that — the run pauses here and picks back up once a person answers.
2. **`system-analyst`'s schema/feasibility confirmation.** §7 calls the Data Model a contract precisely because a person confirmed it — a schema nobody looked at is not a contract, it's a guess that everything downstream will treat as settled. This step waits for confirmation in both modes.
3. **`qa-engineer`, the moment a phase comes back ⚠️ Partial or ❌ Failed.** Autonomous mode may drive an automatic fix-and-reverify cycle back through the responsible engineer — but only up to the re-check ceiling already defined in `qa-engineer.md` (two rounds). Hitting that ceiling, or hitting a routing decision that needs `system-analyst`/`business-analyst`, stops the run and reports rather than continuing to loop. A phase where every task is ✅ Verified in a FULL round may continue automatically without a separate accept/reject prompt — see `qa-engineer.md` for exactly when that applies.
4. **`security`, any 🔴 Critical or 🟠 Important finding.** Accepting a security risk is a business decision, not an engineering one, and this pipeline doesn't make that call unattended. 🟡 Minor findings may be logged as deferred and the run continues past them.
5. **`devops`, the actual deploy or migration command, against any environment.** Generating a Dockerfile, a CI workflow, or a migration dry-run may proceed automatically; running it against something real never does — this is the same "confirm before a hard-to-reverse, outward-facing action" rule the top-level instructions already require, and autonomous mode doesn't waive it.

Outside those five, a stage that genuinely can't proceed without a human decision — `project-manager` hitting a sequencing ambiguity it can't resolve from `design.md`, `system-analyst` hitting an ambiguity mid-analysis — still stops, in either mode. That's not a mode setting; it's just an agent that has run out of things it can decide for itself.

The normal flow, and the loops back:

```
setup (once per project)
   ↓
business-analyst → system-analyst → project-manager → backend-engineer → frontend-engineer
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

## 6a. `backend-engineer` before `frontend-engineer`, never at the same time

A phase's `[frontend]` tasks are not an independent track from its `[backend]` tasks — the frontend reads its types and API calls off what the backend *actually built* (a route's real request/response shape), not off `design.md`'s Data Model alone, which describes storage, not wire format. Running both engineers at once on the same phase means `frontend-engineer` has nothing real to read yet and has to guess the contract. That guess is exactly what produced the `staff-roles/sync` response-shape mismatch in `hkt`'s `crm-ai-support` module (`created`/`reactivated`/`deactivated`/`unchanged` guessed by the frontend session while the backend session — running concurrently — actually shipped `processed`/`failed`) — caught only after the fact, and it cost a dedicated fix round on top of both engineer runs.

**Within a phase, always run `backend-engineer` to completion first, then `frontend-engineer`.** This applies in both manual and autonomous mode — it isn't one of the five points that stop for a person (§6), because it isn't a decision at all, it's an ordering rule like any other in this file: the pipeline (or the user) simply invokes them in that order instead of together.

The one exception: tasks in the same phase that share no API contract — a frontend-only styling task and an unrelated backend task — can run in either order or the same session, since there's no contract to guess at. The rule is about tasks that share a contract within one phase, not a blanket ban on touching both halves in one sitting.

---

## 7. The design is the contract

`design.md`'s Data Model section is the confirmed Prisma schema, agreed with the user by `system-analyst`. `backend-engineer` implements it verbatim, `frontend-engineer` derives its types from it, `qa-engineer` fails any drift from it.

No agent invents, renames, or "improves" a field, type, or relation. If a task needs something the schema doesn't cover, stop and route it back to `system-analyst` — don't improvise a schema change and don't work around the gap.

**Once `setup` has written the real `schema.prisma`, that file is the contract's working copy** — `design.md`'s Data Model stays the authority, but the engineers work from `schema.prisma`, which is the file their queries and types actually have to agree with, and which they have open anyway. Reading both is reading the same contract twice.

That only holds because one agent keeps them equal: **`qa-engineer` reads both and compares them field by field**, and an unexplained divergence is a ❌ — a field in `schema.prisma` that no module's `design.md` accounts for is exactly the improvised schema change this rule exists to catch. **Every model in this module's `design.md` Data Model must exist in `schema.prisma` and match field for field** — a missing model, a renamed field, a changed type, a dropped relation, all ❌, and that direction is absolute regardless of module count.

**If `_docs/module/` has more than one folder**, a model in `schema.prisma` that *this* module's `design.md` doesn't declare isn't automatically a ❌ — it may belong to another module, and deciding that needs an ownership check before you flag it. Read `.claude/shared/multi-module-schema-scoping.md` for the exact procedure the moment you're in that situation; skip it entirely on a single-module project, where every model in `schema.prisma` belongs to your one `design.md` by definition and the rule above already covers you completely.

So:

- Before scaffold (`schema.prisma` doesn't exist yet): `setup`/`backend-engineer` read `design.md`'s Data Model. It's the only copy.
- After scaffold: engineers read `schema.prisma` for the models their task touches, and go to `design.md`'s Data Model only when they need the reasoning behind a field rather than its shape.
- `qa-engineer` always reads both, in full, for the phase it's verifying. It is the only agent that does, and that is deliberate — not a step to optimize away.

If `schema.prisma` and `design.md` disagree, **`design.md` wins and the code is wrong** — route it to `system-analyst` if the design turns out to be the thing that's wrong, never by editing `design.md` to match whatever got built.

**Only two agents ever write `schema.prisma`**: `setup` seeds it from `design.md`'s Data Model at scaffold time, and `backend-engineer` changes it afterwards — and only to bring it in line with a Data Model `system-analyst` has already amended and the user has already confirmed. A schema amendment isn't finished when `design.md` is saved; it lands when `backend-engineer` propagates it and `qa-engineer` confirms the two match again.

**`node .claude/scripts/check-schema-contract.js` does this comparison mechanically.** It parses every module's `design.md` Data Model and the real `schema.prisma`, diffs `model` blocks field by field, and reports unclaimed models (in `schema.prisma`, declared by no module) as the improvised-change ❌ this section describes — the cross-module "who owns this" lookup included, instead of a per-module `Grep`. It's not a hook and blocks nothing; it's a script `qa-engineer` runs via `Bash` as an aid to the manual comparison this section requires, not a replacement for reading the phase's actual models — it's a regex-based parser, not a real Prisma parser, and says so when something didn't parse.

---

## 8. Right-sizing the pipeline

The full chain exists for building something new. **Running all of it for a small change is waste, not diligence** — every stage costs a model run, and a two-line copy fix does not need a requirements interview.

Match the entry point to the size of the change:

| The work is | Start at | Skip |
|---|---|---|
| Copy/styling tweak, or a bug where the requirement and schema are already clear | `backend-engineer` (if it touches the API) → `frontend-engineer` → `qa-engineer` | `business-analyst`, `system-analyst`, `project-manager` |
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

**Always read**, whatever your phase is, because these carry decisions and prohibitions that don't repeat anywhere else — and because they're mandatory reading on every run, `system-analyst` keeps them archived per §4's "Keeping `design.md`'s always-read sections small": a closed decision's rule lives in a Contract section, and only a one-line pointer to `design-archive.md` remains here, not the full question-and-answer record:

- **`## Feature-by-Feature Feasibility`** — current feasibility verdict per feature and which dependencies the design actually sanctioned
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

---

## 11. Language

Every agent talks to the user in Thai — status updates, questions (`AskUserQuestion` labels/options included), and handoff summaries. **Every document an agent creates is written in Thai too** — `requirement.md`, `design.md`, `plan.md`, `test-plan.md`, `review.md`, `security.md`, `deploy.md`, `status.md`, and their `## Change Log` entries. Keep technical vocabulary in its original English form rather than translating it (model/field names, stack terms like "endpoint"/"migration"/"schema", file paths, code identifiers, code/schema blocks) — translating those makes them harder to match against the actual code and docs, not easier to read.

This governs new content, not a retranslation pass: if a document already exists with content written in another language, amend it per §4 — add or edit your section in Thai — but don't retranslate the rest of the document as a side effect of an unrelated edit. Bringing a whole existing document over to Thai is a deliberate decision the user asks for explicitly.

---

## 12. Verify against real state, not memory

A recalled fact — from an earlier turn in the same run, from a summary, from "I remember this project does X" — is a hypothesis, not a fact. Every agent (and whoever is driving the session) reads the actual current file, schema, or code before stating something as true or acting on it.

This matters more than it looks: a recollection is never automatically revalidated the way a file is. An error made once at recall time can silently outlive the file it was drawn from — the file gets edited, the wrong belief doesn't.

There's also no good reason to lean on recall in the first place: this pipeline already keeps its own memory, in files — `status.md` for where things stand, `plan.md`/`design.md`/`review.md` for what was decided and why, each with a `## Change Log` — updated with discipline (§4) precisely so nobody has to hold state in their head. An agent's own recollection is a worse copy of something the project already tracks properly; reach for the file, not the memory. This is the same discipline §2 already applies to `status.md` ("an index, not a truth" — the real docs win on disagreement) and the one every agent invokes when it says "don't work from memory" about `conventions.md` itself; it generalizes to any recalled fact, not just those two. Whenever a stated fact and the current file/code disagree, the file/code wins, and the stale belief is corrected on the spot rather than carried forward.
