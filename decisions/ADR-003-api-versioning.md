---
id: ADR-003
title: No API versioning scheme — a single, unversioned REST API
status: accepted
date: 2026-08-20
---

## Status
accepted — 2026-08-20

## Context
`backend-engineer.md` fixes REST as the API style but is silent on versioning, which leaves a real
question open: does a breaking change to an endpoint get a new `/v2/...` route, a version header,
or does the existing route just change? Without an answer, each backend task that touches an
existing endpoint would have to guess, and `frontend-engineer` would have no fixed contract for
which version it's calling.

## Decision
No versioning scheme. Routes are unversioned (`/api/users`, not `/api/v1/users`). A breaking
change to an endpoint's contract is a coordinated change: `backend-engineer` updates the route and
`frontend-engineer` updates every caller in the same phase, per the backend-before-frontend
ordering rule in `.claude/shared/conventions.md` §6a — not a parallel `/v2` route kept alongside
the old one.

## Consequences
- `design.md`'s API contract sections describe one shape per endpoint, not a version history.
- A breaking backend change is treated the same as any other cross-cutting change: it goes back to
  `system-analyst` if it affects the data model, and if it's implementation-only it stays inside
  one phase so frontend never has to support two contracts for the same route.
- This project never needs to run two API versions in production side by side. If a future
  requirement genuinely needs that (e.g. an external, versioned public API), that's a new decision
  — write an ADR that supersedes this one rather than special-casing one endpoint.
