import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyTask } from "../classification/taskClassifier.js";
import type { PlanTaskRow } from "../docs/planGraph.js";
import { GitCommandLayer } from "../git/commandLayer.js";
import { inspectRepositoryPreflight } from "../git/preflight.js";
import { TaskRegistry } from "../orchestrator/taskRegistry.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { AgentStage } from "../types.js";
import { planHash, type RunManifest } from "./journal.js";
import { buildWavePreview, executeWave, type ResolvedWaveRoute } from "./waveRunner.js";

const fixtureEnabled = process.env.STA_KILL_FIXTURE === "1";

function task(id: string): PlanTaskRow {
  return {
    id,
    phase: 1,
    designRefs: ["DES-001"],
    dependsOn: [],
    status: "pending",
    owner: AgentStage.BACKEND_ENGINEER,
    wave: null,
    tier: "T2",
    description: `Implement ${id}`,
    fromCheckbox: false,
  };
}

const verification: DeterministicVerification = {
  required: ["typecheck"],
  ran: [{ id: "typecheck", status: "PASS", durationMs: 1, outputSummary: "pass" }],
  failures: [],
  skipped: [],
  missingRequired: [],
  status: "passed",
  enforcement: "enforce",
  passed: true,
};

describe.skipIf(!fixtureEnabled)("real process-kill wave fixture", () => {
  it("runs until the parent terminates the process during the second owner stage", async () => {
    const projectRoot = process.env.STA_KILL_STATE_ROOT!;
    const targetRoot = process.env.STA_KILL_TARGET_ROOT!;
    const frameworkRoot = process.env.STA_KILL_FRAMEWORK_ROOT!;
    const marker = process.env.STA_KILL_MARKER!;
    const store = new SqliteTaskStore(path.join(projectRoot, ".workflow", "state.db"));
    const registry = new TaskRegistry({ store });
    const tasks = [task("BE-1"), task("BE-2")];
    for (const row of tasks) {
      registry.create({
        taskId: row.id,
        classification: classifyTask({ isClearBugFix: true, touchesBackend: true }),
        dependsOn: row.dependsOn,
        projectRoot: frameworkRoot,
        taskText: row.description,
        targetWorkRoots: [
          { stage: AgentStage.BACKEND_ENGINEER, targetId: "target", path: targetRoot },
          { stage: AgentStage.QA_ENGINEER, targetId: "target", path: targetRoot },
        ],
      });
    }

    const route: ResolvedWaveRoute = {
      runtimeId: "claude-code",
      tier: "T2",
      model: "opus",
      capabilities: new Set([RuntimeCapability.PRE_TOOL_GUARD]),
    };
    const preview = buildWavePreview({
      planTasks: tasks,
      wave: 1,
      maxTasks: 2,
      store,
      route,
      repositoryState: "clean-ordinary",
    });
    const git = new GitCommandLayer({ cwd: targetRoot });
    const runId = "01J00000000000000000000099";
    const preflight = await inspectRepositoryPreflight(git, "orders", runId);
    const manifest: RunManifest = {
      run_id: runId,
      created_at: "2026-09-07T00:00:00.000Z",
      target_root: targetRoot,
      target_id: "target",
      knowledge_root: projectRoot,
      module: "orders",
      wave: 1,
      plan_hash: planHash(tasks),
      task_order: tasks.map((row) => row.id),
      base_branch: preflight.baseBranch,
      base_sha: preflight.baseSha,
      run_branch: preflight.runBranch,
      runtime_id: route.runtimeId,
      tier: route.tier,
      model: route.model,
      max_tasks: 2,
      sta_version: "1.1.0",
    };

    const result = await executeWave({
      projectRoot,
      manifest,
      planTasks: tasks,
      preview,
      preflight,
      registry,
      store,
      route,
      git,
      log: console.log,
      secretScanner: () => ({ ok: true, problems: [] }),
      compose: async (row) => ({
        executor: async () => {
          if (row.id === "BE-1") {
            fs.writeFileSync(path.join(targetRoot, "BE-1.txt"), "checkpoint me\n");
            return { outcome: { result: "PASS", tokens: 1, cost: 0 } };
          }
          fs.writeFileSync(path.join(targetRoot, "partial-BE-2.txt"), "interrupted work\n");
          fs.writeFileSync(marker, "ready\n");
          return await new Promise<never>(() => undefined);
        },
        verificationFor: () => verification,
      }),
    });
    expect(result).toBe(0); // The parent must kill this process before this line is reachable.
  }, 30_000);
});
