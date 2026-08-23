# `knowledge/` — what this project knows about itself

One YAML file per fact: a requirement, a business rule, a domain term, an architecture
note, an API, a DB model, an ADR, a task, a test. Nine kinds, **one shape** — the envelope
in `orchestrator/schemas/knowledge-item.schema.json` — so that a question crossing kinds
("which tasks implement the API this requirement needs") is one query rather than a join
each caller writes for itself.

```
knowledge/
├── <module>/            ← _docs/module/<name>, or `_project` for project-wide items
│   └── <kind>/
│       └── <ID>.yaml
├── _sources/            ← SRC-*.yaml: the raw material that was ingested (T62)
├── _conflicts/          ← CONF-*.yaml: a person's decision about two facts that contradict (T66)
├── _bootstrap/          ← STATE.yaml: how far first-time discovery got (T73)
├── _human-input/        ← what a person supplied that no file could be read for (T79)
├── _adoption/           ← the staging area for migrating an existing project in (T81)
└── _roles/              ← <module>/<lane>.yaml: where BA, SA and DEV each stand (T99)
```

Every `_`-prefixed name above is reserved — the item walk skips them, so they can never be
mistaken for a module full of malformed items. The list the code enforces is `RESERVED_DIRS`
in `orchestrator/src/knowledge/knowledgeStore.ts`.

`<ID>` is the id the pipeline already uses — `REQ-003`, `DES-003`, `BE-014`, `TEST-003`,
`ADR-004` (T19). Not a parallel id: one that differed from the id in `plan.md` would need a
mapping nobody maintains.

## Why files in the repo, and not a database

Everything here has to be shared between people on different machines. A SQLite file cannot
do that: committed, it is a binary blob git cannot merge; not committed, it is not shared,
which is the problem this directory exists to solve. Files plus git also match the
constraints already enforced on every agent — they can write files and cannot run git — and
they make review a pull request instead of a UI somebody would have to build first.

**One file per item** so a conflict happens only when two people really did edit the same
item. BA adding `REQ-012` while DEV edits `BE-014` touches two files and merges clean. The
by-product is per-item history for free: `git log knowledge/sales-crm/requirement/REQ-003.yaml`.

**`version` is the concurrency mechanism, not bookkeeping.** Two people editing one item
both bump the same line, so git reports a conflict on `version` itself instead of quietly
merging two different edits into a plausible-looking third.

## Shared vs local

```
knowledge/   committed, shared, merged by git   — what is true about the project
.workflow/   local, gitignored, never synced    — what is true about this run (state.db)
```

Run state is deliberately not shared: two orchestrators syncing one state file would fight
over it.

## Raw material vs derived knowledge

A source is what was there; an item is what somebody concluded from it. They are separate
records because only that split can answer "we read this file and derived nothing from it
yet" — the normal state during discovery — and "one file backs eleven items; has it changed
since any of them were written?". An item's `sources[].source_id` joins the two.

## Conflicts

Contradictions are **detected fresh on every run** and never stored: a saved conflict list
goes stale the moment somebody fixes one, and then the system escalates a problem that no
longer exists. Only the *decision* is stored, in `_conflicts/`, because nothing in the items
records that a person looked at both and chose.

A `conflicts-with` relation somebody wrote is blocking until it is decided. A duplicate
found by pattern-matching is a note — a heuristic that can fail CI is one that gets deleted
the first time it is wrong.

## Who sees what

`knowledge-policy.yaml` at the repo root says which fields each role may see, and how old an
item may get before it is called stale. Agents read knowledge through
`orchestrator/src/knowledge/knowledgeContext.ts`, which applies the role's view (which kinds)
and the field policy (which parts) **before** returning anything — and always reports what it
withheld, so an absent fact and a hidden one never look the same.

## Role workspaces (`_roles/`)

V1.5 puts lanes — BA, SA, UXUI and DEV — around this one knowledge base, each with a person
who decides. `_roles/<module>/<lane>.yaml` holds the only two things about a lane that cannot
be worked out from `knowledge/` itself:

- **`seen`** — which version of which item the person in that lane has acknowledged.
- **`signoffs`** — that person's own approval gate (T103), and the exact item versions each
  answer covered. Approving an *item* says a fact is binding; signing off the *lane* says the
  lane is finished and the next one may start. A sign-off names versions so that amending
  what it covered makes it stale by arithmetic, rather than leaving a flag that outlives its
  subject. There is no `pending` status: "asked and unanswered" is the derived stage
  `awaiting-signoff`.

Everything else — what the lane is drafting, what moved under it, what it is waiting on a
person for, what it should be told about — is computed from those two every time it is asked.

Two consequences, both deliberate:

- **Nothing writes into another lane's file.** BA amending `REQ-003` does not notify DEV;
  DEV notices, because DEV's own recorded version of `REQ-003` no longer matches. So "every
  affected lane is told" is arithmetic rather than a discipline somebody has to keep.
- **No agent may write one of these files at all.** `knowledge/_roles/**` is in
  `UNIVERSAL_DENY` (`orchestrator/src/agents/pathPermissions.ts` and the matching hook), so
  the block holds in every mode, with or without a contract. An acknowledgement and a sign-off
  each record a human act; an agent that could write one could record it on that person's
  behalf. The writer is a person, through `sta roles`.

```bash
sta roles [--module <name>]                     # where each lane stands, and what it is waiting on
sta roles review <id> --as <agent>              # draft -> reviewed, with that kind's checklist
sta roles approve <id> --by <name>              # reviewed -> approved; a person only
sta roles signoff <ba|sa|uxui|dev> --by <name>  # that lane's own gate  [--reject] [--note ...]
sta roles ack <lane> <id>[,<id>...] --by <name> # record the handoff into that lane
sta roles inbox [<lane>]                        # what each lane has to look at, derived fresh
sta roles impact <id>[,<id>...]                 # which lanes a change would reach, before making it
sta roles context <lane> [<id>]                 # what that lane may see, and via which role
```

## Checking it

```bash
node orchestrator/dist/cli.js --check-knowledge
node orchestrator/dist/cli.js --check-roles
```

Reports dangling relation targets, an id whose prefix does not match its kind, two files
claiming one id, a relation whose two ends are not a legal pair, an `approved` item with no
source, a `supersedes` cycle, and any file left holding a git conflict marker. An empty (or
absent) `knowledge/` passes with a note — this checks consistency, not progress.

`--check-roles` covers `_roles/` separately: a lane file that disagrees with its own path, a
watermark pointing at an item that no longer exists, or one claiming a version the item never
reached. A lane simply being *behind* is a note, not a failure — being told is the point.
