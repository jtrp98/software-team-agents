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
└── _conflicts/          ← CONF-*.yaml: a person's decision about two facts that contradict (T66)
```

`_sources/` and `_conflicts/` are reserved names — the item walk skips them, so they can
never be mistaken for a module full of malformed items.

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

## Checking it

```bash
node orchestrator/dist/cli.js --check-knowledge
```

Reports dangling relation targets, an id whose prefix does not match its kind, two files
claiming one id, a relation whose two ends are not a legal pair, an `approved` item with no
source, a `supersedes` cycle, and any file left holding a git conflict marker. An empty (or
absent) `knowledge/` passes with a note — this checks consistency, not progress.
