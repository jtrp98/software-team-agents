---
id: ADR-007
title: The task classifier is the single source of truth for pipelines; workflows/*.yml are generated from it and byte-checked
status: accepted
date: 2026-08-27
---

## Status

accepted — 2026-08-27

## Context

Two places claimed to say which agents run, in what order, for one kind of change:

- `orchestrator/src/classification/taskClassifier.ts` — a pure function, called at
  `cli.ts` when a task is created. This is what actually runs.
- `workflows/*.yml` — eleven hand-written files describing the same pipelines.

`--check-workflows` kept them aligned by comparing them semantically. That arrangement is
the exact thing the user ruled out: two hand-maintained descriptions of one behaviour, held
together by a lint that can only object *after* somebody has already forgotten to edit the
second one.

T-V3TOK-110 re-checked the consumer graph before deciding anything. What the repository
actually shows:

1. **The YAML has no runtime consumer.** `grep loadAllWorkflows` finds `cli.ts`
   (`--check-workflows`) and `review/reviewSeparation.ts`, and `checkReviewSeparation()` is
   itself only reachable from `--check-review-separation`. Nothing in `sta run` reads a
   workflow file. The pipeline comes from `classifyTask()`.
2. **The YAML nevertheless carries things the classifier does not model** — a
   `description`, a rationale comment per file, `trigger.priority`, per-step `note`s, and
   the `when: always_sensitive` distinction that says a security pass is *forced* rather
   than conditional. `schema-change.yml`'s note ("a schema change gets a security pass
   whether or not the caller flagged one") is a rule stated nowhere else.
3. **Three workflows exist only in the YAML.** `hotfix`, `refactor` and `security-fix` have
   `trigger: explicit`: they are distinguished by intent, not by anything observable in the
   change. The classifier has no branch for them.
4. **The files are shipped, not internal.** `workflows` is in `TEMPLATE_SOURCES`, so every
   target project materializes its own copy, and `.claude/commands/blueprint.md` and
   `stepbystep.md` instruct agents to name the governing `workflows/<name>.yml` by path.
   `CLAUDE.md`, `docs/pipeline-rationale.md` and `docs/rules-rationale.md` cite them too.

So the plain reading of the audit's recommendation — "delete the YAML" — was not supported.
Deleting the files would have removed three pipelines, every rationale note, and a
user-facing artifact that other parts of the system reference by path. Equally, promoting
the YAML to runtime authority (option A) would mean writing an interpreter for `priority`,
`when`, `level` and `requires_human_approval`, and making a pure function read files at
import time, to buy a capability nobody has asked for.

## Decision

**The classifier stays the source of truth. `workflows/*.yml` become generated artifacts.**

- `orchestrator/src/workflow/workflowCatalog.ts` is the new authored home for the prose the
  classifier does not model: each workflow's rationale comment, description, priority
  rationale, and per-step notes.
- Behaviour is **derived, never re-declared**. For the eight signal-triggered workflows the
  catalog probes `classifyTask()` across the five inputs the `when:` vocabulary can express
  and reads the step list, the conditions, the level and the approval flag out of its
  answers. Signal precedence is derived too, by asking which signal wins when two are set —
  so `priority:` stopped being a number anybody maintains.
- The three intent-named workflows (`hotfix`, `refactor`, `security-fix`) stay authored, in
  the catalog, because no classification signal selects them. They are authored *once*, so
  they carry no sync obligation either. Adding signals for them would be inventing runtime
  behaviour to make a table look complete.
- `--check-workflows` changes from a semantic comparison to a **byte comparison** of the
  committed files against what the catalog renders, plus the existing Ajv schema load and
  the priority-clash check. `node scripts/regenerate-renderings.mjs` writes the files, the
  same generate-then-byte-check arrangement `--check-bindings` already uses for `.codex/`,
  `.opencode/` and `.agents/skills`.
- `review/reviewSeparation.ts` reads the catalog directly instead of parsing YAML, so the
  check no longer depends on a project root having been synced.
- `resolveWorkflowId()` gained a runtime consumer: `sta run` names the workflow in its
  opening line, so the file explaining *why* a pipeline is shaped that way is one `cat`
  away from the run that used it.

Nothing was discarded. The generator reproduces all eleven committed files byte-for-byte,
which is the proof: every description, note, comment, priority, level and step survived.

## Consequences

- **One authored place per fact.** Behaviour lives in the classifier; prose lives in the
  catalog. There is no pair of files anybody has to keep aligned by hand, which is what the
  user objected to.
- **The drift check got stronger, not weaker.** The old comparison probed four flag
  combinations and could not see a description, a note or a priority change at all. A byte
  check sees every character. It remains in `scripts/release-gate.mjs`.
- **Hand-editing a workflow file now fails the check** rather than passing quietly. The
  error names the two files to edit and the command to run. This is the intended tightening;
  it is also a change for any target project that edited its local copy, and the message
  says so.
- **A classifier change that the `when:` vocabulary cannot express fails loudly.** If a
  stage ever appears for a backend-only *and* a frontend-only task but not for one with
  neither, `WorkflowDerivationError` stops generation rather than writing a wrong file.
- **`workflows/*.yml` remain real files** in this repo and in every target project — still
  shipped, still readable, still what `blueprint` and `stepbystep` point at. Only their
  authorship moved.
- Option A (YAML as an executable definition) is now recorded as considered and turned
  down. Re-proposing it means proposing a new interpreter, and should say what capability
  that interpreter buys.
