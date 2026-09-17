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
> **Human-facing counterpart:** [`README.md` § Getting Started](README.md#getting-started) is the
> manual onboarding guide; [§ Ownership, health and troubleshooting](README.md#ownership-health-และ-troubleshooting)
> covers recovery (`TEAM_SETUP_V1.md` is now a pointer to the same place).
>
> **Knowledge refresh counterpart:** [`prompt-update-knowledge.md`](prompt-update-knowledge.md)
> incrementally refreshes and reconciles canonical knowledge against evolving codebase reality.

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
   doesn't exist locally yet, Register-a-Target cases 2/3 — always
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
software-team-agents status --json        # workspace, roots, versions, sync state, readiness
software-team-agents --version            # installed Framework version
sta --check-workspace --project-root .    # misplaced module docs, when this is a Target checkout
```

Then, guided by what status reports:

| Fact | How to detect |
|---|---|
| Framework root + version | `status --json` → `frameworkRoot`, `frameworkVersion`; missing ⇒ the CLI is not installed — install it (see below), then continue rather than stopping |
| Current directory's workspace kind | `status --json` → `workspaceKind`; also read `.agent-team/config.yaml` if present (`knowledge.path`, `overrides` — a `role` key there is a legacy record and decides nothing) |
| Target stack profile | `status --json` → `stack` (`profile`, `package_manager`, `commands`, `schema_paths`, `source_roots`, `fingerprint`). Report this Harness result; do not detect the stack yourself. If absent or the Harness reports ambiguity/unresolved evidence, show that evidence and ask the user to confirm one `--stack <name>` choice before rerunning `init`/`sync`. Ask no stack question when `stack` is resolved. |
| Knowledge root (machine-wide) | `status --json` → `knowledgeRoot` / `knowledgeBinding` (via installation binding) |
| Registered Targets | read `<knowledgeRoot>/targets.yaml` when a Knowledge root resolved |
| Local path mappings | read `<knowledgeRoot>/.workflow/targets.local.yaml` if present |
| Sync status of the current workspace | `status --json` → `syncState`, `syncedVersion`, `conflictCount`, `managedFileCount` |
| Runtime readiness | `status --json` → `claude.ready`, `codex.ready`, `opencode.ready`, `antigravity.ready` (OpenCode needs bindings **and** `.opencode/plugin/sta-guards.js` — its headless default posture is allow-all, so a missing plugin means unguarded, not just incomplete) |
| Knowledge root bound but never initialized | `status --json` → `knowledgeBoundButUninitialized` (the bound root's path, or absent) — machine binding resolves but `<knowledgeRoot>/.agent-team/config.yaml` is absent; status prints `WARNING:` line with fix command |
| Module docs stranded in a Target | `sta --check-workspace --project-root <path>` (the Framework's top-level CLI, not `software-team-agents`) — flags `_docs/module/**` files and `## Modules` in `_docs/status.md` inside a Target checkout with Knowledge destination paths |

If `status` fails because the current directory is not a Git repository, that is
fine — you are likely standing outside any workspace. Note it and continue to
the setup menu; the chosen flow will ask where to work.

Present a one-screen summary of what you found, then show the menu.

### Installing the CLI, if it is missing

From a Framework checkout:
```bash
cd <framework-checkout>
npm --prefix orchestrator run build
npm link
```
`npm link` points global `software-team-agents` / `sta` binaries at the checkout.
Verify with `software-team-agents --version`. From a released package without checkout:
`npm i -g software-team-agents-<v>.tgz`. Do not run `npm run release` to install —
it runs the full test suite and packs a tarball.

---

## Setup menu

Ask which one applies (**this is the one question always asked**, unless the user
already said):

1. **Set up the Knowledge workspace** — the one workspace V10 works from; every
   role's prompts ship in the single payload, so analysis, engineering and QA
   all work from here
2. **Register a Target** — add a Target to `targets.yaml` + `.workflow/targets.local.yaml`,
   cloning or creating its checkout when needed
3. **Update Setup** — re-inspect and refresh an existing setup (Framework moved/updated)
4. **Inspect Setup** — full read-only report; change nothing
5. **Repair Setup** — something broke (moved repos, stale sync, remote mismatch)

---

## Flow: Set up the Knowledge workspace

**Goal:** the Knowledge workspace ready — Framework payload synced, ready to open a
session with `software-team-agents open`. A Target never blocks this; Targets are
registered (flow 2) and stay plain checkouts.

- If no Knowledge path was detected: ask for it. Validate before accepting:
  - path exists, is a standalone Git repository (`.git` present)
  - looks like a Knowledge repo (`knowledge/`, `_docs/`, `targets.yaml`, or
    `knowledge-policy.yaml` present). If not, say so and stop — do not create
    one unless the user explicitly asks for a fresh Knowledge repo.
- **Bound-but-uninitialized Knowledge root.** If Phase 0 found a machine-wide
  binding whose repository has no `.agent-team/config.yaml`, surface that first
  and offer to materialize it now ("Knowledge root found at X but never set up —
  initialize? [Y/n]"): `cd <root> && software-team-agents init` then `sync`.
  Until this runs, no STA prompts exist anywhere on the machine.
- `cd <knowledge>` then run `software-team-agents init`
  (detects the Knowledge workspace) followed by `software-team-agents sync`.
- Optionally offer: "Bind this machine's default Knowledge root too?" →
  `sta configure knowledge-root <path>` (affects other flows on this machine).
- Verify with `software-team-agents status`: expect `Workspace: Knowledge`, sync
  `UP_TO_DATE`, Claude/Codex/OpenCode READY.
- **One payload, every role.** The synced workspace materializes all eleven
  prompts — analysis roles, engineers, `qa-engineer`, `security`, `devops` and
  `uxui-designer` — plus contracts, workflows, stacks, hooks and policies
  (V10 TASK-020). There is no per-role payload split to choose. Targets are
  read-only from the session; writing one goes through an orchestrated stage.
- **UX/UI consultant.** For Figma/Claude Design MCP, configure identity once:
  `sta configure identity --figma-email <email> --claude-email <email>` (matching
  emails; `FIGMA_PAT` stays in environment). Without these, `uxui-designer` fails closed.
- **Capturing canonical knowledge for an existing project.** When bootstrapping
  knowledge from an existing codebase across Targets:
  1. Inspect reality: code, runtime behaviour, configs, API/DB contracts,
     maintained docs, existing knowledge, and optional reference docs.
  2. **Source Priority on conflict (AD-12):** (1) Current code & runtime behaviour;
     (2) Config, API, DB schemas, contracts; (3) Canonical STA knowledge;
     (4) Maintained docs; (5) Optional reference docs. Current implementation wins
     unless evidence explicitly marks an approved future/planned requirement.
  3. Derive canonical entities: modules (`_docs/module/<name>/`), Target IDs,
     paths, and declared `type` (`frontend` | `backend` | `fullstack`) in `targets.yaml`,
     responsibilities, dependencies, and scopes (module-wide `target_ids: []`,
     Target-specific `target_ids: [target_id, ...]`). Supports 3+ Targets.
  4. Write canonical output only: `knowledge/<module>/<kind>/<ID>.yaml` and
     `_docs/module/<name>/design.md` `## Targets`.
  5. **Read-only evidence rule (CR-6, AD-11):** Reference docs remain untouched —
     never move, rename, rewrite, normalize, convert or validate them; never run
     migration commands or compatibility frameworks.
  6. For ongoing incremental updates, use [`prompt-update-knowledge.md`](prompt-update-knowledge.md).
- Tell the user their working command: `cd <knowledge> && software-team-agents open`
  (add `--runtime opencode` or `--runtime codex` to choose a different runtime).

## Flow: Register a Target

**Goal:** one more Target registered without disturbing anything else.

- **Resolve the Target checkout — three shapes; tell them apart before touching
  anything, and never guess which one applies:**
  1. **Already exists.** The current directory is an application repo, or the user points at an existing local path. Validate: exists, standalone Git repo, has application markers (package.json, pyproject.toml, pom.xml, *.sln, …). This is the common case — proceed as below.
  2. **Has a remote, not cloned to this machine yet.** Ask for the remote URL and the local path to clone it to. Show the exact command — `git clone <url> <path>` — before running it, and wait for the user's explicit confirmation (Safety rails below: this is the first state-changing git command anywhere in this playbook, and it is never auto-run). Once cloned, validate exactly as case 1.
  3. **Nothing yet — a genuinely new project, no remote either.** Agree the target path with the user, show `git init <path>` before running it, and wait for the same explicit confirmation as case 2. The Target is registered as an identity here; its code arrives when the project actually starts — scaffolding is the `setup` agent's job, through an orchestrated stage, never this playbook.
- Registration never writes inside the Target checkout: a Target stays a plain
  checkout (V10 — no STA payload is installed in a Target; TASK-020/029. A legacy
  payload left from before V10 is removed by `software-team-agents cleanup --yes`,
  a person's decision, not this playbook's).
1. Read `targets.yaml` in the Knowledge root first — existing targets stay untouched.
2. Ask for: Target name/id, local path, remote URL, optional type (`frontend` | `backend` | `fullstack`).
3. Validate the new path like case 1 above; additionally check the local checkout's
   git remote matches the given URL (report a mismatch, don't "fix" it silently).
4. Propose the exact YAML block to append to `targets.yaml` (including optional type)
   **and** the matching `.workflow/targets.local.yaml` mapping; apply only after the user confirms.
5. Verify all previously registered Targets still resolve, then `status`.

## Flow: Update Setup

**Goal:** refresh an existing setup after a Framework upgrade or a move.

- Re-run Phase 0 for each workspace.
- For workspaces where `syncState` is OUTDATED: run `software-team-agents sync`.
  If conflicts are reported, show them verbatim with recovery advice and stop —
  force only on explicit request.
- If `syncState` is INCOMPATIBLE (major jump): explain and let user decide whether to `sync --force`.
- If paths moved: jump to Repair.

## Flow: Inspect Setup

Read-only variant of everything above. Run every check, touch nothing — not even
`.agent-team/` regeneration. Produce the Final Report plus a Warnings section
(missing bindings, outdated syncs, unregistered-but-present repos, remote mismatches).

Note: Desktop sessions without launcher env are supported: the Knowledge root resolves from
`installation.yaml` (`T-V6-006`), so `sta context` runs directly. A `role` key in
`.agent-team/config.yaml` (`T-V6-007`) is a legacy record that decides nothing.
Do not treat missing launcher env as a failure.

## Flow: Repair

Common breakages, minimal fixes — canonical identities never change implicitly:

| Symptom | Fix |
|---|---|
| Requirements/design docs found inside a Target (`_docs/module/**`) | report exact paths as read-only project references; do not copy, rewrite, move or delete them; route canonical doc work to owning analysis role in Knowledge workspace |
| No STA prompts anywhere despite a bound Knowledge root | Knowledge repo never initialized — run the Set-up-the-Knowledge-workspace flow's bound-but-uninitialized step |
| Knowledge/Target moved on disk | update `knowledge.path` in config or entry in `.workflow/targets.local.yaml` (show diff first); identity in `targets.yaml` stays |
| Missing local mapping | add mapping block to `.workflow/targets.local.yaml` |
| Stale sync (`OUTDATED`) | plain `software-team-agents sync` |
| Remote mismatch vs `targets.yaml` | report both URLs, change nothing until user decides which side is wrong |
| Config half-lost (manifest without config) | re-run `init` in that workspace |
| Knowledge repo's STA-owned doc tree doesn't match current canonical shape | report failing checker and exact STA-owned paths; do not convert project reference docs or create compatibility layout |

After any repair: `status` again and confirm the specific symptom is gone.

---

## Validation rules for any user-supplied path

- exists and readable; the Knowledge workspace is the only workspace this playbook
  creates or writes — Target checkouts are registered, never written
- standalone Git repository (reject linked worktrees)
- not inside the Framework checkout
- not already claimed by another configured workspace (duplicate detection)
- actually the kind of repo it claims to be (Knowledge markers vs app markers)

## Existing Claude setup

`software-team-agents sync` preserves project-owned configuration: it merges
missing Framework guard registrations into `.claude/settings.json` and injects
only delimited `sta:bootstrap` into project-owned root instructions, backing up
first. On blocking conflicts, leave untouched and follow named recovery advice
(repair, claim in `overrides`, or confirmed backed-up force).

## Safety rails — never, under this playbook

- never delete a Target, Knowledge content, project source, or `.agent-team/`
- never edit Framework source/templates to make a setup work
- never run `sync --force` unprompted; never write into a Target checkout (registration
  touches `targets.yaml` + `.workflow/targets.local.yaml` only)
- never invent config fields; unknown keys in existing configs are preserved
- never bypass the CLI by generating managed files by hand
- never modify, move, rename, convert, or validate optional reference documents (read-only evidence)
- never run removed migration commands or rely on compatibility frameworks
- **never run a state-changing git command without showing it first and getting
  explicit confirmation.** This playbook is otherwise entirely git-free — every
  other step goes through the official CLI (Operating principle #2). `git clone`
  and `git init`, introduced by Register-a-Target cases 2 and 3, are
  the one exception, and the bar for them is the same either way: show the exact
  command, wait for the user to say yes to *that* command, never assume a
  "use my defaults" answer earlier in the conversation covers it too.

## Final report template

```text
Setup complete — <workspace kind>
Framework : <frameworkVersion> at <frameworkRoot>
Workspace : <workspace path> (<kind>)
Knowledge : <path or "not required">
Targets   : <ids> (local paths)
Stack     : <resolved profile and package manager, or unresolved + confirmed fix>
Sync      : <state>, managed files <n>, conflicts <n>
Runtimes  : claude <READY/…>, codex <…>, opencode <…>, antigravity <…>
Next      : cd <workspace> && software-team-agents <command>
Warnings  : <anything worth watching, else "none">
```

---

## Notes for framework developers and future modes

- Running from a dev checkout works identically (`resolveFrameworkRoot`), but
  the checkout itself must never become a workspace.
- The setup contract depends only on the installed CLI's surface
  (`init/sync/status/--json`) and standard files — future commands or distributions
  adopt the same model without changing this playbook.
