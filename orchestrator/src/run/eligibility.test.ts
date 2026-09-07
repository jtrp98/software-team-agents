import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PlanTaskRow } from "../docs/planGraph.js";
import { ApprovalType } from "../gates/approval.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import { AgentStage } from "../types.js";
import {
  evaluateAutoEligibility,
  renderAutoEligibility,
  tasksInDerivedWave,
  type LiveEligibilityContext,
  type StaticEligibilityIntent,
} from "./eligibility.js";

function row(overrides: Partial<PlanTaskRow> = {}): PlanTaskRow {
  return {
    id: "BE-1",
    phase: 1,
    designRefs: ["DES-1"],
    dependsOn: [],
    status: "pending",
    owner: AgentStage.BACKEND_ENGINEER,
    wave: null,
    description: "Implement",
    fromCheckbox: false,
    ...overrides,
  };
}

function intent(overrides: Partial<PlanTaskRow> = {}, planTasks?: PlanTaskRow[]): StaticEligibilityIntent {
  const task = row(overrides);
  return { task, planTasks: planTasks ?? [task] };
}

function live(overrides: Partial<LiveEligibilityContext> = {}): LiveEligibilityContext {
  return {
    classification: { pipeline: [AgentStage.BACKEND_ENGINEER] },
    checkpointedTaskIds: new Set(),
    approvals: [],
    runtimeId: "claude-code",
    runtimeCapabilities: new Set([RuntimeCapability.PRE_TOOL_GUARD]),
    writableTargetRoots: [path.resolve("target")],
    executableVerificationChecks: ["typecheck"],
    repositoryState: "clean-ordinary",
    ...overrides,
  };
}

function expectClause(decision: ReturnType<typeof evaluateAutoEligibility>, clause: string): void {
  expect(decision.eligible).toBe(false);
  expect(decision.action).toBe("HALT");
  expect(decision.failures.some((failure) => failure.clause === clause)).toBe(true);
  expect(renderAutoEligibility(decision).join("\n")).toContain(`Clause ${clause}:`);
}

describe("auto-eligibility A-J", () => {
  it("accepts only a fully known, safe task", () => {
    expect(evaluateAutoEligibility(intent(), live())).toEqual({ eligible: true, action: "RUN", failures: [] });
  });

  it.each([
    AgentStage.QA_ENGINEER,
    AgentStage.SECURITY,
    AgentStage.DEVOPS,
    AgentStage.SYSTEM_ANALYST,
    AgentStage.PROJECT_MANAGER,
    AgentStage.TEST_PLANNER,
    AgentStage.UXUI_DESIGNER,
    AgentStage.BUSINESS_ANALYST,
    AgentStage.SETUP,
  ])("clause A halts excluded owner %s", (owner) => {
    expectClause(evaluateAutoEligibility(intent({ owner }), live()), "A");
  });

  it("clause B requires pending", () => {
    expectClause(evaluateAutoEligibility(intent({ status: "in_progress" }), live()), "B");
  });

  it("clause C accepts verified or same-run checkpointed dependencies and halts otherwise", () => {
    const dependency = row({ id: "BE-0", status: "pending" });
    const current = row({ dependsOn: [dependency.id] });
    expectClause(evaluateAutoEligibility(intent(current, [dependency, current]), live()), "C");
    expect(evaluateAutoEligibility(intent(current, [{ ...dependency, status: "verified" }, current]), live()).eligible).toBe(true);
    expect(evaluateAutoEligibility(intent(current, [dependency, current]), live({ checkpointedTaskIds: new Set([dependency.id]) })).eligible).toBe(true);
  });

  it.each(["touchesSchema", "isProductionDeployOrMigration", "touchesSensitiveArea"] as const)(
    "clause D reads existing classification boolean %s",
    (flag) => expectClause(evaluateAutoEligibility(intent(), live({ classification: { pipeline: [AgentStage.BACKEND_ENGINEER], [flag]: true } })), "D"),
  );

  it.each(Object.values(ApprovalType))("clause E halts every unanswered ApprovalType: %s", (type) => {
    expectClause(evaluateAutoEligibility(intent(), live({ approvals: [{ type, required: true, status: "pending" }] })), "E");
  });

  it("clause F derives interactive requirements from the existing capability policy", () => {
    expectClause(evaluateAutoEligibility(intent(), live({ classification: { pipeline: [AgentStage.BUSINESS_ANALYST] } })), "F");
  });

  it.each([
    ["codex", "preview"],
    ["opencode", "experimental"],
    ["antigravity", "experimental"],
  ])("clause G refuses %s and names support level %s", (runtimeId, level) => {
    const decision = evaluateAutoEligibility(intent(), live({ runtimeId }));
    expectClause(decision, "G");
    expect(renderAutoEligibility(decision).join("\n")).toContain(`support level "${level}"`);
  });

  it("clause G fails closed for an unresolved runtime or guard capability", () => {
    expectClause(evaluateAutoEligibility(intent(), live({ runtimeId: null })), "G");
    expectClause(evaluateAutoEligibility(intent(), live({ runtimeCapabilities: null })), "G");
    expectClause(evaluateAutoEligibility(intent(), live({ runtimeCapabilities: new Set() })), "G");
  });

  it("clause H accepts one legacy root, refuses two roots, and fails closed when unresolved", () => {
    expect(evaluateAutoEligibility(intent(), live({ writableTargetRoots: [path.resolve("legacy")] })).eligible).toBe(true);
    expectClause(evaluateAutoEligibility(intent(), live({ writableTargetRoots: [path.resolve("one"), path.resolve("two")] })), "H");
    expectClause(evaluateAutoEligibility(intent(), live({ writableTargetRoots: null })), "H");
  });

  it("clause I refuses a deterministic gate that can only be unverified", () => {
    expectClause(evaluateAutoEligibility(intent(), live({ executableVerificationChecks: [] })), "I");
    expectClause(evaluateAutoEligibility(intent(), live({ executableVerificationChecks: null })), "I");
  });

  it("clause J requires a known clean ordinary repository", () => {
    expectClause(evaluateAutoEligibility(intent(), live({ repositoryState: "not-clean-ordinary" })), "J");
    expectClause(evaluateAutoEligibility(intent(), live({ repositoryState: null })), "J");
  });

  it("classification unknown fails closed rather than becoming eligible by omission", () => {
    const decision = evaluateAutoEligibility(intent(), live({ classification: null }));
    expectClause(decision, "D");
    expectClause(decision, "F");
  });

  it("derives waves from dependencies and ignores an authored Wave cell", () => {
    const first = row({ id: "BE-1", wave: 99 });
    const second = row({ id: "BE-2", dependsOn: [first.id], wave: 1 });
    expect(tasksInDerivedWave([first, second], 1).map((task) => task.id)).toEqual(["BE-1"]);
    expect(tasksInDerivedWave([first, second], 2).map((task) => task.id)).toEqual(["BE-2"]);
  });

  it("keeps all non-engineer role literals confined to clause A's test surface", () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "eligibility.ts"), "utf8");
    for (const role of ["qa-engineer", "security", "devops", "system-analyst", "project-manager", "test-planner", "uxui-designer", "business-analyst", "setup"]) {
      expect(source).not.toContain(`"${role}"`);
    }
  });
});
