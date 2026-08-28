---
id: ADR-021
title: Keep the shared agent preamble as an on-demand pointer
status: accepted
date: 2026-08-26
---

## Status

accepted — 2026-08-26

## Context

Repeated role-operating prose drifted across eleven prompts. P1's enforcement
matrix distinguishes deterministic enforcement from judgment that must remain
available to an agent. Injecting another full shared prompt would not reduce
runtime static context and would create a parallel prompt architecture.

## Decision

`.claude/shared/agent-preamble.md` is the authoritative home for repeated
operating guidance and every role carries a one-line pointer to it. It is not
inlined by a renderer. Deterministically enforced rules remain backed by their
hooks, contracts, or runtime gates. Prompt-only and partial judgment remains in
the operating card and role-specific instructions; the preamble is retrieved
on demand. `--check-prompt-budget` caps it at 800 B and rejects remaining
named blocks duplicated in three or more role prompts.

## Consequences

The pointer reduces duplicated static role text without claiming that a
referenced file is automatically loaded. Future shared guidance belongs here
only when it is genuinely common and does not require always-loaded context.
