# Semantic task fixture requirements

## Overview

Exercise four independently bounded planning cases.

## Target Users & Roles

Backend implementers and independent QA reviewers.

## Core Features

- REQ-101: Add the order export.
- AC-101.1: Exported orders contain the selected fields.
- REQ-102: Preserve the empty-order behavior.
- AC-102.1: Empty orders return an explicit zero total.
- REQ-103: Add the order audit relation.
- AC-103.1: Existing orders receive a safe audit backfill.
- REQ-104: Replace the legacy order summary contract.
- AC-104.1: All consumers use the versioned replacement.

## Scope

Only the four fixture contracts.

## Constraints & Assumptions

No real deployment or data migration is authorized.

## Open Questions

—

## Declined / Not Pursuing

Unrelated order behavior.

## References

Synthetic test fixture; no external facts.

## Change Log

- Undated — added the T-V8-008 semantic planning fixture.
