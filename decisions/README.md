# `decisions/` — Architecture Decision Records

This directory holds ADRs: decisions already settled, written down once so an agent reads one
instead of re-litigating it. It exists because `system-analyst` and `backend-engineer` have no
memory across runs — without a place to record "we already decided this," the same question gets
re-asked, or worse, re-decided a different way, every time a fresh session touches the area.

## Scope

**Project-wide decisions only** — stack choices, cross-cutting architecture, permission model.
A decision that only affects one module (e.g. "should `orders` soft-delete or hard-delete")
belongs in that module's `_docs/module/<name>/design.md` instead, next to the schema it shapes.
The test: would this decision matter to a module that doesn't exist yet? If yes, it's an ADR.

## Index

| ADR | Decision |
|---|---|
| ADR-023 | [Freeze V4 framework capabilities until the stabilization exit condition is met](ADR-023-v4-framework-feature-freeze.md) |
| ADR-024 | [`_docs` is the authoritative knowledge system; `knowledge/` stops mirroring it](ADR-024-docs-vs-knowledge.md) |

## Format

One file per decision: `ADR-<NNN>-<slug>.md`, numbers zero-padded to 3 digits and never reused,
even for a superseded decision — the number is the identity, and it stays put in history.

Each file starts with YAML frontmatter, validated against `orchestrator/schemas/adr.schema.json`
(`orchestrate --check-decisions` runs the check):

```yaml
---
id: ADR-001
title: Use PostgreSQL with Prisma for the data layer
status: accepted
date: 2026-08-20
---
```

`status` is one of:

| Status | Meaning |
|---|---|
| `proposed` | Written down, not yet binding — an agent may still ask about it |
| `accepted` | Settled. An agent implements it and does not ask again |
| `superseded` | Replaced by a later ADR; `supersedes`/`superseded_by` link the two |
| `rejected` | Considered and turned down — kept so the option isn't proposed again without new information |

A `superseded` or `rejected` record adds `superseded_by: ADR-004` (or the reverse,
`supersedes: ADR-002`, on the record that replaces it) so the chain reads either direction.

After the frontmatter, the body follows the standard four sections:

```markdown
## Status
accepted — 2026-08-20

## Context
What forced this decision; the constraint or the question it answers.

## Decision
What was decided, stated as a sentence an engineer can implement without reading further.

## Consequences
What this makes easy, what it makes hard, and what it rules out.
```

## Capability proposal gate (`REQ-17`)

An ADR that proposes a new framework capability must add all five of the
following required sections. They make the proposed capability reviewable
before it becomes framework surface; they do not make an answer automatically
good.

```markdown
## REQ-17 justification

### 1. What is the real pain?

### 2. Why can existing components not solve it?

### 3. How much cost, time, or error does it reduce?

### 4. What benchmark or evidence supports that?

### 5. How much maintenance complexity or cost does it add?
```

An unanswerable question means **reject**. A blank is not an answer and must
not be treated as an omission that can be filled in later. Question 5 was
unanswered for every Part II capability as originally proposed; that missing
maintenance cost is the decisive reason `R4` could not proceed. ADR-022 could
proceed where `R4` could not because it answered Question 5 (as well as
Questions 1 and 2).

A partially answered gate may proceed only when the owner explicitly authorizes
it **in that ADR itself**, naming the unanswered questions and their status.
ADR-022 is the recorded example: it answers three of five questions and records
the owner's authorization to proceed with Questions 3 and 4 incomplete. A
partially answered gate is never authorized by leaving the gaps unstated.

The ADR checker validates ADR shape, not the quality of these answers. Existing
ADRs that predate this template are not retroactively required to add these
sections.

## Why this isn't `_docs/`

`_docs/module/<name>/design.md` is per-module and owned by `system-analyst` on that module's own
timeline. A stack-level decision (database, auth approach, API versioning policy) has no module
to live in — it's true before the first module exists and stays true across all of them. This
directory is that home. See `layout.yaml`'s `docs` concept for the full boundary.

## Who writes here

Any agent that settles a project-wide decision with the user may add or amend an ADR — most often
`system-analyst` during feasibility analysis. Amend an existing record the same way every other
doc in this repo is amended: don't rewrite it, add a new ADR that supersedes it and link both
ways.
