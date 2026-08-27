# Backend-engineer rationale

T-V3TOK-023 moved coding rationale and stack-change examples out of the static
prompt. T-V3-04 then made the Target's deterministic `.agent-team/config.yaml`
`stack:` block authoritative for profile, tooling, commands, and paths. The role
implements that resolved stack and existing repository conventions; choosing or
introducing another stack remains a human decision. The prompt still keeps its
implementation boundaries, contract fidelity, and stop-and-route judgment.
