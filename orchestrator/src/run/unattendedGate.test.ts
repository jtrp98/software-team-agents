import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApprovalType } from "../gates/approval.js";
import { AgentStage, TaskLevel } from "../types.js";
import {
  evaluateUnattendedGate,
  renderUnattendedGate,
  type UnattendedGateInput,
} from "./unattendedGate.js";

function input(overrides: Partial<UnattendedGateInput> = {}): UnattendedGateInput {
  return {
    taskId: "BE-1",
    owner: AgentStage.BACKEND_ENGINEER,
    classification: {
      level: TaskLevel.SMALL,
      pipeline: [AgentStage.BACKEND_ENGINEER],
      requiresHumanApproval: false,
      sensitiveGate: false,
    },
    businessInput: null,
    approvals: [],
    ...overrides,
  };
}

describe("T-V8-029 — the unattended human/approval gate", () => {
  it("passes a task with no gate, no pending approval and a non-interactive owner", () => {
    expect(evaluateUnattendedGate(input())).toEqual([]);
  });

  it.each(["touchesSchema", "isProductionDeployOrMigration", "touchesSensitiveArea", "requiresHumanApproval", "sensitiveGate"] as const)(
    "gates on classification signal %s",
    (flag) => {
      const failures = evaluateUnattendedGate(input({
        classification: { ...input().classification!, [flag]: true },
      }));
      expect(failures.map((failure) => failure.kind)).toContain("classification-gate");
      expect(renderUnattendedGate("BE-1", failures)).toContain(flag);
    },
  );

  it("gates on LARGE_CRITICAL", () => {
    const failures = evaluateUnattendedGate(input({
      classification: { ...input().classification!, level: TaskLevel.LARGE_CRITICAL },
    }));
    expect(renderUnattendedGate("BE-1", failures)).toContain(`level=${TaskLevel.LARGE_CRITICAL}`);
  });

  it.each(Object.values(ApprovalType))("gates on every unanswered required approval type: %s", (type) => {
    const failures = evaluateUnattendedGate(input({ approvals: [{ type, required: true, status: "pending" }] }));
    expect(failures.map((failure) => failure.kind)).toContain("approval");
  });

  it("gates on an approval type this build does not recognize, rather than ignoring it", () => {
    const failures = evaluateUnattendedGate(input({
      approvals: [{ type: "FUTURE_APPROVAL" as ApprovalType, required: false, status: "approved" }],
    }));
    expect(failures.map((failure) => failure.kind)).toContain("approval");
  });

  it("lets an answered, approved approval through", () => {
    expect(evaluateUnattendedGate(input({
      approvals: [{ type: ApprovalType.SCHEMA_CONFIRMATION, required: true, status: "approved" }],
    }))).toEqual([]);
  });

  it("gates an owner stage that needs interactive prompts, and clears it with confirmed intake", () => {
    const interactive = evaluateUnattendedGate(input({ owner: AgentStage.BUSINESS_ANALYST }));
    expect(interactive.map((failure) => failure.kind)).toContain("interactive");

    const confirmed = evaluateUnattendedGate(input({
      owner: AgentStage.BUSINESS_ANALYST,
      businessInput: {
        version: 1,
        mode: "confirmed",
        source: { type: "user-confirmed", locator: "intake://unattended-gate-test" },
        owner: "Product owner",
        scope: ["Refund eligibility"],
        requirement_ids: ["REQ-302"],
        acceptance_criteria_ids: ["AC-302.1"],
        decisions: [],
        assumptions: [],
      },
    }));
    expect(confirmed).toEqual([]);
  });

  it("honours an explicit human pause or cancel, which the ledger status alone does not carry", () => {
    expect(evaluateUnattendedGate(input({ paused: true })).map((f) => f.kind)).toEqual(["human-override"]);
    const cancelled = evaluateUnattendedGate(input({ cancelled: true, cancelReason: "superseded by BE-9" }));
    expect(renderUnattendedGate("BE-1", cancelled)).toContain("superseded by BE-9");
  });

  it("fails closed when classification or the approval ledger cannot be read", () => {
    const failures = evaluateUnattendedGate(input({ classification: null, approvals: null }));
    expect(failures.map((failure) => failure.kind).sort()).toEqual(["approval", "classification-gate"]);
  });

  /**
   * The retired evaluator hardcoded which roles could run; this one does not
   * decide roles at all — `git/guardedRun.ts` refuses a non-writer attempt.
   */
  it("hardcodes no role literal", () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "unattendedGate.ts"), "utf8");
    for (const role of [
      "backend-engineer", "frontend-engineer", "qa-engineer", "security", "devops",
      "system-analyst", "project-manager", "test-planner", "uxui-designer", "business-analyst", "setup",
    ]) {
      expect(source).not.toContain(`"${role}"`);
    }
  });
});
