import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { compileAndRegisterPlan } from "../orchestrator/planCompilation.js";
import { createRunId } from "./journal.js";
import { RuntimeRegistry } from "../runtime/runtimeRegistry.js";
import { MockRuntimeAdapter, okResult } from "../runtime/mockAdapter.js";
import { contractGuardResolver } from "../runtime/runtimeGuards.js";
import { BoundedRunController } from "./boundedRunController.js";
import { createProductionBoundedRunServices } from "./boundedRunServices.js";

/**
 * T-V8-021 — the production `BoundedRunServices` against a real registered
 * task, a real Git repository and a real (mocked-adapter) runtime executor:
 * no `BoundedRunServices` fake stands in for `prepareTask`/`executeAttempt`
 * here the way `boundedRunController.test.ts` deliberately uses one to keep
 * T-V8-020's own tests focused on the controller.
 */

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Fixture {
  /** The Framework/Knowledge root: docs, contracts and runtime state (`.workflow/`, the ledger DB). Never Git-guarded. */
  root: string;
  /** A real, separate Git repository — the only thing `GuardedRunSession` may touch, exactly as three-repo mode requires. */
  targetRoot: string;
}

/** Framework root (docs/contracts/state) kept separate from a real, clean Git target — the same split `boundedRunController.test.ts` uses, required because `GuardedRunSession` refuses a dirty tree and the ledger/docs are not its business. */
function project(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-bounded-services-"));
  roots.push(root);
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "v8-bounded-services-target-"));
  roots.push(targetRoot);
  git(targetRoot, "init", "-b", "main");
  git(targetRoot, "config", "user.name", "Fixture");
  git(targetRoot, "config", "user.email", "fixture@example.invalid");
  fs.mkdirSync(path.join(targetRoot, "src"), { recursive: true });
  const orderSource = "export function orderSummary(): number { return 0; }\n";
  fs.writeFileSync(path.join(targetRoot, "src", "orders.ts"), orderSource);
  // A trivially passing `test` script so the deterministic gate has at least
  // one real, executed check — with none, `runDeterministicVerification`
  // reports `status: "skipped"` (CLAUDE.md's "no test suite" rule), and the
  // controller correctly refuses to checkpoint an unverified attempt.
  fs.writeFileSync(path.join(targetRoot, "package.json"), JSON.stringify({ name: "fixture-target", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2));
  git(targetRoot, "add", "--", "src/orders.ts", "package.json");
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

  // `buildRuntimeTask` resolves each stage's real `contracts/<role>.yaml`
  // (via `pathRulesFor`) at registration time, independent of the `guards`
  // seam the services layer itself uses — copy the two roles this fixture
  // exercises from the Framework's own templates rather than inventing a
  // parallel, drifting contract shape.
  const templateContracts = path.join(fileURLToPath(new URL("../../../templates/contracts", import.meta.url)));
  const contracts = path.join(root, "contracts");
  fs.mkdirSync(contracts, { recursive: true });
  for (const role of ["backend-engineer", "qa-engineer"]) {
    fs.copyFileSync(path.join(templateContracts, `${role}.yaml`), path.join(contracts, `${role}.yaml`));
  }
  return { root, targetRoot };
}

function register(fixture: Fixture) {
  const { root, targetRoot } = fixture;
  const store = new SqliteTaskStore(path.join(root, "state.db"));
  const ledger = new SqliteRunLedger(store, { projectRoot: root });
  const registry = new TaskRegistry({ store, stateViewPath: path.join(root, ".workflow", "state.yaml") });
  closers.push(() => registry.close());
  closers.push(() => ledger.close());
  const runId = createRunId();
  const planMarkdown = fs.readFileSync(path.join(root, "_docs", "module", "orders", "plan.md"), "utf8");
  const requirementMd = fs.readFileSync(path.join(root, "_docs", "module", "orders", "requirement.md"), "utf8");
  const designMd = fs.readFileSync(path.join(root, "_docs", "module", "orders", "design.md"), "utf8");
  const result = compileAndRegisterPlan({
    registry, store, ledger,
    planMarkdown,
    references: { requirementMd: "REQ-007 AC-007.2", designMd: "DES-011 Contract:OrderSummary.v2" },
    scope: { kind: "all" },
    runId, module: "orders", boundary: "done",
    targetId: "target", targetRoot, knowledgeRoot: root,
    baseBranch: "main", baseSha: git(targetRoot, "rev-parse", "HEAD"), runBranch: `sta/run/orders/${runId}`,
    configHash: "a".repeat(64), requirementHash: sha256(requirementMd), designHash: sha256(designMd),
    staVersion: "2.0.0",
    taskContextFor: () => ({
      projectRoot: root,
      docsRoot: root,
      workflow: "bug-fix",
      targetWorkRoots: [
        { stage: AgentStage.BACKEND_ENGINEER, targetId: "target", path: targetRoot },
        { stage: AgentStage.QA_ENGINEER, targetId: "target", path: targetRoot },
      ],
    }),
  });
  return { root, targetRoot, store, ledger, registry, run: result.run, tasks: result.tasks };
}

describe("T-V8-021 — production BoundedRunServices against a real registered task", () => {
  it("prepares, executes and checkpoints a real backend task through the bounded controller", async () => {
    const fixture = project();
    const { root, targetRoot, ledger, store, run } = register(fixture);
    let adapterRef: MockRuntimeAdapter;
    const adapter = new MockRuntimeAdapter({
      id: "claude-code",
      models: ["sonnet"],
      // The mock adapter's own workspace is in-memory; the real change the
      // checkpoint commits has to land on the real Target repo, exactly as a
      // real coding agent would leave one there. This fixture supplies no
      // `.agent-team/config.yaml`, so `pathRulesFor`'s stack-layout merge
      // contributes nothing and the real, contract-derived `guards` this test
      // uses below grant only `contracts/backend-engineer.yaml`'s own role-
      // boundary write list (`README.md`, `_docs/status.md`,
      // `_docs/status-archive.md`) — `README.md` is the one of those that
      // reads naturally as "the task's change". `src/orders.ts` itself stays
      // untouched: it is read-only design evidence, not the write target.
      respond: (req) => {
        if (req.role === "qa-engineer") {
          // `qaArtifactResult` reads the verdict back through the runtime's
          // own workspace, never real disk — the mock's in-memory files map
          // is that workspace.
          adapterRef.workspace.files.set(
            "_docs/module/orders/review.md",
            "# review.md — orders\n\n" +
              "## Round 1 — verify\n\n" +
              "**Status:** ✅ Verified (FULL)\n\n" +
              "## Per-Task Results\n\n" +
              "- BE-004: ✅ Verified — the empty-order response stays stable.\n" +
              "- AC-007.2: ✅ Verified — zero-total response confirmed by inspection.\n" +
              "- DES-011: ✅ Verified — serializer boundary preserved.\n",
          );
          return okResult();
        }
        fs.writeFileSync(path.join(targetRoot, "README.md"), "# orders\n\nReviewed the empty-order summary path.\n");
        return okResult();
      },
      // `detectRuntimeCapabilities`'s deep guard checker for "claude-code"
      // requires the workspace's own `settings.json`-shaped guard config to
      // name the real hook scripts before it verifies PRE_TOOL_GUARD/EXIT_GUARD
      // — a claimed capability alone is not enough for a Target-writing freeze.
      files: {
        ".mock/guards.json": JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ command: "node .claude/hooks/block-path-permissions.js" }] }],
            Stop: [{ hooks: [{ command: "node .claude/hooks/require-green-before-stop.js" }] }],
          },
        }),
      },
    });
    adapterRef = adapter;
    const registry = new RuntimeRegistry([adapter]);

    const services = createProductionBoundedRunServices({
      ledger, store, registry,
      projectRoot: root, targetRoot, runtimeStateRoot: root,
      defaultRuntimeId: "claude-code",
      moduleName: "orders", docsRoot: root,
      guards: contractGuardResolver(root),
      adapterVersion: "test@1",
      // Production's default scanner shells out to the Target's own
      // `.claude/scripts/static-analysis-gate.js`, which this bare fixture
      // does not scaffold; a no-op is the documented test seam
      // (`CheckpointInput.secretScanner`'s own doc comment), not a production default.
      secretScanner: () => ({ ok: true, problems: [] }),
    });

    const controller = new BoundedRunController({ ledger, runId: run.run_id, runtimeStateRoot: root, services });
    const result = await controller.run();

    expect(result.kind).toBe("COMPLETED");
    expect(result.launchedAttempts).toBe(1);
    expect(result.qaRounds).toBe(1);
    // One DEV attempt through the frozen route, then one (unfrozen) coherent
    // QA round against the checkpointed set — both real invocations of the
    // same mock adapter.
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]!.role).toBe("backend-engineer");
    expect(adapter.requests[1]!.role).toBe("qa-engineer");
    expect(ledger.readTasks(run.run_id).map((t) => t.status)).toEqual(["DONE"]);
    expect(ledger.checkpointsForRun(run.run_id)).toHaveLength(1);
    expect(git(targetRoot, "rev-list", "--count", run.run_branch)).toBe("2");

    const attempt = ledger.attemptsForTask(run.run_id, "BE-004")[0]!;
    expect(attempt.observed.runtime).toBe("claude-code");
    expect(attempt.packet_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(attempt.guard_evidence.writable_roots).toEqual([targetRoot]);
  }, 30_000);

  it("gates when no runtime route can be resolved", async () => {
    const fixture = project();
    const { root, targetRoot, ledger, store, run } = register(fixture);
    const registry = new RuntimeRegistry([]); // no adapters registered at all
    const services = createProductionBoundedRunServices({
      ledger, store, registry,
      projectRoot: root, targetRoot, runtimeStateRoot: root,
      defaultRuntimeId: "claude-code",
      moduleName: "orders", docsRoot: root,
      guards: contractGuardResolver(root),
      adapterVersion: "test@1",
    });
    const controller = new BoundedRunController({ ledger, runId: run.run_id, runtimeStateRoot: root, services });
    const result = await controller.run();
    expect(result.kind).toBe("GATE");
    expect(result.reason).toMatch(/no runtime route resolved/);
    expect(ledger.readRun(run.run_id)?.status).toBe("AWAITING_HUMAN");
  });
});
