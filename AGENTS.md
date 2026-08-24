# software-team-agents — Agent Instructions

Operational instructions for AI agents working in this repository. This describes
**current** V1 behavior only; superseded architecture (`.Codex/`, pre-Three-Repo
layouts) no longer applies anywhere in this repo.

## What this repo is

The **Framework repo** of a Three-Repo architecture — a process/workflow layer plus
the `sta` orchestrator CLI that drives ten agent roles (`setup`, `business-analyst`,
`system-analyst`, `project-manager`, `test-planner`, `backend-engineer`,
`frontend-engineer`, `qa-engineer`, `security`, `devops`) through a runtime:
Claude Code reads `.claude/agents/*.md`, Codex reads `.codex/agents/*.toml`,
OpenCode reads `.opencode/agent/*.md` (generated; see `planning/v2/opencode-runtime-TASKS.md`).

| Repo | Owns | Notes |
|---|---|---|
| **Framework** (this repo) | `orchestrator/` (the CLI), agent prompts, hooks, `contracts/`, `workflows/`, `policies/`, `stacks/`, `templates/` | distributed as the npm package `sta` |
| **Knowledge** (per company) | `knowledge/` (9 item kinds, one YAML per fact), `_docs/module/<name>/`, `decisions/`, `targets.yaml`, `knowledge/_roles/**`, `.workflow/targets.local.yaml` | bound to a machine with `configure knowledge-root`; `_roles/**` is written by humans only |
| **Target** (per product) | real source code | identity registered in `targets.yaml`; each machine maps physical paths in `.workflow/targets.local.yaml` |

Installation state lives outside any repo: `%LOCALAPPDATA%\software-team-agents\installation.yaml`
(Windows) or `~/.config/software-team-agents/installation.yaml`. Install modes are
explicit: `sta init --mode <legacy-project|three-repo>` — never inferred.
Team onboarding flow: [`TEAM_SETUP_V1.md`](TEAM_SETUP_V1.md).

## Hard boundaries (enforced by hooks, not memory)

- **No state-changing git.** Read-only git (`status`/`log`/`diff`/`show`) runs; everything else is blocked at the tool call (`.claude/hooks/block-git.js`).
- **No write outside the resolved workspace roots**, whatever the reason (`.claude/hooks/block-outside-repo.js`). In three-repo runs the orchestrator passes the writable Target roots via `AGENTCLAUDE_WRITABLE_WORK_ROOTS`.
- **Write only what your role's contract allows** (`contracts/<role>.yaml` → `.claude/hooks/block-path-permissions.js`). `knowledge/_roles/**` and `.workflow/**` are denied to every agent.
- **Amend, don't regenerate**: existing module docs under `_docs/` are edited section-by-section with a dated Change Log line (`.claude/hooks/block-doc-rewrite.js`).
- **Only `qa-engineer` sets a task's Status cell** to `verified`/`blocked` in `plan.md`. Engineers don't edit `plan.md` at all (their contracts deny `_docs/module/**`) — an engineer starting a row says so in its handoff; `project-manager` and `qa-engineer` are the only writers the table has.
- **Approvals and sign-offs are human acts**, recorded via `sta roles approve|signoff|ack`. An agent writing one would be forging it.
- **Five points always wait for a person**: requirement interview, schema confirmation, failed QA round (rounds 1–2 auto-route back; the third failure or any Critical escalates), Critical/Important security finding, real deploy/migration. Knowledge-migration cutover additionally requires `--confirm I_CONFIRM_MIGRATION`. Orchestrated pipelines chain `qa-engineer` (every code change) and `security` (sensitive/schema) automatically — it is their *verdicts* that stop for a person, never bypassed.
- **Dates come from the user. Engineers never decide rules** — unclear logic goes back to `system-analyst` (business questions on to `business-analyst`), never improvised.

## Commands

All commands below are real; verify against `node orchestrator/dist/cli.js` usage output when unsure.

```bash
# framework development
cd orchestrator && npm ci && npm test && npm run typecheck && npm run build
npm run build:templates          # (inside orchestrator/) regenerate templates/ snapshot + manifest.json — never hand-edit templates/
node .claude/tests/run.js        # hook/script self-test — must pass after touching ANY hook or script (covers both runtimes' hook copies)

# validation flags (all 15 wired into CI; the CLI also has --check-bindings, not in CI)
node orchestrator/dist/cli.js --check-contracts|--check-layout|--check-workflows|--check-profile|--check-decisions \
  |--check-test-pyramid|--check-review-separation|--check-escalation-policy|--check-workspace|--check-repos \
  |--check-environments|--check-doc-structure|--check-knowledge|--check-installation|--check-roles

# task lifecycle / installation
node orchestrator/dist/cli.js init --mode <legacy-project|three-repo> [--templates templates]
node orchestrator/dist/cli.js configure knowledge-root <path>
node orchestrator/dist/cli.js doctor --project-root <path>
node orchestrator/dist/cli.js run --task-id <id> --module <name> <classification flags> [--autonomy read-only|propose|edit|full]
node orchestrator/dist/cli.js status|approve|resume|retry|pause|cancel|audit <task-id>
node orchestrator/dist/cli.js roles review|approve|signoff|ack|inbox|impact|context ...
node orchestrator/dist/cli.js upgrade|migrate|rollback|list-backups|adopt|knowledge-migrate ...
```

## Files an agent must not treat as editable docs

- `templates/` — build artifact regenerated by `npm run build:templates`; edit the root sources it snapshots (`.claude/agents/`, `contracts/`, `policies/`, …) instead.
- `.workflow/` — runtime state (`state.db`), machine-local, never hand-edited.
- `planning/` — internal working docs, deliberately gitignored, not part of the release.

## Canonical documentation

One home per concept; link instead of copying:

- Shared agent rules → [`policies/`](policies/README.md) (coding, git, architecture, documentation, security, agent-boundaries)
- Pipeline detail (roles, gates, recovery, model tiers) → [`CLAUDE.md`](CLAUDE.md)
- Knowledge model → [`knowledge/README.md`](knowledge/README.md)
- Product overview & runtime support status → [`README.md`](README.md)
- Team setup / troubleshooting → [`TEAM_SETUP_V1.md`](TEAM_SETUP_V1.md)
- Directory ownership declaration → [`layout.yaml`](layout.yaml) (checked by `--check-layout`)
