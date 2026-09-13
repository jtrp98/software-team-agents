# Known Non-Blocking Drifts

This document records architectural drifts and system boundaries identified during V9 problem analysis that are deliberate non-blocking facts and not V9 work.

---

## DRIFT-2: `stacks/dotnet/stack.yaml` declares `kind: backend` for fullstack MVC

### Fact
`stacks/dotnet/stack.yaml` ships a fullstack ASP.NET Core MVC layout (Views, Controllers, wwwroot) but declares `kind: backend`.

### Why it is non-blocking in V9
- Under V9 Architecture Decision AD-5, fullstack MVC relies on the existing stack profile role split (`role: backend-engineer` writes Controllers/Models; `role: frontend-engineer` writes Views/wwwroot) without introducing new framework mechanisms.
- Binding a single Target to both engineer roles is already supported (`uniqueBoundTargetIds` deduplicates).
- `StackProfileSchema.kind` currently restricts values to `frontend` | `backend`.
- Adding `fullstack` to `StackProfileSchema.kind` is an optional cosmetic improvement (Item 15 in analysis §13, marked `Could` and F-1 in V9-TASKS §18). It would require updating `checkProfile` comparisons without changing runtime behavior.
- Therefore, extending `StackProfileSchema.kind` is tracked as a non-blocking follow-up outside V9 scope.

---

## DRIFT-6: Framework repository checkout has no resolved stack

### Fact
In a local developer checkout of the Framework repository (`software-team-agents`), `.claude/shared/stack.md` reads "Stack not yet detected" and there is no `.agent-team/config.yaml` `stack:` block at the Framework root. Consequently, local invocations of `pathRulesFor` fall back to `STACK_PERMISSION_FALLBACK` (`node` / `frontend`).

### Why it is non-blocking in V9
- The Framework checkout is a meta-repository for developing the agent framework and orchestrator tooling, not an end-user application target.
- Target repositories initialized via `sta init` or `software-team-agents init` receive a real detected stack profile and explicit `.agent-team/config.yaml` configuration.
- Falling back to `STACK_PERMISSION_FALLBACK` locally within the Framework checkout is expected behavior and does not block Target execution or tests.
