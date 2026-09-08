# `policies/` — ห้ามอะไร

The framework policies are organized into one file per area:

```
policies/
├── README.md            this index
├── agent-boundaries.md  §6, §6a, §8
├── architecture.md      §7, §14, §15
├── coding.md            §5c, §9, §12, §19, §20
├── communication.md     §13
├── data.md              §16
├── documentation.md     §0, §1, §2, §3, §4, §5b, §10, §11, §12
├── git.md               §5, §22
├── security.md          §5a, §5c-1, §5d, §21
└── ux.md                §17, §18
```

A citation like "conventions.md §7" reads `policies/architecture.md §7`; `.claude/shared/conventions.md` itself is a short pointer table for compatibility.

The bounded wave run has a user-facing guide at `docs/bounded-wave-run.md`; it points at
`policies/git.md §22` and `decisions/ADR-026` rather than restating them.

## What belongs here

Policy is the answer to *ห้ามอะไร* — what no agent may do. Nine area files above plus this
index, one file per area, so a rule can be found by asking "which area is this?" instead of
searching one file's headings.

## What does not belong here

**The enforced half of policy.** A rule in `.claude/hooks/` is not documentation of a rule — it
*is* the rule, and it binds an agent that never read a word of it. Those stay where
`.claude/settings.json` wires them, and `--check-layout` verifies every one of them is actually
referenced there. A guard on disk that the settings file does not mention enforces nothing while
looking installed; this repo has shipped exactly that failure twice.

Anything load-bearing should end up in that enforced form. Written policy is for the rules a
hook cannot express.

See `layout.yaml` for the full concept map.
