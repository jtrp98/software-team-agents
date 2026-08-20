# `workflows/` — ทำเมื่อไหร่

**Reserved for T09.** This directory is claimed but not yet filled: it holds nothing but this
file, and `--check-layout` fails if anything else appears here before T09 lands.

## What belongs here

A workflow is the answer to *ทำเมื่อไหร่* — which roles run, in what order, for a given kind of
change. One YAML per kind:

```yaml
workflow: feature
steps: [ba, sa, pm, backend, frontend, qa, security, devops]
```

T09 adds `feature.yml`, `bugfix.yml`, `refactor.yml`, `hotfix.yml`, `security-fix.yml`.

## Where this lives today

In code, not data: `orchestrator/src/classification/taskClassifier.ts` decides the pipeline for a
change from a set of flags. That works and is tested — the cost is that changing *what happens
for a hotfix* is a code change and a release, rather than an edit to a file a person can read.

## What does not belong here

**Which agent runs a step, and what it may touch.** That is the agent concept
(`.claude/agents/` + `contracts/`). A workflow names steps; it does not redefine the roles that
serve them.

**What is currently running.** That is runtime state, in `.workflow/state.db`. A workflow file is
a definition — the same for every task — and must stay readable without knowing which task is in
flight.

See `layout.yaml` for the full concept map.
