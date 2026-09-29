import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask } from "../store/taskStore.js";
import { AgentStage } from "../types.js";
import { preflightThreeRepoTask, type WorkRoot } from "./preflight.js";
import { validateNewTaskBindings, type TargetBindings } from "./taskBindings.js";
import type { TargetRegistry } from "./targets.js";

/** Bound by the task; `spare` is declared by the module but left unbound. */
const TARGET_IDS = ["api", "worker", "web", "spare"] as const;

const registry: TargetRegistry = {
  schema_version: 1,
  targets: TARGET_IDS.map((target_id) => ({
    target_id,
    name: target_id,
    remote_url: `https://github.com/acme/${target_id}.git`,
    status: "active" as const,
  })),
};

const bindings: TargetBindings = {
  targets: [
    { target_id: "api", role: AgentStage.BACKEND_ENGINEER },
    { target_id: "worker", role: AgentStage.BACKEND_ENGINEER },
    { target_id: "web", role: AgentStage.FRONTEND_ENGINEER },
  ],
};

const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });

const temporaryRoots: string[] = [];

function initRepository(directory: string, remote?: string): void {
  fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
  if (remote) fs.writeFileSync(path.join(directory, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
}

function fixture(): { options: { frameworkRoot: string; installationConfigPath: string }; paths: Record<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v10-module-write-scope-"));
  temporaryRoots.push(root);
  const framework = path.join(root, "framework");
  const knowledge = path.join(root, "knowledge");
  initRepository(framework);
  initRepository(knowledge);
  const paths: Record<string, string> = {};
  for (const id of TARGET_IDS) {
    paths[id] = path.join(root, id);
    initRepository(paths[id], `https://github.com/acme/${id}.git`);
  }
  fs.mkdirSync(path.join(knowledge, ".workflow"));
  fs.writeFileSync(
    path.join(knowledge, "targets.yaml"),
    `schema_version: 1\ntargets:\n${TARGET_IDS.map(
      (id) => `  - target_id: ${id}\n    name: ${id}\n    remote_url: https://github.com/acme/${id}.git\n    status: active\n`,
    ).join("")}`,
  );
  fs.writeFileSync(
    path.join(knowledge, ".workflow", "targets.local.yaml"),
    `schema_version: 1\ntargets:\n${TARGET_IDS.map((id) => `  ${id}:\n    path: ${JSON.stringify(paths[id])}\n`).join("")}`,
  );
  const installationConfigPath = path.join(root, "installation.yaml");
  fs.writeFileSync(installationConfigPath, `schema_version: 1\nknowledge_root: ${JSON.stringify(knowledge)}\n`);
  return { options: { frameworkRoot: framework, installationConfigPath }, paths };
}

function task(taskId: string) {
  return newPersistedTask({
    taskId,
    classification,
    machine: initTaskMachine(classification.pipeline, false),
    now: 1,
    targetBindings: bindings,
  });
}

function accessByTarget(roots: readonly WorkRoot[]): Record<string, string> {
  return Object.fromEntries(roots.map((root) => [root.targetId, root.access]));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("V13 TASK-011 — per-role write scope in preflight", () => {
  it.each([
    [AgentStage.BACKEND_ENGINEER, { api: "write", worker: "write", web: "read" }],
    [AgentStage.FRONTEND_ENGINEER, { api: "read", worker: "read", web: "write" }],
    [AgentStage.DEVOPS, { api: "write", worker: "write", web: "write" }],
    [AgentStage.QA_ENGINEER, { api: "read", worker: "read", web: "read" }],
    [AgentStage.SECURITY, { api: "read", worker: "read", web: "read" }],
  ])("gives %s write only on Targets bound to its own role; the sibling role's Target stays read-only", (stage, expected) => {
    const { options } = fixture();
    const roots = preflightThreeRepoTask(task("matrix"), stage, options).workRoots;
    expect(accessByTarget(roots)).toEqual(expected);
  });

  it("denies an engineer write on a Target another role owns — cross-role root write refusal", () => {
    const { options } = fixture();
    const backendRoots = preflightThreeRepoTask(task("cross-role"), AgentStage.BACKEND_ENGINEER, options).workRoots;
    expect(backendRoots.find((root) => root.targetId === "web")).toMatchObject({ access: "read" });
    const frontendRoots = preflightThreeRepoTask(task("cross-role"), AgentStage.FRONTEND_ENGINEER, options).workRoots;
    expect(frontendRoots.find((root) => root.targetId === "api")).toMatchObject({ access: "read" });
  });

  it("keeps a Target the task does not bind out of workRoots entirely, not merely read-only", () => {
    const { options } = fixture();
    for (const stage of [
      AgentStage.BACKEND_ENGINEER,
      AgentStage.FRONTEND_ENGINEER,
      AgentStage.QA_ENGINEER,
      AgentStage.SECURITY,
      AgentStage.DEVOPS,
    ]) {
      const roots = preflightThreeRepoTask(task("unbound"), stage, options).workRoots;
      expect(roots.map((root) => root.targetId)).toEqual(["api", "worker", "web"]);
      expect(roots.some((root) => root.targetId === "spare")).toBe(false);
    }
  });

  it("does not change a single-Target task: the sole bound Target stays writable for its engineer", () => {
    const { options, paths } = fixture();
    const backendOnly = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const single = newPersistedTask({
      taskId: "single",
      classification: backendOnly,
      machine: initTaskMachine(backendOnly.pipeline, false),
      now: 1,
      targetBindings: { targets: [{ target_id: "api", role: AgentStage.BACKEND_ENGINEER }] },
    });
    expect(preflightThreeRepoTask(single, AgentStage.BACKEND_ENGINEER, options).workRoots).toEqual([
      { targetId: "api", path: paths.api, access: "write" },
    ]);
    expect(preflightThreeRepoTask(single, AgentStage.QA_ENGINEER, options).workRoots).toEqual([
      { targetId: "api", path: paths.api, access: "read" },
    ]);
  });

  it("keeps the module's declared ## Targets as the upper bound of the widened scope", () => {
    const { options } = fixture();
    expect(() =>
      preflightThreeRepoTask(task("outside-module"), AgentStage.BACKEND_ENGINEER, {
        ...options,
        moduleScope: { module: "sales", designPath: "sales/design.md", declaredTargetIds: ["api", "web"] },
      }),
    ).toThrow(/Target "worker" is outside module "sales" declared ## Targets/);
  });
});

describe("V10 TASK-009 — one engineer role may hold several Targets", () => {
  it("accepts two Targets on one engineer role at creation", () => {
    expect(() => validateNewTaskBindings(classification, bindings, registry)).not.toThrow();
  });

  it("still refuses a Target whose declared type does not admit the bound role", () => {
    const typed: TargetRegistry = {
      schema_version: 1,
      targets: registry.targets.map((entry) =>
        entry.target_id === "worker" ? { ...entry, type: "frontend" as const } : entry,
      ),
    };
    expect(() => validateNewTaskBindings(classification, bindings, typed)).toThrow(
      /Target "worker" has type "frontend", which does not admit role "backend-engineer"/,
    );
  });
});
