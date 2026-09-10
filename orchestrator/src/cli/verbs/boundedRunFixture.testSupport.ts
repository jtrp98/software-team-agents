/**
 * Disposable single-repo bounded-run fixture shared by the CLI surface tests
 * (T-V8-021) and the CLI recovery/E2E tests (T-V8-022).
 *
 * Extracted verbatim from boundedRun.test.ts so both suites exercise one
 * canonical plan/design/requirement and one Target repository shape; two
 * copies would let a recovery test pass against a fixture the real CLI test
 * no longer uses.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface BoundedRunFixture { root: string; targetRoot: string }

/**
 * The calling suite supplies its own Git runner.
 *
 * Deliberate: this module is not a `.test.ts` file, so `checkGitOwnership`
 * treats it as production source and refuses a Git invocation here — the same
 * invariant that keeps Git mutation inside `orchestrator/src/git/`. Taking the
 * runner as a parameter keeps that guard intact instead of adding an exception
 * to it.
 */
export type FixtureGit = (root: string, ...args: string[]) => string;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `roots` collects every created directory so the calling suite can remove them. */
export function boundedRunProject(roots: string[], git: FixtureGit): BoundedRunFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-boundedrun-cli-"));
  roots.push(root);
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v8-boundedrun-cli-target-"));
  roots.push(targetRoot);
  git(targetRoot, "init", "-b", "main");
  git(targetRoot, "config", "user.name", "Fixture");
  git(targetRoot, "config", "user.email", "fixture@example.invalid");
  fs.mkdirSync(path.join(targetRoot, "src"), { recursive: true });
  const orderSource = "export function orderSummary(): number { return 0; }\n";
  fs.writeFileSync(path.join(targetRoot, "src", "orders.ts"), orderSource);
  fs.writeFileSync(path.join(targetRoot, "package.json"), JSON.stringify({ name: "fixture-target", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2));
  // The production secret scanner (`git/checkpoint.ts`'s `scanChangedFilesForSecrets`,
  // used whenever `BoundedRunServiceOptions.secretScanner` is not overridden)
  // shells out to this exact script in the *Target* root with
  // `--scan-files-for-secrets`, reading the candidate paths from stdin as
  // JSON and expecting `{ok, problems}` JSON back — a minimal real
  // implementation, not a stub swapped in through a test seam.
  fs.mkdirSync(path.join(targetRoot, ".claude", "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(targetRoot, ".claude", "scripts", "static-analysis-gate.js"),
    "let input = '';\n" +
      "process.stdin.on('data', (chunk) => { input += chunk; });\n" +
      "process.stdin.on('end', () => {\n" +
      "  process.stdout.write(JSON.stringify({ ok: true, problems: [] }));\n" +
      "  process.exit(0);\n" +
      "});\n",
  );
  git(targetRoot, "add", "--", "src/orders.ts", "package.json", ".claude/scripts/static-analysis-gate.js");
  git(targetRoot, "commit", "-m", "initial", "--");
  const headSha = git(targetRoot, "rev-parse", "HEAD");

  const requirement = "# Requirement\n\n- REQ-007: Order summary responses stay stable when no line item exists.\n- AC-007.2: Zero-total responses for orders with no line items must stay serializable.\n";
  const design = `# Design

Design evidence format: 1

## Feasibility Summary

Independently implementable.

## Feature-by-Feature Feasibility

One declaration below defines the selected behavior.

## Data Model

No schema changes.

## DES-011 — Order summary response
Contract:OrderSummary.v2 — the empty-order response shape.
DEC-011 — keep summary construction behind one serializer boundary.
Evidence EVD-011: claim=DES-011 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=${headSha} | basis=source | tool=rg-read | hash=${sha256(orderSource)}
Evidence EVD-012: claim=Contract:OrderSummary.v2 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=${headSha} | basis=source | tool=rg-read | hash=${sha256(orderSource)}
Evidence EVD-013: claim=DEC-011 | state=confirmed | path=src/orders.ts | symbol=orderSummary | line=1 | revision=${headSha} | basis=source | tool=rg-read | hash=${sha256(orderSource)}
Compatibility: unchanged
Data/schema: unchanged
Migration/backfill: none
Security: none
Fallback: retain the current empty-order handler.
Material ambiguity: none

## Modules

Orders service.

## Risks & Dependencies

The per-section decision records are authoritative.

## Unresolved Open Questions

—

## Change Log

- Undated fixture; no human sign-off is implied.
`;
  const plan = `# Plan

PlanTask format: 1

## Plan Summary
Deliver one independently verifiable contract-preserving task.

## Phase 1: Orders

### Task BE-004 — Preserve the order summary

Objective: Return the existing order summary for an empty order.
Why: Clients need a stable empty-order response.
Owner: backend-engineer
Tier: T4
Depends on: none
Traceability: REQ-007, AC-007.2, DES-011
Produces: Contract:OrderSummary.v2
Consumes: none
Risk: shared-contract
Human gate: none
Status: pending

#### Scope and constraints

Preserve the response contract while handling empty line items.

#### Retrieval hints

Hypothesis: The OrderSummary serializer and empty-order regression are likely boundaries; confirm symbols and paths against current source.
Query: Locate definitions and references for Contract:OrderSummary.v2 and the empty-order behavior.
Provenance: DES-011, Contract:OrderSummary.v2

#### Do not modify

Authentication, database schema and unrelated response fields.

#### Acceptance criteria

AC-007.2: An empty order returns the documented zero total without an exception.

#### Required validation and expected evidence

Verify AC-007.2 with the empty-order regression and existing serializer tests. Record commands, exit codes and response assertions.

#### Rollback/compatibility notes

Preserve existing nonempty-order serialization. The patch can be removed independently.

## Sequencing Notes
No preceding implementation is required.

## Unresolved Open Questions
None.

## Change Log
Undated canonical fixture; no human sign-off is implied.
`;

  const docs = path.join(root, "_docs", "module", "orders");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "plan.md"), plan);
  fs.writeFileSync(path.join(docs, "requirement.md"), requirement);
  fs.writeFileSync(path.join(docs, "design.md"), design);

  const templateContracts = path.join(fileURLToPath(new URL("../../../../templates/contracts", import.meta.url)));
  const contracts = path.join(root, "contracts");
  fs.mkdirSync(contracts, { recursive: true });
  for (const role of ["backend-engineer", "qa-engineer"]) {
    fs.copyFileSync(path.join(templateContracts, `${role}.yaml`), path.join(contracts, `${role}.yaml`));
  }
  return { root, targetRoot };
}
