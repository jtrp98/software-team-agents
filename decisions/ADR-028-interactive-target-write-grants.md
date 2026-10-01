---
id: ADR-028
title: Interactive Target writes open through an explicit, per-launch, recorded grant
status: accepted
date: 2026-09-30
---

## Status

accepted — 2026-09-30 (decided by the framework owner in the Phase 4 session)

## Context

Since V10 TASK-026 an interactive session's writable scope is exactly its own
Knowledge workspace: `launchEnv` hard-sets `STA_WRITABLE_WORK_ROOTS = "[]"`
(never inherited from the shell), and every mapped Target rides the
identification channel as `access: "read"`, refused by name on write. Writing
a Target belonged to orchestrated stages alone. In practice this made every
plan that says "engineer edits Target code" unusable from the interactive
session people actually drive, and it pushed work toward shell-level
workarounds (hand-set environment variables) that carry no identity, no
record and no validation — strictly worse than a governed path.

V13 TASK-012 already shipped the identity half for direct mode: the
STA-issued scoped attempt grant (`sta grant issue`) binds role, contract
digest, scope and — for engineer stages bound to a task — Target
`work_roots` with `access: "write"`. But nothing ever set the *boundary*
half (`STA_WRITABLE_WORK_ROOTS`) for a direct-mode session, so the granted
Targets stayed unwritable: the boundary channel remained orchestrated-only.

## Decision

`software-team-agents open` accepts `--writable-target <id|path>`
(repeatable). Preflight resolves each request against the workspace's own
`.workflow/targets.local.yaml` mapping (id or canonical path), refuses
unknown names, the session's own workspace, and any request when no mapping
resolves — invalid input grants nothing. A granted launch:

- sets `STA_WRITABLE_WORK_ROOTS` to exactly the granted roots (still never a
  shell-inherited value),
- flips those entries to `access: "write"` in `STA_TARGET_WORK_ROOTS`, so the
  guard's by-name read-only refusal steps aside for exactly those Targets,
- records the grant (`[{targetId, path, access}]`) in the interactive session
  record at launch time.

The per-role layer is untouched: a Target write inside a granted root still
requires a resolvable role contract — orchestrated `STA_ROLE`, or a valid
`sta grant issue` token in direct mode. Without identity the write is refused
with the hook's existing message. The flag composes with the attempt grant;
it does not replace it.

## Consequences

- The interactive flow can now complete engineer work end to end: open with
  `--writable-target`, issue a grant, write under the contract's rules.
- Grants are explicit human acts at launch, validated and recorded — the
  shell-environment workaround this replaces had none of those properties.
- A granted session without STA identity still writes nothing in a Target:
  the boundary half alone is deliberately inert.
- `runs.writable_targets` (schema 23 → 24, additive nullable) records what
  was granted; historical rows read null.
- Sessions opened without the flag behave byte-for-byte as before.
