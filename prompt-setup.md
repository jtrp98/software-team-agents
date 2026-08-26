# prompt-setup.md — AI-Assisted Setup Playbook

> **What this is:** a playbook for an AI coding assistant (Claude Code, Codex,
> OpenCode, or any agent that can read files and run shell commands) to set up
> **software-team-agents** on this machine for one person's role.
>
> **How to use it:** give your assistant this file — e.g. paste its contents into
> the session, or point Claude Code / Codex / OpenCode at it ("read prompt-setup.md
> and set me up"). The playbook is runtime-agnostic: it only assumes file access
> and a shell.
>
> **Human-facing counterpart:** [`TEAM_SETUP_V1.md`](TEAM_SETUP_V1.md) is the
> same onboarding flow written for a person to follow by hand, with a
> Troubleshooting section (including the exact incident this playbook's
> Phase-0 detectors exist to catch — see "req หลุดไป Target" there). Point a
> user who wants to do this themselves at that file instead of this one.

---

## Operating principles — read before doing anything

1. **Inspect before asking.** Everything detectable from disk or commands is
   detected first. You ask the user only for what inspection cannot find.
2. **Official commands only.** Workspace state is created and changed by
   `software-team-agents init | sync | status` (and `sta configure knowledge-root`
   for the machine-wide binding). Never hand-craft `.agent-team/` contents,
   never duplicate what the CLI already does.
3. **Safe by default.** No deletions. No `sync --force` unless the user says the
   word "force" about that exact step after seeing the conflict report. No edits
   inside the Framework checkout. Existing config is preserved; changes are
   minimal field updates, never wholesale rewrites. The one place this playbook
   runs a state-changing git command at all — bootstrapping a Target that
   doesn't exist locally yet, Flow: DEV's Target-resolution cases 2/3 — always
   shows the exact command first and waits for explicit confirmation (Safety
   rails below).
4. **Short, actionable interactions.** One question at a time, each with the
   detected default offered ("I found X at … — use it? [Y/n]"). Respond in the
   user's language.
5. **Output style: concise.** Lead with the result, not narration — no "I'm
   going to check X now" before a command. State detected facts and decisions
   directly; skip preamble, restating the request, and step-by-step commentary.
   Explain *why* only when a choice is non-obvious or the user must decide.
   This applies to every phase, not just the Final Report.
6. **Report at the end** using the format in the Final Report section, including
   the exact command the user can run to continue working.

---

## Phase 0 — Initial inspection (always run this first)

Run these read-only checks from the current directory. Collect facts silently;
do not bother the user with anything that resolves cleanly.

```bash
software-team-agents status --json        # roots, role, versions, sync state, readiness
software-team-agents --version            # installed Framework version
sta --check-workspace --project-root .    # T-WG4 — misplaced module docs, when this is a role: dev workspace
```

Then, guided by what status reports:

| Fact | How to detect |
|---|---|
| Framework root + version | `status --json` → `frameworkRoot`, `frameworkVersion`; missing ⇒ the CLI is not installed — install it (see below), then continue rather than stopping |
| Current directory's workspace kind & role | `status --json` → `workspaceKind`, `role`; also read `.agent-team/config.yaml` if present (`role`, `knowledge.path`, `overrides`) |
| Knowledge root (machine-wide) | `status --json` → `knowledgeRoot` / `knowledgeBinding` (via installation binding) |
| Registered Targets | read `<knowledgeRoot>/targets.yaml` when a Knowledge root resolved |
| Local path mappings | read `<knowledgeRoot>/.workflow/targets.local.yaml` if present |
| Sync status of the current workspace | `status --json` → `syncState`, `syncedVersion`, `conflictCount`, `managedFileCount` |
| Runtime readiness | `status --json` → `claude.ready`, `codex.ready`, `opencode.ready` (OpenCode needs bindings **and** `.opencode/plugin/sta-guards.js` — its headless default posture is allow-all, so a missing plugin means unguarded, not just incomplete) |
| Knowledge root bound but never initialized (T-WG1) | `status --json` → `knowledgeBoundButUninitialized` (the bound root's path, or absent) — a machine-wide binding resolves, yet `<knowledgeRoot>/.agent-team/config.yaml` is absent, so BA-lane prompts exist nowhere on this machine yet; `status`'s plain-text output prints the same fact as a `WARNING:` line with the exact fix command |
| Roster drift in a workspace (T-WG2) | `status --json` → `rosterDriftPaths` (array of paths; empty = none) — agent-prompt files under `.claude/agents/` / `.codex/agents/` / `.opencode/agent/` whose names belong to the *other* lane's roster (analysis prompts in a DEV workspace, engineer/reviewer prompts in a BA one); never legitimate regardless of how they got there |
| Module docs stranded in a Target (T-WG4) | `sta --check-workspace --project-root <path>` (the Framework's top-level CLI, not `software-team-agents`) — flags every file under a `role: dev` workspace's `_docs/module/**` plus a `## Modules` table in its `_docs/status.md`, each with the Knowledge-repo destination path |

If `status` fails because the current directory is not a Git repository, that is
fine — you are likely standing outside any workspace. Note it and continue to
the role menu; the chosen flow will ask where to work.

Present a one-screen summary of what you found, then show the menu.

### Installing the CLI, if it is missing

From a Framework checkout, one command — no packing, no tarball:

```bash
cd <framework-checkout> && npm link
```

`npm link` points the global `software-team-agents` / `sta` binaries at the
checkout itself, so a later `npm run build` there takes effect immediately with
nothing to reinstall. Verify with `software-team-agents --version`.

Only when installing from a released package (no checkout on the machine) is the
tarball path right: `npm i -g software-team-agents-<v>.tgz`.

Do not run `npm run release` just to get the CLI installed — it runs the full
typecheck + 2000-test suite and packs a tarball, which is a release gate, not a
setup step.

---

## Role menu

Ask which one applies (**this is the one question always asked**, unless the user
already said):

1. **BA** — business analysis lane; works in the Knowledge repository
2. **DEV** — engineering lane; works in a Target repository
3. **QA** — quality lane; derives its needs from the official workflow definitions
4. **Add Target** — register an additional Target in an existing setup
5. **Update Setup** — re-inspect and refresh an existing setup (Framework moved/updated)
6. **Inspect Setup** — full read-only report; change nothing
7. **Repair Setup** — something broke (moved repos, stale sync, remote mismatch)

---

## Flow: BA

**Goal:** BA ready with Framework + Knowledge only. A Target never comes up.

- If no Knowledge path was detected: ask for it. Validate before accepting:
  - path exists, is a standalone Git repository (`.git` present)
  - looks like a Knowledge repo (`knowledge/`, `_docs/`, `targets.yaml`, or
    `knowledge-policy.yaml` present). If not, say so and stop — do not create
    one unless the user explicitly asks for a fresh Knowledge repo.
- **Bound-but-uninitialized Knowledge root.** If Phase 0 found a machine-wide
  binding whose repository has no `.agent-team/config.yaml`, surface that first
  and offer to materialize it now ("Knowledge root found at X but never set up
  for BA work — initialize? [Y/n]"): `cd <root> && software-team-agents init
  --role ba` then `sync`. Until this runs, BA/UXUI prompts do not exist anywhere
  on the machine.
- `cd <knowledge>` then run `software-team-agents init`
  (auto-detects the BA workspace) followed by `software-team-agents sync`.
- Optionally offer: "Bind this machine's default Knowledge root too?" →
  `sta configure knowledge-root <path>` (affects other flows on this machine).
- Verify with `software-team-agents status`: expect Role `BA`, `Target: NOT
  REQUIRED`, sync `UP_TO_DATE`, Claude/Codex/OpenCode READY.
- **UX/UI consultant.** The BA workspace materializes five prompts —
  `business-analyst`, `system-analyst`, `project-manager`, `test-planner` and
  `uxui-designer` (the design-source consultant; it writes only draft `UX-*`
  items plus `_docs/module/<name>/uxui/**`). If the user will run it against
  Figma or Claude Design, also configure the identity gate once per machine:
  `sta configure identity --figma-email <email> --claude-email <email>` (both
  accounts must be the same address; emails only — the Figma token itself stays
  in the environment as `FIGMA_PAT`, never in any config file). Without these,
  `uxui-designer` runs are blocked fail-closed by preflight.
- Tell the user their working command: `cd <knowledge> && software-team-agents ba`
  (add `--runtime opencode` or `--runtime codex` to choose a different runtime).

## Flow: DEV

**Goal:** DEV ready in the Target; Knowledge bound as read context.

- **Resolve the Target — three shapes; tell them apart before touching anything, and never guess which one applies:**
  1. **Already exists.** The current directory is an application repo, or the user points at an existing local path. Validate: exists, standalone Git repo, has application markers (package.json, pyproject.toml, pom.xml, *.sln, …). This is the common case — proceed as below.
  2. **Has a remote, not cloned to this machine yet.** Ask for the remote URL and the local path to clone it to. Show the exact command — `git clone <url> <path>` — before running it, and wait for the user's explicit confirmation (Safety rails below: this is the first state-changing git command anywhere in this playbook, and it is never auto-run). Once cloned, validate exactly as case 1.
  3. **Nothing yet — a genuinely new project, no remote either.** Agree the target path with the user, show `git init <path>` before running it, and wait for the same explicit confirmation as case 2. A freshly-`git init`'d directory has no application markers yet, so it resolves as `unrecognized`, not `target` — `software-team-agents init --role dev` still accepts it there with an explicit `--role dev`. There is no real scaffolding yet, though: tell the user plainly that the `setup` agent has to run from this workspace right after `sync` finishes, before any feature work — that agent is what actually creates `package.json`, `app/`, `prisma/schema.prisma`, `.env`, not this playbook.
- Resolve Knowledge: reuse any valid binding (`config.knowledge.path` or the
  machine-wide one). Only if none: ask for the Knowledge repo path and validate
  as in the BA flow.
- Write the binding into `.agent-team/config.yaml` (`knowledge:` → relative or
  absolute path), or run `sta configure knowledge-root` if the user wants it
  machine-wide. Show exactly what you are about to write before writing.
- In the Target: `software-team-agents init` then `software-team-agents sync`.
  Detection normally resolves an app repo (case 1/2 above) on its own; pass
  `--role dev` explicitly for case 3's fresh `git init` (no app markers yet, so
  detection reports `unrecognized`, not ambiguous) or when it actually reports
  ambiguity (a repo carrying real Knowledge markers — `knowledge/`,
  `targets.yaml`, `knowledge-policy.yaml` — alongside app source).
- **Stack reality check.** `sync` only copies the Framework's generic default stack into
  `.claude/agents/frontend-engineer.md`/`backend-engineer.md` — it does not detect or merge
  the Target's actual one, and a fresh `init`/`sync` on an already-built project will not
  match it by default. Read each file's "Fixed project stack" section and compare against
  the Target's real markers: `package.json` dependencies/devDependencies, `prisma/schema.prisma`
  presence, `tailwind.config.*`/`postcss.config.*`, whether the API is a separate server or
  framework-native route handlers, which auth library is actually wired up. If they disagree,
  show the specific diff and ask the user to confirm the real stack, then update both files'
  "Fixed project stack" section in place per that file's own "When the stack needs to change"
  rule — don't guess, and don't skip this just because `sync` reported `UP_TO_DATE` (sync
  tracks file versions, not stack accuracy).
- Verify: Role `DEV`, Knowledge line present via `workspace-config`/`installation`,
  sync `UP_TO_DATE`, runtimes READY.
- **No analysis prompts here, by design.** A DEV/Target workspace carries only
  the engineer roster (`backend/frontend-engineer`, `qa-engineer`, `security`,
  `devops`). The BA-lane prompts — including `uxui-designer` — are deliberately
  absent, and the engineering agents' contracts additionally deny writing
  requirement/design/test-plan docs, the module's `uxui/` folder, or anything
  under `knowledge/` from this workspace (a bare session with no role is not yet
  covered by a hook-level guard — tracked in
  `planning/v2/workspace-guardrails-TASKS.md`, T-WG3). If the user asks for
  requirements or UX work "here", route them to the BA flow above instead of
  working around the block.
- **Roster drift & stranded docs.** Before declaring DEV ready, check the two
  Phase 0 rows: other-lane prompt files present here, and local `_docs/module/**`
  content. Roster drift is fixed by plain `sync`; if it reports conflicts, show
  them verbatim and wait for the user's explicit "force". Stranded docs are
  migrated, never deleted: propose copying `_docs/module/<name>/` into the
  Knowledge root (`<knowledgeRoot>/_docs/module/<name>/`, merging any status
  tables), then removing the Target-side copy only after explicit confirmation.
- **Runtime choice.** Default is Claude Code; `--runtime opencode` and
  `--runtime codex` launch the other supported runtimes from the same workspace.
  Model/effort are the runtime's own configuration (e.g. OpenCode's
  `opencode.json` `model` key) — never baked into bindings.
- Working command: `cd <target> && software-team-agents dev`.

## Flow: QA

**Goal:** same shape as DEV, but requirements are derived, not assumed.

- Read the official sources of truth before asking anything (location depends on
  install shape — check both, use whichever exists):
  - workflows: `<frameworkRoot>/workflows/*.yml` in a dev checkout, or
    `<frameworkRoot>/templates/workflows/*.yml` when installed from a package —
    which stages participate per change type
  - contract: `<frameworkRoot>/contracts/qa-engineer.yaml` (dev checkout) or
    `<frameworkRoot>/templates/contracts/qa-engineer.yaml` (installed) — QA's
    declared read/write scope
- From those, derive what QA needs on this machine (typically: Knowledge for
  review context + a writable Target checkout to verify against) and state the
  derivation out loud: "workflows X and Y put qa-engineer after engineers, and
  its contract writes review docs — so it needs …".
- Then follow the DEV steps (Target + Knowledge binding + init/sync/status) —
  including Target-resolution cases 2/3 (clone or `git init` a Target that
  doesn't exist here yet) and their confirmation requirement, unchanged for QA.
- Working command: `cd <target> && software-team-agents dev --runtime claude`.

## Flow: Add Target

**Goal:** one more Target registered without disturbing anything else.

1. Read `targets.yaml` in the Knowledge root first — existing targets stay untouched.
2. Ask for: Target name/id, local path, remote URL.
3. Validate the new path like DEV does; additionally check the local checkout's
   git remote matches the given URL (report a mismatch, don't "fix" it silently).
4. Propose the exact YAML block to append to `targets.yaml` **and** the matching
   `.workflow/targets.local.yaml` mapping; apply only after the user confirms.
5. In the new Target repo: `init` (+ binding config) as in the DEV flow.
6. Verify all previously registered Targets still resolve, then `status`.

## Flow: Update Setup

**Goal:** refresh an existing setup after a Framework upgrade or a move.

- Re-run Phase 0 everywhere relevant (each workspace found in Phase 0).
- For each workspace whose `syncState` is OUTDATED: run `software-team-agents sync`.
  A sync that adds a newly supported runtime's files (e.g. `.opencode/**`) is
  add-only and conflict-free by design. If conflicts are reported, show them
  verbatim with the CLI's recovery advice and stop — force only on explicit
  request.
- If `syncState` is INCOMPATIBLE (major jump): explain the implication, and let
  the user decide whether to `sync --force` now or wait.
- If paths moved: jump to Repair.

## Flow: Inspect Setup

Read-only variant of everything above. Run every check, touch nothing — not even
`.agent-team/` regeneration. Produce the Final Report plus a Warnings section
(missing bindings, outdated syncs, unregistered-but-present repos, remote mismatches).

## Flow: Repair

Common breakages, minimal fixes — canonical identities never change implicitly:

| Symptom | Fix |
|---|---|
| Requirements/design docs found inside a Target (`_docs/module/**`) | an analysis role wrote into the wrong workspace; migrate to `<knowledgeRoot>/_docs/module/<name>/` (merge status tables), remove the Target-side copy only on explicit confirmation, and find how lane routing failed before continuing |
| BA-lane prompts present in a DEV workspace (or engineer prompts in a BA one) | roster drift — plain `software-team-agents sync`; escalate to `sync --force` only on the user's explicit word |
| BA/UXUI prompts unavailable anywhere despite a bound Knowledge root | the Knowledge repo was never initialized — run the BA flow's bound-but-uninitialized step |
| Knowledge/Target moved on disk | update `knowledge.path` in the workspace config, or the mapping entry in `.workflow/targets.local.yaml` (show the diff first); identity in `targets.yaml` stays |
| Missing local mapping | add just that mapping block to `.workflow/targets.local.yaml` |
| Stale sync (`OUTDATED`) | plain `software-team-agents sync` |
| Remote mismatch vs `targets.yaml` | report both URLs, change nothing until the user decides which side is wrong |
| Config half-lost (manifest without config) | re-run `init` in that workspace |
| Knowledge repo's own doc tree doesn't match canonical shape (legacy folders, stray files, unrecognized `knowledge/**` subtrees) | binding/sync is a separate concern from this — hand off to `prompt-update-knowledge.md` |

After any repair: `status` again and confirm the specific symptom is gone.

---

## Validation rules for any user-supplied path

- exists and readable; writable iff this role writes there (BA→Knowledge yes,
  DEV→Target yes, everything else no)
- standalone Git repository (reject linked worktrees)
- not inside the Framework checkout
- not already claimed by another configured workspace (duplicate detection)
- actually the kind of repo it claims to be (Knowledge markers vs app markers)

## Merging with the project's existing Claude setup

When the Target already carries its own `.claude/` (common for mature repos),
the CLI deliberately never merges hand-written content: any pre-existing file at
a managed path is reported as `untracked-file` and skipped. That keeps sync
honest but leaves the workspace silently unguarded. You close that gap — this
is one of the few places this playbook edits file content, under these rails:

1. **Show both sides first.** For each reported `untracked-file`, show the
   project's version and the Framework's intended version side by side before
   proposing anything.
2. **Merge, don't replace.**
   - `.claude/settings.json`: keep every project hook/permission; append the
     Framework's PreToolUse/SubagentStop/Stop entries. Validate JSON before and
     after.
   - `CLAUDE.md`: keep the project document intact; add the Framework section
     (agent table pointer + policies reference) below it, clearly delimited.
   - Agent prompts with colliding names: never auto-pick. Ask whether the
     project's file should win (then claim it via `overrides`) or the Framework
     version should land (back up the project's copy into `.agent-team/backups/`
     manually first).
3. **Claim what survives.** After merging, add each touched path to
   `.agent-team/config.yaml` `overrides:` so future syncs skip them *on purpose*
   instead of reporting noise.
4. **Re-verify.** `software-team-agents status` must come back with all
   runtimes READY and zero unexpected `untracked-file` reports; then run one
   read-only agent smoke check if the user wants belt-and-braces.

## Safety rails — never, under this playbook

- never delete a Target, Knowledge content, project source, or `.agent-team/`
- never edit Framework source/templates to make a setup work
- never run `sync --force` unprompted; never write into another role's workspace
- never invent config fields; unknown keys in existing configs are preserved
- never bypass the CLI by generating managed files by hand
- **never run a state-changing git command without showing it first and getting
  explicit confirmation.** This playbook is otherwise entirely git-free — every
  other step goes through the official CLI (Operating principle #2). `git clone`
  and `git init`, introduced by Flow: DEV's Target-resolution cases 2 and 3, are
  the one exception, and the bar for them is the same either way: show the exact
  command, wait for the user to say yes to *that* command, never assume a
  "use my defaults" answer earlier in the conversation covers it too.

## Final report template

```text
Setup complete — <role>
Framework : <frameworkVersion> at <frameworkRoot>
Workspace : <workspace path> (<kind>)
Knowledge : <path or "not required">
Targets   : <ids> (local paths)
Sync      : <state>, managed files <n>, conflicts <n>
Runtimes  : claude <READY/…>, codex <…>, opencode <…>
Next      : cd <workspace> && software-team-agents <command>
Warnings  : <anything worth watching, else "none">
```

---

## Notes for framework developers and future modes

- Running from a development checkout works identically: the CLI resolves the
  Framework from its own location (`resolveFrameworkRoot`), so dogfooding needs
  no special casing — but the checkout itself must never become a workspace.
- The setup contract above deliberately depends only on the installed CLI's
  surface (`init/sync/status/--json`) and standard files — a future
  `software-team-agents setup` command or an installed `.tgz` distribution can
  adopt the same model without changing this playbook.
