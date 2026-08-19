import { describe, expect, it } from "vitest";
import {
  canTransition,
  computeSequence,
  forceBlock,
  forwardState,
  initTaskMachine,
  nextStates,
  transition,
} from "./taskState.js";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";

describe("computeSequence", () => {
  it("TRIVIAL: engineer only, no QA/BA/SA/PM states", () => {
    const seq = computeSequence([AgentStage.FRONTEND_ENGINEER], false);
    expect(seq).toEqual([TaskState.CREATED, TaskState.IMPLEMENTATION, TaskState.READY_TO_DEPLOY, TaskState.DEPLOYED]);
  });

  it("SMALL: engineer -> qa, no BA/SA/PM states", () => {
    const seq = computeSequence([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    expect(seq).toEqual([
      TaskState.CREATED,
      TaskState.IMPLEMENTATION,
      TaskState.QA,
      TaskState.READY_TO_DEPLOY,
      TaskState.DEPLOYED,
    ]);
  });

  it("collapses backend+frontend into a single IMPLEMENTATION state", () => {
    const seq = computeSequence(
      [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER, AgentStage.QA_ENGINEER],
      false,
    );
    expect(seq).toEqual([
      TaskState.CREATED,
      TaskState.IMPLEMENTATION,
      TaskState.QA,
      TaskState.READY_TO_DEPLOY,
      TaskState.DEPLOYED,
    ]);
  });

  it("LARGE_CRITICAL schema change: full path through DESIGN, QA, SECURITY, human approval", () => {
    const seq = computeSequence(
      [AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER, AgentStage.SECURITY],
      true,
    );
    expect(seq).toEqual([
      TaskState.CREATED,
      TaskState.DESIGN,
      TaskState.IMPLEMENTATION,
      TaskState.QA,
      TaskState.SECURITY,
      TaskState.READY_TO_DEPLOY,
      TaskState.APPROVED,
      TaskState.DEPLOYED,
    ]);
  });

  it("deploy-only task starts straight at READY_TO_DEPLOY", () => {
    const seq = computeSequence([AgentStage.DEVOPS], true);
    expect(seq).toEqual([
      TaskState.CREATED,
      TaskState.READY_TO_DEPLOY,
      TaskState.APPROVED,
      TaskState.DEPLOYED,
    ]);
  });

  it("UNKNOWN classification (HUMAN pipeline) has no path past BLOCKED", () => {
    const seq = computeSequence([AgentStage.HUMAN], true);
    expect(seq).toEqual([TaskState.CREATED, TaskState.BLOCKED]);
  });
});

describe("transition / nextStates", () => {
  it("walks a SMALL task's full happy path", () => {
    let machine = initTaskMachine([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    expect(machine.current).toBe(TaskState.CREATED);

    machine = transition(machine, TaskState.IMPLEMENTATION);
    machine = transition(machine, TaskState.QA);
    machine = transition(machine, TaskState.READY_TO_DEPLOY);
    machine = transition(machine, TaskState.DEPLOYED);
    expect(machine.current).toBe(TaskState.DEPLOYED);
    expect(machine.history).toEqual([
      TaskState.CREATED,
      TaskState.IMPLEMENTATION,
      TaskState.QA,
      TaskState.READY_TO_DEPLOY,
      TaskState.DEPLOYED,
    ]);
  });

  it("rejects skipping a state ahead of sequence", () => {
    const machine = initTaskMachine([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    expect(canTransition(machine, TaskState.QA)).toBe(false);
    expect(() => transition(machine, TaskState.QA)).toThrow(/invalid transition/);
  });

  it("QA can fail and loop back to IMPLEMENTATION", () => {
    let machine = initTaskMachine([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    machine = transition(machine, TaskState.IMPLEMENTATION);
    machine = transition(machine, TaskState.QA);
    expect(nextStates(machine)).toEqual(
      expect.arrayContaining([TaskState.READY_TO_DEPLOY, TaskState.QA_FAILED]),
    );
    machine = transition(machine, TaskState.QA_FAILED);
    expect(nextStates(machine)).toEqual([TaskState.IMPLEMENTATION, TaskState.BLOCKED]);
    machine = transition(machine, TaskState.IMPLEMENTATION);
    // must re-enter QA, not skip straight to READY_TO_DEPLOY
    expect(canTransition(machine, TaskState.READY_TO_DEPLOY)).toBe(false);
    machine = transition(machine, TaskState.QA);
    machine = transition(machine, TaskState.READY_TO_DEPLOY);
    expect(machine.current).toBe(TaskState.READY_TO_DEPLOY);
  });

  it("SECURITY can fail and loop back to IMPLEMENTATION", () => {
    let machine = initTaskMachine(
      [AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER, AgentStage.SECURITY],
      true,
    );
    machine = transition(machine, TaskState.DESIGN);
    machine = transition(machine, TaskState.IMPLEMENTATION);
    machine = transition(machine, TaskState.QA);
    machine = transition(machine, TaskState.SECURITY);
    machine = transition(machine, TaskState.SECURITY_FAILED);
    expect(machine.current).toBe(TaskState.SECURITY_FAILED);
    expect(nextStates(machine)).toEqual([TaskState.IMPLEMENTATION, TaskState.BLOCKED]);
  });

  it("a pipeline with no IMPLEMENTATION stage escalates a QA failure straight to BLOCKED", () => {
    // constructed directly since classifyTask never emits QA without an engineer stage —
    // the state machine must still be defensively correct on its own.
    let machine = initTaskMachine([AgentStage.QA_ENGINEER], false);
    machine = transition(machine, TaskState.QA);
    expect(nextStates(machine)).toContain(TaskState.QA_FAILED);
    machine = transition(machine, TaskState.QA_FAILED);
    expect(nextStates(machine)).toEqual([TaskState.BLOCKED]);
  });

  it("BLOCKED and DEPLOYED are terminal", () => {
    let blocked = initTaskMachine([AgentStage.HUMAN], true);
    blocked = transition(blocked, TaskState.BLOCKED);
    expect(nextStates(blocked)).toEqual([]);

    let deployed = initTaskMachine([AgentStage.FRONTEND_ENGINEER], false);
    deployed = transition(deployed, TaskState.IMPLEMENTATION);
    deployed = transition(deployed, TaskState.READY_TO_DEPLOY);
    deployed = transition(deployed, TaskState.DEPLOYED);
    expect(nextStates(deployed)).toEqual([]);
  });

  it("integrates with classifyTask end to end for a LARGE_CRITICAL schema change", () => {
    const classification = classifyTask({ touchesSchema: true, touchesBackend: true });
    const machine = initTaskMachine(classification.pipeline, classification.requiresHumanApproval);
    expect(machine.sequence).toContain(TaskState.SECURITY);
    expect(machine.sequence).toContain(TaskState.APPROVED);
  });
});

describe("forwardState", () => {
  it("picks the single next state on a normal edge", () => {
    const machine = initTaskMachine([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    expect(forwardState(machine)).toBe(TaskState.IMPLEMENTATION);
  });

  it("filters out QA_FAILED, keeping the real forward option", () => {
    let machine = initTaskMachine([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    machine = transition(machine, TaskState.IMPLEMENTATION);
    machine = transition(machine, TaskState.QA);
    expect(forwardState(machine)).toBe(TaskState.READY_TO_DEPLOY);
  });

  it("returns BLOCKED for the unclassifiable HUMAN pipeline (no other forward option)", () => {
    const machine = initTaskMachine([AgentStage.HUMAN], true);
    expect(forwardState(machine)).toBe(TaskState.BLOCKED);
  });

  it("returns null once terminal", () => {
    let machine = initTaskMachine([AgentStage.FRONTEND_ENGINEER], false);
    machine = transition(machine, TaskState.IMPLEMENTATION);
    machine = transition(machine, TaskState.READY_TO_DEPLOY);
    machine = transition(machine, TaskState.DEPLOYED);
    expect(forwardState(machine)).toBeNull();
  });
});

describe("forceBlock", () => {
  it("forces BLOCKED from an arbitrary mid-pipeline state, bypassing the structural graph", () => {
    let machine = initTaskMachine([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER], false);
    machine = transition(machine, TaskState.IMPLEMENTATION);
    expect(canTransition(machine, TaskState.BLOCKED)).toBe(false); // not structurally valid...
    machine = forceBlock(machine); // ...but forceBlock does it anyway
    expect(machine.current).toBe(TaskState.BLOCKED);
    expect(machine.history.at(-1)).toBe(TaskState.BLOCKED);
  });
});
