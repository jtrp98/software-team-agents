# `policies/` — ห้ามอะไร

The framework policies are organized into one file per area:

```
policies/
├── coding.md            §5c, §9, §12
├── git.md               §5
├── architecture.md      §7
├── documentation.md     §1, §2, §3, §4, §5b, §10, §11
├── security.md          §5a, §5c-1, §5d
└── agent-boundaries.md  §6, §6a, §8
```

A citation like "conventions.md §7" reads `policies/architecture.md §7`; `.claude/shared/conventions.md` itself is a short pointer table for compatibility.

## What belongs here

Policy is the answer to *ห้ามอะไร* — what no agent may do. Six files above, one per area, so a
rule can be found by asking "which area is this?" instead of searching one file's headings.

## What does not belong here

**The enforced half of policy.** A rule in `.claude/hooks/` is not documentation of a rule — it
*is* the rule, and it binds an agent that never read a word of it. Those stay where
`.claude/settings.json` wires them, and `--check-layout` verifies every one of them is actually
referenced there. A guard on disk that the settings file does not mention enforces nothing while
looking installed; this repo has shipped exactly that failure twice.

Anything load-bearing should end up in that enforced form. Written policy is for the rules a
hook cannot express.

See `layout.yaml` for the full concept map.
