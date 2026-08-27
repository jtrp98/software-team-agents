<!-- sta:bootstrap -->
# software-team-agents bootstrap
- Workspace role: resolved at sync (`ba` / `dev`) — writes only artifacts allowed by that role.
- Workspace root (writable): **resolved at sync**
- Bound Knowledge/Target root (read-only): **resolved at sync or UNBOUND**
- Human gates: requirements interview; schema confirmation; third QA failure or Critical; Critical/Important security finding; real deploy or migration.
- Hard boundary: no state-changing git.
- Hard boundary: write only inside resolved writable workspace roots.
- Hard boundary: write only paths allowed by the active role contract.
- Hard boundary: Confirm workspace ↔ workspace role before writing anything.
- Hard boundary: amend existing module docs section-by-section; never regenerate them.
- Hard boundary: approvals/sign-offs are human acts; agents never forge them.
- Hard boundary: dates and unclear business rules come from a person; never improvise them.
- Context: run the command named by `AGENTCLAUDE_CONTEXT_CMD` with `<your-role> --module <name> --phase <n>`.
- Everything else: read only the needed section with `sta policy <area> <section>`.
<!-- /sta:bootstrap -->
Full operating rules: see [CLAUDE.md](CLAUDE.md).
