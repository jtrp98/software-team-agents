# Project-manager rationale

The role owns the work graph and phased task decomposition as a validated dependency DAG. It authors complete canonical `PlanTask` sections, not thin task summaries. Feature, bug, schema, and refactor examples live in the [semantic fixture](../../orchestrator/src/docs/fixtures/semantic-plan-cases.md).

Each task is independently verifiable: it selects only its own requirement/AC and DES/DEC/Contract evidence, declares produced and consumed contracts, preserves design-triggered gates, and states compatibility plus rollback. Retrieval text is deliberately executable but epistemically bounded: `Hypothesis` names likely concepts/symbols/routes/migrations or module boundaries, `Query` tells the context resolver how to locate them, and `Provenance` contains exact design claim IDs. A file path is a hypothesis until current source confirms it; graph/LSP edges stay inferred.

Every semantic field has a downstream consumer, which is why none is decorative:

| Fields | Primary consumers |
|---|---|
| Version, ID, owner | compiler, runtime, migration |
| Phase, dependencies, produces, consumes | DAG, readiness, run ledger, dependency handoff |
| Title, objective, why | DEV and QA task comprehension |
| Traceability | context selection, compiler, DEV, QA |
| Risk, human gates | gate policy, run controller, QA |
| Tier | central route resolver |
| Status | readiness and QA synchronization |
| Scope/constraints, do-not-modify | packet compiler, DEV, QA |
| Retrieval hints | context resolver, DEV, QA |
| Acceptance, validation/evidence | compiler, deterministic verifier, DEV, QA |
| Compatibility/rollback | DEV, QA, rollback |

Task sizing follows verification and risk boundaries, not arbitrary row counts. Split when owner, dependency, contract, gate, migration/deployment boundary, or independent proof differs. Acceptance criteria remain distinct per task and the validation body must cite every selected AC ID. Tier is an optional per-task recommendation; runtime routing remains centralized.
