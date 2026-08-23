# prompt-setup.md — AI-Assisted Setup Playbook

> **What this is:** a playbook for an AI coding assistant (Claude Code, Codex, or
> any agent that can read files and run shell commands) to set up
> **software-team-agents** on this machine for one person's role.
>
> **How to use it:** give your assistant this file — e.g. paste its contents into
> the session, or point Claude Code / Codex at it ("read prompt-setup.md and set me
> up"). The playbook is runtime-agnostic: it only assumes file access and a shell.

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
   minimal field updates, never wholesale rewrites.
4. **Short, actionable interactions.** One question at a time, each with the
   detected default offered ("I found X at … — use it? [Y/n]"). Respond in the
   user's language.
5. **Report at the end** using the format in the Final Report section, including
   the exact command the user can run to continue working.

---

## Phase 0 — Initial inspection (always run this first)

Run these read-only checks from the current directory. Collect facts silently;
do not bother the user with anything that resolves cleanly.

```bash
software-team-agents status --json        # roots, role, versions, sync state, readiness
software-team-agents --version            # installed Framework version
```

Then, guided by what status reports:

| Fact | How to detect |
|---|---|
| Framework root + version | `status --json` → `frameworkRoot`, `frameworkVersion`; missing ⇒ the CLI itself is not installed — tell the user how to install (`npm i -g software-team-agents-<v>.tgz`) and stop |
| Current directory's workspace kind & role | `status --json` → `workspaceKind`, `role`; also read `.agent-team/config.yaml` if present (`role`, `knowledge.path`, `overrides`) |
| Knowledge root (machine-wide) | `status --json` → `knowledgeRoot` / `knowledgeBinding` (via installation binding) |
| Registered Targets | read `<knowledgeRoot>/targets.yaml` when a Knowledge root resolved |
| Local path mappings | read `<knowledgeRoot>/.workflow/targets.local.yaml` if present |
| Sync status of the current workspace | `status --json` → `syncState`, `syncedVersion`, `conflictCount`, `managedFileCount` |
| Runtime readiness | `status --json` → `claude.ready`, `codex.ready` |

If `status` fails because the current directory is not a Git repository, that is
fine — you are likely standing outside any workspace. Note it and continue to
the role menu; the chosen flow will ask where to work.

Present a one-screen summary of what you found, then show the menu.

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
- `cd <knowledge>` then run `software-team-agents init`
  (auto-detects the BA workspace) followed by `software-team-agents sync`.
- Optionally offer: "Bind this machine's default Knowledge root too?" →
  `sta configure knowledge-root <path>` (affects other flows on this machine).
- Verify with `software-team-agents status`: expect Role `BA`, `Target: NOT
  REQUIRED`, sync `UP_TO_DATE`, Claude/Codex READY.
- Tell the user their working command: `cd <knowledge> && software-team-agents ba`.

## Flow: DEV

**Goal:** DEV ready in the Target; Knowledge bound as read context.

- Resolve the Target: the current directory if it is an application repo, else ask.
  Validate: exists, standalone Git repo, has application markers (package.json,
  pyproject.toml, pom.xml, *.sln, …).
- Resolve Knowledge: reuse any valid binding (`config.knowledge.path` or the
  machine-wide one). Only if none: ask for the Knowledge repo path and validate
  as in the BA flow.
- Write the binding into `.agent-team/config.yaml` (`knowledge:` → relative or
  absolute path), or run `sta configure knowledge-root` if the user wants it
  machine-wide. Show exactly what you are about to write before writing.
- In the Target: `software-team-agents init` (detects DEV; pass `--role dev`
  yourself only if detection reported ambiguity) then `software-team-agents sync`.
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
- Working command: `cd <target> && software-team-agents dev`.

## Flow: QA

**Goal:** same shape as DEV, but requirements are derived, not assumed.

- Read the official sources of truth before asking anything:
  - `<frameworkRoot>/workflows/*.yml` — which stages participate per change type
  - `<frameworkRoot>/contracts/qa-engineer.yaml` — QA's declared read/write scope
- From those, derive what QA needs on this machine (typically: Knowledge for
  review context + a writable Target checkout to verify against) and state the
  derivation out loud: "workflows X and Y put qa-engineer after engineers, and
  its contract writes review docs — so it needs …".
- Then follow the DEV steps (Target + Knowledge binding + init/sync/status).
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
  If conflicts are reported, show them verbatim with the CLI's recovery advice
  and stop — force only on explicit request.
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
| Knowledge/Target moved on disk | update `knowledge.path` in the workspace config, or the mapping entry in `.workflow/targets.local.yaml` (show the diff first); identity in `targets.yaml` stays |
| Missing local mapping | add just that mapping block to `.workflow/targets.local.yaml` |
| Stale sync (`OUTDATED`) | plain `software-team-agents sync` |
| Remote mismatch vs `targets.yaml` | report both URLs, change nothing until the user decides which side is wrong |
| Config half-lost (manifest without config) | re-run `init` in that workspace |

After any repair: `status` again and confirm the specific symptom is gone.

---

## Validation rules for any user-supplied path

- exists and readable; writable iff this role writes there (BA→Knowledge yes,
  DEV→Target yes, everything else no)
- standalone Git repository (reject linked worktrees)
- not inside the Framework checkout
- not already claimed by another configured workspace (duplicate detection)
- actually the kind of repo it claims to be (Knowledge markers vs app markers)

## Safety rails — never, under this playbook

- never delete a Target, Knowledge content, project source, or `.agent-team/`
- never edit Framework source/templates to make a setup work
- never run `sync --force` unprompted; never write into another role's workspace
- never invent config fields; unknown keys in existing configs are preserved
- never bypass the CLI by generating managed files by hand

## Final report template

```text
Setup complete — <role>
Framework : <frameworkVersion> at <frameworkRoot>
Workspace : <workspace path> (<kind>)
Knowledge : <path or "not required">
Targets   : <ids> (local paths)
Sync      : <state>, managed files <n>, conflicts <n>
Runtimes  : claude <READY/…>, codex <…>
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
