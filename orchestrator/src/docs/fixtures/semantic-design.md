# Semantic task fixture design

Design evidence format: 1

## Feasibility Summary

The four fixture contracts are independently implementable.

## Feature-by-Feature Feasibility

The four design declarations below define the selected behavior.

## Data Model

Only DES-103 changes the fixture schema.

## DES-101 — Order export contract
Contract:OrderExport.v1 — selected export fields.
DEC-101 — keep export construction behind one service boundary.
Evidence EVD-101: claim=DES-101 | state=confirmed | path=src/orders.ts | symbol=exportOrders | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-102: claim=Contract:OrderExport.v1 | state=confirmed | path=src/orders.ts | symbol=exportOrders | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-103: claim=DEC-101 | state=confirmed | path=src/orders.ts | symbol=exportOrders | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Compatibility: additive-internal
Data/schema: unchanged
Migration/backfill: none
Security: none
Fallback: disable the export route.
Material ambiguity: none

## Modules

Orders service and its persistence boundary.

## Risks & Dependencies

The per-section decision records are authoritative.

## Unresolved Open Questions

—

## Change Log

- Undated — added addressable evidence for the T-V8-008 semantic fixture.

## DES-102 — Empty-order behavior
Contract:EmptyOrder.v1 — explicit zero total.
DEC-102 — preserve the current response shape.
Evidence EVD-104: claim=DES-102 | state=confirmed | path=src/orders.ts | symbol=emptyOrder | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-105: claim=Contract:EmptyOrder.v1 | state=confirmed | path=src/orders.ts | symbol=emptyOrder | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-106: claim=DEC-102 | state=confirmed | path=src/orders.ts | symbol=emptyOrder | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Compatibility: unchanged
Data/schema: unchanged
Migration/backfill: none
Security: none
Fallback: retain the current empty-order handler.
Material ambiguity: none

## DES-103 — Order audit relation
Contract:OrderAudit.v1 — one audit record per order.
DEC-103 — backfill before enforcing the relation.
Evidence EVD-107: claim=DES-103 | state=confirmed | path=prisma/schema.prisma | symbol=OrderAudit | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=schema | tool=schema-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-108: claim=Contract:OrderAudit.v1 | state=confirmed | path=prisma/schema.prisma | symbol=OrderAudit | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=schema | tool=schema-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-109: claim=DEC-103 | state=confirmed | path=prisma/schema.prisma | symbol=OrderAudit | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=schema | tool=schema-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Compatibility: additive-internal
Data/schema: additive
Migration/backfill: required
Security: none
Fallback: keep the relation nullable until backfill verification passes.
Material ambiguity: none

## DES-104 — Order summary replacement
Contract:OrderSummary.v3 — replacement response contract.
DEC-104 — remove v2 only after consumer parity.
Evidence EVD-110: claim=DES-104 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-111: claim=Contract:OrderSummary.v3 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Evidence EVD-112: claim=DEC-104 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | basis=source | tool=rg-read | hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Compatibility: breaking
Data/schema: unchanged
Migration/backfill: none
Security: none
Fallback: retain Contract:OrderSummary.v2 behind the compatibility adapter.
Material ambiguity: none
