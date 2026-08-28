---
id: ADR-005
title: v2 — one command source rendered to three runtimes; Claude Design access is fail-closed and draft-only; graphify stays optional (deferred)
status: accepted
date: 2026-08-26
---

## Status
accepted — 2026-08-26

## Context

Three decisions from the v2 streams needed a permanent home because each one will be
re-proposed otherwise:

1. The prompt-shortcut commands (31, claude-commands-TASKS §1.1) work only in Claude Code.
   Codex removed custom prompts (`~/.codex/prompts`, codex-cli 0.117.0) leaving Agent Skills;
   OpenCode has its own `.opencode/commands/`. Hand-copying 31 files twice is how the agent
   bindings drifted before OFF10 M2.
2. uxui-designer gained direct access to Anthropic's Claude Design MCP server. Unbounded
   tool access from an agent lane that must never publish or delete anything is unacceptable,
   but a list kept "in someone's head" cannot be audited.
3. Graphify (code-intelligence provider) was scoped for v2. It needs machine setup
   (`uv`), a real Target for indexing, role benchmarks, and human decisions on cache
   location — none of which belong on the critical path of this release.

## Decision

**Commands — one source, generated mirrors, two guard layers.** `.claude/commands/*.md`
is the only authored surface. `COMMAND_RENDERINGS` (`orchestrator/src/runtime/bindingGenerator.ts`)
renders `.opencode/commands/<name>.md` (guardrails inlined — OpenCode resolves `@file`
from the project root, so the include cannot travel) and `.agents/skills/<name>/SKILL.md`
plus a fixed `agents/openai.yaml` with `allow_implicit_invocation: false` (skills run when a
person types `$name`, never when a model feels like it). Mirrors are **generated, not payload**:
they are absent from `TEMPLATE_SOURCES`, produced at target sync by `runTargetSync`, committed
in this repo via `scripts/regenerate-renderings.mjs`, byte-checked by `--check-bindings`, and
content-checked by self-test sections 11b/11c.

**Claude Design — verdict module, frozen allowlists, draft-only.**
`orchestrator/src/integration/claudeDesignMcp.ts` owns the allowlists: READ = 9 inspect tools;
WRITE adds only `copy_files`, `create_project`, `write_files`. Destructive/publishing
(`delete_files`, `finalize_plan`), membership/sharing, chat-driven, and semantically unclear
tools are refused even in write mode. Selection is fail-closed (unknown tool ⇒ refuse with
reason). Every output stays a draft pending human sign-off; Path A/B file handoffs remain
valid fallbacks.

**Graphify — deferred, default-OFF if/when built.** Not in this release; nothing may make it
a dependency of any pipeline stage. Any future implementation follows
[`graphify-integration-TASKS.md`](../planning/v2/graphify-integration-TASKS.md): provider
abstraction behind fallback, freshness-gated cache outside repos, role capability matrix, and
opt-in rollout gated on an A/B benchmark.

## Consequences

- Adding/removing a command touches ONE file plus regeneration; all three runtimes follow.
- Extending either MCP allowlist is a deliberate constant change with a reason in the diff.
- A runtime whose skill/command loading breaks fails loudly through `--check-bindings`,
  never silently through a stale copy.
- Graphify remains release-notes-level intent until its own stream completes.
