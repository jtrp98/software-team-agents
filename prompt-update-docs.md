# Repository-Wide Documentation Audit & Synchronization

You are acting as a **Senior Software Engineer, Technical Writer, Software Architect, Repository Maintainer, and Documentation Auditor**.

Your task is to inspect the **entire repository** and update all documentation so that it accurately reflects the **current implementation, architecture, configuration, commands, workflows, and behavior of the codebase**.

The primary rule is:

> **The current working code is the Source of Truth.**

Documentation must describe the system that actually exists now — not the system that was originally planned, previously implemented, or assumed to exist.

Do NOT simply proofread documentation.

You must verify documentation claims against the actual repository.

---

# 1. Understand the Codebase First

Before modifying documentation, inspect the repository sufficiently to understand the current system.

Analyze:

* repository structure
* application entry points
* packages/modules/projects
* frontend/backend boundaries
* architecture
* services
* APIs
* database/data layer
* configuration
* environment variables
* authentication/authorization
* scripts
* build system
* tests
* deployment
* CI/CD
* integrations
* CLI commands
* agent/runtime infrastructure
* hooks
* MCP integrations
* development workflow

Do not assume existing documentation is correct.

Use it as a hypothesis that must be verified against code.

---

# 2. Discover All Documentation

Search the entire repository for documentation and documentation-like content.

Examples include:

```text
README
README.md
README.*
docs/
documentation/
guides/
examples/

*.md
*.mdx
*.txt

CONTRIBUTING*
CHANGELOG*
ARCHITECTURE*
DESIGN*
SETUP*
INSTALL*
DEPLOYMENT*
SECURITY*
TROUBLESHOOTING*
```

Also inspect documentation embedded in:

```text
package.json
*.csproj
*.sln
*.slnx
Dockerfile*
docker-compose*
.env.example
config files
CI/CD files
scripts
Makefile
comments
XML docs
JSDoc/TSDoc
OpenAPI/Swagger
```

Documentation may exist outside `/docs`.

Find all of it.

---

# 3. Treat Code as Source of Truth

For every meaningful documentation claim, verify it against the current implementation.

Examples:

Documentation says:

```text
Run:

npm run dev
```

Verify that the command actually exists.

Documentation says:

```text
The application uses PostgreSQL.
```

Verify the actual database implementation/configuration.

Documentation says:

```text
POST /api/users
```

Verify the route exists and verify:

* method
* path
* parameters
* authentication
* request structure
* response structure

Documentation says:

```text
src/services/
```

Verify the directory still exists and has the described responsibility.

Never preserve incorrect documentation merely because it looks intentional.

---

# 4. Update README

Ensure the main README accurately explains the current repository.

Where relevant, it should cover:

* What the system is
* What problem it solves
* Current architecture
* Main capabilities
* Repository structure
* Technology stack
* Prerequisites
* Installation
* Configuration
* Environment variables
* Database setup
* Running locally
* Build
* Testing
* Development workflow
* Deployment
* Troubleshooting
* Links to deeper documentation

Do not make README unnecessarily huge.

Prefer:

```text
README → orientation + getting started
docs/* → detailed documentation
```

The README should help a new developer understand:

> What is this, how does it work at a high level, and how do I run it?

---

# 5. Synchronize Architecture Documentation

Compare architecture documentation against actual code.

Verify:

* components
* modules
* boundaries
* dependencies
* data flow
* service communication
* runtime flow
* persistence
* external integrations
* frontend/backend relationship
* background jobs
* queues/events if applicable
* authentication flow
* authorization boundaries

Update obsolete architecture descriptions.

Remove references to components that no longer exist.

Add important components that exist but are undocumented.

Do NOT redesign the architecture.

Document what actually exists.

---

# 6. Synchronize Repository Structure Documentation

Any documented directory tree must match the current repository.

For example:

```text
src/
├── api/
├── services/
├── domain/
└── infrastructure/
```

Verify every important path.

Remove obsolete paths.

Add important missing paths.

Do not document every trivial directory.

Focus on structure developers need to understand.

---

# 7. Synchronize Setup & Installation

Actually inspect:

* dependency manifests
* runtime versions
* package managers
* SDK versions
* Docker configuration
* database requirements
* environment variables
* migrations
* seed scripts
* build scripts

Ensure setup instructions can realistically take someone from:

```text
git clone
```

to:

```text
working application
```

Do not document commands that no longer work.

---

# 8. Synchronize Commands

Find commands referenced throughout documentation.

Verify them against:

* package scripts
* CLI implementations
* shell scripts
* PowerShell scripts
* Makefiles
* task runners
* build tools
* actual executable entry points

Examples:

```bash
npm install
npm run dev
npm run build
npm test
dotnet restore
dotnet build
dotnet test
docker compose up
```

Do not assume these examples apply.

Use the commands actually supported by the repository.

Remove obsolete commands.

---

# 9. Synchronize Configuration & Environment Variables

Compare documentation against actual configuration access.

Identify:

* required variables
* optional variables
* defaults
* deprecated variables
* renamed variables

Update:

```text
.env.example
README
setup docs
deployment docs
configuration docs
```

so they agree.

Never put real secrets into documentation.

Use safe placeholders.

---

# 10. Synchronize API Documentation

If the project exposes APIs, verify documentation against actual routes/controllers/handlers.

Check:

* HTTP method
* path
* parameters
* request body
* response
* status codes
* authentication
* authorization
* pagination
* validation
* error behavior

Where OpenAPI/Swagger exists, verify whether it is generated from or synchronized with the implementation.

Do not maintain unnecessary duplicate API documentation when an authoritative generated source already exists.

---

# 11. Synchronize Database Documentation

Inspect actual:

* schemas
* models
* entities
* migrations
* relationships
* indexes
* stored procedures/functions
* ORM configuration

Update documentation accordingly.

Do not manually duplicate the complete database schema unless that duplication provides meaningful value.

Prefer documenting:

* important entities
* relationships
* lifecycle
* conventions
* unusual constraints
* migration workflow

---

# 12. Synchronize Tests & Quality Commands

Verify documentation for:

* unit tests
* integration tests
* E2E tests
* lint
* formatting
* type checking
* static analysis
* validation scripts
* coverage

Ensure commands and expected workflows match the current repository.

---

# 13. Synchronize Deployment & CI/CD

Inspect actual:

```text
.github/workflows/
Dockerfile*
docker-compose*
deployment scripts
cloud configuration
pipeline configuration
release scripts
```

Update documentation to reflect the actual process.

Clearly distinguish between:

```text
Local Development
Testing
Staging
Production
```

when those environments actually exist.

---

# 14. Synchronize Agent / AI Documentation

If the repository contains:

```text
AGENTS.md
CLAUDE.md
.agent/
.agents/
.claude/
.codex/
skills/
commands/
hooks/
prompts/
MCP configuration
runtime configuration
```

inspect the actual implementation before modifying them.

Verify:

* supported agents
* supported runtimes
* commands
* hooks
* tool permissions
* workspace behavior
* directory conventions
* configuration paths
* discovery behavior
* guardrails

These files may directly affect AI coding-agent behavior.

Do NOT treat them as ordinary prose documentation.

---

# 15. Synchronize Documentation With Other Documentation

Code consistency alone is not enough.

All documentation must also agree with each other.

Search for contradictions such as:

```text
README says Node 22
SETUP says Node 20
CI actually uses Node 24
```

or:

```text
README says PostgreSQL
architecture.md says SQL Server
code actually uses PostgreSQL
```

Resolve contradictions based on the current implementation.

There should be one consistent understanding of the system.

---

# 16. Establish Documentation Ownership

Avoid maintaining the same fact in many places.

Prefer a hierarchy such as:

```text
Code / Config
      ↓
Authoritative technical documentation
      ↓
README / Guides
```

For example:

If environment variables are documented comprehensively in:

```text
docs/configuration.md
```

README should summarize and link to it rather than maintaining another large duplicate table.

Apply the principle:

> One authoritative source per technical fact whenever practical.

---

# 17. Remove or Consolidate Stale Documentation

When documentation is:

* obsolete
* duplicate
* superseded
* contradictory
* describing removed functionality
* temporary planning material
* no longer useful

choose appropriately between:

```text
UPDATE
MERGE
DELETE
```

Do not keep stale docs merely for history.

Git already preserves history.

However, do not delete ADRs or historical documents when the historical decision itself remains valuable.

---

# 18. Separate Current State From Future Plans

Do not allow proposed features to look like implemented features.

Clearly distinguish:

```text
Current
Planned
Experimental
Deprecated
```

If planning documents exist, ensure they do not contradict current operational documentation.

A developer reading README or `/docs` should not mistake a roadmap for existing functionality.

---

# 19. Fix Documentation References

Check all internal references:

* relative Markdown links
* file links
* anchors
* image references
* source-code references
* documentation cross-links
* command references

Fix links affected by moved/renamed/deleted documentation.

Search the repository for references before renaming or deleting documentation.

---

# 20. Keep Documentation Useful, Not Exhaustive

Do NOT document obvious implementation details simply to increase documentation coverage.

Avoid documentation like:

> `UserService` is a service for users.

Instead document things that help someone understand or operate the system.

Prefer documentation for:

* architecture
* important flows
* boundaries
* setup
* operational knowledge
* business rules
* non-obvious behavior
* extension points
* constraints
* troubleshooting

Apply:

> Document knowledge that cannot be understood quickly from reading the code.

---

# 21. Optimize Documentation for Humans and AI Agents

Documentation should work well for both developers and coding agents.

Prefer:

* clear headings
* concise explanations
* deterministic terminology
* exact paths
* exact commands
* explicit boundaries
* minimal duplication
* small focused documents
* links to authoritative sources

Avoid:

* long narrative explanations
* repeated context
* marketing language
* filler
* obvious statements
* outdated examples
* excessive token-heavy prose

The objective is:

> Maximum useful context with minimum documentation noise.

---

# 22. Do Not Change Code Just to Match Documentation

If documentation and code disagree:

Normally:

```text
Documentation → update to match code
```

Do NOT silently change working code merely because documentation says something different.

However, if you discover something that appears to be an actual implementation bug, security problem, or serious inconsistency:

1. Do not silently redesign/fix it as part of documentation synchronization.
2. Document the discrepancy.
3. Report it separately.

---

# 23. Validate Everything

After documentation changes, verify:

* documented commands exist
* documented paths exist
* documented configuration exists
* internal links resolve
* examples are plausible
* README agrees with detailed docs
* architecture docs agree with implementation
* setup instructions agree with dependency/config files
* agent docs agree with runtime implementation

Run available documentation/link validation if the repository provides it.

Also run normal repository validation when documentation changes affect files consumed by tooling.

---

# 24. Final Consistency Pass

Before finishing, perform another repository-wide search for old terminology.

Search for:

* renamed components
* old paths
* old commands
* removed features
* deprecated configuration
* old runtime names
* old architecture terminology
* outdated version numbers
* obsolete technology names

This is important.

Do not assume updating the main docs is enough.

---

# 25. Final Report

After completing the work, provide:

## Documentation Updated

List the major documents changed and why.

## Documentation Removed

List obsolete documents removed.

## Documentation Consolidated

Explain which duplicated documents were merged and identify the new authoritative source.

## Code ↔ Docs Mismatches Fixed

Summarize important inconsistencies corrected.

## Cross-Documentation Conflicts Fixed

Summarize contradictions between documents that were resolved.

## Potential Code Issues Found

Report discrepancies that appear to be implementation problems rather than documentation problems.

Do not modify those silently.

## Validation

Report:

* commands checked
* tests/validation executed
* links checked
* remaining warnings

## Remaining Uncertainty

List anything that could not be confidently determined from the repository.

---

# Definition of Done

Do NOT consider the task complete merely because README was updated.

The task is complete when:

1. Major documentation has been discovered.
2. Documentation claims have been checked against current code/configuration.
3. Stale information has been updated or removed.
4. Duplicate documentation has been consolidated where appropriate.
5. Documentation agrees with other documentation.
6. Commands and paths are accurate.
7. Agent/tooling documentation reflects actual behavior.
8. Old terminology has been searched repository-wide.
9. Relevant validation passes.
10. Remaining uncertainty is explicitly reported.

The desired final state is:

```text
                 CODE / CONFIG
                      │
              Source of Truth
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
     Architecture            Configuration
          │                       │
          └───────────┬───────────┘
                      ▼
                  README
                      │
                      ▼
               Guides / Docs
```

Everything should describe the **same current system**.

# Core Principle

> Do not document what the system was supposed to become.

> Document what the system actually is today.

And:

> When code, configuration, README, architecture docs, setup guides, and agent instructions describe the same concept, they must tell the same story.
