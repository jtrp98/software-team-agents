# `policies/` — ห้ามอะไร

**Reserved for T49.** This directory is claimed but not yet filled: it holds nothing but this
file, and `--check-layout` fails if anything else appears here before T49 lands.

## What belongs here

Policy is the answer to *ห้ามอะไร* — what no agent may do. Today it lives in one file,
`.claude/shared/conventions.md`, at 373 lines and thirteen numbered sections. T49 splits it into
one file per area:

```
policies/
├── coding.md
├── git.md
├── architecture.md
├── documentation.md
├── security.md
└── agent-boundaries.md
```

## What does not belong here

**The enforced half of policy.** A rule in `.claude/hooks/` is not documentation of a rule — it
*is* the rule, and it binds an agent that never read a word of it. Those stay where
`.claude/settings.json` wires them, and `--check-layout` verifies every one of them is actually
referenced there. A guard on disk that the settings file does not mention enforces nothing while
looking installed; this repo has shipped exactly that failure twice.

Anything load-bearing should end up in that enforced form. Written policy is for the rules a
hook cannot express.

## Why the split is not free

Sixty-eight references across the nine agent prompts point at `.claude/shared/conventions.md`
by path. Splitting the file means updating every one of them in the same change — which is why
T49 is its own task and not a side effect of the layout work that reserved this directory.

See `layout.yaml` for the full concept map.
