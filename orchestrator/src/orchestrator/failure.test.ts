import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { routeFailure, validateStructuredFailure, type StructuredFailure } from "./failure.js";

const PIPELINE = [
  AgentStage.SYSTEM_ANALYST,
  AgentStage.BACKEND_ENGINEER,
  AgentStage.FRONTEND_ENGINEER,
  AgentStage.QA_ENGINEER,
];

function failure(overrides: Partial<StructuredFailure> = {}): StructuredFailure {
  return validateStructuredFailure({
    category: "implementation",
    owner: AgentStage.BACKEND_ENGINEER,
    severity: "high",
    retryable: true,
    reason: "API response mismatch",
    affected: ["BE-004"],
    requiresHuman: false,
    ...overrides,
  });
}

describe("validateStructuredFailure", () => {
  it("rejects a category outside the fixed vocabulary", () => {
    expect(() => validateStructuredFailure({ ...failure(), category: "vibes" })).toThrow();
  });

  it("rejects an empty reason — a failure with no stated cause is not a report", () => {
    expect(() => validateStructuredFailure({ ...failure(), reason: "" })).toThrow();
  });
});

describe("routeFailure", () => {
  it("sends an implementation failure back to the engineer that owns it, not to the start of the phase", () => {
    const route = routeFailure(failure({ owner: AgentStage.FRONTEND_ENGINEER }), PIPELINE);
    expect(route).toEqual({ kind: "RETRY_STAGE", stage: AgentStage.FRONTEND_ENGINEER, reason: "API response mismatch" });
  });

  it("escalates whenever the failure says a person must look, however retryable it claims to be", () => {
    const route = routeFailure(failure({ requiresHuman: true }), PIPELINE);
    expect(route.kind).toBe("ESCALATE");
  });

  it("escalates a failure marked not retryable", () => {
    const route = routeFailure(failure({ retryable: false }), PIPELINE);
    expect(route.kind).toBe("ESCALATE");
    expect(route.reason).toContain("not retryable");
  });

  it("escalates when the owner is not in this task's pipeline at all", () => {
    const route = routeFailure(failure({ owner: AgentStage.DEVOPS }), PIPELINE);
    expect(route.kind).toBe("ESCALATE");
    expect(route.reason).toContain("not in this task's pipeline");
  });

  it("recovers a contract failure to system-analyst rather than retrying an engineer that cannot fix it", () => {
    const route = routeFailure(failure({ category: "contract", owner: AgentStage.SYSTEM_ANALYST }), PIPELINE);
    expect(route.kind).toBe("RECOVER");
    if (route.kind === "RECOVER") {
      expect(route.stage).toBe(AgentStage.SYSTEM_ANALYST);
      expect(route.toState).toBe(TaskState.DESIGN);
    }
  });

  it("recovers a requirement failure all the way back to business-analyst", () => {
    const route = routeFailure(
      failure({ category: "requirement", owner: AgentStage.BUSINESS_ANALYST }),
      [AgentStage.BUSINESS_ANALYST, ...PIPELINE],
    );
    expect(route.kind).toBe("RECOVER");
    if (route.kind === "RECOVER") expect(route.toState).toBe(TaskState.REQUIREMENT);
  });
});
