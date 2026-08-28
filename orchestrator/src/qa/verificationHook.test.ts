import { describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { Orchestrator, type AgentExecutorRequest } from "../orchestrator/orchestrator.js";
import { AgentStage } from "../types.js";
import { createPostDevVerificationHook, withPostDevVerificationDisabled } from "./verificationHook.js";

function required(
  levels: string[],
  enforcement: "warn" | "enforce" = "warn",
): { status: "selected"; levels: string[]; reason: string; enforcement: "warn" | "enforce" } {
  return { status: "selected", levels, reason: "fixture", enforcement };
}

function req(stage: AgentStage): AgentExecutorRequest {
  return { stage, taskId: "T-HOOK", context: [] };
}

describe("post-Dev deterministic verification hook", () => {
  it("runs only RuntimeTask-selected checks after a code-producing stage", async () => {
    const calls: string[] = [];
    const hook = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 5, cost: 0.1, result: "PASS" } }),
      deterministicRunner: () => (id) => {
        calls.push(id);
        return { id, status: "PASS", durationMs: 1, outputSummary: "ok" };
      },
      requiredVerification: () => required(["lint", "typecheck", "unit", "build"]),
    });

    const result = await hook.executor(req(AgentStage.BACKEND_ENGINEER));
    expect(calls).toEqual(["lint", "typecheck", "unit-tests", "build"]);
    expect(result.outcome).toMatchObject({ result: "PASS", deterministic_gate: "enabled" });
  });

  it("returns a red check to the same Dev stage without a QA/model call", async () => {
    const orchestrator = new Orchestrator(
      "T-TYPO-VERIFY",
      classifyTask({ isTypoOrCopyOnly: true, touchesBackend: true }),
    );
    let modelCalls = 0;
    let qaCalls = 0;
    const hook = createPostDevVerificationHook({
      inner: async (request) => {
        modelCalls += 1;
        if (request.stage === AgentStage.QA_ENGINEER) qaCalls += 1;
        return { outcome: { tokens: 8, cost: 0.2, result: "PASS" } };
      },
      deterministicRunner: () => (id) => id === "typecheck"
        ? { id, status: "FAIL", durationMs: 2, outputSummary: "TS2322" }
        : { id, status: "PASS", durationMs: 1, outputSummary: "ok" },
      requiredVerification: () => ({
        status: "full-order",
        levels: ["lint", "typecheck", "unit", "integration", "build"],
        reason: "unknown type keeps full order",
        enforcement: "warn",
      }),
    });

    const status = await orchestrator.step(hook.executor);
    expect(status).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
    expect(modelCalls).toBe(1);
    expect(qaCalls).toBe(0);
    expect(orchestrator.runLog.runsForTask("T-TYPO-VERIFY")[0]).toMatchObject({
      agent: AgentStage.BACKEND_ENGINEER,
      result: "FAIL",
      deterministic_gate: "enabled",
    });
  });

  it("records all-skipped as distinct from PASS while warn-only preserves the exit result", async () => {
    const hook = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } }),
      deterministicRunner: () => () => null,
      requiredVerification: () => required(["lint", "typecheck"]),
    });
    const result = await hook.executor(req(AgentStage.FRONTEND_ENGINEER));
    expect(result.outcome.result).toBe("PASS");
    expect(hook.verificationFor(req(AgentStage.FRONTEND_ENGINEER))).toMatchObject({
      status: "skipped",
      passed: true,
      enforcement: "warn",
    });
  });

  it("makes a skipped required check blocking only under explicit enforcement", async () => {
    const hook = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } }),
      deterministicRunner: () => () => null,
      requiredVerification: () => required(["lint"], "enforce"),
    });
    const result = await hook.executor(req(AgentStage.FRONTEND_ENGINEER));
    expect(result.outcome.result).toBe("FAIL");
    expect(result.postDevVerificationFailed).toBe(true);
  });

  it("never runs deterministic checks around a non-code stage", async () => {
    let checks = 0;
    const hook = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } }),
      deterministicRunner: () => () => {
        checks += 1;
        return null;
      },
      requiredVerification: () => required(["lint"]),
    });
    await hook.executor(req(AgentStage.QA_ENGINEER));
    expect(checks).toBe(0);
  });

  it("the compatibility path makes no check call and records the gate as disabled", async () => {
    let modelCalls = 0;
    const executor = withPostDevVerificationDisabled(async () => {
      modelCalls += 1;
      return { outcome: { tokens: 2, cost: 0, result: "PASS" } };
    });
    const result = await executor(req(AgentStage.BACKEND_ENGINEER));
    expect(modelCalls).toBe(1);
    expect(result.outcome).toEqual({ tokens: 2, cost: 0, result: "PASS", deterministic_gate: "disabled" });
  });
});
