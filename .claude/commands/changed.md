---
description: Surface what the last run changed in the working tree and whether deterministic checks are green.
argument-hint: [optional project-root]
---
@_shared/guardrails.md

Surface recent working tree changes and deterministic gate status:

1. Execute or inspect changes:
- Run `sta changed` with the target project root (or inspect git working tree status).
- List changed files: tracked modifications and untracked non-ignored files.

2. Deterministic gate result:
- Report the outcome of static analysis (typecheck, lint, test, build): PASS, FAIL, or UNVERIFIED.
- If the workspace has no configured stack commands or is not a git repository, report that state honestly.

3. Core boundary:
- State explicitly that this report covers deterministic checks only and is NOT a QA verdict.
- Genuine QA evaluation requires `qa-engineer` comparing code against requirements and design contract.