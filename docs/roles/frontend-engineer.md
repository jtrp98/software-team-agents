# Frontend-engineer rationale

T-V3TOK-024 moved repeated procedure and stack-change rationale out of the
static prompt. T-V3-04 then made the Target's deterministic `.agent-team/config.yaml`
`stack:` block authoritative for profile, tooling, commands, and paths. The role
implements that resolved stack and existing repository conventions; choosing or
introducing another stack remains a human decision. The prompt still keeps
contract-derived types and the signed UX artifact gate.
