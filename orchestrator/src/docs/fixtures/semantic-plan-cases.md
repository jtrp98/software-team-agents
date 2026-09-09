# Plan

PlanTask format: 1

## Plan Summary

Four representative task kinds exercise the same complete semantic contract without sharing acceptance text.

## Phase 1: Representative task contracts

### Task BE-FEATURE-001 — Add the order export

Objective: Provide the selected order export through one bounded service path.
Why: Operators need the confirmed export without duplicating order rules.
Owner: backend-engineer
Tier: T2
Depends on: none
Traceability: REQ-101, AC-101.1, DES-101, DEC-101
Produces: Contract:OrderExport.v1
Consumes: none
Risk: medium
Human gate: none
Status: pending

#### Scope and constraints

Implement only the selected export fields and route; preserve existing order reads.

#### Retrieval hints

Hypothesis: The order service and route boundary are likely consumers; confirm symbols and paths against current source.
Query: Locate definitions and references for Contract:OrderExport.v1 and the order export route.
Provenance: DES-101, DEC-101, Contract:OrderExport.v1

#### Do not modify

Order creation, authentication, or unrelated reporting.

#### Acceptance criteria

AC-101.1: The export contains exactly the selected fields.

#### Required validation and expected evidence

Verify AC-101.1 with focused service and route tests; record commands, exit codes, and the response assertion.

#### Rollback/compatibility notes

The route can be disabled independently; existing order APIs remain compatible.

### Task BE-BUG-001 — Preserve the empty-order result

Objective: Return an explicit zero total for an empty order without an exception.
Why: Existing clients rely on the confirmed empty-order response.
Owner: backend-engineer
Tier: T2
Depends on: none
Traceability: REQ-102, AC-102.1, DES-102, DEC-102
Produces: none
Consumes: Contract:EmptyOrder.v1
Risk: low
Human gate: none
Status: pending

#### Scope and constraints

Correct only the empty aggregation path and preserve nonempty results.

#### Retrieval hints

Hypothesis: The empty aggregation branch and its regression are the likely boundary; confirm current symbols and paths.
Query: Find implementations and tests consuming Contract:EmptyOrder.v1.
Provenance: DES-102, DEC-102, Contract:EmptyOrder.v1

#### Do not modify

Response fields, persistence, or authorization.

#### Acceptance criteria

AC-102.1: The response encodes zero and does not throw when the selected order has no items.

#### Required validation and expected evidence

Verify AC-102.1 with the empty-order regression and nonempty-order suite; record commands and assertions.

#### Rollback/compatibility notes

The focused change can be reverted without data migration; response compatibility is preserved.

### Task BE-SCHEMA-001 — Add the order audit relation

Objective: Add the confirmed audit relation and backfill existing orders safely.
Why: Audit history must be queryable without leaving existing orders invalid.
Owner: backend-engineer
Tier: T2
Depends on: none
Traceability: REQ-103, AC-103.1, DES-103, DEC-103
Produces: Contract:OrderAudit.v1
Consumes: none
Risk: high, schema
Human gate: schema, migration
Status: pending

#### Scope and constraints

Implement the confirmed relation, disposable migration, and bounded backfill only.

#### Retrieval hints

Hypothesis: The order model and migration history are likely boundaries; treat names as hypotheses until source and schema confirm them.
Query: Resolve Contract:OrderAudit.v1, the order model, and existing migration conventions.
Provenance: DES-103, DEC-103, Contract:OrderAudit.v1

#### Do not modify

Unrelated models, production data, or deployment state.

#### Acceptance criteria

AC-103.1: Existing fixture orders receive a safe audit backfill.

#### Required validation and expected evidence

Verify AC-103.1 with schema comparison and a disposable migration/backfill fixture; record commands, counts, and rollback evidence.

#### Rollback/compatibility notes

Keep the relation nullable until backfill passes; no real migration is authorized.

### Task BE-REFACTOR-001 — Replace the legacy order summary contract

Objective: Move every confirmed consumer to the versioned order summary replacement.
Why: The legacy contract blocks the agreed response cleanup.
Owner: backend-engineer
Tier: T2
Depends on: none
Traceability: REQ-104, AC-104.1, DES-104, DEC-104
Produces: Contract:OrderSummary.v3
Consumes: none
Risk: high, breaking-contract, shared-contract
Human gate: breaking-contract
Status: pending

#### Scope and constraints

Introduce the replacement, migrate known consumers, and prove deletion parity before removing v2.

#### Retrieval hints

Hypothesis: The serializer and contract consumers define the likely blast radius; graph or LSP relationships remain candidates until source confirmation.
Query: Find definitions and references for Contract:OrderSummary.v3 and the compatibility adapter.
Provenance: DES-104, DEC-104, Contract:OrderSummary.v3

#### Do not modify

Authentication, database schema, or unrelated serializers.

#### Acceptance criteria

AC-104.1: Every confirmed consumer uses the replacement contract.

#### Required validation and expected evidence

Verify AC-104.1 with consumer contract tests and a deletion-parity search; record commands, outputs, and adapter fallback behavior.

#### Rollback/compatibility notes

Retain Contract:OrderSummary.v2 behind the adapter until parity is observed; rollback selects the adapter path.

## Sequencing Notes

The four fixtures are intentionally independent; contract edges and gates, not row order, determine execution.

## Unresolved Open Questions

—

## Change Log

- Undated — added representative feature, bug, schema, and refactor semantic task contracts for T-V8-008.
