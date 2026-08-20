---
id: ADR-002
title: Hand-rolled JWT authentication, no third-party auth provider
status: accepted
date: 2026-08-20
---

## Status
accepted — 2026-08-20

## Context
Authentication is one of the first things a new module's `requirement.md` touches, and there are
several reasonable ways to build it — a hosted provider (Auth0, Clerk), a framework library
(Passport.js), or issuing tokens directly. Each has different setup, different `.env` variables,
and a different shape for `design.md`'s user/session model, so it has to be settled once rather
than re-opened per module.

## Decision
JWT, hand-rolled: the backend issues and verifies tokens itself using a signing key from `.env`,
with no Passport.js, Auth0, Clerk, or other third-party auth provider or library.

## Consequences
- Every module's `design.md` that touches auth designs against this shape — a `User` model with a
  password hash, a login endpoint that issues a JWT, and middleware that verifies it — rather than
  a provider-specific integration.
- No external account or API key is required to run the project, which matters for `setup`
  scaffolding a project without asking the user to sign up for anything.
- Session revocation, refresh tokens, and expiry are the project's own code to get right, not a
  provider's. `security` audits token handling directly rather than trusting a vendor's model.
- The signing key is a secret: `.env`-only, never hardcoded, never committed — per
  `backend-engineer.md`'s "Never commit secrets" rule.
