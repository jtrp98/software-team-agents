# `policies/` — ห้ามอะไร

**Filled by T49.** `.claude/shared/conventions.md` (373 lines, thirteen numbered sections) is
split into one file per area:

```
policies/
├── coding.md            §5c, §9, §12
├── git.md               §5
├── architecture.md      §7
├── documentation.md     §1, §2, §3, §4, §5b, §10, §11
├── security.md          §5a, §5c-1, §5d
└── agent-boundaries.md  §6, §6a, §8
```

Section numbers didn't change — only which file holds them. A citation like "conventions.md §7"
now reads "`policies/architecture.md` §7"; `.claude/shared/conventions.md` itself is now a short
pointer table for anything still built against the old path.

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

## Why the split took a whole task, not a rename

Around 150 references across the eleven agent prompts, `.claude/hooks/`, `.claude/scripts/`, and
`orchestrator/src/`'s own comments point at `.claude/shared/conventions.md` by path and section
number. Every one of those had to either keep working (the section numbers didn't move) or get
repointed to the new file (the ones that cited `conventions.md` generically, without a number) —
which is why T49 is its own task and not a side effect of the layout work that reserved this
directory.

See `layout.yaml` for the full concept map.
