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
duplicate or empty fields fail. Tier and Targets are optional metadata lines. Tier accepts T2–T6; runtime
routing/role Tier policy is outside this parser. Targets is an optional list of
target IDs (or none) naming the repositories the task touches; it carries target
IDs only, while the engineer role remains on Owner (pairing them is validated by
downstream checkers, never derived from target types). The authoring rule and
what `--check-plan` validates are in `## Targets and task splitting` below.
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
alone cannot unlock a planned dependency. Undeclared FE/BE ordering that would
be ambiguous is refused; explicit empty contract lists mean independent.

## Targets and task splitting

`Targets:` is a permission, not an obligation. A task **may** name several
Targets when the change is logically atomic and the Targets are kept in sync:
a contract published by the API and consumed by the web client in the same
release is one task (`Targets: sales-api, sales-web`). Split per Target only
when the work is genuinely separable; never split a task merely because it
touches two repositories. Rewriting the billing engine (API) alongside an
unrelated redesign of the web navigation is two tasks, not one. `Owner:` stays
the role the work belongs to; `Targets:` says where it lands; one task must not
name two Targets for the same engineer role.

`--check-plan` validates each named id against `targets.yaml`: the id must
exist, be active, sit inside the module's declared `design.md` `## Targets` set,
and — when the owner is an engineer role — the Target's declared `type` must
admit that owner. An untyped Target passes because `Target.type` is optional in
the current schema v1 contract, mirroring binding validation. A task carrying no
`Targets:` is unchecked, and the checks skip with a note in a workspace where
`targets.yaml` is unreachable. The checks run on canonical task sections. The
engineer role is never derived from the Target type.

## Downstream consumers

Every field is executable input, not formatting. Version and identity feed the
compiler; phase, dependencies, produces and consumes feed the DAG,
readiness and handoff; owner feeds runtime; Tier is a per-task recommendation to
the central route resolver; Targets feeds `--check-plan` Target validation
(registry existence, active status, module `## Targets` scope,
type-admits-Owner), packet compilation, and multi-target DEV/QA execution. Traceability and retrieval hints select bounded
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

## Unsupported input

Missing fields, ambiguous IDs, duplicate or unknown labels, checkbox/table task
authorities, mixed formats, and unsupported format markers are refused. Amend the
relevant canonical task sections using the v1 example; STA does not interpret,
convert, or rewrite another document shape. An unknown plan task requires
`--ad-hoc`; a known task cannot use that flag to bypass dependencies. Ad-hoc
selection does not waive packet semantic requirements. A rollback retains
canonical plans and v2 packets for audit. See [ExecutionPacket v2](execution-packet-v2.md).
