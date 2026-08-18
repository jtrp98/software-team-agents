# Merging this agent pipeline into another project

Read this whole file before touching anything. It is written so an AI can execute the merge
directly from these instructions — no further design decisions needed except where a step below
says to ask the user.

**Where you are running**: the staging folder `./software-team-agents/` has been copied into the
root of the target project (call it `projectx` — a real project, its own repo, unrelated to the
`AgentClaude` repo this pipeline came from). This file lives inside that staging folder, alongside
the pipeline itself:

```
projectx/                           ← target project root — your cwd when executing this merge
├── software-team-agents/           ← staging folder — the SOURCE of the merge
│   ├── .claude/
│   ├── CLAUDE.md
│   └── MERGE_GUIDE.md              ← this file
├── .claude/                        ← (if present) projectx's own existing setup — the MERGE TARGET
├── CLAUDE.md                       ← (if present) projectx's own existing CLAUDE.md — the MERGE TARGET
└── ...the rest of projectx
```

So: **source** = `./software-team-agents/.claude/` and `./software-team-agents/CLAUDE.md`. **Target** = `./.claude/`
and `./CLAUDE.md` (i.e. `projectx`'s root — not the staging folder itself, and not a further
subfolder). Every path below is relative to your current directory (`projectx`'s root, even though
this file physically sits one level down inside `software-team-agents/`); the source paths are
explicitly prefixed `software-team-agents/` and the target paths have no prefix.

The merge must be **additive**: the target keeps everything it already has (its own agents, hooks,
settings, CLAUDE.md content) and gains this pipeline on top. Never delete or blindly overwrite a
file that already exists in the target unless a rule below says exactly that.

## 0. Preconditions

1. Confirm `software-team-agents/.claude/` and `software-team-agents/CLAUDE.md` actually exist before starting
   — if they don't, the staging copy step was skipped or pointed somewhere else; stop and tell the
   user rather than improvising a source.
2. If `projectx` has uncommitted changes (`git status`, read-only), tell the user before writing
   anything; don't stash or commit for them.
3. List what the target already has: `ls .claude 2>/dev/null`, `ls .claude/agents 2>/dev/null`,
   `cat .claude/settings.json 2>/dev/null`, `test -f CLAUDE.md`. You need this inventory before any
   copy decision — every rule below branches on "target already has this or not."
4. Check whether this is a **re-merge** — i.e. this pipeline was already merged into `projectx`
   once before, and you're now picking up upstream changes (new/edited agent instructions, a
   changed hook, a new convention) rather than merging for the first time. Signals it's a re-merge:
   `.claude/agents/business-analyst.md` (or any non-stack agent file) already exists and its
   content is recognizably this same pipeline, not something `projectx` built independently; or
   `CLAUDE.md` already has the `<!-- agentclaude-pipeline:start -->` marker described in step 1's
   `CLAUDE.md` row. If it's a re-merge, section 1a below governs instead of treating every file as
   brand new — read it before copying anything.

## 1. File-by-file merge rules

Left column paths are under `software-team-agents/` (the source). Right two columns are about the
target's own copy at the same relative path directly under `projectx`'s root (no `software-team-agents/`
prefix).

| Source path | If target lacks it | If target already has it |
|---|---|---|
| `software-team-agents/.claude/agents/*.md` (9 files) | Copy verbatim to `.claude/agents/`. | Per file: if target's file is byte-identical or clearly a stale copy of this same pipeline, overwrite; if it's a *different* agent the target built for its own purposes (same filename, unrelated content), do **not** overwrite — copy this pipeline's version alongside under a non-colliding name (e.g. suffix `-agentclaude`) and flag the collision to the user instead of guessing which one should win. |
| `software-team-agents/.claude/shared/conventions.md` | Copy verbatim to `.claude/shared/conventions.md`. | If target has no file at that path, this case doesn't apply. If it does (rare), diff the two and ask the user which rule set governs — this file is the contract every agent in the table above points at, so a silent merge here is how two rule sets end up contradicting each other. |
| `software-team-agents/.claude/hooks/block-git.js`, `software-team-agents/.claude/hooks/block-outside-repo.js` | Copy verbatim to `.claude/hooks/`. Both are self-contained: they read `$CLAUDE_PROJECT_DIR` (falling back to cwd) and stdin JSON, with no path baked in from the source project. Safe to drop into any project unchanged. | If the target already has same-named hook files doing something else, copy these under new filenames (e.g. `block-git-agentclaude.js`) and wire both into `settings.json` — don't replace a hook the target depends on. |
| `software-team-agents/.claude/settings.json` | Copy verbatim to `.claude/settings.json`. | **Never overwrite.** JSON-merge instead: for each entry in the source's `hooks.PreToolUse` array, append it to the target's `hooks.PreToolUse` array unless an entry with the same `matcher` + inner `command` already exists (dedupe on that pair, not the whole object). Preserve every other top-level key the target's `settings.json` already has untouched. Do the same additive merge for any other hook events the source might have — never assume `PreToolUse` is the only key. |
| `_docs/` (not present in the staging folder — this is created fresh, not copied) | Create `_docs/status.md` from scratch (empty index — no modules yet) and the `_docs/module/` directory. | Leave the target's existing `_docs/` alone entirely; the pipeline reads/writes it going forward but doesn't need to seed anything that's already there. |
| `software-team-agents/CLAUDE.md` | Copy verbatim as `CLAUDE.md`. | **Append, don't replace — but wrap it so a re-merge can find it.** Add a new section at the end of the target's existing `CLAUDE.md`, wrapped in an HTML comment marker: `<!-- agentclaude-pipeline:start -->`, then `## Agent pipeline (merged from AgentClaude)`, then `software-team-agents/CLAUDE.md`'s content minus its own top `# AgentClaude — Agent Pipeline` H1 (avoid two H1s), then `<!-- agentclaude-pipeline:end -->`. Leave every existing section above the marker untouched, in its original order. On a **re-merge**, replace everything between the two markers with the new content instead of appending a second copy — search for `agentclaude-pipeline:start` first to decide which case you're in. |

## 1a. Re-running this merge — picking up upstream pipeline changes

If precondition 4 above says this is a re-merge, the goal changes from "merge for the first time"
to "update `projectx`'s copy of the pipeline to match `software-team-agents/`'s, without losing
`projectx`-specific customization made during the *first* merge." The only customization this
guide itself ever asks you to make is the stack section handled in step 2 below — treat anything
else as pipeline content that should track `software-team-agents/` exactly.

- **`.claude/agents/*.md` (7 of the 9, all except `frontend-engineer.md`/`backend-engineer.md`)**:
  `diff` the target's copy against `software-team-agents/.claude/agents/<name>.md`. If the only
  differences look like `projectx`-specific hand edits unrelated to this pipeline (not just
  upstream wording changes), stop and ask the user before overwriting — same as a first-time
  collision. Otherwise, overwrite with the new version; a stale copy silently sitting there means
  every fix made upstream since the last merge never reaches `projectx`.
- **`frontend-engineer.md`/`backend-engineer.md`**: `diff` the target's copy against the source.
  If the *only* differing region is the `## Fixed project stack` bullet list, that's expected
  (step 2 customized it last time) — overwrite the rest of the file with the new source content,
  but **carry the target's existing `## Fixed project stack` bullets forward untouched**; don't
  reset them to the pipeline defaults. If there are other differences too, treat it like any other
  collision (ask before overwriting).
- **`.claude/shared/conventions.md`, `.claude/hooks/*.js`**: overwrite with the new source version
  on a re-merge, same reasoning as the agent files — nothing here is meant to diverge per-project.
- **`.claude/settings.json`**: same additive JSON-merge as a first merge (step 1's row already
  dedupes on `matcher`+`command`, so re-running it is naturally safe — it just won't add duplicate
  entries for hooks already merged in).
- **`CLAUDE.md`**: replace the marked section as described in the table row above; don't append a
  second one.
- Still run section 2 (stack check) and section 4 (verification) in full afterward — a re-merge is
  not exempt from either.

## 2. Stack assumptions — check and actually update before finishing

`.claude/agents/frontend-engineer.md` and `.claude/agents/backend-engineer.md` each carry a
`## Fixed project stack` section (bullet list right after the intro paragraph — `**Framework**`,
plus `**Language**`/`**Styling**`/`**Routing**`/`**State management**` on the frontend side,
`**Database**`/`**ORM**`/`**API style**`/`**Auth**`/`**Validation**` on the backend side, and
`**Package manager**`/`**Testing**` on both). As copied from `software-team-agents/`, that section
describes *this* pipeline's default stack (Next.js/TypeScript/Tailwind/Zustand, and
Node+Express/PostgreSQL/Prisma/REST/JWT/Zod). This step is not optional — do it as part of the
merge, not as a follow-up the user has to remember to ask for separately:

1. **Ask the user first whether `projectx`'s codebase is รวม (combined) or แยก (separate)**:
   - **รวม** — one repo holds both frontend and backend (a monorepo, or a single fullstack app).
   - **แยก** — this repo is only one side of the system; the other side lives elsewhere, or doesn't
     exist yet.
   If **แยก**, ask a follow-up: is *this* repo the **frontend** or the **backend**? Don't infer this
   from the repo's existing files — ask, same as the stack questions below.
2. Scope every step after this to that answer:
   - **รวม**: confirm and (if needed) edit both `frontend-engineer.md`'s and `backend-engineer.md`'s
     `## Fixed project stack` sections, per steps 3-5 below.
   - **แยก + frontend**: confirm and (if needed) edit only `frontend-engineer.md`'s section.
     `backend-engineer.md` stays merged at pipeline defaults — this repo has no real backend stack
     to confirm it against — but say so explicitly when reporting back rather than silently leaving
     it untouched.
   - **แยก + backend**: mirror that — only `backend-engineer.md` gets confirmed/edited;
     `frontend-engineer.md` is left at pipeline defaults and flagged as not applicable to this repo.
3. **Ask the user** what `projectx`'s actual stack is for each applicable bullet above (framework,
   language, styling, state management on the frontend; framework, database, ORM, API style, auth,
   validation on the backend) — do not infer it from `package.json`/lockfiles and treat that as
   confirmed; a guess here is exactly the kind of stack decision these two agents are explicitly
   forbidden from making themselves (see their own `## When the stack needs to change` section —
   "confirm with the user that this is an intentional change before proceeding").
4. If the answers match the defaults, leave the section as-is — nothing to edit.
5. If they don't, **directly `Edit` the `## Fixed project stack` bullet list** in the applicable
   file(s) to the confirmed values (rewrite the bullet text, don't just append a note) — this
   section is what `system-analyst` reads as the source of truth for feasibility calls, so it has
   to reflect `projectx`'s real stack, not the pipeline's default, before anyone starts building.
6. Skip this step entirely only if `projectx` had no prior `frontend-engineer.md`/
   `backend-engineer.md` of its own to inform the choice AND the user explicitly says the pipeline
   defaults are fine to use as-is for whichever side(s) apply.

## 3. Rules that must survive the merge unchanged

These are enforced by the hooks copied in step 1, not just by prompt text — don't weaken them
while merging:

- No agent runs git or touches `.git/` (`block-git.js`).
- No agent writes outside `projectx`'s root, except Claude Code's own scratchpad and memory
  conventions (`block-outside-repo.js`).
- `.claude/settings.json`'s `PreToolUse` matchers must still cover `Bash|Write|Edit|MultiEdit|
  NotebookEdit` for `block-git.js` and `Write|Edit|MultiEdit|NotebookEdit` for
  `block-outside-repo.js` — if you renamed either hook file in step 1 to dodge a collision, update
  the `command` string in the merged settings entry to match the new filename.

## 4. Post-merge verification

Run these before telling the user the merge is done:

1. `.claude/settings.json` is valid JSON (`node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"` or equivalent) and still contains every hook entry the target had *before* the merge, plus the ones from `software-team-agents/`.
2. Both hook files execute without crashing on a no-op input, e.g. `echo '{}' | node .claude/hooks/block-git.js` should exit 0.
3. All nine agent files are present under `.claude/agents/` and readable.
4. `.claude/shared/conventions.md` exists and every agent file's references to it (`.claude/shared/conventions.md`) resolve to that same path.
5. `_docs/status.md` exists (even if empty/near-empty) so `business-analyst` has somewhere to start.
6. `CLAUDE.md` has no duplicate H1 and the target's pre-existing content is still present above the merged section.
7. Step 2 actually happened: you asked whether `projectx` is รวม or แยก (and which side, if แยก), then asked for the applicable stack(s) — and if they differ from the defaults, the applicable `.claude/agents/frontend-engineer.md`/`backend-engineer.md` `## Fixed project stack` section(s) were edited to match, not left as pipeline defaults with a TODO for later. Don't report the merge done with this step still outstanding.
8. Delete the staging folder `software-team-agents/` (this file, `MERGE_GUIDE.md`, lives inside it and goes with it) from `projectx`'s root — it was only needed to carry the pipeline over, not to stay as part of it.
9. Report back: what was copied as-is, what was renamed to avoid a collision, what the confirmed stack was and what (if anything) got edited in step 2, and any file this guide told you to flag instead of merge automatically.

## 5. What NOT to do

- Don't `git add`/`commit`/`push` anything in `projectx` — merging files is not the same as
  committing them, and version control stays with the user.
- Don't delete a target file to make room for a same-named source file — rename the incoming file
  instead and surface the collision (step 1's table).
- Don't invent a stack for `frontend-engineer.md`/`backend-engineer.md` — ask. And ask รวม/แยก
  (and which side, if แยก) before asking about stack details, so you don't end up customizing a
  side that isn't part of this repo.
- Don't leave `software-team-agents/` (and the `MERGE_GUIDE.md` inside it) behind after the merge —
  it's staging, not part of the pipeline.
