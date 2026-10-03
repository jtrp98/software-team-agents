import * as fs from "node:fs";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { defaultStateDbPath } from "../store/stateView.js";
import { SqliteRunLedger } from "../ledger/sqliteRunLedger.js";
import { engineViewOfRun } from "../engine/boundedRunService.js";
import { GitCommandLayer } from "../git/commandLayer.js";
import { AgentStage } from "../types.js";

/**
 * A read-only projection of one bounded run, for the Runs/Review pages.
 *
 * Everything comes from the run's OWN Knowledge root (`<knowledge>/.workflow/
 * state.db`) — the root pinned in the work run — so one run's view can never
 * include another Knowledge root's tasks. It reads the engine's projection
 * (`engineViewOfRun`, the same one `sta status` prints) and the ledger; it
 * writes nothing.
 */

export interface ProjectedTask {
  taskId: string;
  phase: number;
  owner: string;
  status: string;
  state: string | null;
  stage: string | null;
  reason: string;
  attempts: Array<{ stage: string; attempt: number; status: string; runtime: string; model: string | null }>;
  findings: number;
  retries: { review: number; qa: number; security: number } | null;
}

export interface BoundedRunProjection {
  runId: string;
  status: string;
  boundary: string;
  module: string;
  knowledgeRoot: string;
  targetId: string;
  targetRoot: string;
  baseBranch: string;
  baseSha: string;
  runBranch: string;
  tasks: ProjectedTask[];
  checkpoints: number;
  currentTask: string | null;
  currentStage: string | null;
  verification: {
    reviewPassed: number;
    qaPassed: number;
    securityPassed: number;
    checkpointed: number;
    done: number;
    total: number;
  };
}

const VERIFIER_EVENTS = { REVIEW_PASSED: "reviewPassed", QA_PASSED: "qaPassed", SECURITY_PASSED: "securityPassed" } as const;

export function projectBoundedRun(knowledgePath: string, boundedRunId: string): BoundedRunProjection | null {
  const dbPath = defaultStateDbPath(knowledgePath);
  if (!fs.existsSync(dbPath)) return null;
  const store = new SqliteTaskStore(dbPath);
  const ledger = new SqliteRunLedger(store, { projectRoot: knowledgePath });
  try {
    const run = ledger.readRun(boundedRunId);
    if (!run) return null;
    const views = engineViewOfRun(ledger, store, run);
    const verification = { reviewPassed: 0, qaPassed: 0, securityPassed: 0, checkpointed: 0, done: 0, total: views.length };
    let currentTask: string | null = null;
    let currentStage: string | null = null;
    const tasks: ProjectedTask[] = views.map((item) => {
      const persisted = store.loadTask(item.task.task_id);
      for (const event of store.eventsForTask(item.task.task_id)) {
        const key = VERIFIER_EVENTS[event.type as keyof typeof VERIFIER_EVENTS];
        if (key) verification[key] += 1;
      }
      if (item.status === "DONE") verification.done += 1;
      if (item.status === "CHECKPOINTED") verification.checkpointed += 1;
      const stage = persisted && persisted.pipelineCursor < persisted.machine.pipeline.length
        ? String(persisted.machine.pipeline[persisted.pipelineCursor])
        : null;
      if (!currentTask && item.status !== "DONE" && item.status !== "PLANNED" && stage && stage !== AgentStage.HUMAN) {
        currentTask = item.task.task_id;
        currentStage = stage;
      }
      return {
        taskId: item.task.task_id,
        phase: item.task.phase,
        owner: item.task.owner,
        status: item.status,
        state: persisted?.machine.current ?? null,
        stage,
        reason: item.reason,
        attempts: ledger.attemptsForTask(run.run_id, item.task.task_id).map((attempt) => ({
          stage: attempt.stage,
          attempt: attempt.attempt,
          status: attempt.status,
          runtime: attempt.observed.runtime,
          model: attempt.observed.model,
        })),
        findings: ledger.findingsFor(item.task.task_id).length,
        retries: ledger.retriesFor(item.task.task_id),
      };
    });
    return {
      runId: run.run_id,
      status: run.status,
      boundary: run.boundary,
      module: run.module,
      knowledgeRoot: run.knowledge_root,
      targetId: run.target_id,
      targetRoot: run.target_root,
      baseBranch: run.base_branch,
      baseSha: run.base_sha,
      runBranch: run.run_branch,
      tasks,
      checkpoints: ledger.checkpointsForRun(run.run_id).length,
      currentTask,
      currentStage,
      verification,
    };
  } finally {
    ledger.close();
    store.close();
  }
}

export interface ChangedFile {
  status: string;
  path: string;
}

/** Files the run branch changed relative to its frozen base — through the closed, read-only Git layer. */
export async function changedFilesOfRun(projection: Pick<BoundedRunProjection, "targetRoot" | "baseSha" | "runBranch">): Promise<ChangedFile[]> {
  const git = new GitCommandLayer({ cwd: projection.targetRoot });
  const out = await git.diffNameStatus(`${projection.baseSha}..${projection.runBranch}`);
  return out.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [status, ...rest] = line.split(/\t/);
    return { status: status ?? "?", path: rest.join(" → ") };
  });
}

export async function diffOfRun(projection: Pick<BoundedRunProjection, "targetRoot" | "baseSha" | "runBranch">, limitBytes = 400_000): Promise<{ diff: string; truncated: boolean }> {
  const git = new GitCommandLayer({ cwd: projection.targetRoot });
  const out = await git.diffPatch(`${projection.baseSha}..${projection.runBranch}`);
  return out.stdout.length > limitBytes ? { diff: out.stdout.slice(0, limitBytes), truncated: true } : { diff: out.stdout, truncated: false };
}
