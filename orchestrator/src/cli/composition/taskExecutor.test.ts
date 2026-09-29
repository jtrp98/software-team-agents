import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { composeProductionTaskExecutor } from "./taskExecutor.js";
import { Orchestrator } from "../../orchestrator/orchestrator.js";
import { MemoryTaskStore } from "../../store/memoryStore.js";
import { classifyTask } from "../../classification/taskClassifier.js";
import { AgentStage } from "../../types.js";
import { MockRuntimeAdapter } from "../../runtime/mockAdapter.js";
import { RuntimeRegistry } from "../../runtime/runtimeRegistry.js";
import { fixtureTask } from "../../runtime/packetFixture.testSupport.js";
import { renderCanonicalTasks } from "../../docs/planTask.js";
import type { QaOptimizationOptions } from "../../qa/optimized.js";
import type { QaTaskContract } from "../../qa/taskContract.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../../orchestrator/stageGuards.testSupport.js";

const observed = vi.hoisted(() => ({
  contracts: [] as (QaTaskContract | undefined)[],
  files: [] as string[],
}));

// Isolate composition freshness from native execution and Git. The canonical
// plan reader and QA contract builder remain the real production implementations.
vi.mock("../../runtime/runtimeExecutor.js", () => ({
  createRuntimeExecutor: () => async () => ({ outcome: { result: "FAIL", tokens: 0, cost: 0 } }),
}));
vi.mock("../../threeRepo/cliRoots.js", () => ({
  resolveDocsRoot: (root: string) => root,
  resolveThreeRepoTaskLookup: () => undefined,
}));
vi.mock("../../qa/changeSource.js", () => ({
  collectQaChangedFiles: async () => ({ files: [...observed.files], failedTargets: [] }),
  gitDiffSummary: async () => "",
}));
vi.mock("../../qa/optimized.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../qa/optimized.js")>(),
  withQaOptimization: (opts: QaOptimizationOptions) => async (req: Parameters<typeof opts.inner>[0]) => {
    observed.contracts.push(opts.taskContract?.(req));
    return opts.inner(req);
  },
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  observed.contracts.length = 0;
  observed.files.length = 0;
});

it("loads the PM plan and changed-file manifest anew for later stages of one composed executor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-qa-composition-"));
  roots.push(root);
  const store = new MemoryTaskStore();
  const taskId = "BE-FRESH";
  const orchestrator = new Orchestrator(taskId, classifyTask({ isNewFeatureModuleOrProject: true, touchesBackend: true }), {
    store, stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD,
  });
  const { executor } = await composeProductionTaskExecutor({
    projectRoot: root, module: "fresh", phases: [], autonomy: "edit",
    qaWorkRoots: () => [], stageRoots: {},
    runtimeSelection: () => ({ defaultRuntimeId: "claude-code" }),
  }, taskId, orchestrator, store, {
    createRuntimeRegistry: () => new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code" })]),
  });
  await executor({ taskId, stage: AgentStage.BUSINESS_ANALYST, context: [] });
  expect(observed.contracts).toEqual([undefined]);

  const moduleDir = path.join(root, "_docs/module/fresh");
  fs.mkdirSync(moduleDir, { recursive: true });
  const task = fixtureTask({ id: taskId, dependsOn: [] });
  fs.writeFileSync(path.join(moduleDir, "plan.md"), renderCanonicalTasks([task]));
  observed.files = ["src/first.ts"];
  await executor({ taskId, stage: AgentStage.REVIEWER, context: [] });
  expect(observed.contracts[1]).toMatchObject({ taskId, fileManifest: ["src/first.ts"] });

  observed.files = ["src/first.ts", "src/second.ts"];
  await executor({ taskId, stage: AgentStage.QA_ENGINEER, context: [] });
  expect(observed.contracts[2]).toMatchObject({ taskId, fileManifest: ["src/first.ts", "src/second.ts"] });
  // A later invocation must not mutate the earlier stage's evidence snapshot.
  expect(observed.contracts[1]?.fileManifest).toEqual(["src/first.ts"]);
});
