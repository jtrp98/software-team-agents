import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { TaskNotFoundError } from "../store/taskStore.js";
import { DependencyNotMetError, TaskRegistry, UnknownDependencyError } from "./taskRegistry.js";
import { ApprovalType } from "../gates/approval.js";

const trivial = () => classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
const incremental = () => classifyTask({ isIncrementalFeature: true, touchesBackend: true });

const pass = { outcome: { tokens: 10, cost: 0.001, result: "PASS" as const } };

function registry(stateViewPath?: string) {
  return new TaskRegistry({ store: new MemoryTaskStore(), stateViewPath });
}

describe("TaskRegistry", () => {
  it("creates a task and can list it with its status", () => {
    const reg = registry();
    reg.create({ taskId: "T-1", classification: trivial() });

    const listing = reg.list();
    expect(listing).toHaveLength(1);
    expect(listing[0].task.taskId).toBe("T-1");
    expect(listing[0].status.state).toBe(TaskState.CREATED);
  });

  it("rejects a dependency on a task that does not exist, instead of blocking forever on a typo", () => {
    const reg = registry();
    expect(() => reg.create({ taskId: "T-2", classification: trivial(), dependsOn: ["T-nope"] })).toThrow(
      UnknownDependencyError,
    );
  });

  it("refuses to open a task whose dependency has not shipped", () => {
    const reg = registry();
    reg.create({ taskId: "T-1", classification: incremental() });
    reg.create({ taskId: "T-2", classification: trivial(), dependsOn: ["T-1"] });

    expect(() => reg.open("T-2")).toThrow(DependencyNotMetError);
    expect(reg.waitingOn("T-2")).toEqual(["T-1"]);
  });

  it("opens it once the dependency reaches DEPLOYED", async () => {
    const reg = registry();
    const first = reg.create({ taskId: "T-1", classification: trivial() });
    reg.create({ taskId: "T-2", classification: trivial(), dependsOn: ["T-1"] });

    await first.step(() => pass);
    expect(first.machine.current).toBe(TaskState.DEPLOYED);

    const second = reg.open("T-2");
    expect(second.status()).toEqual({ kind: "RUNNING", stage: AgentStage.FRONTEND_ENGINEER });
  });

  it("leaves a waiting task out of readyTasks, and includes it once it is unblocked", async () => {
    const reg = registry();
    const first = reg.create({ taskId: "T-1", classification: trivial() });
    reg.create({ taskId: "T-2", classification: trivial(), dependsOn: ["T-1"] });

    expect(reg.readyTasks().map((t) => t.taskId)).toEqual(["T-1"]);

    await first.step(() => pass);
    expect(reg.readyTasks().map((t) => t.taskId)).toEqual(["T-2"]);
  });

  it("a BLOCKED dependency keeps the dependent task out of readyTasks and open — failed upstream is never satisfied", async () => {
    const reg = registry();
    // A task reaches its schema-confirmation human gate; rejecting the gate parks it
    // in BLOCKED (the same settled state a spent retry budget produces).
    const first = reg.create({ taskId: "T-1", classification: incremental() });
    reg.create({ taskId: "T-2", classification: trivial(), dependsOn: ["T-1"] });

    await first.step(() => pass); // system-analyst finishes; leaving DESIGN is gated
    expect(first.status().kind).toBe("WAITING_FOR_HUMAN");
    first.decideApproval(ApprovalType.SCHEMA_CONFIRMATION, false, { by: "test" });
    expect(first.status().kind).toBe("BLOCKED");

    expect(reg.readyTasks().map((t) => t.taskId)).toEqual([]);
    expect(() => reg.open("T-2")).toThrow(DependencyNotMetError);
  });

  it("still resumes a dependency-blocked task for inspection — looking is not running", () => {
    const reg = registry();
    reg.create({ taskId: "T-1", classification: incremental() });
    reg.create({ taskId: "T-2", classification: trivial(), dependsOn: ["T-1"] });

    expect(reg.resume("T-2").taskId).toBe("T-2");
  });

  it("throws for a task id it has never seen", () => {
    const reg = registry();
    expect(() => reg.open("ghost")).toThrow(TaskNotFoundError);
    expect(() => reg.waitingOn("ghost")).toThrow(TaskNotFoundError);
  });

  it("reports a dependency-blocked task as WAITING_FOR_DEPENDENCY, not as ready to run", () => {
    const reg = registry();
    reg.create({ taskId: "T-1", classification: incremental() });
    reg.create({ taskId: "T-2", classification: trivial(), dependsOn: ["T-1"] });

    const second = reg.list().find((l) => l.task.taskId === "T-2")!;
    expect(second.status.kind).toBe("WAITING_FOR_DEPENDENCY");
    expect(second.status.waitingOn).toEqual(["T-1"]);
  });

  it("writes the readable state view when it was given a path for it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-view-"));
    try {
      const file = path.join(dir, ".workflow", "state.yaml");
      const reg = registry(file);
      reg.create({ taskId: "T-1", classification: trivial() });

      expect(fs.readFileSync(file, "utf8")).toContain("task_id: T-1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("TaskRegistry as a dependency graph (T10/T11 wiring)", () => {
  /** A store plus the registry over it, so a case can reach past the registry when it needs to. */
  function fixture() {
    const store = new MemoryTaskStore();
    return { store, registry: new TaskRegistry({ store }) };
  }

  it("groups independent tasks into one batch", () => {
    const { registry } = fixture();
    registry.create({ taskId: "A", classification: incremental() });
    registry.create({ taskId: "B", classification: incremental() });

    const layers = registry.readyLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0].map((t) => t.taskId).sort()).toEqual(["A", "B"]);
  });

  it("puts a dependent task in the batch after the one it waits for", () => {
    const { registry } = fixture();
    registry.create({ taskId: "A", classification: incremental() });
    registry.create({ taskId: "B", classification: incremental(), dependsOn: ["A"] });

    const layers = registry.readyLayers();
    expect(layers.map((l) => l.map((t) => t.taskId))).toEqual([["A"], ["B"]]);
  });

  it("reports how much of the store could run at once", () => {
    const { registry } = fixture();
    registry.create({ taskId: "A", classification: incremental() });
    registry.create({ taskId: "B", classification: incremental() });
    registry.create({ taskId: "C", classification: incremental(), dependsOn: ["A", "B"] });

    expect(registry.parallelism()).toMatchObject({ tasks: 3, layers: 2, widest: 2 });
  });

  it("collapses to one task per layer when everything is a chain", () => {
    const { registry } = fixture();
    registry.create({ taskId: "A", classification: incremental() });
    registry.create({ taskId: "B", classification: incremental(), dependsOn: ["A"] });
    registry.create({ taskId: "C", classification: incremental(), dependsOn: ["B"] });

    expect(registry.parallelism()).toMatchObject({ layers: 3, widest: 1, sequentialSpeedup: 1 });
  });

  it("builds a graph over an empty store without complaining", () => {
    const { registry } = fixture();
    expect(registry.readyLayers()).toEqual([]);
    expect(registry.parallelism().tasks).toBe(0);
  });

  /**
   * The creation rule already makes a cycle impossible, so this is not the normal
   * defence — it is what catches a store that was hand-edited or restored from a
   * backup written by something with looser rules.
   */
  it("survives a dependency on a task the store no longer holds", () => {
    const { store, registry } = fixture();
    registry.create({ taskId: "A", classification: incremental() });
    const orphan = { ...store.loadTask("A")!, taskId: "B", dependsOn: ["GONE"] };
    store.createTask(orphan);

    expect(() => registry.readyLayers()).not.toThrow();
  });
});

describe("TaskRegistry pause/cancel (T31)", () => {
  it("pause sets the flag, and the listing reports PAUSED", () => {
    const reg = registry();
    reg.create({ taskId: "T-1", classification: trivial() });
    reg.pause("T-1");
    expect(reg.list()[0].status.kind).toBe("PAUSED");
  });

  it("unpause clears the flag, and the listing goes back to a normal status", () => {
    const reg = registry();
    reg.create({ taskId: "T-1", classification: trivial() });
    reg.pause("T-1");
    reg.unpause("T-1");
    expect(reg.list()[0].status.kind).not.toBe("PAUSED");
  });

  it("unpause on a task that was never paused is a no-op, not an error", () => {
    const reg = registry();
    reg.create({ taskId: "T-1", classification: trivial() });
    expect(() => reg.unpause("T-1")).not.toThrow();
  });

  it("cancel sets the flag and records the reason, and the listing reports CANCELLED", () => {
    const reg = registry();
    reg.create({ taskId: "T-1", classification: trivial() });
    reg.cancel("T-1", "duplicate of T-9, abandoned by the requester");
    const listing = reg.list()[0];
    expect(listing.status.kind).toBe("CANCELLED");
    expect(listing.status.reason).toBe("duplicate of T-9, abandoned by the requester");
  });

  it("cancel outranks pause when both are set — cancel is the more final of the two", () => {
    const reg = registry();
    reg.create({ taskId: "T-1", classification: trivial() });
    reg.pause("T-1");
    reg.cancel("T-1", "abandoned");
    expect(reg.list()[0].status.kind).toBe("CANCELLED");
  });

  it("pause/cancel/unpause on an unknown task throws TaskNotFoundError, same as every other lookup here", () => {
    const reg = registry();
    expect(() => reg.pause("nope")).toThrow(TaskNotFoundError);
    expect(() => reg.cancel("nope", "x")).toThrow(TaskNotFoundError);
    expect(() => reg.unpause("nope")).toThrow(TaskNotFoundError);
  });
});
