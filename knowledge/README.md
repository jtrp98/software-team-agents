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
├── _sources/            ← SRC-*.yaml: the raw material that was ingested;
│                          plus design/ — Claude Design / Figma exports a *person*
│                          placed for the uxui-designer lane. Agents read
│                          these files and cite them with sha256 digests; only a
│                          person writes here.
├── _conflicts/          ← CONF-*.yaml: a person's decision about two facts that contradict
├── _bootstrap/          ← STATE.yaml: how far first-time discovery got
├── _human-input/        ← what a person supplied that no file could be read for
└── _roles/              ← reserved and guard-denied; read by nothing since V13 TASK-028 (lane decisions live in STA's ledger)
```

Every `_`-prefixed name above is reserved — the item walk skips them, so they can never be
mistaken for a module full of malformed items. The list the code enforces is `RESERVED_DIRS`
in `orchestrator/src/knowledge/knowledgeStore.ts`.

`<ID>` is the id the pipeline already uses — `REQ-003`, `DES-003`, `BE-014`, `TEST-003`,
`ADR-004`. Not a parallel id: one that differed from the id in `plan.md` would need a
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

## Role workspaces (lane sign-off and acknowledgement)

V1.5 puts lanes — BA, SA, UXUI and DEV — around this one knowledge base, each with a person
who decides. Two things about a lane cannot be worked out from `knowledge/` itself, and since
V13 TASK-028 both are **trusted human decisions in STA's lane ledger** (the `lane_decisions`
table of the STA state DB), never files:

- **sign-off** — the person in the lane says the lane is finished. The same decision makes the
  lane's items binding: an item is `approved` exactly when the lane's latest decided sign-off
  covers it at its current `{id, version, digest}`. There is no separate item approval.
- **acknowledgement (ack)** — a separate decision by the person in the *receiving* lane that
  they have seen those exact versions. The handoff watermark is built from these.

Each lane and act has its own gate type, and so its own approver allowlist in the human-owned
github-app configuration: `ba-signoff`, `sa-signoff`, `uxui-signoff`, `dev-signoff`, `ba-ack`,
`sa-ack`, `uxui-ack`, `dev-ack`. STA opens a pending request over the exact current items,
announces it on the trusted channel (the same one `sta approve` uses) and records a decision
only when the channel verifies it; an item edited or bumped after the request or the decision
makes it stale. With no channel configured the request stays pending.

What is **not** authority, anywhere: a file under `knowledge/_roles/**` (nothing reads it; the
path stays in `UNIVERSAL_DENY` so no agent can leave one there), an item file's own
`status: approved` (read as `reviewed` until a sign-off covers it), and any name typed on the
command line (`--by` is refused).

Everything else — what the lane is drafting, what moved under it, what it is waiting on a
person for, what it should be told about — is computed from those decisions every time it is
asked. Nothing writes into another lane's watermark: BA amending `REQ-003` does not notify DEV;
DEV notices, because DEV's acknowledged version of `REQ-003` no longer matches.

```bash
sta roles [--module <name>]                                  # where each lane stands, plus pending lane requests
sta roles signoff <ba|sa|uxui|dev> --module <name>           # open + announce the request (exit 4)
sta roles signoff <lane> --module <name> --request <id>      # record the approver's decision from the channel
sta roles ack <lane> [<id>[,<id>...]] --module <name> [--request <id>]   # the receiving lane's acknowledgement
sta roles inbox [<lane>]                                     # what each lane has to look at, derived fresh
sta roles impact <id>[,<id>...]                              # which lanes a change would reach, before making it
sta roles context <lane> [<id>]                              # what that lane may see, and via which role
```

## Checking it

```bash
node orchestrator/dist/cli.js --check-knowledge
```

Reports dangling relation targets, an id whose prefix does not match its kind, two files
claiming one id, a relation whose two ends are not a legal pair, an `approved` item with no
source, a `supersedes` cycle, and any file left holding a git conflict marker. An empty (or
absent) `knowledge/` passes with a note — this checks consistency, not progress.

`--check-roles` was removed with the `_roles/` files (V13 TASK-028): lane state is `sta roles`,
read from the lane ledger.

## Schema v2 scope, origin, freshness, and reconciliation

Schema v2 adds `target_ids` and `sources[].origin`. An empty `target_ids` array
is global; otherwise retrieval includes the item only for a bound Target named
in the array (an item may name every Target a module spans) and reports how
many items scope excluded. `origin.root` is the
only current/desired axis: `target` is current implementation evidence,
`knowledge` is desired requirement/contract evidence, and `external` is
evidence that may be unhashable locally.

Brief index lines show the existing `freshnessOf()` verdict;
changed/unavailable items also show its one-line reason, still within the
16,384-byte cap.

Run `sta knowledge reconcile --target <id>` (add `--json` for a stable report)
to recompute current/desired classifications without writing or persisting a
verdict. A person resolves conflicts; pending requirements are backlog, and
implementation drift routes through the system-analyst/design contract.
