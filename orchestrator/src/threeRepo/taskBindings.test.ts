import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { parseArgs } from "../cli.js";
import { openTask } from "../cli/composition/taskIntake.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask, type PersistedTask } from "../store/taskStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { defaultStateViewPath } from "../store/stateView.js";
import Database from "../store/sqliteDatabase.js";
import { assertBindingsImmutable, uniqueBoundTargetIds, validateNewTaskBindings, validatePersistedTaskBindings } from "./taskBindings.js";
import { preflightThreeRepoTask } from "./preflight.js";
import { figmaPatConfigured } from "./identities.js";
import type { TargetRegistry } from "./targets.js";

const registry: TargetRegistry = {
  schema_version: 1,
  targets: [
    { target_id: "backend", name: "Backend", remote_url: "https://github.com/acme/backend.git", status: "active" },
    { target_id: "frontend", name: "Frontend", remote_url: "https://github.com/acme/frontend.git", status: "active" },
  ],
};
const both = () => classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
const bindings = (backend: string | null, frontend: string | null) => ({
  targets: [
    ...(backend ? [{ target_id: backend, role: AgentStage.BACKEND_ENGINEER as const }] : []),
    ...(frontend ? [{ target_id: frontend, role: AgentStage.FRONTEND_ENGINEER as const }] : []),
  ],
});
function initRepository(directory: string): void {
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
}

describe("Phase 2 task Target bindings", () => {
  it("requires the binding corresponding to each code classification, permits document-only nulls, and deduplicates one Target", () => {
    expect(() => validateNewTaskBindings(both(), bindings(null, "frontend"), registry)).toThrow(/engineer roles/);
    expect(() => validateNewTaskBindings(classifyTask({ isTypoOrCopyOnly: true }), bindings(null, null), registry)).not.toThrow();
    expect(uniqueBoundTargetIds(bindings("backend", "backend"))).toEqual(["backend"]);
  });

  it("T-V9-008 applies type admission identically at creation and resume, while fullstack admits both roles", () => {
    const typedRegistry: TargetRegistry = {
      schema_version: 1,
      targets: [
        { target_id: "api", name: "API", remote_url: "https://github.com/acme/api.git", status: "active", type: "backend" },
        { target_id: "web", name: "Web", remote_url: "https://github.com/acme/web.git", status: "active", type: "frontend" },
        { target_id: "mvc", name: "MVC", remote_url: "https://github.com/acme/mvc.git", status: "active", type: "fullstack" },
      ],
    };
    const frontend = classifyTask({ isClearBugFix: true, touchesFrontend: true });
    const backend = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const fullstack = both();
    const frontendOnApi = bindings(null, "api");
    const backendOnWeb = bindings("web", null);
    const bothOnMvc = bindings("mvc", "mvc");
    const persisted = (taskId: string, classification: ReturnType<typeof classifyTask>, targetBindings: ReturnType<typeof bindings>) =>
      newPersistedTask({ taskId, classification, machine: initTaskMachine(classification.pipeline, false), now: 1, targetBindings });

    expect(() => validateNewTaskBindings(frontend, frontendOnApi, typedRegistry)).toThrow(/type "backend".*frontend-engineer.*bind it to an admitted role|type "backend".*frontend-engineer.*correct/);
    expect(() => validatePersistedTaskBindings(persisted("resume-front", frontend, frontendOnApi), typedRegistry)).toThrow(/type "backend".*frontend-engineer/);
    expect(() => validateNewTaskBindings(backend, backendOnWeb, typedRegistry)).toThrow(/type "frontend".*backend-engineer/);
    expect(() => validatePersistedTaskBindings(persisted("resume-back", backend, backendOnWeb), typedRegistry)).toThrow(/type "frontend".*backend-engineer/);
    expect(() => validateNewTaskBindings(fullstack, bothOnMvc, typedRegistry)).not.toThrow();
    expect(() => validatePersistedTaskBindings(persisted("resume-mvc", fullstack, bothOnMvc), typedRegistry)).not.toThrow();
  });

  it("V10 TASK-009 admits two Targets on one engineer role at creation and resume (V9 Q-3 rule retired)", () => {
    const typedRegistry: TargetRegistry = {
      schema_version: 1,
      targets: [
        { target_id: "api", name: "API", remote_url: "https://github.com/acme/api.git", status: "active", type: "backend" },
        { target_id: "worker", name: "Worker", remote_url: "https://github.com/acme/worker.git", status: "active", type: "backend" },
      ],
    };
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const targetBindings = {
      targets: [
        { target_id: "api", role: AgentStage.BACKEND_ENGINEER as const },
        { target_id: "worker", role: AgentStage.BACKEND_ENGINEER as const },
      ],
    };
    const persisted = newPersistedTask({
      taskId: "same-role-resume",
      classification,
      machine: initTaskMachine(classification.pipeline, false),
      now: 1,
      targetBindings,
    });
    expect(() => validateNewTaskBindings(classification, targetBindings, typedRegistry)).not.toThrow();
    expect(() => validatePersistedTaskBindings(persisted, typedRegistry)).not.toThrow();
  });

  it("T-V9-008 returns the same explicit compatibility warnings at creation and resume", () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const targetBindings = bindings("backend", null);
    const moduleScope = { module: "legacy-module", designPath: "legacy-module/design.md", declaredTargetIds: ["backend"] };
    const persisted = newPersistedTask({
      taskId: "legacy-resume",
      classification,
      machine: initTaskMachine(classification.pipeline, false),
      now: 1,
      targetBindings,
    });

    const created = validateNewTaskBindings(classification, targetBindings, registry, { moduleScope });
    const resumed = validatePersistedTaskBindings(persisted, registry, { moduleScope });
    expect(created.warnings).toEqual(resumed.warnings);
    expect(created.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/no declared type.*schema v1 compatibility/)]));
  });

  it("V10 TASK-011 refuses a Target binding in a module that declares no ## Targets, naming the design.md to fix", () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const targetBindings = bindings("backend", null);
    const persisted = newPersistedTask({
      taskId: "unscoped-resume",
      classification,
      machine: initTaskMachine(classification.pipeline, false),
      now: 1,
      targetBindings,
    });
    const moduleScope = { module: "sales", designPath: "knowledge/_docs/module/sales/design.md", declaredTargetIds: [] };

    expect(() => validateNewTaskBindings(classification, targetBindings, registry, { moduleScope })).toThrow(
      /module "sales" declares no Targets[\s\S]*binding\(s\) backend[\s\S]*"## Targets"[\s\S]*knowledge\/_docs\/module\/sales\/design\.md/,
    );
    expect(() => validatePersistedTaskBindings(persisted, registry, { moduleScope })).toThrow(
      /module "sales" declares no Targets[\s\S]*knowledge\/_docs\/module\/sales\/design\.md/,
    );
  });

  it("V10 TASK-011 leaves a task that binds no Target alone: a document-only module still needs no ## Targets", () => {
    const classification = classifyTask({ isTypoOrCopyOnly: true });
    const targetBindings = bindings(null, null);
    const persisted = newPersistedTask({
      taskId: "doc-only-resume",
      classification,
      machine: initTaskMachine(classification.pipeline, false),
      now: 1,
      targetBindings,
    });
    const moduleScope = { module: "policy", designPath: "policy/design.md", declaredTargetIds: [] };

    const created = validateNewTaskBindings(classification, targetBindings, registry, { moduleScope });
    const resumed = validatePersistedTaskBindings(persisted, registry, { moduleScope });
    expect(created.warnings).toEqual(resumed.warnings);
    expect(created.warnings).toEqual([expect.stringMatching(/declares no Targets.*binds none either/)]);
  });

  it("T-V9-008 enforces a declared module Target set on creation and resume", () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const targetBindings = bindings("backend", null);
    const persisted = newPersistedTask({
      taskId: "scoped-resume",
      classification,
      machine: initTaskMachine(classification.pipeline, false),
      now: 1,
      targetBindings,
    });
    const moduleScope = { module: "sales", designPath: "sales/design.md", declaredTargetIds: ["frontend"] };

    expect(() => validateNewTaskBindings(classification, targetBindings, registry, { moduleScope })).toThrow(/Target "backend".*outside module "sales".*## Targets/);
    expect(() => validatePersistedTaskBindings(persisted, registry, { moduleScope })).toThrow(/Target "backend".*outside module "sales".*## Targets/);
  });

  it("T-V9-008 refuses type and module-scope errors before creating a durable task row", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v9-binding-intake-"));
    const knowledge = path.join(root, "knowledge");
    const target = path.join(root, "target");
    const config = path.join(root, "installation.yaml");
    fs.mkdirSync(path.join(knowledge, "_docs", "module", "sales"), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(knowledge, "targets.yaml"),
      "schema_version: 1\ntargets:\n  - target_id: api\n    name: API\n    remote_url: https://github.com/acme/api.git\n    status: active\n    type: backend\n  - target_id: other\n    name: Other\n    remote_url: https://github.com/acme/other.git\n    status: active\n    type: backend\n",
    );
    fs.writeFileSync(path.join(knowledge, "_docs", "module", "sales", "design.md"), "# Design\n\n## Targets\n\n- api\n");
    fs.writeFileSync(config, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`);
    const previousConfig = process.env.STA_INSTALLATION_CONFIG;
    process.env.STA_INSTALLATION_CONFIG = config;
    const store = new SqliteTaskStore(path.join(target, "state.db"));
    const taskRegistry = new TaskRegistry({ store, stateViewPath: defaultStateViewPath(target) });
    try {
      const wrongType = parseArgs(["--task-id", "wrong-type", "--module", "sales", "--bug-fix", "--frontend", "--frontend-target", "api", "--project-root", target], target);
      expect(() => openTask(taskRegistry, wrongType, "wrong-type")).toThrow(/type "backend"/);
      expect(store.loadTask("wrong-type")).toBeNull();

      const wrongScope = parseArgs(["--task-id", "wrong-scope", "--module", "sales", "--bug-fix", "--backend", "--backend-target", "other", "--project-root", target], target);
      expect(() => openTask(taskRegistry, wrongScope, "wrong-scope")).toThrow(/outside module "sales"/);
      expect(store.loadTask("wrong-scope")).toBeNull();

      // V10 TASK-009: two Targets on one engineer role are admitted; the
      // module's declared `## Targets` remains the refusal that stands.
      const sameRoleOutsideModule = {
        ...parseArgs(["--task-id", "same-role", "--module", "sales", "--bug-fix", "--backend", "--backend-target", "api", "--project-root", target], target),
        targetBindings: {
          targets: [
            { target_id: "api", role: AgentStage.BACKEND_ENGINEER as const },
            { target_id: "other", role: AgentStage.BACKEND_ENGINEER as const },
          ],
        },
      };
      expect(() => openTask(taskRegistry, sameRoleOutsideModule, "same-role")).toThrow(/outside module "sales"/);
      expect(store.loadTask("same-role")).toBeNull();
    } finally {
      taskRegistry.close();
      if (previousConfig === undefined) delete process.env.STA_INSTALLATION_CONFIG;
      else process.env.STA_INSTALLATION_CONFIG = previousConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects retired/unknown creation bindings and immutable edits", () => {
    const retired: TargetRegistry = { ...registry, targets: [{ ...registry.targets[0], status: "retired" }, registry.targets[1]] };
    expect(() => validateNewTaskBindings(classifyTask({ isClearBugFix: true, touchesBackend: true }), bindings("backend", null), retired)).toThrow(/retired/);
    expect(() => validateNewTaskBindings(classifyTask({ isClearBugFix: true, touchesBackend: true }), bindings("missing", null), registry)).toThrow(/unknown/);
    expect(() => assertBindingsImmutable(bindings("backend", null), bindings("backend", "frontend"))).toThrow(/immutable/);
  });

  it("blocks legacy code tasks but preserves historical rows via null defaults", () => {
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const legacy = newPersistedTask({ taskId: "legacy", classification, machine: initTaskMachine(classification.pipeline, false), now: 1 });
    expect(legacy.targetBindings).toEqual({ targets: [] });
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
        targetBindings: bindings("backend", null),
      });
      store.createTask(task);
      expect(store.loadTask("bound")?.targetBindings).toEqual(bindings("backend", null));
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
      expect(loaded?.targetBindings).toEqual({ targets: [] });
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
  it("T-V9-008 derives module scope from persisted plan_source; V10 TASK-011 refuses an unscoped bound task on resume", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "v9-resume-module-scope-"));
    try {
      const framework = path.join(root, "framework");
      const knowledge = path.join(root, "knowledge");
      const target = path.join(root, "backend");
      const moduleDir = path.join(knowledge, "_docs", "module", "sales");
      initRepository(framework);
      initRepository(knowledge);
      initRepository(target);
      fs.writeFileSync(path.join(target, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/backend.git\n");
      fs.mkdirSync(path.join(knowledge, ".workflow"));
      fs.mkdirSync(moduleDir, { recursive: true });
      fs.writeFileSync(path.join(moduleDir, "design.md"), "# Design\n\n## Targets\n");
      fs.writeFileSync(path.join(moduleDir, "plan.md"), "# Plan\n");
      fs.writeFileSync(path.join(knowledge, "targets.yaml"), "schema_version: 1\ntargets:\n  - target_id: backend\n    name: Backend\n    remote_url: https://github.com/acme/backend.git\n    status: active\n    type: backend\n");
      fs.writeFileSync(path.join(knowledge, ".workflow", "targets.local.yaml"), `schema_version: 1\ntargets:\n  backend:\n    path: ${JSON.stringify(target)}\n`);
      const config = path.join(root, "installation.yaml");
      fs.writeFileSync(config, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`);
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      const legacy = newPersistedTask({
        taskId: "legacy-scoped",
        classification,
        machine: initTaskMachine(classification.pipeline, false),
        now: 1,
        targetBindings: bindings("backend", null),
      });
      const task = {
        ...legacy,
        runtimeTask: { version: 2, plan_source: path.join(moduleDir, "plan.md") } as unknown as PersistedTask["runtimeTask"],
      };
      const warnings: string[] = [];
      const options = {
        frameworkRoot: framework,
        installationConfigPath: config,
        bindingWarning: (message: string) => warnings.push(message),
      };

      // V10 TASK-011: resume applies the same rule as creation — a bound Target
      // with no module declaration to sit inside is refused, not warned about.
      expect(() => preflightThreeRepoTask(task, AgentStage.BACKEND_ENGINEER, options)).toThrow(
        /module "sales" declares no Targets[\s\S]*design\.md/,
      );
      expect(warnings).toEqual([]);

      fs.writeFileSync(path.join(moduleDir, "design.md"), "# Design\n\n## Targets\n\n- another-target\n");
      expect(() => preflightThreeRepoTask(task, AgentStage.BACKEND_ENGINEER, options)).toThrow(/Target "backend".*outside module "sales"/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("V10 TASK-008 two live Targets: every code stage writes every Target the task binds; QA/security read them all", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "three-repo-two-live-"));
    try {
      const framework = path.join(root, "framework");
      const knowledge = path.join(root, "knowledge");
      const backendRepo = path.join(root, "backend");
      const frontendRepo = path.join(root, "frontend");
      initRepository(framework); initRepository(knowledge); initRepository(backendRepo); initRepository(frontendRepo);
      fs.writeFileSync(path.join(backendRepo, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/backend.git\n");
      fs.writeFileSync(path.join(frontendRepo, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/frontend.git\n");
      fs.mkdirSync(path.join(knowledge, ".workflow"));
      fs.writeFileSync(path.join(knowledge, "targets.yaml"), "schema_version: 1\ntargets:\n  - target_id: backend\n    name: Backend\n    remote_url: https://github.com/acme/backend.git\n    status: active\n  - target_id: frontend\n    name: Frontend\n    remote_url: https://github.com/acme/frontend.git\n    status: active\n");
      fs.writeFileSync(path.join(knowledge, ".workflow", "targets.local.yaml"), `schema_version: 1\ntargets:\n  backend:\n    path: ${JSON.stringify(backendRepo)}\n  frontend:\n    path: ${JSON.stringify(frontendRepo)}\n`);
      const config = path.join(root, "installation.yaml");
      fs.writeFileSync(config, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`);
      const classification = both();
      const task = newPersistedTask({ taskId: "split", classification, machine: initTaskMachine(classification.pipeline, false), now: 1, targetBindings: bindings("backend", "frontend") });
      const opts = { frameworkRoot: framework, installationConfigPath: config };

      const forBackend = preflightThreeRepoTask(task, AgentStage.BACKEND_ENGINEER, opts);
      expect(forBackend.workRoots).toEqual([
        { targetId: "backend", path: backendRepo, access: "write" },
        { targetId: "frontend", path: frontendRepo, access: "write" },
      ]);

      const forFrontend = preflightThreeRepoTask(task, AgentStage.FRONTEND_ENGINEER, opts);
      expect(forFrontend.workRoots).toEqual([
        { targetId: "backend", path: backendRepo, access: "write" },
        { targetId: "frontend", path: frontendRepo, access: "write" },
      ]);

      // QA verifies both, owns neither.
      const forQa = preflightThreeRepoTask(task, AgentStage.QA_ENGINEER, opts);
      expect(forQa.workRoots).toEqual([
        { targetId: "backend", path: backendRepo, access: "read" },
        { targetId: "frontend", path: frontendRepo, access: "read" },
      ]);

      const forSecurity = preflightThreeRepoTask(task, AgentStage.SECURITY, opts);
      expect(forSecurity.workRoots).toEqual([
        { targetId: "backend", path: backendRepo, access: "read" },
        { targetId: "frontend", path: frontendRepo, access: "read" },
      ]);

      const forDevops = preflightThreeRepoTask(task, AgentStage.DEVOPS, opts);
      expect(forDevops.workRoots).toEqual([
        { targetId: "backend", path: backendRepo, access: "write" },
        { targetId: "frontend", path: frontendRepo, access: "write" },
      ]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

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
      const task = newPersistedTask({ taskId: "two", classification, machine: initTaskMachine(classification.pipeline, false), now: 1, targetBindings: bindings("backend", "frontend") });
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
      const task = newPersistedTask({ taskId: "origin", classification, machine: initTaskMachine(classification.pipeline, false), now: 1, targetBindings: bindings("backend", null) });
      expect(() => preflightThreeRepoTask(task, AgentStage.BACKEND_ENGINEER, { frameworkRoot: framework, installationConfigPath: config })).not.toThrow();
      fs.writeFileSync(path.join(target, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/other.git\n");
      expect(() => preflightThreeRepoTask(task, AgentStage.BACKEND_ENGINEER, { frameworkRoot: framework, installationConfigPath: config })).toThrow(/expected canonical remote_url/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  /** The UX/UI stage's declared-identity gate — fail closed before any agent starts. */
  it("blocks the uxui-designer stage when identities are undeclared or disagreeing, and passes others through", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "three-repo-identity-"));
    try {
      const framework = path.join(root, "framework");
      const knowledge = path.join(root, "knowledge");
      const target = path.join(root, "target");
      initRepository(framework); initRepository(knowledge); initRepository(target);
      fs.writeFileSync(path.join(target, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/backend.git\n");
      fs.mkdirSync(path.join(knowledge, ".workflow"));
      fs.writeFileSync(path.join(knowledge, "targets.yaml"), "schema_version: 1\ntargets:\n  - target_id: backend\n    name: Backend\n    remote_url: https://github.com/acme/backend.git\n    status: active\n  - target_id: frontend\n    name: Frontend\n    remote_url: https://github.com/acme/frontend.git\n    status: active\n");
      fs.writeFileSync(path.join(knowledge, ".workflow", "targets.local.yaml"), `schema_version: 1\ntargets:\n  backend:\n    path: ${JSON.stringify(target)}\n`);
      const base = { frameworkRoot: framework };

      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      const engineerTask = newPersistedTask({ taskId: "eng", classification, machine: initTaskMachine(classification.pipeline, false), now: 1, targetBindings: bindings("backend", null) });

      const uxuiClassification = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
      const uxuiTask = newPersistedTask({ taskId: "ux", classification: uxuiClassification, machine: initTaskMachine(uxuiClassification.pipeline, false), now: 1, targetBindings: bindings(null, "frontend") });

      // Undeclared → blocked, with the fix named; a stage without the gate runs as before.
      const noIdentitiesConfig = path.join(root, "installation.yaml");
      fs.writeFileSync(noIdentitiesConfig, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`);
      expect(() => preflightThreeRepoTask(engineerTask, AgentStage.BACKEND_ENGINEER, { ...base, installationConfigPath: noIdentitiesConfig })).not.toThrow();
      expect(() => preflightThreeRepoTask(uxuiTask, AgentStage.UXUI_DESIGNER, { ...base, installationConfigPath: noIdentitiesConfig })).toThrow(/identity gate.*sta configure identity/);

      // Declared but disagreeing → blocked.
      const mismatchConfig = path.join(root, "mismatch.yaml");
      fs.writeFileSync(mismatchConfig, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\nidentities:\n  figma_email: one@person.dev\n  claude_email: other@person.dev\n`);
      expect(() => preflightThreeRepoTask(uxuiTask, AgentStage.UXUI_DESIGNER, { ...base, installationConfigPath: mismatchConfig })).toThrow(/different addresses/);

      // Matching declaration → the gate passes (knowledge-only lane acquires no Target work root).
      const okConfig = path.join(root, "ok.yaml");
      fs.writeFileSync(okConfig, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\nidentities:\n  figma_email: same@person.dev\n  claude_email: same@person.dev\n`);
      const result = preflightThreeRepoTask(uxuiTask, AgentStage.UXUI_DESIGNER, { ...base, installationConfigPath: okConfig });
      expect(result.workRoots).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  /** The identity gate is design-source-agnostic. A Claude Design MCP run authenticates through
   * Anthropic itself, so the preflight must keep accepting a declared-identity installation with
   * NO Figma PAT present — if anyone ever wires figmaPatConfigured() into this gate, the Claude
   * Design direction breaks fail-closed-by-accident and this test is the tripwire. */
  it("passes the uxui-designer stage with declared identities and no FIGMA_PAT anywhere — the Claude Design MCP direction needs none", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "three-repo-claude-design-"));
    try {
      const framework = path.join(root, "framework");
      const knowledge = path.join(root, "knowledge");
      const target = path.join(root, "target");
      initRepository(framework); initRepository(knowledge); initRepository(target);
      fs.writeFileSync(path.join(target, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/backend.git\n");
      fs.mkdirSync(path.join(knowledge, ".workflow"));
      fs.writeFileSync(path.join(knowledge, "targets.yaml"), "schema_version: 1\ntargets:\n  - target_id: backend\n    name: Backend\n    remote_url: https://github.com/acme/backend.git\n    status: active\n  - target_id: frontend\n    name: Frontend\n    remote_url: https://github.com/acme/frontend.git\n    status: active\n");
      fs.writeFileSync(path.join(knowledge, ".workflow", "targets.local.yaml"), `schema_version: 1\ntargets:\n  backend:\n    path: ${JSON.stringify(target)}\n`);
      const config = path.join(root, "installation.yaml");
      fs.writeFileSync(config, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\nidentities:\n  figma_email: designer@person.dev\n  claude_email: designer@person.dev\n`);

      // Deterministic stand-in for "no token configured": the PAT presence helper answers from env,
      // and an empty env means the gate below cannot be leaning on one.
      expect(figmaPatConfigured({})).toBe(false);

      const classification = classifyTask({ isTypoOrCopyOnly: true, touchesFrontend: true });
      const task = newPersistedTask({ taskId: "ux", classification, machine: initTaskMachine(classification.pipeline, false), now: 1, targetBindings: bindings(null, "frontend") });
      const result = preflightThreeRepoTask(task, AgentStage.UXUI_DESIGNER, { frameworkRoot: framework, installationConfigPath: config });
      expect(result.workRoots).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
