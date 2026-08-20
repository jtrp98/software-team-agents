import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage, TaskState } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { TaskNotFoundError } from "../store/taskStore.js";
import { DependencyNotMetError, TaskRegistry, UnknownDependencyError } from "./taskRegistry.js";

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
