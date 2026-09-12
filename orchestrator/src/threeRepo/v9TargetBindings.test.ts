import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { parseArgs } from "../cli.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask, PersistedTaskSchema } from "../store/taskStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { AgentStage } from "../types.js";
import Database from "../store/sqliteDatabase.js";
import { preflightThreeRepoTask } from "./preflight.js";
import {
  assertBindingsImmutable,
  uniqueBoundTargetIds,
  validateNewTaskBindings,
  type TargetBindings,
} from "./taskBindings.js";
import type { TargetRegistry } from "./targets.js";

const registry: TargetRegistry = {
  schema_version: 1,
  targets: ["api", "worker", "web"].map((target_id) => ({
    target_id,
    name: target_id,
    remote_url: `https://github.com/acme/${target_id}.git`,
    status: "active" as const,
  })),
};

function initRepository(directory: string, remote?: string): void {
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
  if (remote) fs.writeFileSync(path.join(directory, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
}

describe("T-V9-006 variable-arity Target bindings", () => {
  it("accepts three Targets while comparing engineer roles biconditionally", () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
    const bindings = {
      targets: [
        { target_id: "api", role: AgentStage.BACKEND_ENGINEER },
        { target_id: "worker", role: AgentStage.BACKEND_ENGINEER },
        { target_id: "web", role: AgentStage.FRONTEND_ENGINEER },
      ],
    } satisfies TargetBindings;

    expect(() => validateNewTaskBindings(classification, bindings, registry)).not.toThrow();
    expect(uniqueBoundTargetIds(bindings)).toEqual(["api", "worker", "web"]);
    expect(() =>
      validateNewTaskBindings(classification, { targets: bindings.targets.slice(0, 2) }, registry),
    ).toThrow(/engineer roles/);
  });

  it("loads a persisted legacy pair into the list form without a SQL migration", () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
    const current = newPersistedTask({
      taskId: "legacy-bindings",
      classification,
      machine: initTaskMachine(classification.pipeline, false),
      now: 1,
    });
    const legacyState = {
      ...current,
      targetBindings: { frontend_target: "web", backend_target: "api" },
    };
    const parsed = PersistedTaskSchema.parse(legacyState);

    expect(parsed.targetBindings).toEqual({
      targets: [
        { target_id: "api", role: AgentStage.BACKEND_ENGINEER },
        { target_id: "web", role: AgentStage.FRONTEND_ENGINEER },
      ],
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v9-legacy-bindings-"));
    const file = path.join(root, "state.db");
    try {
      const store = new SqliteTaskStore(file);
      store.createTask(current);
      store.close();

      const raw = new Database(file);
      const schemaVersion = raw.pragma("user_version", { simple: true });
      raw.prepare("UPDATE tasks SET state = ? WHERE task_id = ?").run(JSON.stringify(legacyState), current.taskId);
      raw.close();

      const reopened = new SqliteTaskStore(file);
      expect(reopened.loadTask(current.taskId)?.targetBindings).toEqual(parsed.targetBindings);
      reopened.close();

      const after = new Database(file);
      expect(after.pragma("user_version", { simple: true })).toBe(schemaVersion);
      after.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats binding order as immutable-set noise but refuses a changed pair", () => {
    const previous = {
      targets: [
        { target_id: "api", role: AgentStage.BACKEND_ENGINEER },
        { target_id: "web", role: AgentStage.FRONTEND_ENGINEER },
      ],
    } satisfies TargetBindings;
    expect(() => assertBindingsImmutable(previous, { targets: [...previous.targets].reverse() })).not.toThrow();
    expect(() =>
      assertBindingsImmutable(previous, {
        targets: [
          previous.targets[0],
          { target_id: "worker", role: AgentStage.FRONTEND_ENGINEER },
        ],
      }),
    ).toThrow(/immutable/);
  });

  it("keeps the legacy CLI flags and maps them into the list form", () => {
    const args = parseArgs(
      ["--task-id", "T-1", "--module", "m", "--backend", "--frontend", "--frontend-target", "web", "--backend-target", "api"],
      "/repo",
    );
    expect(args.targetBindings).toEqual({
      targets: [
        { target_id: "web", role: AgentStage.FRONTEND_ENGINEER },
        { target_id: "api", role: AgentStage.BACKEND_ENGINEER },
      ],
    });
  });

  it("collapses a fullstack Target to one work root writable by either engineer and devops", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v9-fullstack-bindings-"));
    try {
      const framework = path.join(root, "framework");
      const knowledge = path.join(root, "knowledge");
      const target = path.join(root, "fullstack");
      initRepository(framework);
      initRepository(knowledge);
      initRepository(target, "https://github.com/acme/fullstack.git");
      fs.mkdirSync(path.join(knowledge, ".workflow"));
      fs.writeFileSync(
        path.join(knowledge, "targets.yaml"),
        "schema_version: 1\ntargets:\n  - target_id: fullstack\n    name: Fullstack\n    remote_url: https://github.com/acme/fullstack.git\n    status: active\n",
      );
      fs.writeFileSync(
        path.join(knowledge, ".workflow", "targets.local.yaml"),
        `schema_version: 1\ntargets:\n  fullstack:\n    path: ${JSON.stringify(target)}\n`,
      );
      const config = path.join(root, "installation.yaml");
      fs.writeFileSync(config, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`);
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
      const task = newPersistedTask({
        taskId: "fullstack",
        classification,
        machine: initTaskMachine(classification.pipeline, false),
        now: 1,
        targetBindings: {
          targets: [
            { target_id: "fullstack", role: AgentStage.BACKEND_ENGINEER },
            { target_id: "fullstack", role: AgentStage.FRONTEND_ENGINEER },
          ],
        },
      });
      const options = { frameworkRoot: framework, installationConfigPath: config };

      for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER, AgentStage.DEVOPS]) {
        expect(preflightThreeRepoTask(task, stage, options).workRoots).toEqual([
          { targetId: "fullstack", path: target, access: "write" },
        ]);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
