import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import { initTaskMachine } from "../state/taskState.js";
import { newPersistedTask, PersistedTaskSchema } from "../store/taskStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { AgentStage } from "../types.js";
import {
  validateNewTaskBindings,
  validatePersistedTaskBindings,
  type TargetBindings,
} from "./taskBindings.js";
import type { TargetRegistry } from "./targets.js";
import { parseModuleTargets } from "../docs/moduleTargets.js";
import { detectTargetProfileEvidence } from "../targetcli/targetProfile.js";
import { resolveWritableWorkRoots } from "./cliRoots.js";
import { declareInstallationConfigOverrideChannelForTest } from "./installation.js";

declareInstallationConfigOverrideChannelForTest();

function tmpDir(prefix = "v9-scenario-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("V9 Scenario Matrix Coverage (T-V9-020)", () => {
  const registry: TargetRegistry = {
    schema_version: 1,
    targets: [
      {
        target_id: "web-ui",
        name: "Web UI",
        remote_url: "https://github.com/acme/web-ui.git",
        type: "frontend",
        status: "active",
      },
      {
        target_id: "api-server",
        name: "API Server",
        remote_url: "https://github.com/acme/api-server.git",
        type: "backend",
        status: "active",
      },
      {
        target_id: "fullstack-app",
        name: "Fullstack App",
        remote_url: "https://github.com/acme/fullstack-app.git",
        type: "fullstack",
        status: "active",
      },
      {
        target_id: "untyped-service",
        name: "Untyped Service",
        remote_url: "https://github.com/acme/untyped-service.git",
        status: "active",
      },
      {
        target_id: "retired-service",
        name: "Retired Service",
        remote_url: "https://github.com/acme/retired-service.git",
        type: "backend",
        status: "retired",
      },
    ],
  };

  describe("Single Target / single repo scenarios", () => {
    it("single-repo with no installation config resolves to project root", () => {
      const root = tmpDir("single-repo-");
      const store = new SqliteTaskStore(path.join(root, "state.db"));
      try {
        const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
        const task = newPersistedTask({
          taskId: "single-repo-task",
          classification,
          machine: initTaskMachine(classification.pipeline, false),
          now: 1,
        });
        store.createTask(task);

        const prevConfig = process.env.STA_INSTALLATION_CONFIG;
        process.env.STA_INSTALLATION_CONFIG = path.join(root, "non-existent-install.yaml");
        try {
          const roots = resolveWritableWorkRoots(root, "single-repo-task", store, AgentStage.BACKEND_ENGINEER);
          expect(roots).toEqual([{ path: root }]);
        } finally {
          if (prevConfig === undefined) delete process.env.STA_INSTALLATION_CONFIG;
          else process.env.STA_INSTALLATION_CONFIG = prevConfig;
        }
      } finally {
        store.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("resumes in-flight task across binding-shape change (legacy pair -> targets list)", () => {
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
      const current = newPersistedTask({
        taskId: "in-flight-legacy",
        classification,
        machine: initTaskMachine(classification.pipeline, false),
        now: 1,
      });
      const legacyState = {
        ...current,
        targetBindings: { frontend_target: "web-ui", backend_target: "api-server" },
      };

      const parsed = PersistedTaskSchema.parse(legacyState);
      expect(parsed.targetBindings).toEqual({
        targets: [
          { target_id: "api-server", role: AgentStage.BACKEND_ENGINEER },
          { target_id: "web-ui", role: AgentStage.FRONTEND_ENGINEER },
        ],
      });

      expect(() => validatePersistedTaskBindings(parsed, registry)).not.toThrow();
    });

    it("single-Target task binds and validates cleanly", () => {
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      const bindings: TargetBindings = {
        targets: [{ target_id: "api-server", role: AgentStage.BACKEND_ENGINEER }],
      };
      expect(() => validateNewTaskBindings(classification, bindings, registry)).not.toThrow();
    });
  });

  describe("Stack profile scenarios", () => {
    it("no matching stack profile returns empty candidates", () => {
      const root = tmpDir("empty-stack-");
      try {
        const evidence = detectTargetProfileEvidence(root);
        expect(evidence.candidates).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("ambiguous profile detection returns multiple candidates", () => {
      const root = tmpDir("ambiguous-stack-");
      try {
        fs.writeFileSync(path.join(root, "package.json"), "{}");
        fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
        fs.writeFileSync(path.join(root, "pom.xml"), "<project/>");
        fs.writeFileSync(path.join(root, "pyproject.toml"), "");
        fs.writeFileSync(path.join(root, "app.csproj"), "<Project/>");

        const evidence = detectTargetProfileEvidence(root);
        expect(evidence.candidates.length).toBeGreaterThan(1);
        expect(evidence.candidates).toContain("node");
        expect(evidence.candidates).toContain("java");
        expect(evidence.candidates).toContain("python");
        expect(evidence.candidates).toContain("dotnet");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Task scope & Q-3 refusal scenarios", () => {
    it("V10 TASK-009: admits two distinct Targets on one engineer role (V9 Q-3 refusal retired)", () => {
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      const bindings: TargetBindings = {
        targets: [
          { target_id: "api-server", role: AgentStage.BACKEND_ENGINEER },
          { target_id: "untyped-service", role: AgentStage.BACKEND_ENGINEER },
        ],
      };
      expect(() => validateNewTaskBindings(classification, bindings, registry)).not.toThrow();
    });

    it("fullstack MVC Target admits both engineer roles cleanly", () => {
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
      const bindings: TargetBindings = {
        targets: [
          { target_id: "fullstack-app", role: AgentStage.BACKEND_ENGINEER },
          { target_id: "fullstack-app", role: AgentStage.FRONTEND_ENGINEER },
        ],
      };
      expect(() => validateNewTaskBindings(classification, bindings, registry)).not.toThrow();
    });
  });

  describe("Module ↔ Target resolution combinations", () => {
    it("1 module -> 1 Target", () => {
      const design = "# Design\n\n## Targets\n\n- api-server\n";
      const parsed = parseModuleTargets(design);
      expect(parsed.present).toBe(true);
      expect(parsed.ids).toEqual(["api-server"]);
    });

    it("1 module -> N Targets", () => {
      const design = "# Design\n\n## Targets\n\n- api-server\n- web-ui\n- fullstack-app\n";
      const parsed = parseModuleTargets(design);
      expect(parsed.present).toBe(true);
      expect(parsed.ids).toEqual(["api-server", "web-ui", "fullstack-app"]);
    });

    it("module declaring none (unscoped)", () => {
      const design = "# Design\n\n## Feasibility\n\nNo targets declared\n";
      const parsed = parseModuleTargets(design);
      expect(parsed.present).toBe(false);
      expect(parsed.ids).toEqual([]);
    });
  });
});
