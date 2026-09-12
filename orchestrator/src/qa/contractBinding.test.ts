import { describe, expect, it } from "vitest";
import { AgentStage, TaskLevel, TaskState } from "../types.js";
import type { AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
import type { PlanTask } from "../docs/planTask.js";
import type { Finding } from "../artifacts/finding.js";
import { checkGate } from "../gates/gatePolicy.js";
import { selectQaMode } from "./mode.js";
import { buildQaScope } from "./scope.js";
import { buildQaTaskContract, requiredVerdictIds } from "./taskContract.js";
import { withQaOptimization } from "./optimized.js";
import type { DeterministicVerification } from "./deterministic.js";

/**
 * T-V8-014 end-to-end: the contract-bound QA round. These exercise the seam
 * `withQaOptimization` owns — package content, FULL escalation from the plan's
 * own declared risk, and the rejection of a report that cannot be checked —
 * plus the gate's defense-in-depth copy of the same rule.
 */

const PLAN_TASK: PlanTask = {
  version: 1,
  id: "BE-004",
  phase: 1,
  title: "Preserve the order summary",
  objective: "Return the existing order summary for an empty order.",
  why: "Clients need a stable empty-order response.",
  owner: AgentStage.BACKEND_ENGINEER,
  tier: "T4",
  dependsOn: [],
  traceability: ["REQ-007", "AC-007.2", "DES-011"],
  produces: ["Contract:OrderSummary.v2"],
  consumes: [],
  risk: ["low"],
  humanGate: [],
  status: "pending",
  scopeAndConstraints: "Preserve the response contract while handling empty line items.",
  retrievalHints: "Query: Locate Contract:OrderSummary.v2.",
  doNotModify: "Authentication and database schema.",
  acceptanceCriteria: "AC-007.2: An empty order returns the documented zero total without an exception.",
  validationAndEvidence: "Verify AC-007.2 with the empty-order regression.",
  compatibility: "Preserve existing nonempty-order serialization.",
} as PlanTask;

const GRAPH = taskGraphFromPlan([
  { id: "BE-004", owner: AgentStage.BACKEND_ENGINEER, phase: 1, dependsOn: [], produces: ["Contract:OrderSummary.v2"], consumes: [] },
  { id: "FE-010", owner: AgentStage.FRONTEND_ENGINEER, phase: 1, dependsOn: [], produces: [], consumes: ["Contract:OrderSummary.v2"] },
]);

const PASSING_DETERMINISTIC: DeterministicVerification = {
  required: ["typecheck", "unit-tests"],
  ran: [
    { id: "typecheck", ok: true, command: "npm run typecheck", exitCode: 0, output: "" },
    { id: "unit-tests", ok: true, command: "npm test", exitCode: 0, output: "3 passed" },
  ],
  failures: [],
  skipped: [],
  missingRequired: [],
  status: "passed",
  enforcement: "warn",
  passed: true,
} as unknown as DeterministicVerification;

function req(overrides: Partial<AgentExecutorRequest> = {}): AgentExecutorRequest {
  return { stage: AgentStage.QA_ENGINEER, taskId: "BE-004", context: [], ...overrides } as AgentExecutorRequest;
}

function qaReport(overrides: Partial<QaReportArtifact> = {}): QaReportArtifact {
  return {
    taskId: "BE-004",
    status: "PASS",
    mode: "TARGETED",
    requirements: { "BE-004": "PASS", "AC-007.2": "PASS", "DES-011": "PASS" },
    tests: { passed: 3, failed: 0 },
    evidence: ["vitest src/orders — 3 passed"],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
    ...overrides,
  };
}

function reportingExecutor(report: QaReportArtifact, captured: { pkg?: string } = {}) {
  return async (request: AgentExecutorRequest): Promise<AgentExecutorResult> => {
    captured.pkg = request.context.find((item) => item.source === "qa-evidence")?.content;
    return {
      outcome: { tokens: 10, cost: 0, result: report.status },
      artifactType: ArtifactType.QA_REPORT,
      artifact: report,
    };
  };
}

function contractFor(overrides: { task?: PlanTask; findings?: Finding[]; changedFiles?: string[] } = {}) {
  return buildQaTaskContract({
    task: overrides.task ?? PLAN_TASK,
    graph: GRAPH,
    ...(overrides.findings ? { findings: overrides.findings } : {}),
    changedFiles: overrides.changedFiles ?? ["src/orders/summary.ts"],
  });
}

describe("contract-bound QA package", () => {
  it("hands QA the exact acceptance text, blast radius and file manifest — no unrelated task prose", async () => {
    const captured: { pkg?: string } = {};
    const contract = contractFor();
    const execute = withQaOptimization({
      inner: reportingExecutor(qaReport(), captured),
      changedFiles: () => ["src/orders/summary.ts"],
      deterministicVerification: () => PASSING_DETERMINISTIC,
      taskContract: () => contract,
    });
    const result = await execute(req());
    expect(result.outcome.result).toBe("PASS");
    expect(captured.pkg).toContain("An empty order returns the documented zero total without an exception.");
    expect(captured.pkg).toContain("transitive descendants: FE-010");
    expect(captured.pkg).toContain("contract edge BE-004 -> FE-010");
    expect(captured.pkg).toContain("src/orders/summary.ts");
    expect(result.gateEvidence?.qaVerdictRequirements).toEqual(["BE-004", "AC-007.2", "DES-011"]);
  });

  it("lists every open finding for recheck and requires a verdict for each", async () => {
    const captured: { pkg?: string } = {};
    const finding: Finding = {
      finding_id: "FIND-0123456789abcdef",
      run_id: "run-1",
      task_id: "BE-004",
      attempt: 1,
      packet_hash: "a".repeat(64),
      category: "implementation",
      owner: AgentStage.BACKEND_ENGINEER,
      raised_by: AgentStage.QA_ENGINEER,
      severity: "high",
      acceptance_ids: ["AC-007.2"],
      design_ids: [],
      files: [{ path: "src/orders/summary.ts" }],
      expected: "zero total for an empty order",
      observed: "throws on empty line items",
      evidence_refs: ["review.md#round-1"],
      retryable: true,
      requires_human: false,
      status: "OPEN",
    } as Finding;
    const contract = contractFor({ findings: [finding] });
    const execute = withQaOptimization({
      inner: reportingExecutor(
        qaReport({ requirements: { "BE-004": "PASS", "AC-007.2": "PASS", "DES-011": "PASS", "FIND-0123456789abcdef": "PASS" } }),
        captured,
      ),
      changedFiles: () => ["src/orders/summary.ts"],
      deterministicVerification: () => PASSING_DETERMINISTIC,
      taskContract: () => contract,
    });
    const result = await execute(req());
    expect(captured.pkg).toContain("FIND-0123456789abcdef [OPEN]");
    expect(captured.pkg).toContain("throws on empty line items");
    expect(result.gateEvidence?.qaVerdictRequirements).toContain("FIND-0123456789abcdef");
    expect(result.outcome.result).toBe("PASS");
  });
});

describe("FULL escalation from the plan's declared risk", () => {
  it.each([
    ["schema", "schema/architecture change"],
    ["shared-contract", "shared contract change"],
    ["security", "security-sensitive change"],
  ])("a %s task cannot close on TARGETED", async (risk, reason) => {
    const contract = contractFor({ task: { ...PLAN_TASK, risk: [risk] } as PlanTask });
    const execute = withQaOptimization({
      inner: reportingExecutor(qaReport({ mode: "TARGETED" })),
      changedFiles: () => ["src/orders/summary.ts"],
      deterministicVerification: () => PASSING_DETERMINISTIC,
      taskContract: () => contract,
    });
    const result = await execute(req());
    expect(result.gateEvidence?.qaModeDecision?.mode).toBe("FULL");
    expect(result.gateEvidence?.qaModeDecision?.reasons).toContain(reason);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("re-run qa-engineer in FULL mode");
  });

  it("a FULL report discharges the same FULL decision", async () => {
    const contract = contractFor({ task: { ...PLAN_TASK, risk: ["schema"] } as PlanTask });
    const execute = withQaOptimization({
      inner: reportingExecutor(qaReport({ mode: "FULL" })),
      changedFiles: () => ["src/orders/summary.ts"],
      deterministicVerification: () => PASSING_DETERMINISTIC,
      taskContract: () => contract,
    });
    expect((await execute(req())).outcome.result).toBe("PASS");
  });
});

describe("rejection of an uncheckable verdict", () => {
  it("converts a PASS that maps no id into a FAIL owned by qa-engineer, with no passing artifact", async () => {
    const execute = withQaOptimization({
      inner: async () => ({
        outcome: { tokens: 5, cost: 0, result: "PASS" as const },
        artifactType: ArtifactType.QA_REPORT,
        // Constructed directly: the artifact schema itself refuses this shape,
        // so this is the "an executor handed us something unusable" path.
        artifact: { ...qaReport(), requirements: {} },
      }),
      changedFiles: () => ["src/orders/summary.ts"],
      deterministicVerification: () => PASSING_DETERMINISTIC,
      taskContract: () => contractFor(),
    });
    const result = await execute(req());
    expect(result.outcome.result).toBe("FAIL");
    expect(result.artifact).toBeUndefined();
    expect(result.outcome.failure_reason).toContain("bare PASS rejected");
    expect(result.failure).toMatchObject({ owner: AgentStage.QA_ENGINEER, category: "test", retryable: true });
  });

  it("rejects a PASS that leaves one acceptance criterion unmapped, naming it", async () => {
    const execute = withQaOptimization({
      inner: reportingExecutor(qaReport({ requirements: { "BE-004": "PASS", "DES-011": "PASS" } })),
      changedFiles: () => ["src/orders/summary.ts"],
      deterministicVerification: () => PASSING_DETERMINISTIC,
      taskContract: () => contractFor(),
    });
    const result = await execute(req());
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("AC-007.2");
  });

  it("leaves a genuine FAIL exactly as the QA agent reported it", async () => {
    const failing = qaReport({
      status: "FAIL",
      requirements: { "AC-007.2": "FAIL" },
      tests: { passed: 2, failed: 1 },
    });
    const execute = withQaOptimization({
      inner: reportingExecutor(failing),
      changedFiles: () => ["src/orders/summary.ts"],
      deterministicVerification: () => PASSING_DETERMINISTIC,
      taskContract: () => contractFor(),
    });
    const result = await execute(req());
    expect(result.outcome.result).toBe("FAIL");
    expect(result.artifact).toBe(failing);
  });

  it("changes nothing for a round with no resolvable contract", async () => {
    const report = qaReport({ requirements: {} });
    const execute = withQaOptimization({
      inner: reportingExecutor(report),
      changedFiles: () => ["src/orders/summary.ts"],
      deterministicVerification: () => PASSING_DETERMINISTIC,
    });
    const result = await execute(req());
    expect(result.outcome.result).toBe("PASS");
    expect(result.gateEvidence?.qaVerdictRequirements).toBeUndefined();
  });
});

describe("no-suite behaviour stays explicit Unverified Behaviour", () => {
  it("accepts a PASS whose uncovered criterion is declared read-but-not-executed", async () => {
    const execute = withQaOptimization({
      inner: reportingExecutor(
        qaReport({
          requirements: { "BE-004": "PASS", "DES-011": "PASS" },
          hasAutomatedTests: false,
          tests: { passed: 0, failed: 0 },
          unverifiedBehaviour: ["AC-007.2 — inspected, not executed: no suite covers the empty-order path"],
        }),
      ),
      changedFiles: () => ["src/orders/summary.ts"],
      deterministicVerification: () => PASSING_DETERMINISTIC,
      taskContract: () => contractFor(),
    });
    expect((await execute(req())).outcome.result).toBe("PASS");
  });

  it("the low-risk deterministic skip claims only the task, listing every AC/DES as unverified", async () => {
    const execute = withQaOptimization({
      inner: async () => {
        throw new Error("the skip path must not call the QA model");
      },
      changedFiles: () => ["src/orders/summary.ts"],
      deterministicVerification: () => PASSING_DETERMINISTIC,
      taskLevel: () => TaskLevel.TRIVIAL,
      allowQaSkip: true,
      taskContract: () => contractFor(),
    });
    const result = await execute(req());
    expect(result.outcome.result).toBe("PASS");
    const report = result.artifact as QaReportArtifact;
    expect(report.requirements).toEqual({ "BE-004": "PASS" });
    expect(report.unverifiedBehaviour.join(" ")).toContain("AC-007.2");
    expect(report.unverifiedBehaviour.join(" ")).toContain("DES-011");
  });
});

describe("the gate's defense-in-depth copy", () => {
  const decision = selectQaMode("BE-004", buildQaScope({ taskId: "BE-004", changedFiles: ["src/orders/summary.ts"] }));
  const required = requiredVerdictIds(contractFor());

  it("blocks QA -> READY_TO_DEPLOY on an under-covered PASS even without the wrapper", () => {
    const result = checkGate(TaskState.QA, TaskState.READY_TO_DEPLOY, {
      qaReport: qaReport({ requirements: { "BE-004": "PASS" } }),
      qaModeDecision: decision,
      qaVerdictRequirements: required,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("QA_VERDICT_COVERAGE required");
  });

  it("allows it once every required id carries a verdict", () => {
    expect(
      checkGate(TaskState.QA, TaskState.READY_TO_DEPLOY, {
        qaReport: qaReport(),
        qaModeDecision: decision,
        qaVerdictRequirements: required,
      }).allowed,
    ).toBe(true);
  });

  it("stays backward-compatible for a row with no recorded requirement set", () => {
    expect(
      checkGate(TaskState.QA, TaskState.READY_TO_DEPLOY, {
        qaReport: qaReport({ requirements: { "BE-004": "PASS" } }),
        qaModeDecision: decision,
      }).allowed,
    ).toBe(true);
  });
});
