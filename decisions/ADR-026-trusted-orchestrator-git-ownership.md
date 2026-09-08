---
id: ADR-026
title: Trusted orchestrator owns Git mutation; agents never do; STA never pushes or merges
status: accepted
date: 2026-09-07
---

## Status

**accepted — 2026-09-07.** Accepted by the owner in the implementation session after reviewing the
proposed boundary.

The date was supplied by the owner. Phase 9 may now start, but this record does not start it.

## Context

V7 introduces per-task local checkpoints. The existing Git controls govern agents:
`orchestrator/src/runtime/runtimeGuards.ts:25` forbids the `git` command, `.claude/hooks/block-git.js`
blocks state-changing Git and says that unparseable input is allowed through, and the universal deny
rules prevent direct `.git/**` writes. None defines a narrow mutation boundary for the trusted
orchestrator process.

The orchestrator already performs read-only Git inspection in `qa/changeSource.ts`,
`codeintel/targetRevision.ts`, and `knowledge/knowledgeHistory.ts`. A checkpoint extends that trusted
process boundary; it does not grant a runtime agent any Git capability. `policies/git.md §5` remains
unchanged.

## Decision

Only the trusted orchestrator process, through `orchestrator/src/git/`, may run a state-changing Git
command. Agents never may. `.claude/hooks/block-git.js` is not modified by V7.

The subsystem has a closed command and argument allow-list: `rev-parse`, `symbolic-ref`,
`status --porcelain`, `ls-files`, `diff`, `log`, `cat-file`, `merge-base`, `switch -c`, `branch`,
`add -- <paths>`, and `commit -m --` without `-a`. Calls use argument arrays and `shell: false`.
`push`, `remote add`, `remote set-url`, `reset`, `clean`, `rebase`, `merge`, `tag`, `revert`,
`cherry-pick`, and `filter-branch` have no code path.

A run starts only from a clean, ordinary Target repository. Staging uses a path list computed by the
orchestrator and contained within the resolved writable Target roots; `git add -A` and
`git commit -a` are never allowed. A checkpoint is a local durability and attribution boundary, not
a QA verdict. STA never pushes, merges, reverts, or resets.

### Rejected alternatives

| Alternative | Decision and evidence |
|---|---|
| Agent Git whitelist | Rejected. It would expose the shell surface to prompt injection and turn the fail-open backstop into a permission oracle. Evidence: `orchestrator/src/runtime/runtimeGuards.ts:25`, `.claude/hooks/block-git.js` header, validation §8. |
| Worktree isolation | Rejected for V7. Four fail-closed identity checks reject linked/shared Git metadata: `orchestrator/src/targetcli/roots.ts:145,148`, `orchestrator/src/threeRepo/installation.ts:46`, and `orchestrator/src/threeRepo/preflight.ts` `readOriginRemote()`; validation §9. |
| Checkpoint tags | Rejected. The journal and commit trailers already provide task-to-commit identity without a third ref namespace; validation §11. |
| Automatic rollback | Rejected. It cannot repair pre-checkpoint changes and otherwise destroys or obscures the failed evidence. Halt and preserve; validation §12. |
| `sta merge-wave` | Rejected. STA has no merge or conflict-resolution path; the person chooses how to integrate a completed branch. Evidence: validation §24. |

## Consequences

The Git mutation surface is isolated in one testable module and is independent of runtime adapter
guard fidelity. A repository-wide ownership check can prove that mutating Git calls exist nowhere
else and that no push path exists.

The run stays on its local branch. Failures preserve the working tree and checkpoints for human
inspection; STA does not roll back, switch back, merge, push, or clean up automatically.
