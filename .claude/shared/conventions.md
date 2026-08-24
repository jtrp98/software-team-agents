# Shared Agent Conventions — moved

T49 split this file into `policies/`, one file per area, because it had grown into thirteen
numbered sections a person had to search through to find one rule. Section numbers (`§1`…`§12`,
`§5a`–`§5d`) are unchanged — only which file holds them moved, so an existing `conventions.md §N`
citation still means the same rule; only the path in front of it needs the table below.

| Section(s) | Now lives in |
|---|---|
| §0 (T-WG5 — confirm workspace ↔ lane before writing) | `policies/documentation.md` |
| §1, §2, §3, §4, §5b, §10, §11 | `policies/documentation.md` |
| §5 | `policies/git.md` |
| §5a, §5c-1, §5d | `policies/security.md` |
| §5c, §9, §12 | `policies/coding.md` |
| §6, §6a, §8 | `policies/agent-boundaries.md` |
| §7 | `policies/architecture.md` |

Every agent still reads its rules **before doing anything else** — from `policies/`, not from
here. This file stays only as a pointer for anything still built against the old path; see
`layout.yaml` for why.
