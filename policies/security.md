# Policy — Security guards (§5a, §5c-1, §5d)

Split from `.claude/shared/conventions.md` by T49. The three rules here are the parts of the
guard layer that are specifically about containment and leakage — where an agent may write, and
what it may never leave behind — plus the rule that keeps that layer honest.

---

## 5a. Stay inside the repo

Every write resolves under this project's root. No agent writes elsewhere, whatever the reason.

**Enforced** by `.claude/hooks/block-outside-repo.js` on `Write`/`Edit`/`MultiEdit`/`NotebookEdit`. Two narrow exceptions exist, both the harness's own mechanisms rather than an agent going off scope (the OS-temp scratchpad, and Claude Code's cross-session memory store) — see the hook's own comments for the exact scoping. If blocked, tell the user what you were trying to write and where, and let them decide.

---

## 5c-1. An agent doesn't hand off a hardcoded secret

Same shape and same cadence as `policies/coding.md` §5c, a separate hook because it catches a different mistake: `.claude/hooks/block-secret-leak.js` scans every file a run changed (git diff/ls-files, read-only) for a curated set of secret-shaped patterns — AWS access key IDs, private-key blocks, database connection strings with a real (non-placeholder) embedded password, and hardcoded `api_key`/`secret`/`token`/`password` literal assignments — and blocks the Stop if it finds one. `.env` is excluded (it's the convention-approved, gitignored place for real values); `.env.example` is not (it's committed by convention and must hold only placeholders). `.claude/` itself is excluded too — its hooks/scripts/self-test deliberately contain secret-shaped literals as their own test fixtures, so scanning it would be self-referential. Same never-trap guarantee as `policies/coding.md` §5c: `stop_hook_active` releases the block on the second attempt.

## 5d. The guards are themselves tested

`policies/git.md` §5, this file's §5a and §5c-1, and `policies/coding.md` §5c are the only rules here that don't depend on an agent remembering them — the load-bearing part of the design. `node .claude/tests/run.js` exercises every hook and every checker script.

**Run it after editing anything under `.claude/hooks/` or `.claude/scripts/`.** A hook with a syntax error exits 1, not 2 — and `PreToolUse` only blocks on exit 2 — so a typo makes a guard **fail open**: still wired up, still looking installed, enforcing nothing. That happened once for real. A failing guard is worse than no guard, because it buys false confidence — treat a red run as blocking.
