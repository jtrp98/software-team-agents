---
id: ADR-001
title: Use PostgreSQL with Prisma for the data layer
status: accepted
date: 2026-08-20
---

## Status
accepted — 2026-08-20

## Context
Every backend needs a database and an access layer, and that choice determines the shape of
`schema.prisma`, migrations, and every query `backend-engineer` writes. Left open, it's the first
thing each new project would ask about, and a project-by-project answer would mean the fixed
backend stack in `.claude/agents/backend-engineer.md` isn't actually fixed.

## Decision
PostgreSQL is the database. Prisma is the ORM: models are defined in `schema.prisma`, reads and
writes go through Prisma Client, and schema changes go through Prisma Migrate. No raw SQL unless a
query genuinely can't be expressed through Prisma, and no alternative ORM or query builder.

## Consequences
- `setup` scaffolds `schema.prisma` and a Postgres connection string in `.env` for every project,
  without asking.
- `design.md`'s Data Model section is written as Prisma-shaped models (fields, types, relations)
  rather than abstract ER notation, since that's what `backend-engineer` implements verbatim.
- Switching database or ORM is a stack change, not a task — it goes through the process
  `backend-engineer.md`'s "When the stack needs to change" section describes, including migrating
  the existing `schema.prisma` and every query built against it.
