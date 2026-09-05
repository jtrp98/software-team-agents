# prompt-reconcile-knowledge-layout.md — Knowledge Repo Structure Reconciliation Playbook

> **Scope:** This playbook reconciles file layout inside a Knowledge repo,
> and flags canonical docs whose *content format* has drifted from the
> current Framework schema (routing the reformat to the owning agent, never
> rewriting them here). It does not read a Target and does not reconcile
> evidence. For current/desired evidence classification, run
> `sta knowledge reconcile --target <id>`.

> **What this is:** a playbook for an AI coding assistant (Claude Code, Codex,
> OpenCode, or any agent that can read files and run shell commands) to
> reconcile an **existing** Knowledge repository whose on-disk file structure
> doesn't match this Framework's canonical layout — because it predates the
> Framework, was touched by another tool, or grew organically before anyone
> enforced the module-folder convention.
>
> **How to use it:** point your assistant at a Knowledge repo root and this
> file — e.g. "read prompt-reconcile-knowledge-layout.md and reconcile this repo's
> structure." The playbook is runtime-agnostic: it only assumes file access
> and a shell.
>
> **Worked example this playbook was written against:** a real Knowledge repo
> (`schoolbright-knowledge`) that already has `_docs/module/<name>/` folders
> done correctly for several modules, but also carries a parallel `_docs/hkt/
> module/**` tree, ad-hoc `_docs/requirement/<domain>/**` docs predating
> per-module folders, reference dumps (`_docs/schema-map/`, `_docs/route-map/`,
> `_docs/api/`, `_docs/prompt/`), a stray file directly under `_docs/module/`
> (not inside any module subfolder), a `.migration/` artifact from a different
> tool, and `knowledge/<module>/{db-schema,task,architecture}/*.yaml` files in
> a shape `CLAUDE.md` doesn't document. None of that is necessarily wrong —
> it's real content from before or outside this Framework's conventions, and
> this playbook exists to sort it, not to guess and rewrite it.
>
> **This is not `prompt-setup.md`.** That playbook gets bindings, sync, and
> runtime files working ("is this workspace correctly registered and synced").
> This one assumes that part is already fine and looks *inside* an already-
> registered Knowledge repo's own doc tree for structural drift. Run
> `prompt-setup.md`'s Inspect/Repair flows first if `status`/`--check-workspace`
> reports binding or sync problems — this playbook doesn't touch those.

---

## Operating principles — read before doing anything

1. **The canonical shape lives in code, not in this file.** Read
   `layout.yaml` and `CLAUDE.md`'s "Where things live" section (plus
   `policies/documentation.md` §1 for the module-folder test) from the
   Framework checkout every time you run this — don't rely on a remembered
   or hardcoded copy. If the Framework isn't reachable, ask the user for its
   path before classifying anything as non-canonical.
2. **Classify before acting.** Every path that doesn't match the canonical
   shape gets sorted into a bucket (below) before you propose any change to
   it. A path you can't confidently classify stays in "ask the user" — never
   guessed into a bucket to keep moving.
3. **Nothing is deleted, and nothing is bulk-moved.** Every relocation is
   proposed per-path (or per small, clearly-related group) with the exact
   `mv`/edit shown first, and applied only after the user confirms that
   specific item. This mirrors `prompt-setup.md`'s Safety rails — treat them
   as inherited, not restated.
4. **Structural drift is not the same as a broken pipeline.** The agent
   contracts (`contracts/*.yaml`) and hooks only look at the paths they name
   (`_docs/module/**`, `knowledge/*/ux-design/**`, etc.). A stray file or an
   unrecognized subtree elsewhere is invisible to the pipeline and harmless
   until acted on — so an unclassified item is a reporting item, not an
   emergency. Don't let "this looks messy" turn into an unrequested cleanup.
5. **Docs are amended, never regenerated.** If reconciliation touches the
   *content* of a canonical doc (e.g. merging a legacy requirement file's
   content into `_docs/module/<name>/requirement.md`), use `Edit` with a
   dated `## Change Log` line — never a full rewrite — same rule every
   analysis agent in this Framework follows.
6. **Short, actionable interactions.** One classification batch at a time,
   grouped by bucket, each with a proposed action and a yes/no. Respond in
   the user's language.
7. **Output style: concise.** Lead with the inventory and the classification,
   not a narration of the scan. Explain reasoning only where the user has to
   decide something from it.

---

## Phase 0 — Build the diff

1. Resolve the canonical shape (Operating principle #1): the fixed top-level
   entries under a Knowledge repo root (`_docs/status.md`, `_docs/module/`,
   `knowledge/`, `decisions/`, `policies/`, `.claude/`/`.codex/`/`.opencode/`,
   `.agent-team/`, `targets.yaml`, `knowledge-policy.yaml`, `CLAUDE.md`,
   `.gitignore`, `.workflow/`), and the shape *inside* `_docs/module/<name>/`
   (`requirement.md`, `design.md`, `plan.md`, `test-plan.md`, `uxui/design.md`,
   `review.md`, `review/phase-N.md`, `security.md`, `deploy.md` — not every
   module has every file, but every file present must be one of these).
2. Walk the repo (`find`/`ls -R`, respecting `.gitignore`) and produce two
   lists: paths that match the canonical shape, and paths that don't.
3. For every module folder under `_docs/module/`, confirm it's a folder
   (never a loose file sitting directly at `_docs/module/<something>`) and
   that every file inside it is one of the recognized doc names above —
   anything else inside a module folder (a stray export, a `.txt` dump) is
   its own classification item, not silently "part of the module."
4. Don't stop at `_docs/` and `knowledge/` — a sibling top-level directory
   this Framework doesn't define at all (an old tool's cache/manifest dir,
   OS cruft like `.DS_Store`) is also in scope for the report, even though
   it's almost never something to move *into* the canonical shape.
5. **Check content-format conformance, not just placement.** A file can sit
   at the right path and still be written to an outdated schema — a legacy
   `plan.md` full of `- [x] [backend] …` checkboxes instead of the
   `| Task | Status | Owner | Depends on |` table with `BE-`/`FE-NNN` ids,
   `(DES-NNN)` traceability and `pending/in_progress/verified/blocked`
   Status (`policies/documentation.md` §2, §4); a
   `requirement.md` missing its `## References` table; knowledge items
   without `sources[]`. Run the Framework's own structural validators from
   the checkout, per module, and record each result:

   ```bash
   sta --check-doc-structure       # every _docs/module/*/*.md's sections against its schema
   sta --check-plan                # every module's plan.md as a task DAG (deps/cycle/owner/status/DES/waves)
   sta --check-plan --module <name>   # scope to one module
   sta --check-knowledge           # knowledge/*.yaml against its schema and cross-links
   sta --check-roles               # each role workspace's watermark against knowledge/
   ```

   Build a per-module conformance table — `module → format OK? (what's off) →
   check-plan result` — as part of the Phase 0 inventory. `0 tasks / 0 waves`
   from `--check-plan` means the parser found no recognizable task table,
   i.e. the doc is pre-format, not empty. This table is a **report**, not a
   licence to rewrite (Bucket F says what to do with it).

---

## Classification buckets

Sort every non-canonical path found into exactly one bucket. Show your
reasoning for anything not obviously in its bucket.

### Bucket A — Parallel/legacy module tree

A whole subtree that mirrors `_docs/module/<name>/**` under a different
top-level name (e.g. `_docs/<brand-or-team-prefix>/module/<name>/**`).

**Don't assume it's a duplicate to merge.** It can be:
- an actual duplicate/superseded copy from before the team consolidated on
  one module namespace,
- an in-progress migration someone left half-done, or
- a genuinely separate business unit / brand that deliberately wants its own
  module namespace (this Framework's module-folder rule is about delivery
  units, not about forbidding a naming prefix).

**Action:** for each module name that appears in both trees, show both
copies' headline facts (module name, last-touched content, whether
`plan.md` has verified tasks) side by side and ask the user which one is
current. For a module name that appears only in the legacy tree, ask
whether it should become a real `_docs/module/<name>/` folder (a genuine
migration — content moves via `Edit`, not `Write`, preserving history notes)
or is intentionally out of scope for this Framework. Never merge or delete
either side without that answer.

### Bucket B — Pre-module reference material

Ad-hoc docs that predate per-module folders or don't belong to any one
module: domain-organized requirement dumps (`_docs/requirement/<domain>/**`),
standalone reference docs (`_docs/schema-map/`, `_docs/route-map/`,
`_docs/api/`, `_docs/prompt/`), loose top-level `.md` files under `_docs/`.

**Action:** these are raw material, not a broken instance of the canonical
shape — the module-folder rule doesn't require *everything* to live in a
module folder, only that a module's own requirement/design/plan does.
Recommend leaving them in place (they're inert to the pipeline per Operating
principle #4) unless the user wants a labeled staging area — in which case
propose a new `_docs/_reference/` directory (a genuinely new top-level
concept) and get explicit confirmation before creating it, since introducing
a new layout concept is the user's call, not this playbook's.

### Bucket C — Stray files

A file sitting directly under `_docs/module/` (not inside any module
subfolder), a filename that couldn't have been written by an agent (spaces,
non-standard extensions like `.txt`, obvious manual exports) inside an
otherwise-canonical module folder.

**Action:** always ask. No agent in this Framework ever writes directly
under `_docs/module/` or drops a `.txt`/export file into a module folder, so
this is unambiguously something a person placed by hand. Ask whether it's
reference material to relocate (to Bucket B's staging area) or content that
should be folded into a specific module's `requirement.md`/`design.md` via
`Edit`.

### Bucket D — Out-of-Framework artifacts

Top-level directories/files this Framework never creates or reads:
tool-specific manifests from something else that touched this repo, OS
cruft (`.DS_Store`), editor state.

**Action:** report only. These are not this playbook's concern — leave them
untouched unless the user separately asks for repo cleanup unrelated to the
Framework's own layout.

### Bucket E — Unrecognized structured data under `knowledge/`

A subtree under `knowledge/<module>/` whose shape isn't one `CLAUDE.md`
documents (today, only `knowledge/*/ux-design/**` is a defined Framework
concept — e.g. `knowledge/<module>/db-schema/*.yaml`,
`knowledge/<module>/task/*.yaml`, `knowledge/<module>/architecture/*.yaml`).

**Don't assume this is legacy or unused.** It may be:
- output from a different/earlier tool or process the team ran before this
  Framework,
- a locally-evolved convention the team relies on that this Framework simply
  hasn't formalized yet, or
- genuinely stale.

**Action:** never treat these files as the Data Model contract —
`_docs/module/<name>/design.md`'s Data Model stays the one source of truth
per this Framework's hard rule, and `schema.prisma` is its working copy.
Ask the user what produced this subtree and whether anything currently reads
it. If it turns out to be a live, recurring convention worth keeping, that's
a `layout.yaml` change to propose to the user — not something this playbook
decides unilaterally by moving files around.

### Bucket F — Right place, outdated format

A canonical doc at its correct path but written to a schema this Framework
no longer recognizes: `plan.md` as a checkbox list rather than the task
DAG table (`--check-plan` → `0 tasks / 0 waves`), `requirement.md` with no
`## References` table, `design.md` missing its mandatory sections,
`review.md` with closed rounds never archived, knowledge YAML without
`sources[]`/`version`.

**Don't rewrite it.** Regenerating an analysis doc is exactly what every
agent contract in this Framework forbids, and this playbook inherits that
rule. A pre-format `plan.md` still encodes real decisions about scope and
order — losing them to a reformat is worse than the format drift.

**Action:** report each non-conforming doc with its failing check and the
specific gap. Then, per doc, offer the user one of:
- **route to the owning agent** — the reformat is that agent's job on its
  own doc (`project-manager` re-derives `plan.md` as a validated DAG from
  the existing `design.md` + the old plan's content; `business-analyst`
  adds the `## References` table). This playbook does not run those agents;
  it names which one and hands off.
- **leave as-is** — the doc is inert to the pipeline until a stage that
  needs it runs (Operating principle #4); a module with no active work
  doesn't need its `plan.md` migrated today.
- **incremental `Edit`** — only for additive, mechanical gaps (a missing
  `(DES-NNN)` reference on one row, a `## References` heading with rows the
  user dictates), never a structural rewrite. Same amend rules as every
  analysis agent: `Edit` the affected section only, add one dated
  `## Change Log` line (the date comes from the user —
  `policies/documentation.md` §3), write the content in Thai (§11), and
  confirm the section with the user before saving (§4).

Never treat a failing `--check-*` as authority to regenerate the doc — §4
and the `block-doc-rewrite.js` hook (§5b) both forbid it.

---

## Reconciliation flow

1. Run Phase 0, produce the full classified inventory (one table: path →
   bucket → one-line reasoning) plus the per-module content-conformance
   table (module → format OK? → `--check-plan`/`--check-doc-structure`
   result).
2. Walk the user through each bucket in order (A → F), proposing one action
   per item or per clearly-related group — never a blanket "move everything
   in Bucket B."
3. Apply only what's confirmed, one path (or confirmed group) at a time.
   Content moves into a canonical doc use `Edit` with a dated `## Change
   Log` line; a folder move is a plain `mv` (or the tool equivalent) shown
   before running.
4. If a new recurring pattern emerges that the user wants formalized (a
   `_reference/` convention, a `db-schema/` subtree the team actually
   relies on), write that up as a proposal for a `layout.yaml`/`CLAUDE.md`
   change — this playbook reconciles against the existing canonical shape,
   it doesn't redefine it.
5. Re-run Phase 0's walk after applying changes and confirm the new
   inventory matches what was agreed — nothing left half-moved.

---

## Safety rails — never, under this playbook

- never delete a file or directory, in any bucket, under any confidence level
- never bulk-move a bucket without per-item (or explicitly confirmed
  per-group) sign-off
- never merge Bucket A's two copies of a module, or fold Bucket C content
  into a module doc, without the user picking which side is current
- never treat an unrecognized `knowledge/**` subtree (Bucket E) as, or fold
  it into, the Data Model contract — `design.md` and `schema.prisma` stay
  the only source of truth
- never invent a new top-level layout concept (e.g. `_docs/_reference/`)
  without explicit confirmation — that's a `layout.yaml` decision, not a
  file-move decision
- never rewrite a canonical doc wholesale to absorb legacy content — `Edit`,
  section by section, with a dated Change Log line
- never regenerate a doc that fails a `--check-*` validator (Bucket F) —
  report it and route the reformat to the owning agent; a failing check is
  a finding, not a mandate to rewrite

## Final report template

```text
Knowledge structure reconciliation — <repo path>
Canonical shape read from : <Framework checkout path>
Paths scanned             : <n>
Canonical                 : <n>
Bucket A (parallel tree)  : <n> — <n> resolved, <n> left pending
Bucket B (reference)      : <n> — <n> staged, <n> left in place
Bucket C (stray files)    : <n> — <n> resolved, <n> left pending
Bucket D (out-of-scope)   : <n> — reported only
Bucket E (unrecognized knowledge/** data) : <n> — <n> explained, <n> left pending
Bucket F (outdated doc format) : <n> — <n> routed to owning agent, <n> left as-is
Content-format checks     : check-doc-structure <pass/n fail>, check-plan <n pass / n fail>, check-knowledge <pass/n fail>
Layout proposals raised   : <none, or list>
Next                      : <what the user should decide/run next>
```
