import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { TaskRegistry } from "./taskRegistry.js";
import { testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "./stageGuards.testSupport.js";
import { isRuntimeUnavailableFailure, type StructuredFailure } from "./failure.js";

/**
 * STA Core resume after runtime exhaustion: only a block whose cause is "no
 * runtime could serve this stage" is lifted; every other block stays a person's.
 */
function blockedTask(failure: StructuredFailure) {
  const store = new MemoryTaskStore();
  const registry = new TaskRegistry({ stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, store, humanDecisionVerifier: testHumanVerifier() });
  registry.create({ taskId: "T-1", classification: classifyTask({ isPlanTask: true, touchesBackend: true }) });
  const task = store.loadTask("T-1")!;
  store.saveTask({
    ...task,
    machine: { ...task.machine, current: TaskState.BLOCKED, history: [...task.machine.history, TaskState.IMPLEMENTATION, TaskState.BLOCKED] },
    blockedReason: failure.reason,
    lastFailure: failure,
  });
  return { store, registry };
}

const unavailable: StructuredFailure = {
  category: "infrastructure", owner: AgentStage.HUMAN, severity: "high", retryable: false,
  reason: 'runtime "codex" is unavailable: provider refused to serve | routing.order is exhausted', affected: [], requiresHuman: true,
};

describe("TaskRegistry.releaseRuntimeUnavailableBlock", () => {
  it("recognizes exactly the runtime-unavailability failure", () => {
    expect(isRuntimeUnavailableFailure(unavailable)).toBe(true);
    expect(isRuntimeUnavailableFailure({ ...unavailable, category: "implementation" })).toBe(false);
    expect(isRuntimeUnavailableFailure({ ...unavailable, reason: "tests failed" })).toBe(false);
    expect(isRuntimeUnavailableFailure(null)).toBe(false);
  });

  it("restores the pre-block state so the same stage runs again, and records who did it", () => {
    const { store, registry } = blockedTask(unavailable);
    const result = registry.releaseRuntimeUnavailableBlock("T-1");
    expect(result.released).toBe(true);
    const task = store.loadTask("T-1")!;
    expect(task.machine.current).toBe(TaskState.IMPLEMENTATION);
    expect(task.blockedReason).toBeNull();
    expect(store.eventsForTask("T-1").some((event) => event.type === "RUNTIME_BLOCK_RELEASED" && event.actor === "sta-core")).toBe(true);
  });

  it("refuses every other block — a gate, a finding or a spent budget stays a person's", () => {
    const { store, registry } = blockedTask({ ...unavailable, category: "implementation", owner: AgentStage.BACKEND_ENGINEER, reason: "repair budget spent" });
    expect(registry.releaseRuntimeUnavailableBlock("T-1")).toMatchObject({ released: false });
    expect(store.loadTask("T-1")!.machine.current).toBe(TaskState.BLOCKED);
  });

  it("does nothing to a task that is not blocked", () => {
    const store = new MemoryTaskStore();
    const registry = new TaskRegistry({ stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, store, humanDecisionVerifier: testHumanVerifier() });
    registry.create({ taskId: "T-2", classification: classifyTask({ isPlanTask: true, touchesBackend: true }) });
    expect(registry.releaseRuntimeUnavailableBlock("T-2")).toMatchObject({ released: false, reason: "task is not BLOCKED" });
  });
});
