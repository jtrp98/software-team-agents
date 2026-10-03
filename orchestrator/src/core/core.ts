import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type SqliteDatabase from "../store/sqliteDatabase.js";
import { openStore } from "../cli/support.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import { openCoreDb } from "./coreDb.js";
import { corePaths, type CorePaths } from "./corePaths.js";
import { changedFilesOfRun, projectBoundedRun } from "./engineProjection.js";
import { listKnowledge, listModules, resolveKnowledge } from "./knowledgeRegistry.js";
import { loadMachineConfig, type MachineConfig } from "./machineConfig.js";
import { childEnvironment, childProcessCommanderInvoker, productionSegmentLauncher, staCliEntry, type SegmentLauncher } from "./processes.js";
import type { CommanderInvoker } from "./commander.js";
import type { RuntimeConnectStatus } from "./runtimeConnect.js";
import { RuntimeHealthStore } from "./runtimeHealth.js";
import { classifyRuntimeResult } from "../runtime/runtimeFailureClass.js";
import { SecretStore } from "./secretStore.js";
import { WorkRunService, type TaskControl } from "./workRunService.js";
import { WorkRunStore } from "./workRunStore.js";

/**
 * The STA Core composition root: one place that wires the durable store,
 * runtime health, the work-run controller and the runtime-status cache. The
 * service (`sta start`) and the CLI (`sta work status`) both open the Core
 * through here, so there is exactly one implementation of every rule.
 */

export interface StaCore {
  readonly paths: CorePaths;
  readonly db: SqliteDatabase;
  readonly store: WorkRunStore;
  readonly health: RuntimeHealthStore;
  readonly runs: WorkRunService;
  readonly secrets: SecretStore;
  machine(): MachineConfig;
  runtimeStatus(): RuntimeConnectStatus[] | null;
  /** Re-detects every pool runtime in a child process and caches the result. */
  refreshRuntimeStatus(): Promise<RuntimeConnectStatus[]>;
  /**
   * Runtime "Test": one tiny read-only prompt through the same child path the
   * Commander uses, with the result recorded into runtime health. Proves the
   * runtime can actually serve a request (auth, quota), not only that
   * its binary exists.
   */
  testRuntime(runtimeId: string): Promise<{ ok: boolean; status: string; failureClass: string | null; detail: string }>;
  close(): void;
}

export interface OpenCoreOptions {
  home?: string;
  launcher?: SegmentLauncher;
  commander?: CommanderInvoker;
  tasks?: TaskControl;
  clock?: () => number;
  /** Test seam for runtime detection; production spawns `sta core detect-runtimes`. */
  detectRuntimes?: () => Promise<RuntimeConnectStatus[]>;
  secrets?: SecretStore;
}

/** Engine-side pause/unpause through the existing TaskRegistry — the same flag `sta pause <task-id>` sets. */
export const engineTaskControl: TaskControl = {
  pause(knowledgePath, boundedRunId) {
    return forEachOpenTask(knowledgePath, boundedRunId, (registry, taskId) => registry.pause(taskId));
  },
  unpause(knowledgePath, boundedRunId) {
    return forEachOpenTask(knowledgePath, boundedRunId, (registry, taskId) => registry.unpause(taskId));
  },
};

function forEachOpenTask(knowledgePath: string, boundedRunId: string, act: (registry: ReturnType<typeof openStore>["registry"], taskId: string) => void): string[] {
  const { store, registry } = openStore(knowledgePath);
  const ledger = new SqliteRunLedger(store, { projectRoot: knowledgePath });
  try {
    const touched: string[] = [];
    for (const task of ledger.readTasks(boundedRunId)) {
      if (task.status === "DONE") continue;
      if (!registry.has(task.task_id)) continue;
      act(registry, task.task_id);
      touched.push(task.task_id);
    }
    return touched;
  } finally {
    ledger.close();
    registry.close();
  }
}

function runtimeStatusFile(paths: CorePaths): string {
  return path.join(path.dirname(paths.database), "runtime-status.json");
}

/** Production runtime detection: `sta core detect-runtimes --output <file>` in a child, so the service never blocks. */
export function detectRuntimesInChild(paths: CorePaths): Promise<RuntimeConnectStatus[]> {
  const output = runtimeStatusFile(paths) + ".tmp";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [staCliEntry(), "core", "detect-runtimes", "--output", output], { windowsHide: true, stdio: "ignore", env: childEnvironment() });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", () => {
      clearTimeout(timer);
      try {
        const statuses = JSON.parse(fs.readFileSync(output, "utf8")) as RuntimeConnectStatus[];
        fs.renameSync(output, runtimeStatusFile(paths));
        resolve(statuses);
      } catch (error) {
        reject(new Error(`runtime detection produced no result: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

export function openCore(options: OpenCoreOptions = {}): StaCore {
  const paths = corePaths(options.home);
  const db = openCoreDb(paths.database);
  const machine = (): MachineConfig => loadMachineConfig(paths.machineConfig);
  const health = new RuntimeHealthStore(db, machine().health, options.clock);
  const store = new WorkRunStore(db, options.clock);
  let cached: RuntimeConnectStatus[] | null = null;
  const statusFile = runtimeStatusFile(paths);
  const runtimeStatus = (): RuntimeConnectStatus[] | null => {
    if (cached) return cached;
    try {
      cached = JSON.parse(fs.readFileSync(statusFile, "utf8")) as RuntimeConnectStatus[];
    } catch {
      cached = null;
    }
    return cached;
  };
  const runs = new WorkRunService({
    store,
    health,
    machine,
    launcher: options.launcher ?? productionSegmentLauncher,
    commander: options.commander ?? childProcessCommanderInvoker({ home: paths.home }),
    runtimeStatus,
    project: projectBoundedRun,
    changedFiles: changedFilesOfRun,
    tasks: options.tasks ?? engineTaskControl,
    resolveKnowledge: (name) => resolveKnowledge(name, paths.installationConfig),
    listModules,
    listTargets: (knowledgePath) => {
      const found = listKnowledge({ configPath: paths.installationConfig }).find((entry) => path.resolve(entry.path) === path.resolve(knowledgePath));
      return found?.targets.map((target) => target.targetId) ?? [];
    },
    healthDbPath: paths.database,
    home: paths.home,
    clock: options.clock,
  });
  return {
    paths,
    db,
    store,
    health,
    runs,
    secrets: options.secrets ?? new SecretStore(paths.secretsDir),
    machine,
    runtimeStatus,
    async refreshRuntimeStatus() {
      const statuses = await (options.detectRuntimes ?? (() => detectRuntimesInChild(paths)))();
      cached = statuses;
      if (options.detectRuntimes) {
        fs.mkdirSync(path.dirname(statusFile), { recursive: true });
        fs.writeFileSync(statusFile, JSON.stringify(statuses, null, 2), "utf8");
      }
      return statuses;
    },
    async testRuntime(runtimeId) {
      const invoker = options.commander ?? childProcessCommanderInvoker({ home: paths.home, timeoutMs: 5 * 60_000 });
      let cwd = paths.home;
      try { cwd = resolveKnowledge(undefined, paths.installationConfig).path; } catch { /* no Knowledge yet: run in the Core home */ }
      const result = await invoker.invoke({ runtimeId, cwd, runId: "runtime-test", prompt: 'Connectivity check from STA Core. Do not use tools. Reply with exactly: {"ok": true}' });
      const failureClass = classifyRuntimeResult(result);
      if (result.status === "OK") health.recordSuccess(runtimeId, { role: "test" });
      else health.recordFailure({ runtimeId, failureClass: failureClass ?? "EXECUTION_ERROR", reason: result.diagnostics.join("; ").slice(0, 500) || result.status, role: "test", ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}) });
      return { ok: result.status === "OK", status: result.status, failureClass, detail: result.status === "OK" ? result.text.slice(0, 200) : result.diagnostics.join("; ").slice(0, 500) };
    },
    close() {
      db.close();
    },
  };
}
