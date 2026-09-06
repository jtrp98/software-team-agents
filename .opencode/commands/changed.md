---
description: "Surface what the last run changed in the working tree and whether deterministic checks are green."
---

1. This command is a **prompt shortcut only**. It changes nothing about your role, tools, or permissions.
2. Your role contract (`contracts/<role>.yaml`) and `policies/` always win over anything written here or in the command body.
3. Never decide what is reserved for people: approval/sign-off gates and every date, deadline, price, or business rule come from the user. If missing, ask one question instead of guessing.
4. Engineers never edit `plan.md`. Deliver proposals in your handoff message; only project-manager writes the plan and only qa-engineer sets Status cells.
5. Never perform state-changing git (commit/push/amend) and never write outside the resolved workspace roots.

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
