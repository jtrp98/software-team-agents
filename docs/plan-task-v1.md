# Canonical PlanTask v1

`plan.md` is the sole authored task authority. `PlanTaskSchema` in
`orchestrator/src/docs/planTask.ts` defines its internal normalized object and
inferred `PlanTask` type. JSON snapshots are test output, never authoring inputs.
The [canonical example](../orchestrator/src/docs/fixtures/canonical-plan.md) is
the small versioned template. PM workflow/prompt adoption follows T-V8-008;
this round establishes the deterministic contract and checker only.

## Grammar

Use exactly one `PlanTask format: 1`, `## Phase N` (positive integer), then
`### Task BE-004 — title` and the example's metadata lines and `####` headings.
IDs accept a role prefix and nonempty alphanumeric suffix (also dot, dash and
underscore). Labels are case-sensitive. Fields/headings occur once; unknown,
duplicate or empty fields fail. Tier is the only optional metadata line and
accepts T2–T6; runtime routing/role Tier policy is outside this parser.
Owner is one of the eleven agent role names. Status is pending, in_progress,
verified or blocked. Lists use comma-separated values or exactly `none` for
an empty list. Traceability must contain REQ, AC and DES IDs; duplicate references
fail. Contract IDs use `Contract:Name.vN`, with positive version N.

Risk accepts low, medium, high, critical, shared-contract, authorization, schema,
security, data-loss, breaking-contract or business. Human gate accepts business,
schema, breaking-contract, security, plan-approval, deployment or migration;
`none` means no declared gate, never approval. Gate enforcement remains with the
existing safety kernel. Scope/constraints, retrieval hints, do-not-modify,
acceptance, required validation/evidence and compatibility are each one
nonempty Markdown body. Retrieval paths are hints, not verified source truth.
Code fences are allowed inside these bodies; headings inside a fence are text.
The parser rejects a whole malformed plan, never exposes a partial task set.

`parseCanonicalPlan(text, {requirementMd, designMd})` checks trace and contract
references against the supplied authoritative documents, plus dependency IDs,
duplicates and declared cycles. The CLI `--check-plan` supplies those documents
and fails on missing references. Parsing without documents is syntax/local
reference validation only. A consumed external contract requires design.md.
Full contract/phase graph construction and runtime propagation belong to T-V8-003;
the new parser does not claim scheduler or readiness parity.

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
reader. It refuses v1 instead of flattening rich contracts. Legacy runtime
consumers have not migrated in Round 01; v1 is a parser/checker contract, not a
claim of executable runtime support. T-V8-003/004 integrate its consumers and
T-V8-029 removes the adapter only after parity. Existing old table behavior and
public reader signatures remain available; no authored module document is
automatically rewritten. Rollback is removing the additive v1 parser/checker
branch before consumers adopt it; do not feed v1 into a pre-v1 runtime.
