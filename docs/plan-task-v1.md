# Canonical PlanTask v1

`plan.md` is the sole authored task authority. `PlanTaskSchema` in
`orchestrator/src/docs/planTask.ts` defines its internal normalized object and
inferred `PlanTask` type. JSON snapshots are test output, never authoring inputs.
The [canonical example](../orchestrator/src/docs/fixtures/canonical-plan.md) is
the small versioned template. The [semantic cases](../orchestrator/src/docs/fixtures/semantic-plan-cases.md)
show independently bounded feature, bug, schema, and refactor work. The PM prompt,
parser, graph consumers, evidence selector, gate policy, and packet compiler share
this contract.

## Grammar

Use exactly one `PlanTask format: 1`, `## Phase N` (positive integer), then
`### Task BE-004 — title` and the example's metadata lines and `####` headings.
IDs accept a role prefix and nonempty alphanumeric suffix (also dot, dash and
underscore). Labels are case-sensitive. Fields/headings occur once; unknown,
duplicate or empty fields fail. Tier is the only optional metadata line and
accepts T2–T6; runtime routing/role Tier policy is outside this parser.
Owner is one of the eleven agent role names. Status is pending, in_progress,
verified or blocked. Lists use comma-separated values or exactly `none` for
an empty list. Traceability must contain REQ, AC and DES IDs and may select `DEC-NNN`;
duplicate references fail. Contract IDs use `Contract:Name.vN`, with positive
version N. When addressable design is supplied, every selected DES/DEC/Contract
must exist and carry evidence.

Risk accepts low, medium, high, critical, shared-contract, authorization, schema,
security, data-loss, breaking-contract or business. Human gate accepts business,
schema, breaking-contract, security, design-ambiguity, plan-approval, deployment or migration;
`none` means no declared gate, never approval. Gate enforcement remains with the
existing safety kernel. Schema, migration, breaking-contract, Critical security,
and material-ambiguity design triggers require matching task gates. Scope/constraints,
retrieval hints, do-not-modify, acceptance, required validation/evidence and
compatibility are each one nonempty Markdown body. Retrieval hints must state
`Hypothesis:`, `Query:`, and `Provenance:`; provenance is an exact subset of the
task's selected DES/DEC/Contract claims. Concepts, symbols, routes, migrations,
likely module boundaries, and paths remain hypotheses until current source
confirms them; graph/LSP relationships remain inferred.
Code fences are allowed inside these bodies; headings inside a fence are text.
The parser rejects a whole malformed plan, never exposes a partial task set.

`parseCanonicalPlan(text, {requirementMd, designMd})` checks trace and contract
references against the supplied authoritative documents, task-local AC identity,
retrieval provenance, risk/design gate parity, duplicate semantic bodies, dependency
IDs, duplicates and mixed declared/contract/phase cycles. Acceptance and validation
must each cite every task-selected AC and must not import unrelated AC IDs. The CLI `--check-plan` supplies those documents
and fails on missing references. Parsing without documents is syntax/local
reference validation only. A normalized semantic field copied verbatim from the
supplied requirement/design is rejected: cite its stable ID and author the bounded
task interpretation. A consumed external contract requires design.md.
`taskGraphFromPlan` preserves dependencies, produced/consumed contracts, owner and
phase for validation, waves, readiness, QA impact, handoff and registration.
Declared edges take diagnostic precedence over contract edges, then phase edges.
Runtime readiness requires ledger/checkpoint completion; a verified Status cell
alone cannot unlock a planned dependency. Unannotated legacy FE/BE ordering that
would be ambiguous is refused; explicit empty contract lists mean independent.

## Downstream consumers

Every field is executable input, not formatting. Version and identity feed the
compiler/migration; phase, dependencies, produces and consumes feed the DAG,
readiness and handoff; owner feeds runtime; Tier is a per-task recommendation to
the central route resolver. Traceability and retrieval hints select bounded
context. Risk and human gates feed gate policy. Status feeds readiness/QA sync.
Objective/why/title, scope, do-not-modify, acceptance, validation/evidence and
compatibility feed DEV/QA packets, deterministic verification, and rollback.
`PLAN_TASK_FIELD_CONSUMERS` is the machine-checked complete map.

## Identity

`planTaskHash` validates and serializes fields in schema order, excluding only
Status. Version, ID, phase, title, every semantic field, optional Tier and list
order all affect SHA-256. Field-boundary whitespace and CRLF normalize during
parsing; internal Markdown content remains significant. A status-only edit
leaves the hash unchanged. A hash is not a QA verdict or human approval.
The old wave journal's `planHash` retains its legacy status-inclusive meaning
until its migration task; these are explicitly different versioned contracts.

## Compatibility and migration matrix

| Input | Explicit behavior | Conversion |
|---|---|---|
| v1 sections | Strict canonical checker/parser | No conversion |
| Existing thin table | `parseLegacyPlanTasks` preserves old behavior during the window; `--check-plan` reports compatibility use | Refuse automatic semantic promotion; PM authors missing objective/why/trace/scope/evidence using the template |
| Expanded table with every exact v1 field and body as a column, Task cell `ID — title` | `migrateLegacyTaskTable` validates and returns a lossless task-section conversion | Opt-in only; no filesystem writes, no invented prose |
| Missing fields, ambiguous ID/cells, duplicate/unknown columns, checkbox-only plan | Actionable refusal naming task/field where identifiable | Amend the relevant task sections manually; preserve all other authored sections |
| Unsupported format, mixed tables and task sections | Refuse, never guess | Correct the declared format using the v1 example |

The old `parsePlanTasks` export is a compatibility alias to the explicit legacy
reader. It refuses v1 instead of flattening rich contracts. `readWorkPlan` returns
the complete canonical object or an explicitly recognized legacy row. Planned
execution requires canonical semantics and an immutable v2 packet; a thin table
can still be inspected but cannot silently become an executable description.
An unknown plan task requires `--ad-hoc`; a known task cannot use that flag to
bypass dependencies. Ad-hoc selection does not waive packet semantic requirements.
T-V8-029 retains ownership of retiring the legacy reader and wave lifecycle.
No authored module document is automatically rewritten. A rollback must retain
new canonical plans and v2 packets for audit and use a compatible reader; never
resume them through an older thin-task compiler. See [ExecutionPacket v2](execution-packet-v2.md).
