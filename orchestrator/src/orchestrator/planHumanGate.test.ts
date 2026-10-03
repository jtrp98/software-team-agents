import { describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { AgentStage } from "../types.js";
import { classificationInputForPlanTask } from "./planCompilation.js";
import type { PlanTask } from "../docs/planTask.js";

/**
 * plan-task-v1 accepts `breaking-contract`, `business`, `design-ambiguity`
 * and `plan-approval` as human gates and leaves their enforcement to the
 * safety kernel. Each must become a person's approval before Done — never a
 * refusal of the whole plan, and never a gate that silently disappears.
 */
function task(humanGate: PlanTask["humanGate"], risk: PlanTask["risk"] = ["medium"]): PlanTask {
  return { id: "BE-004", owner: AgentStage.BACKEND_ENGINEER, humanGate, risk } as unknown as PlanTask;
}

describe("plan task human gates", () => {
  it.each(["breaking-contract", "business", "design-ambiguity", "plan-approval"] as const)("%s requires a person's approval before Done", (gate) => {
    const classification = classifyTask(classificationInputForPlanTask(task([gate], ["medium", "breaking-contract"])));
    expect(classification.requiresHumanApproval).toBe(true);
    expect(classification.pipeline).toEqual([AgentStage.BACKEND_ENGINEER, AgentStage.REVIEWER, AgentStage.QA_ENGINEER]);
  });

  it("a security-only gate keeps its security pass and does not add an approval", () => {
    const classification = classifyTask(classificationInputForPlanTask(task(["security"], ["critical", "security"])));
    expect(classification.sensitiveGate).toBeTruthy();
    expect(classification.requiresHumanApproval).toBe(false);
  });

  it("no declared gate needs no approval", () => {
    expect(classifyTask(classificationInputForPlanTask(task([]))).requiresHumanApproval).toBe(false);
  });
});
