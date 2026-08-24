# Policy — Documentation discipline (§1, §2, §3, §4, §5b, §10, §11)

Split from `.claude/shared/conventions.md` by T49. Everything about where a document lives, how
it's kept current, how it's amended without losing history, how big it's allowed to get before
it taxes every future run, and what language it's written in.

---

## 0. Before writing anything — confirm workspace ↔ lane (T-WG5)

**Every analysis/doc-writing run's first action is `software-team-agents status`, before touching
`§1`'s module-folder resolution.** This isn't optional context-gathering — it's the checkpoint
that catches a session running in the wrong repository before it writes a single file. The
sb-compass incident that motivated this rule (`planning/v2/workspace-guardrails-TASKS.md`) was a
requirement written straight into a Target repo that looked ready but wasn't a Knowledge
workspace at all; nothing asked first.

Read `status`'s output and confirm two things with the user before writing:

1. **This workspace's role matches the work.** BA-lane work (`business-analyst`,
   `system-analyst`, `project-manager`, `test-planner`, `uxui-designer`) writes only from a
   `role: ba` workspace (the Knowledge repo). If `status` reports `role: dev` or no role at all,
   stop and ask — don't write a module doc into a Target.
2. **If `status` prints `WARNING: Knowledge root bound in installation.yaml ... has no
   .agent-team/config.yaml`** (the T-WG1 detector — a Knowledge root is bound but nobody ever ran
   `init --role ba` there), **stop and ask the user before writing any doc file at all**, even
   into a folder that already exists. Writing into an uninitialized Knowledge workspace is exactly
   how the incident happened: the binding looked valid, so nothing else caught it.

This checkpoint is one question, asked once per session, not a rule to re-litigate on every file
write within that session. `setup` and `business-analyst` — the two agents that can create a
module folder from nothing — carry this explicitly in their own prompts (`.claude/agents/setup.md`,
`.claude/agents/business-analyst.md`); every other agent inherits it by resolving the module folder
per `§1` after this checkpoint has already passed.

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
- Module folders share one codebase and one `schema.prisma` (`policies/architecture.md` §7), so cross-folder work needs care: each `design.md` owns its own models, and a relation reaching into another folder's model is allowed but is never redesigned from this side.

When it's genuinely ambiguous, ask the user — and record the reason in `requirement.md` so the next person doesn't re-litigate it.

### The files in a module folder

| File | Written by | Contains |
|---|---|---|
| `requirement.md` | `business-analyst` | business requirements, scope, declined features, references for any external fact |
| `design.md` | `system-analyst` | feasibility verdicts, the confirmed Prisma schema, module breakdown |
| `plan.md` | `project-manager` (task Status: `project-manager` writes rows `pending`, `qa-engineer` sets `verified`/`blocked` — T52; engineers don't edit the table, they report progress in their handoff) | phased task table |
| `review.md` | `qa-engineer` | open issues (all phases) + the current verify round + undeployed phases' `Unverified Behaviour` |
| `review/phase-N.md` | `qa-engineer` | archived verify rounds for phases that are closed — read only on demand |
| `security.md` | `security` | findings, accepted risks |
| `deploy.md` | `devops` | environments, deploy/migration runbook, history |

---

## 2. Keeping `_docs/status.md` current

`_docs/status.md` is the project-wide index: which modules exist, how far each has got, and who should pick it up next. It saves every agent (and the user) from opening four files to answer "where are we?".

**Read it when you start** — it tells you which modules exist and what state they're in, which usually answers the module-resolution question before you have to ask.

**Regenerate it when you finish**, as the last thing you do: run `node .claude/scripts/generate-status.js` with `Bash` (T51). No agent hand-edits `status.md` with `Write`/`Edit` any more — the generator computes every module's `Docs:` line, per-phase table, `**Now**`, and `**Blocked on**` straight from `plan.md`'s task table (T52 — each row's `Status` cell), `review.md`'s `## Review Outcome` `**Status:**` line, `security.md`'s `## Open Findings` table, and `deploy.md`'s Deploy History, so there is nothing left to get out of sync by hand. It preserves the `## Scaffold` line verbatim (that one fact — is this project scaffolded — isn't derivable from any other document, so `setup` is still the one that sets it, and the generator never overwrites it). The output format below is unchanged from before T51 — only who produces it changed.

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

**The `(FULL)`/`(TARGETED)` mode comes straight from `qa-engineer`'s `**Status:**` line in `review.md`** — `generate-status.js` reads it, nobody types it into `status.md` directly any more. That parenthesis is the difference between a phase `devops` can ship and one that needs a full pass first (`.claude/agents/qa-engineer.md` defines the two modes and the gate).

**`status.md` is an index, not a source of truth.** If it ever disagrees with the actual documents, the documents win — and since T51 that's structural, not a discipline an agent has to remember: re-running the generator regenerates `status.md` from whatever the documents currently say, so "correcting" `status.md` means fixing the document it was computed from and regenerating, never hand-editing the index itself.

**`node .claude/scripts/check-status-sync.js` is still useful as an independent second opinion** — it counts `verified` rows per phase in every module's `plan.md` task table (T52) and compares them against what a `status.md` on disk claims. Since `generate-status.js` computes the same `implemented` symbol the same way, the two should never disagree when the generator produced the file you're looking at; `check-status-sync.js` earns its keep on a `status.md` nobody has regenerated yet (manual mode, before this project ran the generator once, or a file someone edited by hand despite the rule above). Not a hook, blocks nothing; run it via `Bash` as a cheap first pass before deciding a phase needs a full `qa-engineer` round.

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
- **A task's Status cell in `plan.md`'s task table (T52) has one writer per value.** `project-manager` writes every new row `pending`, and is the only writer of `in_progress` (an engineer that started the row says so in its handoff, and `project-manager`/`qa-engineer` record it — engineers don't edit `plan.md`; their contracts deny `_docs/module/**`). Only `qa-engineer` sets `verified` or `blocked`, only after inspecting real code. No agent may clear or reorder a row it doesn't own the current value of — and this is exactly why `project-manager` must amend `plan.md` with `Edit` rather than rewriting it.
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

## 5b. Amend, don't regenerate — the mechanical half

§4 says existing docs are amended with `Edit`, never replaced with `Write`. **Enforced** by `.claude/hooks/block-doc-rewrite.js`, which blocks a `Write` to one of the seven per-module docs once it already exists on disk — `Edit`/`MultiEdit` are unaffected, and so is a doc's first creation (file doesn't exist yet). If blocked, use `Edit` on the section that needs to change. (The hook can't tell which agent is calling it — see its comments for why the file-exists check is the right proxy anyway.)

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

**Skip:** `## Feasibility Summary` (an executive summary of sections you're reading anyway), `## Change Log`, and `## Data Model` — read `schema.prisma` for that instead, per `policies/architecture.md` §7, once it exists.

`system-analyst` owns this document and reads it in full when amending. `qa-engineer` reads the Data Model in full every round — see `policies/architecture.md` §7 for why that one isn't optional. `project-manager` also reads the Data Model, because it writes one task per model/migration and needs the model list; it usually runs before scaffold, when `design.md` is the only copy anyway.

### `review.md`

Read **`## Open Issues — all phases`** first — it's at the top for that reason, and for most runs it's the only part you need to act on. Then the current round, for the phase you're working on.

Don't open `review/phase-N.md` as part of startup. Go there only when an `Open Issues` row doesn't give you enough to act on, when something looks like it's re-opening closed work, or when the user asks about history. §4 has the full rule.

### `requirement.md`

Read it in full. It's the shortest of the four, it has no per-phase structure to slice along, and the business rule you skipped is exactly the one you'd have implemented wrong.

---

## 11. Language

Every agent talks to the user in Thai — status updates, questions (`AskUserQuestion` labels/options included), and handoff summaries. **Every document an agent creates is written in Thai too** — `requirement.md`, `design.md`, `plan.md`, `test-plan.md`, `review.md`, `security.md`, `deploy.md`, `status.md`, and their `## Change Log` entries. Keep technical vocabulary in its original English form rather than translating it (model/field names, stack terms like "endpoint"/"migration"/"schema", file paths, code identifiers, code/schema blocks) — translating those makes them harder to match against the actual code and docs, not easier to read.

This governs new content, not a retranslation pass: if a document already exists with content written in another language, amend it per §4 — add or edit your section in Thai — but don't retranslate the rest of the document as a side effect of an unrelated edit. Bringing a whole existing document over to Thai is a deliberate decision the user asks for explicitly.
