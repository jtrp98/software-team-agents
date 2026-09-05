import { describe, expect, it } from "vitest";
import { GateBlockedError, checkGate, gatedTransition } from "./gatePolicy.js";
import { initTaskMachine, transition } from "../state/taskState.js";
import { AgentStage, TaskState } from "../types.js";
import type { QaReportArtifact, SecurityReportArtifact } from "../artifacts/schemas.js";

const passingQaReport: QaReportArtifact = {
  taskId: "T-1",
  status: "PASS",
  mode: "FULL",
  requirements: { "REQ-001": "PASS" },
  tests: { passed: 10, failed: 0 },
  evidence: ["log"],
  risks: [],
  hasAutomatedTests: true,
  unverifiedBehaviour: [],
};

const passingSecurityReport: SecurityReportArtifact = {
  taskId: "T-1",
  overallStatus: "PASS",
  findings: [],
};

describe("checkGate", () => {
  it("blocks DESIGN -> IMPLEMENTATION without designApproved", () => {
    const result = checkGate(TaskState.DESIGN, TaskState.IMPLEMENTATION, {});
    expect(result.allowed).toBe(false);
  });

  it("allows DESIGN -> IMPLEMENTATION with designApproved", () => {
    const result = checkGate(TaskState.DESIGN, TaskState.IMPLEMENTATION, { designApproved: true });
    expect(result.allowed).toBe(true);
  });

  /** test-planner and project-manager can sit between DESIGN and IMPLEMENTATION,
   *  so the gate must fire leaving DESIGN at all — not only on the literal
   *  DESIGN->IMPLEMENTATION edge, which a pipeline may never actually take. */
  it("blocks DESIGN -> PLAN without designApproved too", () => {
    expect(checkGate(TaskState.DESIGN, TaskState.PLAN, {}).allowed).toBe(false);
    expect(checkGate(TaskState.DESIGN, TaskState.PLAN, { designApproved: true }).allowed).toBe(true);
  });

  it("blocks QA -> next without a passing qa report", () => {
    expect(checkGate(TaskState.QA, TaskState.READY_TO_DEPLOY, {}).allowed).toBe(false);
    expect(
      checkGate(TaskState.QA, TaskState.READY_TO_DEPLOY, {
        qaReport: { ...passingQaReport, status: "FAIL" },
      }).allowed,
    ).toBe(false);
  });

  it("does not gate the QA -> QA_FAILED failure path itself", () => {
    expect(checkGate(TaskState.QA, TaskState.QA_FAILED, {}).allowed).toBe(true);
  });

  it("blocks SECURITY -> next without a passing security report", () => {
    expect(checkGate(TaskState.SECURITY, TaskState.READY_TO_DEPLOY, {}).allowed).toBe(false);
  });

  it("blocks READY_TO_DEPLOY -> APPROVED without humanApproved", () => {
    expect(checkGate(TaskState.READY_TO_DEPLOY, TaskState.APPROVED, {}).allowed).toBe(false);
    expect(
      checkGate(TaskState.READY_TO_DEPLOY, TaskState.APPROVED, { humanApproved: true }).allowed,
    ).toBe(true);
  });

  it("has no condition on edges outside the four gates", () => {
    expect(checkGate(TaskState.CREATED, TaskState.REQUIREMENT, {}).allowed).toBe(true);
    expect(checkGate(TaskState.IMPLEMENTATION, TaskState.QA, {}).allowed).toBe(true);
  });
});

describe("gatedTransition", () => {
  it("throws GateBlockedError, not a generic error, when the gate fails", () => {
    let machine = initTaskMachine(
      [AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER],
      false,
    );
    machine = transition(machine, TaskState.DESIGN);
    expect(() => gatedTransition(machine, TaskState.IMPLEMENTATION, {})).toThrow(GateBlockedError);
  });

  it("proceeds once designApproved is supplied, and cannot be skipped by an agent later without qaReport", () => {
    let machine = initTaskMachine(
      [AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER],
      false,
    );
    machine = transition(machine, TaskState.DESIGN);
    machine = gatedTransition(machine, TaskState.IMPLEMENTATION, { designApproved: true });
    machine = gatedTransition(machine, TaskState.QA, {});
    expect(() => gatedTransition(machine, TaskState.READY_TO_DEPLOY, {})).toThrow(GateBlockedError);
    machine = gatedTransition(machine, TaskState.READY_TO_DEPLOY, { qaReport: passingQaReport });
    expect(machine.current).toBe(TaskState.READY_TO_DEPLOY);
  });

  it("still throws the structural error (not GateBlockedError) for an illegal edge", () => {
    const machine = initTaskMachine([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    expect(() => gatedTransition(machine, TaskState.QA, {})).toThrow(/invalid transition/);
  });

  it("full LARGE_CRITICAL path requires design, qa, security, and human approval in order", () => {
    let machine = initTaskMachine(
      [AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER, AgentStage.SECURITY],
      true,
    );
    machine = transition(machine, TaskState.DESIGN);
    machine = gatedTransition(machine, TaskState.IMPLEMENTATION, { designApproved: true });
    machine = gatedTransition(machine, TaskState.QA, {});
    machine = gatedTransition(machine, TaskState.SECURITY, { qaReport: passingQaReport });
    expect(() => gatedTransition(machine, TaskState.READY_TO_DEPLOY, {})).toThrow(GateBlockedError);
    machine = gatedTransition(machine, TaskState.READY_TO_DEPLOY, {
      securityReport: passingSecurityReport,
    });
    expect(() => gatedTransition(machine, TaskState.APPROVED, {})).toThrow(GateBlockedError);
    machine = gatedTransition(machine, TaskState.APPROVED, { humanApproved: true });
    machine = gatedTransition(machine, TaskState.DEPLOYED, {});
    expect(machine.current).toBe(TaskState.DEPLOYED);
  });
});
