# prompt-cleanup.md — AI-Assisted Repository Cleanup & Standardization Playbook

> **What this is:** a playbook for an AI coding assistant (Claude Code, Codex,
> OpenCode, or any agent that can read files and run shell commands) to bring
> this repository to widely accepted engineering standards and delete
> everything that is **provably unused** — without breaking anything.
>
> **How to use it:** give your assistant this file — paste its contents into
> the session, or point the agent at it ("read prompt-cleanup.md and clean up
> this repo"). The playbook is runtime-agnostic: it assumes only file access
> and a shell. Run it only when a human has explicitly asked for the cleanup;
> the plan-approval gate below is that human's authorization for the specific
> listed paths.
>
> **Counterparts:** [`prompt-setup.md`](prompt-setup.md) (setup),
> [`prompt-update-knowledge.md`](prompt-update-knowledge.md) (knowledge
> refresh), [`prompt-update-docs.md`](prompt-update-docs.md) (doc refresh).
> This playbook never overrides the workspace bootstrap rules in
> [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md); where they conflict, those win.

---

## Operating principles — read before doing anything

1. **Evidence before deletion.** A file, folder, dependency, script, config, or
   doc counts as unused only when you can *prove* nothing references it: no
   imports/requires, not named in any package.json (`scripts`, `files`, `bin`,
   `workspaces`), not in CI workflows, not in build/test/release tooling, not
   in docs the repo maintains, not a snapshot source of the framework.
   "It looks unused" is not evidence. Ambiguous → keep it and flag it.
2. **Plan first, delete once.** Produce an itemized plan and get the human's
   explicit approval of the DELETE list before removing anything. One approval
   covers the whole approved batch — do not re-ask per file.
3. **Behavior must not change.** After every mutating step the verification
   suite (below) must pass. If a check did not exist before the cleanup, say
   so — never claim a pass you did not run.
4. **No state-changing git.** Work in the working tree only. Never commit,
   push, branch, checkout, reset, stash, `git rm`, or `git mv` — use plain
   `rm`/`mv` and let the human review `git status` and commit.
5. **Amend, never regenerate.** Docs are edited section-by-section in place;
   a wholesale rewrite is out of scope for a cleanup (AGENTS.md hard boundary).
6. **Minimal diffs.** Match surrounding style. A cleanup that rewrites half
   the repo is a rewrite, not a cleanup — propose it, don't do it.
7. **Concise output.** Lead with the result. No step-by-step narration; state
   detected facts and decisions directly.
8. **Humans own the unknown.** Ownership, intent, dates, licensing, publishing
   — if a decision is a business choice or evidence is missing, ask. Never
   improvise.

## Verification suite (must be green before you report done)

```bash
npm run typecheck       # orchestrator typecheck
npm test                # orchestrator test suite
npm run build           # regenerates the templates/ snapshot
npm run docs:check      # README/docs sync check
npm run release:check   # release gate
git status --porcelain  # every change you made, human-visible
```

---

## Phase 0 — Inventory (read-only, always first)

Collect facts silently; surface only what matters. Suggested read-only probes:

```bash
git ls-files                          # everything actually tracked
git status --porcelain                # untracked/local-only files
git clean -ndX                        # DRY RUN ONLY (-n) — ignored files present
find . -path ./node_modules -prune -o -type d -empty -print   # empty dirs
```

Then classify candidates into:

| Category | Typical finds |
|---|---|
| Junk | `*.bak`, `*.orig`, `*~`, `*.log`, `*.tmp`, `.DS_Store`, `Thumbs.db`, editor droppings |
| Committed build artifacts | anything gitignore-worthy that is tracked (dist, coverage, snapshots) |
| Empty directories | git cannot track them; confirm nothing references the path, then propose deletion |
| Orphaned scripts | `scripts/*` not referenced by any package.json script, CI workflow, or doc |
| Unused dependencies | root/orchestrator deps with zero import sites (check both package.json files) |
| Duplicate docs | two files describing the same thing; propose the canonical one per doc conventions |
| Stale docs | sections describing removed files, commands, or features |
| Dead code | unreferenced exports/modules — flag only; riskiest category, lowest priority |
| Standards gaps | missing/inaccurate root hygiene files, naming drift, no lint/format wiring |

## Phase 1 — Plan (the human gate)

Present one table: `path | category | evidence | proposed action`. Categories:

- **DELETE** — provably unused; one line of evidence per item. Requires the
  human's explicit approval before anything is removed.
- **MERGE/AMEND** — duplicate or stale docs; propose the section-level edit.
- **MOVE/RENAME** — naming/layout standardization; must list every reference
  you will update in the same step (imports, scripts, CI, doc links).
- **ADD/CONFIGURE** — standards gaps to fill (new hygiene files, CI checks).
- **KEEP-FLAG** — suspected unused but unverifiable (dynamic requires, external
  systems, or the human simply knows). State what evidence would settle it.

Wait for approval. Without it, stop after the plan.

## Phase 2 — Execute the approved plan

- Delete/move only approved paths, with plain `rm`/`mv`.
- Update every dangling reference in the same step: imports, package.json
  scripts/paths, CI workflows, doc links. A cleanup that leaves broken links
  is not done.
- Amend affected docs section-by-section where paths or commands changed.
- Re-run the verification suite after each batch, not only at the end.

## Phase 3 — Standardize (propose first, then apply)

Adapt to this stack (Node ≥ 24, npm workspaces-style root + orchestrator):

- **Layout/naming:** one convention for file and directory names; source under
  clear roots (`orchestrator/src`, `scripts`, `docs`); no lookalike names that
  differ only by case or separator.
- **Root hygiene files present and accurate:** README (purpose, quickstart
  that actually runs, script table), `.gitignore` (complete, minimal),
  `.editorconfig`, CI workflow running the verification suite. A missing
  LICENSE is a human decision — flag it, never pick one yourself.
- **Dependencies:** one package manager, lockfile committed, engines pinned;
  unused deps removed per Phase 1 evidence.
- **Scripts:** every entry in package.json must work; `dev`/`build`/`test`/
  `lint`/`format`/`typecheck` naming per common convention where missing.
- **Commits:** Conventional Commits (history already follows it); document it
  only if the repo lacks the note.

## Hard do-not-delete list — this repo's landmines

Never delete, move, or hand-edit any of these, no matter how unused they look:

- `/templates/` — build artifact regenerated by `npm run build`; never a
  source of truth (gitignored by design).
- Snapshot sources: `.claude/agents/`, `contracts/`, `workflows/`,
  `policies/`, `stacks/` — the framework's source of truth for the snapshot.
- `.agent-team/`, `.workflow/`, `.zcode/config.json` — CLI-managed / synced.
- `knowledge/`, `decisions/` — canonical knowledge and ADR history; append-only.
- `planning/` — gitignored on purpose (local-only docs) yet referenced by npm
  scripts (`test:benchmark`, `test:v8-benchmark`); its absence is not junk.
- `orchestrator/` — the dev package; root `bin`/`files` point into
  `orchestrator/dist`, `orchestrator/schemas`, `orchestrator/web`.
- `prompt-setup.md`, `prompt-update-knowledge.md` — shipped in package.json
  `files[]`; removing or renaming breaks packaging.
- Reference documents — read-only evidence (CR-6/AD-11): never move, rename,
  rewrite, convert, or validate them.
- `package-lock.json`, active CI configs, `node_modules/` and other
  gitignored artifact dirs (out of scope — npm owns those).

## Known open items at the time of writing (verify, don't assume)

- `platform/` — untracked at repo root; ask the human what it is before
  touching it.
- `srcschoolbright-knowledge/` — empty directory; invisible to git. Confirm
  nothing expects the path, then propose deleting it.
- `prompt-update-docs.md` — exists at root but is not in package.json
  `files[]`; whether it should ship is a packaging decision for the human.

## Safety rails — never, under this playbook

- never delete without recorded evidence; no proof → KEEP-FLAG
- never touch anything on the do-not-delete list
- never run `git clean` without `-n` (and `-n` only as a dry-run report)
- never run a state-changing git command (commit, push, branch, reset,
  checkout, stash, `git rm`, `git mv`)
- never regenerate docs wholesale — amend section-by-section
- never delete a file referenced by CI or any npm script because it "looks
  internal"
- never fill business unknowns (ownership, intent, dates, license) yourself

## Final report template

```text
Cleanup complete — <date>
Deleted : <n> paths — <each with one-line evidence>
Moved   : <from → to> (references updated: <n>)
Amended : <files/docs touched, section-level>
Added   : <standards files created>
Flagged : <path — why kept, what evidence would settle it>
Verify  : typecheck <PASS/FAIL> · test <…> · build <…> · docs:check <…> · release:check <…>
Git     : nothing committed — review `git status --porcelain` and commit yourself
Next    : <the exact follow-up decision(s) that belong to the human>
```
