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

---

## 5. Version control

**No agent runs git.** No `git init`, `add`, `commit`, `push`, `checkout`, branch or tag operations, and nothing that touches `.git/`. Version control is entirely the user's.

Writing a *file* that happens to relate to git — `.gitignore`, a CI workflow YAML — is allowed for the agents whose job that is (`setup`, `devops`). Writing a config file is not running git.

**This one is enforced, not just requested.** `.claude/hooks/block-git.js`, wired as a `PreToolUse` hook in `.claude/settings.json`, blocks state-changing git commands and any direct access to `.git/` before the tool call runs. Read-only inspection (`git status`, `log`, `diff`, `show`) still works, because it changes nothing. If you get blocked, the answer is never to find a way around it — report to the user what you wanted to do and let them run it.

## 5a. Stay inside the repo

Every agent's writes resolve to a path under this project's root — `_docs/module/<name>/`, app source, `.claude/...`. No agent writes a file elsewhere on disk, whatever the reason: not to "fix" something outside the project, not to save a copy somewhere else, not because an absolute path looked more convenient.

**This is enforced, not just requested**, the same way as §5's git rule: `.claude/hooks/block-outside-repo.js`, wired in `.claude/settings.json`, blocks `Write`/`Edit`/`MultiEdit`/`NotebookEdit` calls whose target resolves outside the repo root before the tool runs. If you get blocked, don't look for a path that slips past it — tell the user what you were trying to write and where, and let them decide. Two narrow exceptions exist, both the harness's own mechanisms rather than an agent going off scope: the OS-temp-dir scratchpad convention, and `~/.claude/projects/<project-key>/memory/...` (Claude Code's cross-session auto-memory store) — see the hook file's own comment for the exact scoping.

---

## 5b. Amend, don't regenerate — the mechanical half

§4 says existing docs are amended with `Edit`, never replaced with `Write`. The "never replaced" half of that is enforced, not just requested, the same way as §5 and §5a: `.claude/hooks/block-doc-rewrite.js`, wired in `.claude/settings.json`, blocks a `Write` call whose target is one of the six per-module docs (`requirement.md`, `design.md`, `plan.md`, `review.md`, `security.md`, `deploy.md`) **when that file already exists**. `Edit`/`MultiEdit` are unaffected — they're the allowed path. A `Write` to one of these paths when the file doesn't exist yet (the doc's first creation) is unaffected too. If you get blocked, the answer is the same as §5/§5a: don't look for a way around it, use `Edit` on the section that needs to change.

This hook cannot tell *which agent* is calling it — it has no way to except "business-analyst creating requirement.md for the first time" by name, so it doesn't try to; the file-exists check produces the right behavior structurally instead.

## 5c. An engineer doesn't hand off red code

The most expensive thing in this pipeline is the dev↔QA round trip. `qa-engineer` starts from a fresh context every round — it reads `plan.md`, `design.md`, `requirement.md`, `schema.prisma` and the real code — so a round that exists only to report a type error costs a full verification run plus a full engineer run to fix it, and the round after that costs exactly the same again. Nothing amortizes across rounds.

Most of what such a round catches is what a compiler catches for free. So those checks happen **before an engineer is allowed to finish**, not after: `.claude/hooks/require-green-before-stop.js`, wired as a `Stop`/`SubagentStop` hook, runs `typecheck` and `lint` (plus this repo's two drift scripts) when a run has changed application code, and blocks the finish while they're red. A failure caught there is fixed in-context for the price of one edit; the same failure caught by QA costs two fresh-context agent runs.

Three things worth knowing about it:

- **It only triggers on runs that changed application code.** Doc-only runs (`business-analyst`, `system-analyst`, `project-manager`, and `qa-engineer` writing `review.md`) never trip it. Stop hooks carry no agent identity, so "did app code change?" is the proxy — and it's the more accurate question anyway.
- **It can never trap you.** It forces at most one in-context fix attempt; the next attempt is allowed through regardless. That one attempt is the whole saving.
- **It is not a licence to improvise.** If a failure isn't yours to fix — a schema gap that belongs to `system-analyst`, a contract question you must not invent an answer to (§7) — say so in your handoff and finish. Never edit the contract, or fake a type, to make the checks pass.

`build` and `test` deliberately stay with `qa-engineer`: too slow to pay for on every agent stop.

## 5d. The guards are themselves tested

§5, §5a, §5b and §5c are the only rules in this pipeline that don't depend on an agent remembering them, which makes them the load-bearing part of the design. So they get the same treatment they give everyone else: `node .claude/tests/run.js` exercises every hook and both checker scripts — 69 cases, no dependencies, no install.

**Run it after editing anything under `.claude/hooks/` or `.claude/scripts/`.** The reason is specific: a hook that throws a `SyntaxError` exits 1, and a `PreToolUse` hook only blocks on exit 2 — so a hook with a typo **fails open**. It stays wired in `settings.json`, still looks installed, and enforces nothing, silently. That already happened once during development. The first thing the harness checks is that every guard still parses, and it's verified to catch both that failure and a silent behavioral regression (a guard whose syntax is fine but whose logic stopped blocking).

A failing guard is worse than no guard, because it buys false confidence. Treat a red run as blocking.

## 6. Handoffs

**No agent invokes the next agent.** This is structural, not just a rule: none of the nine agents has the `Agent` tool in its own toolset, so none of them can call another one even if it wanted to. Every run ends the same way — telling the user (or the session driving the pipeline) what was produced, what state it leaves the module in, and which agent should pick it up next — then stops. What differs between the two modes below is **who decides to make that next call**, not whether an agent is allowed to make it itself. It never is.

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

That only holds because one agent keeps them equal: **`qa-engineer` reads both and compares them field by field**, and an unexplained divergence is a ❌ — a field in `schema.prisma` that no module's `design.md` accounts for is exactly the improvised schema change this rule exists to catch. Which divergences count depends on how many modules exist:

### Scoping the comparison when more than one module exists

`schema.prisma` is one file for the whole project; `design.md` is one file **per module folder**. So the comparison is directional, and only one direction is a straight equality check:

- **Every model in this module's `design.md` Data Model must exist in `schema.prisma` and match field for field.** A missing model, a renamed field, a changed type, a dropped relation — all ❌. This direction is absolute.
- **A model in `schema.prisma` that this module's `design.md` doesn't have is not automatically a ❌.** It may belong to another module. Before flagging it, **`Grep` for `model <Name>` across `_docs/module/*/design.md`** — one search per unclaimed model, and the hit tells you which folder owns it. Do *not* read other modules' Data Model sections to answer this; ownership is a name lookup, and reading another module's schema to check one name is exactly the whole-file read §10 exists to prevent. If another module claims it, it's out of scope for this round — leave it alone, don't verify it, don't report it. **If the Grep comes back empty, that is the improvised schema change this rule exists to catch, and it is a ❌** regardless of which module's round found it.

The second bullet is why the rule can't be "the two files must be identical" — that phrasing is only correct on a single-module project, and it produces a guaranteed false ❌ on every round the moment a second module exists.

Cross-module relations (a model in module B with a relation to a model owned by module A) are legitimate and expected. Verify the field on **your** side of the relation; take the other side as given, since the module that owns it is responsible for it.

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

---

## 11. Language

Every agent talks to the user in Thai — status updates, questions (`AskUserQuestion` labels/options included), and handoff summaries. **Every document an agent creates is written in Thai too** — `requirement.md`, `design.md`, `plan.md`, `review.md`, `security.md`, `deploy.md`, `status.md`, and their `## Change Log` entries. Keep technical vocabulary in its original English form rather than translating it (model/field names, stack terms like "endpoint"/"migration"/"schema", file paths, code identifiers, code/schema blocks) — translating those makes them harder to match against the actual code and docs, not easier to read.

This governs new content, not a retranslation pass: if a document already exists with content written in another language, amend it per §4 — add or edit your section in Thai — but don't retranslate the rest of the document as a side effect of an unrelated edit. Bringing a whole existing document over to Thai is a deliberate decision the user asks for explicitly.

---

## 12. Verify against real state, not memory

A recalled fact — from an earlier turn in the same run, from a summary, from "I remember this project does X" — is a hypothesis, not a fact. Every agent (and whoever is driving the session) reads the actual current file, schema, or code before stating something as true or acting on it.

This matters more than it looks: a recollection is never automatically revalidated the way a file is. An error made once at recall time can silently outlive the file it was drawn from — the file gets edited, the wrong belief doesn't.

There's also no good reason to lean on recall in the first place: this pipeline already keeps its own memory, in files — `status.md` for where things stand, `plan.md`/`design.md`/`review.md` for what was decided and why, each with a `## Change Log` — updated with discipline (§4) precisely so nobody has to hold state in their head. An agent's own recollection is a worse copy of something the project already tracks properly; reach for the file, not the memory. This is the same discipline §2 already applies to `status.md` ("an index, not a truth" — the real docs win on disagreement) and the one every agent invokes when it says "don't work from memory" about `conventions.md` itself; it generalizes to any recalled fact, not just those two. Whenever a stated fact and the current file/code disagree, the file/code wins, and the stale belief is corrected on the spot rather than carried forward.
