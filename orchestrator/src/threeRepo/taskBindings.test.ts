import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask } from "../store/taskStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import Database from "better-sqlite3";
import { assertBindingsImmutable, uniqueBoundTargetIds, validateNewTaskBindings, validatePersistedTaskBindings } from "./taskBindings.js";
import { preflightThreeRepoTask } from "./preflight.js";
import type { TargetRegistry } from "./targets.js";

const registry: TargetRegistry = {
  schema_version: 1,
  targets: [
    { target_id: "backend", name: "Backend", remote_url: "https://github.com/acme/backend.git", status: "active" },
    { target_id: "frontend", name: "Frontend", remote_url: "https://github.com/acme/frontend.git", status: "active" },
  ],
};
const both = () => classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
function initRepository(directory: string): void {
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
}

describe("Phase 2 task Target bindings", () => {
  it("requires the binding corresponding to each code classification, permits document-only nulls, and deduplicates one Target", () => {
    expect(() => validateNewTaskBindings(both(), { frontend_target: "frontend", backend_target: null }, registry)).toThrow(/backend_target/);
    expect(() => validateNewTaskBindings(classifyTask({ isTypoOrCopyOnly: true }), { frontend_target: null, backend_target: null }, registry)).not.toThrow();
    expect(uniqueBoundTargetIds({ frontend_target: "backend", backend_target: "backend" })).toEqual(["backend"]);
  });

  it("rejects retired/unknown creation bindings and immutable edits", () => {
    const retired: TargetRegistry = { ...registry, targets: [{ ...registry.targets[0], status: "retired" }, registry.targets[1]] };
    expect(() => validateNewTaskBindings(classifyTask({ isClearBugFix: true, touchesBackend: true }), { frontend_target: null, backend_target: "backend" }, retired)).toThrow(/retired/);
    expect(() => validateNewTaskBindings(classifyTask({ isClearBugFix: true, touchesBackend: true }), { frontend_target: null, backend_target: "missing" }, registry)).toThrow(/unknown/);
    expect(() => assertBindingsImmutable({ frontend_target: null, backend_target: "backend" }, { frontend_target: "frontend", backend_target: "backend" })).toThrow(/immutable/);
  });

  it("blocks legacy code tasks but preserves historical rows via null defaults", () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const legacy = newPersistedTask({ taskId: "legacy", classification, machine: initTaskMachine(classification.pipeline, false), now: 1 });
    expect(legacy.targetBindings).toEqual({ frontend_target: null, backend_target: null });
    expect(() => validatePersistedTaskBindings(legacy, registry)).toThrow(/legacy code task/);
  });

  it("round-trips bindings through the SQLite store unchanged (T138)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "three-repo-store-"));
    try {
      const store = new SqliteTaskStore(path.join(dir, "state.db"));
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      const task = newPersistedTask({
        taskId: "bound",
        classification,
        machine: initTaskMachine(classification.pipeline, false),
        now: 1,
        targetBindings: { frontend_target: null, backend_target: "backend" },
      });
      store.createTask(task);
      expect(store.loadTask("bound")?.targetBindings).toEqual({ frontend_target: null, backend_target: "backend" });
      expect(store.loadTask("missing") ?? null).toBeNull();
      store.close();
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* left for the OS — Windows can hold the sqlite handle a beat longer */
      }
    }
  });

  it("reads a pre-bindings row with null defaults and still refuses it as a legacy code task (T138)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "three-repo-store-legacy-"));
    try {
      const file = path.join(dir, "state.db");
      const store = new SqliteTaskStore(file);
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      store.createTask(newPersistedTask({ taskId: "legacy-row", classification, machine: initTaskMachine(classification.pipeline, false), now: 1 }));

      // Simulate a row written before targetBindings existed by stripping the
      // field from the persisted state blob behind the store's back.
      const raw = new Database(file);
      const row = raw.prepare("SELECT state FROM tasks WHERE task_id = 'legacy-row'").get() as { state: string };
      const state = JSON.parse(row.state) as Record<string, unknown>;
      delete state.targetBindings;
      raw.prepare("UPDATE tasks SET state = ? WHERE task_id = 'legacy-row'").run(JSON.stringify(state));
      raw.close();

      const loaded = store.loadTask("legacy-row");
      expect(loaded?.targetBindings).toEqual({ frontend_target: null, backend_target: null });
      expect(() => validatePersistedTaskBindings(loaded!, registry)).toThrow(/legacy code task/);
      store.close();
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* left for the OS — Windows can hold the sqlite handle a beat longer */
      }
    }
  });
});

describe("Phase 2 preflight", () => {
  it("fails closed before any Target lookup when Framework and Knowledge roots overlap", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "three-repo-overlap-"));
    try {
      const framework = path.join(root, "framework");
      initRepository(framework);
      const config = path.join(root, "installation.yaml");
      fs.writeFileSync(config, `schema_version: 1\nknowledge_root: ${JSON.stringify(framework)}\n`);
      const classification = classifyTask({ isTypoOrCopyOnly: true });
      const task = newPersistedTask({ taskId: "overlap", classification, machine: initTaskMachine(classification.pipeline, false), now: 1 });
      expect(() => preflightThreeRepoTask(task, AgentStage.BUSINESS_ANALYST, { frameworkRoot: framework, installationConfigPath: config })).toThrow(/overlaps Framework root/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when either of two Targets lacks a local mapping, before remote verification", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "three-repo-preflight-"));
    try {
      const framework = path.join(root, "framework");
      const knowledge = path.join(root, "knowledge");
      const backend = path.join(root, "backend");
      initRepository(framework); initRepository(knowledge); initRepository(backend);
      fs.mkdirSync(path.join(knowledge, ".workflow"));
      fs.writeFileSync(path.join(knowledge, "targets.yaml"), "schema_version: 1\ntargets:\n  - target_id: backend\n    name: Backend\n    remote_url: https://github.com/acme/backend.git\n    status: active\n  - target_id: frontend\n    name: Frontend\n    remote_url: https://github.com/acme/frontend.git\n    status: active\n");
      fs.writeFileSync(path.join(knowledge, ".workflow", "targets.local.yaml"), `schema_version: 1\ntargets:\n  backend:\n    path: ${JSON.stringify(backend)}\n`);
      const config = path.join(root, "installation.yaml");
      fs.writeFileSync(config, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`);
      const classification = both();
      const task = newPersistedTask({ taskId: "two", classification, machine: initTaskMachine(classification.pipeline, false), now: 1, targetBindings: { backend_target: "backend", frontend_target: "frontend" } });
      let remoteCalls = 0;
      expect(() => preflightThreeRepoTask(task, AgentStage.BACKEND_ENGINEER, { frameworkRoot: framework, installationConfigPath: config, verifyRemote: () => { remoteCalls++; } })).toThrow(/frontend.*no local path mapping/);
      expect(remoteCalls).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("verifies the local origin metadata without invoking Git and rejects a mismatch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "three-repo-origin-"));
    try {
      const framework = path.join(root, "framework");
      const knowledge = path.join(root, "knowledge");
      const target = path.join(root, "target");
      initRepository(framework); initRepository(knowledge); initRepository(target);
      fs.writeFileSync(path.join(target, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/backend.git\n");
      fs.mkdirSync(path.join(knowledge, ".workflow"));
      fs.writeFileSync(path.join(knowledge, "targets.yaml"), "schema_version: 1\ntargets:\n  - target_id: backend\n    name: Backend\n    remote_url: https://github.com/acme/backend.git\n    status: active\n");
      fs.writeFileSync(path.join(knowledge, ".workflow", "targets.local.yaml"), `schema_version: 1\ntargets:\n  backend:\n    path: ${JSON.stringify(target)}\n`);
      const config = path.join(root, "installation.yaml");
      fs.writeFileSync(config, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`);
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      const task = newPersistedTask({ taskId: "origin", classification, machine: initTaskMachine(classification.pipeline, false), now: 1, targetBindings: { backend_target: "backend", frontend_target: null } });
      expect(() => preflightThreeRepoTask(task, AgentStage.BACKEND_ENGINEER, { frameworkRoot: framework, installationConfigPath: config })).not.toThrow();
      fs.writeFileSync(path.join(target, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/other.git\n");
      expect(() => preflightThreeRepoTask(task, AgentStage.BACKEND_ENGINEER, { frameworkRoot: framework, installationConfigPath: config })).toThrow(/expected canonical remote_url/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
