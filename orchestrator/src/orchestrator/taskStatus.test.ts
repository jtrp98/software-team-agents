import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask, type PersistedTask } from "../store/taskStore.js";
import { describeStatus, isAgentAssignedAt, phaseOf, stageStateOf, unmetDependencies } from "./taskStatus.js";

function task(overrides: Partial<PersistedTask> = {}): PersistedTask {
  const classification = classifyTask({ isIncrementalFeature: true, touchesBackend: true });
  return {
    ...newPersistedTask({
      taskId: "T-1",
      classification,
      machine: initTaskMachine(classification.pipeline, classification.requiresHumanApproval),
      now: 1_000,
    }),
    ...overrides,
  };
}

describe("stageStateOf", () => {
  it("maps devops to READY_TO_DEPLOY, which the plain stage map cannot express", () => {
    expect(stageStateOf(AgentStage.DEVOPS)).toBe(TaskState.READY_TO_DEPLOY);
    expect(stageStateOf(AgentStage.QA_ENGINEER)).toBe(TaskState.QA);
    expect(stageStateOf(undefined)).toBeUndefined();
  });
});

describe("isAgentAssignedAt (T44 — devops runs at two states, everyone else at one)", () => {
  it("devops is assigned at READY_TO_DEPLOY only when it hasn't prepared yet", () => {
    expect(isAgentAssignedAt(AgentStage.DEVOPS, TaskState.READY_TO_DEPLOY, false)).toBe(true);
    expect(isAgentAssignedAt(AgentStage.DEVOPS, TaskState.READY_TO_DEPLOY, true)).toBe(false);
  });

  it("devops is assigned at APPROVED regardless of deployPrepared", () => {
    expect(isAgentAssignedAt(AgentStage.DEVOPS, TaskState.APPROVED, true)).toBe(true);
    expect(isAgentAssignedAt(AgentStage.DEVOPS, TaskState.APPROVED, false)).toBe(true);
  });

  it("devops is never assigned at any other state", () => {
    expect(isAgentAssignedAt(AgentStage.DEVOPS, TaskState.QA, false)).toBe(false);
    expect(isAgentAssignedAt(AgentStage.DEVOPS, TaskState.DEPLOYED, false)).toBe(false);
  });

  it("every other stage ignores deployPrepared and just falls back to stageStateOf", () => {
    expect(isAgentAssignedAt(AgentStage.QA_ENGINEER, TaskState.QA, true)).toBe(true);
    expect(isAgentAssignedAt(AgentStage.QA_ENGINEER, TaskState.QA, false)).toBe(true);
    expect(isAgentAssignedAt(AgentStage.QA_ENGINEER, TaskState.READY_TO_DEPLOY, false)).toBe(false);
  });
});

describe("describeStatus", () => {
  it("never advances the task it describes — reading state must not change it", () => {
    const t = task();
    const before = structuredClone(t);
    describeStatus(t);
    expect(t).toEqual(before);
  });

  it("reports the gate a task is stopped at, and which state it would move to", () => {
    const base = task();
    const stopped = { ...base, machine: { ...base.machine, current: TaskState.DESIGN }, pipelineCursor: 1 };

    const status = describeStatus(stopped);
    expect(status.kind).toBe("WAITING_FOR_HUMAN");
    // PLAN (test-planner), not IMPLEMENTATION directly — but the gate still fires leaving
    // DESIGN either way (T20's fix to checkGate/approvalTypeForEdge).
    expect(status.nextState).toBe(TaskState.PLAN);
    expect(status.reason).toContain("DESIGN_APPROVED");
  });

  it("stops reporting that gate once the approval is recorded", () => {
    const base = task();
    const approved = {
      ...base,
      machine: { ...base.machine, current: TaskState.DESIGN },
      pipelineCursor: 1,
      gateContext: { designApproved: true },
    };
    expect(describeStatus(approved).kind).toBe("RUNNING");
  });

  it("prefers a dependency wait over anything else — a task that may not start has no agent", () => {
    const dependent = task({ taskId: "T-2", dependsOn: ["T-1"] });
    const status = describeStatus(dependent, [task(), dependent]);
    expect(status.kind).toBe("WAITING_FOR_DEPENDENCY");
    expect(status.currentAgent).toBeUndefined();
  });

  it("T44: a deploy-only task at READY_TO_DEPLOY is RUNNING/devops before prepare, and WAITING_FOR_HUMAN once deployPrepared is true — from the stored row alone, the same as the live orchestrator", () => {
    const deployClassification = classifyTask({ isProductionDeployOrMigration: true });
    const base = newPersistedTask({
      taskId: "T-DEPLOY",
      classification: deployClassification,
      machine: initTaskMachine(deployClassification.pipeline, deployClassification.requiresHumanApproval),
      now: 1_000,
    });
    // Both rows are already at READY_TO_DEPLOY — describeStatus never transitions a task itself,
    // so the fixture has to already be where it would be after the CREATED -> READY_TO_DEPLOY
    // ungated walk, the same way other describeStatus tests above override `machine.current`.
    const atReadyToDeploy = {
      ...base,
      machine: { ...base.machine, current: TaskState.READY_TO_DEPLOY, history: [...base.machine.history, TaskState.READY_TO_DEPLOY] },
    };

    const beforePrepare = describeStatus(atReadyToDeploy);
    expect(beforePrepare.kind).toBe("RUNNING");
    expect(beforePrepare.currentAgent).toBe(AgentStage.DEVOPS);

    const preparedTask = { ...atReadyToDeploy, deployPrepared: true };
    const afterPrepare = describeStatus(preparedTask);
    expect(afterPrepare.kind).toBe("WAITING_FOR_HUMAN");
    expect(afterPrepare.nextState).toBe(TaskState.APPROVED);
  });
});

describe("unmetDependencies", () => {
  it("counts a dependency that does not exist as unmet, never as satisfied", () => {
    expect(unmetDependencies(task({ dependsOn: ["ghost"] }), [])).toEqual(["ghost"]);
  });

  it("clears once the dependency reaches DEPLOYED", () => {
    const done = task({ taskId: "T-1" });
    const deployed = { ...done, machine: { ...done.machine, current: TaskState.DEPLOYED } };
    const dependent = task({ taskId: "T-2", dependsOn: ["T-1"] });
    expect(unmetDependencies(dependent, [deployed, dependent])).toEqual([]);
  });
});

describe("phaseOf", () => {
  it("resolves IMPLEMENTATION by the engineer holding it", () => {
    expect(phaseOf(TaskState.IMPLEMENTATION, AgentStage.BACKEND_ENGINEER)).toBe("backend");
    expect(phaseOf(TaskState.IMPLEMENTATION, AgentStage.FRONTEND_ENGINEER)).toBe("frontend");
    expect(phaseOf(TaskState.IMPLEMENTATION)).toBe("implementation");
  });

  it("does not let an unrelated agent rename the phase", () => {
    expect(phaseOf(TaskState.IMPLEMENTATION, AgentStage.QA_ENGINEER)).toBe("implementation");
  });

  it("gives every state a phase — a new state cannot slip through unlabelled", () => {
    for (const state of Object.values(TaskState)) {
      expect(typeof phaseOf(state)).toBe("string");
    }
  });

  it("collapses the failure states onto the round that produced them", () => {
    expect(phaseOf(TaskState.QA_FAILED)).toBe("qa");
    expect(phaseOf(TaskState.SECURITY_FAILED)).toBe("security");
  });
});

describe("describeStatus — next state", () => {
  it("says what state follows even while an agent is still running", () => {
    const base = task();
    // cursor 2: pipeline is [system-analyst, test-planner, backend-engineer, qa-engineer] (T20
    // inserted test-planner at index 1), and IMPLEMENTATION is backend-engineer's state.
    const running = { ...base, machine: { ...base.machine, current: TaskState.IMPLEMENTATION }, pipelineCursor: 2 };
    const status = describeStatus(running);

    expect(status.kind).toBe("RUNNING");
    expect(status.currentAgent).toBe(AgentStage.BACKEND_ENGINEER);
    expect(status.nextState).toBe(TaskState.QA);
  });

  it("has no next state to report once the task is finished", () => {
    const base = task();
    const done = { ...base, machine: { ...base.machine, current: TaskState.DEPLOYED } };
    expect(describeStatus(done).nextState).toBeUndefined();
  });
});
