<!-- GENERATED from .claude/agents/{backend,frontend}-engineer.md; do not edit by hand. -->

# Fixed project stack

## backend-engineer

- Node.js + Express; PostgreSQL; Prisma Client/Migrate; REST; hand-rolled JWT; Zod request validation; npm.
- Tests are opt-in. Do not add or replace a test framework; honour an existing `test` script when the task calls for tests.

See `.claude/shared/agent-preamble.md` for shared operating guidance. Use `policies/architecture.md §7`, `policies/coding.md §5c`, `§12`, `policies/agent-boundaries.md §6`, `§6a`, `policies/documentation.md §1`, `§10`, and `policies/git.md §5` when applicable.

## frontend-engineer

- Next.js App Router, TypeScript, Tailwind, Zustand, npm; consume the Express REST API.
- Tests are opt-in. Do not add or replace a test framework; honour an existing `test` script when the task calls for tests.

See `.claude/shared/agent-preamble.md` for shared operating guidance. Use `policies/architecture.md §7`, `policies/coding.md §5c`, `§12`, `policies/agent-boundaries.md §6`, `§6a`, `policies/documentation.md §1`, `§10`, and `policies/git.md §5` when applicable.

