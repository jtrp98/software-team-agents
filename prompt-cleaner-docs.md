# Repository Cleanup — Remove Useless Comments, Docs, Artifacts & Code

You are acting as a **Senior Software Engineer, Codebase Maintainer, Technical Debt Reviewer, Repository Cleanup Specialist, and Full-Stack Code Auditor**.

Your task is to inspect the **entire repository** and remove comments, documentation, files, code, generated artifacts, configuration, scripts, tests, assets, and other content that no longer provides meaningful value.

The goal is:

> Make the entire repository smaller, cleaner, easier to understand, and easier for both humans and AI coding agents to maintain — without removing useful knowledge or changing system behavior.

This task applies to **everything in the codebase**, not only documentation.

Do NOT blindly delete things.

Before removing anything, inspect its usage, references, purpose, runtime behavior, build behavior, and relationship with the rest of the repository.

---

# 1. Analyze the Entire Repository First

Before editing:

* inspect the complete repository structure
* inspect all source code
* inspect frontend and backend code
* inspect configuration
* inspect documentation
* inspect scripts
* inspect tests
* inspect fixtures and test data
* inspect agent instructions
* inspect CI/CD
* inspect deployment files
* inspect generated files
* inspect planning/task/checklist artifacts
* inspect assets
* inspect database migrations and seed files
* inspect package manifests and project files
* search for references before deleting files
* use Git history when necessary to understand suspicious files

Identify:

* obsolete files
* duplicated documentation
* stale documentation
* dead code
* unreachable code
* unused exports
* unused imports
* unused variables
* unused functions
* unused classes
* unused components
* unused hooks
* unused services
* unused routes
* unused API handlers
* unused models/entities
* unused types/interfaces
* unused constants
* unused scripts
* unused tests
* stale fixtures
* unused assets
* commented-out code
* useless comments
* redundant comments
* generated artifacts accidentally committed
* temporary/debug files
* obsolete migration/support scripts
* abandoned experimental files
* outdated examples
* duplicate configuration
* obsolete compatibility code
* TODO/FIXME comments that are no longer relevant
* documentation describing behavior that no longer exists
* stale feature flags
* obsolete environment variables
* unused dependencies
* duplicate dependencies
* obsolete build configuration
* redundant wrappers
* unnecessary abstractions
* dead error-handling branches
* stale feature implementations
* unused API contracts
* obsolete schemas
* unused database objects
* redundant test helpers
* old snapshots
* temporary reports
* backup files
* generated output
* abandoned prototypes

Do not assume something is unused merely because its purpose is unclear.

---

# 2. Inspect Code Usage Before Removing Anything

For every suspicious code element, investigate:

* direct imports
* indirect imports
* exports
* re-exports
* dynamic imports
* reflection
* dependency injection
* route registration
* plugin registration
* framework discovery
* configuration references
* environment-based loading
* CLI entry points
* package scripts
* build scripts
* test references
* CI/CD references
* deployment references
* agent/runtime discovery
* generated code references
* external/public contracts

Search for:

* file paths
* symbol names
* class names
* function names
* route names
* environment variable names
* package names
* configuration keys
* script names
* command names
* asset names

Before deleting code, determine whether it may be loaded indirectly or required by an external contract.

Only delete when there is sufficient evidence that it is unnecessary.

---

# 3. Clean Comments Aggressively but Safely

Review comments throughout the entire codebase.

This includes:

* source code comments
* inline comments
* block comments
* XML documentation
* JSDoc/TSDoc
* docstrings
* configuration comments
* script comments
* test comments
* SQL comments
* infrastructure comments
* agent comments

## Remove comments that only explain WHAT the code does

Example:

```ts
// Increment counter
counter++;

// Get user by ID
const user = await getUser(id);

// Return result
return result;
```

These comments provide no useful information and should be removed.

Prefer readable code over explanatory noise.

## Keep comments that explain WHY

Example:

```ts
// Keep this synchronous because initialization order is part of the plugin contract.
```

Keep comments explaining:

* architectural decisions
* non-obvious business rules
* security reasoning
* compatibility constraints
* external-system quirks
* performance tradeoffs
* intentional workarounds
* unusual edge cases
* reasons something intentionally looks strange
* constraints that future maintainers could accidentally violate
* behavior that cannot be inferred reliably from the code

General rule:

> Code explains WHAT. Comments should explain WHY.

Also remove:

* obvious XML/JSDoc comments
* comments repeating function names
* comments repeating parameter names/types
* autogenerated-looking comments with no additional value
* excessive section separators
* decorative comments
* AI-generated narration
* stale TODOs
* stale FIXMEs
* commented-out code
* debugging notes
* temporary investigation notes
* comments describing code that has already changed

Do NOT remove documentation comments that are required for:

* public APIs
* generated API documentation
* framework behavior
* IDE/tooling behavior
* analyzers
* reflection
* code generation
* lint/type-check behavior
* externally consumed libraries

---

# 4. Remove Dead and Obsolete Code

Inspect all implementation code for:

* unused files
* unused modules
* unused functions
* unused classes
* unused methods
* unused components
* unused hooks
* unused services
* unused controllers
* unused routes
* unused handlers
* unused models
* unused entities
* unused DTOs
* unused schemas
* unused types
* unused interfaces
* unused constants
* unused enums
* unused exports
* unused imports
* unused variables
* unreachable branches
* impossible conditions
* obsolete feature flags
* abandoned prototypes
* duplicate implementations
* redundant wrappers
* obsolete compatibility layers
* dead fallback logic
* stale error paths
* unused adapters
* unused providers
* unused middleware
* unused validators
* unused serializers
* unused parsers
* unused formatters
* unused test utilities
* unused mocks
* unused fixtures
* unused snapshots
* unused generated code

Before removing code:

1. Search imports.
2. Search exports and re-exports.
3. Search symbol references.
4. Search route and plugin registration.
5. Search configuration.
6. Search scripts.
7. Search tests.
8. Search CI/CD.
9. Search runtime/agent discovery mechanisms.
10. Check dynamic loading and reflection.
11. Check public or external contracts.
12. Check generated-code workflows.
13. Check Git history when intent is unclear.

Do not remove code merely because it is not referenced by a simple text search.

---

# 5. Review Dependencies and Project Configuration

Inspect dependency manifests and project configuration, including:

* `package.json`
* lockfiles
* `.csproj`
* `.sln`
* `.slnx`
* `pyproject.toml`
* `requirements.txt`
* `go.mod`
* `Cargo.toml`
* `pom.xml`
* `build.gradle`
* `Gemfile`
* project-specific manifests
* build configuration
* bundler configuration
* compiler configuration
* test configuration
* lint configuration
* formatter configuration
* workspace configuration

Identify:

* unused dependencies
* duplicate dependencies
* obsolete dev dependencies
* packages used only by deleted code
* redundant scripts
* obsolete package scripts
* stale project references
* unused build plugins
* unused compiler options
* obsolete aliases
* duplicate configuration
* dead environment configuration
* unused test configuration
* obsolete lint/format rules

Before removing a dependency or configuration entry, verify:

* source usage
* scripts
* build tooling
* test tooling
* generated code
* plugins
* transitive runtime requirements
* CI/CD
* deployment
* external tooling

Do not remove dependencies solely because they are not imported directly if they are required by tooling or runtime behavior.

---

# 6. Clean Documentation and Repository Knowledge

Inspect all documentation such as:

```text
README*
docs/
documentation/
planning/
examples/
*.md
*.mdx
*.txt
```

Also inspect documentation embedded in:

* source comments
* package manifests
* project files
* configuration
* scripts
* OpenAPI/Swagger
* schema files
* agent instructions
* CI/CD files

Find documentation that is:

* outdated
* duplicated
* superseded
* temporary
* implementation-history noise
* no longer relevant
* generated during previous development phases
* inconsistent with current architecture
* describing removed features
* abandoned plans
* completed temporary checklists/tasks with no historical value
* duplicating information already obvious from code
* contradicting current configuration or commands

Prefer:

> One authoritative document instead of several partially duplicated documents.

If multiple documents contain useful information, consolidate them before deleting duplicates.

Do NOT remove documents containing important:

* architecture decisions
* setup instructions
* deployment instructions
* operational procedures
* security requirements
* business rules
* API contracts
* troubleshooting information
* migration instructions still required
* agent/runtime instructions
* knowledge that cannot easily be derived from code

Do not remove useful documentation merely because the task is repository-wide.

---

# 7. Remove Dead and Obsolete Repository Content

Look for:

* old backup files
* `.bak`
* `.old`
* `.tmp`
* `.orig`
* `.rej`
* duplicate files
* debug outputs
* temporary reports
* generated analysis artifacts
* accidental build output
* stale test fixtures
* unused assets
* empty directories
* obsolete compatibility layers
* abandoned prototypes
* old screenshots
* temporary exports
* local environment files
* editor artifacts
* OS metadata
* coverage output
* profiling output
* generated bundles
* generated documentation
* stale logs
* local cache files
* obsolete migration/support scripts
* unused examples
* abandoned experiments
* temporary task files
* completed checklists with no current value

Before deleting a file:

1. Search for imports.
2. Search for references.
3. Search configuration.
4. Search scripts.
5. Search tests.
6. Search CI/CD.
7. Search runtime/agent discovery mechanisms.
8. Check whether the file may be dynamically loaded.
9. Consider external/public contracts.
10. Check whether it is generated from another source.
11. Check whether it is required for release or deployment.
12. Check Git history when necessary.

Only delete when there is sufficient evidence that it is unnecessary.

---

# 8. Review Tests, Fixtures, Mocks, and Snapshots

Inspect:

* unit tests
* integration tests
* end-to-end tests
* test helpers
* fixtures
* mocks
* stubs
* snapshots
* test data
* test configuration
* test scripts

Remove only items that are clearly:

* unreachable
* duplicated
* obsolete
* tied to deleted behavior
* no longer executed
* generated accidentally
* temporary
* misleading

Do not remove tests merely because they are inconvenient or currently failing.

If a test exposes a real implementation problem, preserve the test and report the issue separately unless the task explicitly authorizes behavior changes.

---

# 9. Review Database, Migration, and Schema Content

Inspect:

* migrations
* seed scripts
* schema definitions
* ORM models
* entities
* repositories
* database scripts
* stored procedures
* views
* indexes
* fixtures
* migration tooling

Do not delete migrations that are required to build a fresh database or support the current deployment process.

Potentially obsolete migration or database content may be removed only when you can prove that:

* it is not required for fresh setup
* it is not required for upgrades
* it is not referenced by tooling
* it is not part of a public/deployed contract
* the repository’s migration strategy permits removal

Preserve historical migrations when they are operationally required.

---

# 10. Be Careful With AI / Agent Instructions

If the repository contains files such as:

```text
AGENTS.md
CLAUDE.md
.agent/
.agents/
.claude/
.codex/
.github/
skills/
commands/
hooks/
prompts/
```

do NOT treat them as ordinary documentation.

Determine whether they are consumed by:

* Claude Code
* Codex
* Gemini / Antigravity
* OpenCode
* repository agents
* orchestrators
* hooks
* MCP integrations
* CI/CD
* development tooling

Keep instructions that materially affect agent behavior.

However, remove:

* duplicated agent instructions
* obsolete instructions
* excessive explanations
* instructions already enforced automatically by tooling
* stale model-specific instructions
* redundant context that unnecessarily consumes AI context/tokens
* references to deleted tools, commands, paths, or workflows

Optimize these files for:

> Minimum context required for correct agent behavior.

---

# 11. Review Scripts, Automation, CI/CD, and Deployment

Inspect:

* shell scripts
* PowerShell scripts
* Makefiles
* task runners
* package scripts
* build scripts
* release scripts
* deployment scripts
* CI workflows
* CD workflows
* Dockerfiles
* Docker Compose files
* infrastructure configuration
* scheduled jobs
* hooks
* automation commands

Identify:

* unused scripts
* duplicate scripts
* obsolete commands
* scripts referencing deleted files
* unreachable workflow steps
* stale CI jobs
* obsolete deployment targets
* unused environment variables
* redundant automation
* temporary debugging steps
* abandoned release tooling

Before deleting or changing automation, verify all references and execution paths.

Do not remove a script merely because it is not called from a package manifest if it may be invoked directly by CI/CD, deployment, operators, or external tooling.

---

# 12. Do Not Preserve History Just Because It Exists

Git already provides history.

Do not keep files merely because:

> "Someone may want to see the old version."

If Git contains the history and the file has no current operational, contractual, or documentation value, it can usually be removed.

Avoid keeping:

```text
README-old.md
README-v2.md
architecture-old.md
backup.ts
service-old.ts
final-final.md
deprecated-copy/
```

unless there is a concrete current reason.

Do not delete:

* required migration history
* legally required records
* security/audit records
* active ADRs
* operational runbooks
* public compatibility files
* files required by external consumers

---

# 13. Preserve Behavior

This cleanup must NOT intentionally change:

* application behavior
* APIs
* database behavior
* business logic
* public contracts
* authentication
* authorization
* security behavior
* runtime behavior
* build behavior
* deployment behavior
* agent behavior
* generated output contracts

Treat this primarily as:

> Repository hygiene + documentation cleanup + dead-content removal + safe codebase simplification.

Do not turn the cleanup into an architecture redesign.

Do not refactor working code merely because another design looks cleaner.

If removing apparently dead code could alter behavior, preserve it and report it as a remaining candidate.

---

# 14. Improve `.gitignore` When Appropriate

If generated or temporary files were committed but should never be committed again, update `.gitignore` where appropriate.

Consider:

* build output
* coverage output
* logs
* caches
* local environment files
* editor metadata
* OS metadata
* generated reports
* temporary exports
* profiling output
* local databases
* generated bundles

Do not ignore files that are required by the repository.

Do not use `.gitignore` to hide files that should be removed or reviewed.

---

# 15. Validate After Cleanup

After making changes, run all applicable validation available in the repository, such as:

```text
build
typecheck
lint
tests
unit tests
integration tests
end-to-end tests
repository validation
agent/runtime validation
documentation/link validation
```

Use the project's actual commands rather than blindly using the examples above.

Also verify:

* no broken imports
* no broken exports
* no broken links
* no missing referenced files
* no invalid configuration
* no documentation pointing to deleted files
* no agent instructions referencing deleted resources
* no CI/CD references to deleted scripts
* no package scripts referencing deleted files
* no build configuration referencing deleted files
* no deployment configuration referencing deleted files
* no generated-code workflow failures
* no missing runtime-discovered resources
* no accidental API or behavior changes

If static analysis is available, use it to identify unused code, but do not rely on static analysis alone.

---

# 16. Perform a Repository-Wide Stale Reference Search

After cleanup, search the entire repository for:

* deleted file names
* deleted directory names
* deleted symbols
* old commands
* old package names
* old environment variables
* old route names
* old architecture terminology
* obsolete feature names
* stale documentation links
* references to removed scripts
* references to removed agent resources
* references to removed configuration

Do not assume deleting a file is sufficient.

Remove or update stale references where appropriate.

---

# 17. Do Not Stop at Comments or Docs

This is a **repository-wide cleanup of the entire codebase**.

Do not finish after removing obvious comments or documentation.

Continue examining:

* source
* tests
* dependencies
* configuration
* database code
* migrations
* scripts
* CI/CD
* deployment
* prompts
* agent instructions
* examples
* generated artifacts
* planning artifacts
* temporary files
* obsolete compatibility code
* assets
* build tooling
* runtime discovery mechanisms

until the repository contains primarily information, code, configuration, and artifacts that still serve a current purpose.

---

# 18. Final Report

After completing the cleanup, provide a concise report containing:

## Removed

What was deleted and why.

## Consolidated

Documentation, code, configuration, scripts, or instructions that were merged.

## Updated

Files that were simplified, corrected, or synchronized.

## Dependencies and Configuration Cleaned

Unused dependencies, scripts, project references, environment variables, or configuration removed.

## Preserved Intentionally

Suspicious-looking files, code, comments, migrations, tests, or documentation that were intentionally retained and why.

## Validation

Commands/tests executed and their results.

## Remaining Candidates

Anything that may be obsolete but could not be safely proven unnecessary.

Do not delete uncertain items merely to maximize the number of deletions.

---

# Cleanup Philosophy

Apply these principles:

### Comments

```text
WHAT → usually remove
WHY → usually keep
```

### Documentation

```text
Current + useful → keep
Duplicate → consolidate
Outdated → update or remove
Historical-only → prefer Git history
```

### Files

```text
Used → keep
Clearly unused → remove
Uncertain → investigate before touching
```

### Code

```text
Dead and proven unused → remove
Working → don't redesign unnecessarily
Potentially dynamic/public → preserve unless proven safe
```

### Dependencies and Configuration

```text
Required by source/tooling/runtime → keep
Clearly unused → remove
Uncertain or indirectly consumed → investigate first
```

### Agent Context

```text
Useful instruction → keep
Repeated context → remove
Automatically enforceable rule → prefer automation
Historical explanation → remove
```

---

# Core Rule

The final repository should follow this principle:

> If removing something does not reduce maintainability, understanding, correctness, operational knowledge, or safety — it probably does not belong in the repository.

But:

> When uncertain, investigate first. Never trade correctness for cleanliness.

The cleanup applies to the **entire codebase**, not only to docs or comments.
