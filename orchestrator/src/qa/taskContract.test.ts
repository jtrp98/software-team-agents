import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { taskGraphFromPlan } from "../graph/taskGraph.js";
import type { PlanTask } from "../docs/planTask.js";
import type { Finding } from "../artifacts/finding.js";
import {
  buildQaTaskContract,
  qaRiskSignalsFromTask,
  renderQaTaskContract,
  requiredVerdictIds,
} from "./taskContract.js";
import { buildEvidencePackage } from "./evidence.js";
import { buildQaScope } from "./scope.js";
import { selectQaMode } from "./mode.js";

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
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
    risk: ["shared-contract"],
    humanGate: [],
    status: "pending",
    scopeAndConstraints: "Preserve the response contract while handling empty line items.",
    retrievalHints: "Query: Locate Contract:OrderSummary.v2.",
    doNotModify: "Authentication and database schema.",
    acceptanceCriteria: "AC-007.2: An empty order returns the documented zero total without an exception.",
    validationAndEvidence: "Verify AC-007.2 with the empty-order regression.",
    compatibility: "Preserve existing nonempty-order serialization.",
    ...overrides,
  } as PlanTask;
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
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
    design_ids: ["DES-011"],
    files: [{ path: "src/orders/summary.ts", symbol: "serialize" }],
    expected: "zero total for an empty order",
    observed: "throws on empty line items",
    evidence_refs: ["review.md#round-2"],
    retryable: true,
    requires_human: false,
    status: "OPEN",
    ...overrides,
  } as Finding;
}

describe("buildQaTaskContract", () => {
  it("carries the authored acceptance text itself, not a pointer to it", () => {
    const contract = buildQaTaskContract({ task: task() });
    expect(contract.acceptanceText).toBe(
      "AC-007.2: An empty order returns the documented zero total without an exception.",
    );
    expect(contract.validationAndEvidence).toContain("empty-order regression");
    expect(contract.acceptanceIds).toEqual(["AC-007.2"]);
    expect(contract.designIds).toEqual(["DES-011"]);
    expect(contract.requirementIds).toEqual(["REQ-007"]);
  });

  it("reports no packet identity rather than inventing one when none was persisted", () => {
    const contract = buildQaTaskContract({ task: task() });
    expect(contract.packet).toBeUndefined();
    expect(renderQaTaskContract(contract).join("\n")).toContain("no execution packet was persisted");
  });

  it("carries the real attempt/packet identity when a packet is supplied", () => {
    const contract = buildQaTaskContract({
      task: task(),
      packet: {
        stage: AgentStage.BACKEND_ENGINEER,
        attempt: 3,
        packet_hash: "b".repeat(64),
        identity: {
          task_hash: "c".repeat(64),
          plan_hash: "d".repeat(64),
          artifact_hashes: [
            { source: "requirement.md", hash: "e".repeat(64) },
            { source: "design.md", hash: "f".repeat(64) },
          ],
          config_hash: "1".repeat(64),
          compiler_version: "v8-packet-2",
          compiler_hash: "2".repeat(64),
          base_revision: "3".repeat(40),
        },
        dependencies: [
          {
            task_id: "BE-002",
            produces: ["Contract:OrderRead.v1"],
            edges: ["declared"],
            evidence: {
              task_id: "BE-002",
              status: "complete",
              source: "task-store:BE-002",
              hash: "4".repeat(64),
              outputs: [{ source: "task-store:BE-002/artifacts/code", hash: "5".repeat(64) }],
            },
          },
        ],
      },
    });
    expect(contract.packet).toMatchObject({ attempt: 3, packet_hash: "b".repeat(64), task_hash: "c".repeat(64) });
    expect(contract.dependencyOutputs).toEqual([
      {
        taskId: "BE-002",
        produces: ["Contract:OrderRead.v1"],
        edgeKinds: ["declared"],
        evidence: {
          source: "task-store:BE-002",
          hash: "4".repeat(64),
          outputs: [{ source: "task-store:BE-002/artifacts/code", hash: "5".repeat(64) }],
        },
      },
    ]);
  });

  it("derives blast radius from graph descendants and names the contract edge that carried it", () => {
    const graph = taskGraphFromPlan([
      { id: "BE-004", owner: AgentStage.BACKEND_ENGINEER, phase: 1, dependsOn: [], produces: ["Contract:OrderSummary.v2"], consumes: [] },
      { id: "FE-010", owner: AgentStage.FRONTEND_ENGINEER, phase: 1, dependsOn: [], produces: [], consumes: ["Contract:OrderSummary.v2"] },
      { id: "FE-011", owner: AgentStage.FRONTEND_ENGINEER, phase: 2, dependsOn: ["FE-010"], produces: [], consumes: [] },
    ]);
    const contract = buildQaTaskContract({ task: task(), graph });
    expect(contract.blastRadius.descendants).toEqual(["FE-010", "FE-011"]);
    expect(contract.blastRadius.contractEdges).toEqual([
      expect.objectContaining({ from: "BE-004", to: "FE-010" }),
    ]);
    expect(contract.blastRadius.phases).toEqual([1, 2]);
  });

  it("splits open findings from closed history and normalizes the file manifest", () => {
    const contract = buildQaTaskContract({
      task: task(),
      findings: [
        finding(),
        finding({ finding_id: "FIND-fedcba9876543210", status: "ACCEPTED" }),
        finding({ finding_id: "FIND-1111111111111111", task_id: "BE-999" }),
      ],
      changedFiles: ["src\\orders\\summary.ts", "src/orders/summary.ts", "src/orders/routes.ts"],
    });
    expect(contract.openFindings.map((f) => f.finding_id)).toEqual(["FIND-0123456789abcdef"]);
    expect(contract.closedFindings.map((f) => f.finding_id)).toEqual(["FIND-fedcba9876543210"]);
    expect(contract.fileManifest).toEqual(["src/orders/routes.ts", "src/orders/summary.ts"]);
  });

  it("names an empty manifest as a finding rather than a clean round", () => {
    const rendered = renderQaTaskContract(buildQaTaskContract({ task: task() })).join("\n");
    expect(rendered).toContain("an empty manifest is itself a finding, not a clean round");
  });
});

describe("requiredVerdictIds", () => {
  it("requires the task, every AC/DES, and every open finding", () => {
    const contract = buildQaTaskContract({ task: task(), findings: [finding()] });
    expect(requiredVerdictIds(contract)).toEqual(["BE-004", "AC-007.2", "DES-011", "FIND-0123456789abcdef"]);
  });

  it("does not narrow for a TARGETED round — TARGETED narrows files, not acceptance criteria", () => {
    const contract = buildQaTaskContract({ task: task() });
    // No mode parameter exists on purpose; asserted so a future "lighter
    // TARGETED requirement set" cannot be added without this failing.
    expect(requiredVerdictIds(contract)).toEqual(["BE-004", "AC-007.2", "DES-011"]);
  });
});

describe("qaRiskSignalsFromTask", () => {
  it("turns the plan's own declared shared-contract risk into a FULL signal", () => {
    const signals = qaRiskSignalsFromTask({ risk: ["shared-contract"], humanGate: [] });
    expect(signals.changesSharedContract).toBe(true);
    const decision = selectQaMode(
      "BE-004",
      buildQaScope({ taskId: "BE-004", changedFiles: ["src/orders/summary.ts"] }),
      signals,
    );
    expect(decision.mode).toBe("FULL");
    expect(decision.reasons).toContain("shared contract change");
  });

  it.each([
    [{ risk: ["schema"], humanGate: [] }, "touchesSchema"],
    [{ risk: ["security"], humanGate: [] }, "securitySensitive"],
    [{ risk: ["authorization"], humanGate: [] }, "securitySensitive"],
    [{ risk: ["data-loss"], humanGate: [] }, "securitySensitive"],
    [{ risk: ["breaking-contract"], humanGate: [] }, "changesSharedContract"],
    [{ risk: ["low"], humanGate: ["schema"] }, "touchesSchema"],
    [{ risk: ["low"], humanGate: ["security"] }, "securitySensitive"],
    [{ risk: ["low"], humanGate: ["migration"] }, "migrationOrCutover"],
    [{ risk: ["low"], humanGate: ["deployment"] }, "migrationOrCutover"],
  ])("maps %o to %s", (input, signal) => {
    expect(qaRiskSignalsFromTask(input as { risk: string[]; humanGate: string[] })[signal as "touchesSchema"]).toBe(true);
  });

  it("leaves an ordinary low-risk task on TARGETED", () => {
    const signals = qaRiskSignalsFromTask({ risk: ["low"], humanGate: [] });
    expect(Object.values(signals).some(Boolean)).toBe(false);
    expect(
      selectQaMode("BE-004", buildQaScope({ taskId: "BE-004", changedFiles: ["src/a.ts"] }), signals).mode,
    ).toBe("TARGETED");
  });
});

describe("evidence package with a task contract", () => {
  it("renders the acceptance text and the verdict-mapping list without truncating them", () => {
    const contract = buildQaTaskContract({ task: task(), findings: [finding()], changedFiles: ["src/orders/summary.ts"] });
    const scope = buildQaScope({ taskId: "BE-004", changedFiles: ["src/orders/summary.ts"] });
    const pkg = buildEvidencePackage({
      taskId: "BE-004",
      mode: selectQaMode("BE-004", scope, qaRiskSignalsFromTask({ risk: contract.risk, humanGate: contract.humanGate })),
      scope,
      taskContract: contract,
      taskIntent: "unused when a contract is supplied",
      acceptanceCriteria: ["design.md#DES-011"],
      diffSummary: "1 file changed",
      knownRisks: [],
    });
    expect(pkg).toContain("An empty order returns the documented zero total without an exception.");
    expect(pkg).toContain("Verdict mapping this round must produce");
    expect(pkg).toContain("`FIND-0123456789abcdef`");
    // The thin pointer form is what the contract replaces.
    expect(pkg).not.toContain("unused when a contract is supplied");
    expect(pkg).not.toContain("(evidence package truncated");
  });

  it("keeps the pre-T-V8-014 pointer package when no contract is resolvable", () => {
    const scope = buildQaScope({ taskId: "BE-004", changedFiles: ["src/orders/summary.ts"] });
    const pkg = buildEvidencePackage({
      taskId: "BE-004",
      mode: selectQaMode("BE-004", scope),
      scope,
      taskIntent: "Return the existing order summary.",
      acceptanceCriteria: ["design.md#DES-011", "plan.md#BE-004"],
      diffSummary: "1 file changed",
      knownRisks: [],
    });
    expect(pkg).toContain("## Task intent");
    expect(pkg).toContain("design.md#DES-011");
    expect(pkg).not.toContain("Verdict mapping this round must produce");
  });
});
