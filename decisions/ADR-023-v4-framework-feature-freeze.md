---
id: ADR-023
title: Freeze V4 framework capabilities until the stabilization exit condition is met
status: accepted
date: 2026-09-01
---

## Status

accepted — 2026-09-01

## Context

V4's stabilization work exists to finish the framework with enforceable release
controls rather than to create another layer of framework machinery. A checker
cannot honestly distinguish a new capability from an extension, so a release
gate would turn this human decision into an unfalsifiable green check.

## Decision

The V4 framework capability freeze is in effect. Do not add a new agent,
planner, graph abstraction, memory layer, router layer, workflow abstraction,
or runtime abstraction without a real, documented provider or use case.

The freeze lifts only when all of the following repository-visible conditions
are true:

1. Every item in the `Topic exit gate` of
   `planning/v4/framework-stabilization-CHECKLIST.md` is complete.
2. That checklist records a successful `npm run release:check` transcript for
   the final V4 state.
3. A later accepted ADR explicitly states that this freeze has ended and names
   the post-V4 scope it authorizes.

These conditions are checkable by reading the checklist, its recorded
transcript, and the later ADR; they do not depend on an assessment of whether a
proposed capability seems worthwhile.

## Consequences

Capability proposals remain possible only through a documented use case and a
later ADR after the stated exit condition is met. The freeze does not introduce
a checker or change the existing release gate. It also does not weaken,
disable, or replace any existing guardrail.

## Internal V1 Stable

**Internal V1 Stable = P0 → P1 → P2 → P3 → P4 each executed and reported,
with the release gate green.** It never means that P3 produced a favourable
result. A benchmark that shows the harness does not help in some or all
categories still satisfies this milestone; that negative result is valid and
publishable evidence.
