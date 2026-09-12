# Design evidence v1

`design.md` is authored design authority; current source/schema is implementation evidence. `Design evidence format: 1` makes the relationship addressable without treating discovered code as the decision-maker.

## Claim and evidence grammar

Declare the marker exactly once. Each normative contract section starts `## DES-NNN — title`, declares at least one `Contract:Name.vN`, and declares exactly one `DEC-NNN`. All three identity kinds are stable and each has an evidence line:

```text
Evidence EVD-001: claim=DES-001 | state=confirmed | path=src/example.ts | symbol=example | line=1 | revision=<40-or-64-lowercase-hex> | basis=source | tool=rg-read | hash=<sha256>
```

Fields occur exactly once. `path` is repository-relative and cannot traverse outside the Target. `line`, `revision`, `symbol`, and content `hash` make drift detectable; `basis` is one of `source`, `schema`, `compiler`, `test`, `graph`, or `lsp`. State is `confirmed`, `inferred`, or `unresolved`. Graph/LSP evidence must remain inferred until current source or schema confirms the relationship.

Every section records exactly one of each decision:

```text
Compatibility: unchanged | additive-internal | additive-external | breaking
Data/schema: unchanged | additive | breaking
Migration/backfill: none | required | destructive
Security: none | sensitive | critical
Fallback: <an executable fallback, not none/TBD/unknown>
Material ambiguity: none | unresolved
```

## Gates and execution

Schema changes, required/destructive migration, breaking compatibility, Critical security consequence, and unresolved material ambiguity require the corresponding human gate. A valid, current, additive-internal section with no trigger may proceed without a universal design-confirmation gate. The human owns every approval; the parser only identifies whether one is required.

The planner selects exact DES/DEC/Contract claims. Packet assembly includes only their `EVD-NNN` records and rechecks revision, path, hash, line, and symbol against the current Target. Stale or drifting evidence blocks compilation. In legacy single-repository layout only, a later documentation-only revision may remain usable when the exact referenced current file hash is unchanged; this avoids a self-referential commit hash while retaining current-source confirmation. Separate Knowledge/Target layouts require the exact Target revision. Legacy designs use safe whole-section fallback for inspection, are never semantically promoted, and must be migrated before unattended execution.

## Compatibility

Addressable format is additive to document structure. Existing designs remain readable in legacy mode; rollback retains new addressable documents and v2 packets for audit. Do not resume them through a legacy compiler that discards claim identities or provenance.
