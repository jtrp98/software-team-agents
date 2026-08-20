import { AgentStage } from "../types.js";

export interface RunRecord {
  task_id: string;
  agent: AgentStage;
  start_time: number;
  end_time: number;
  duration: number;
  tokens: number;
  cost: number;
  result: "PASS" | "FAIL";
  retry_count: number;
  failure_reason: string | null;
}

export interface RunOutcome {
  tokens: number;
  cost: number;
  result: "PASS" | "FAIL";
  retry_count?: number;
  failure_reason?: string | null;
}

/**
 * In-memory recorder for the per-run metrics item 11 requires. Deliberately
 * append-only and never mutates a past record — item 15 (Run History) reads
 * this same log to answer "why did it fail / how many rounds / how much
 * token" per task, so a record written here must stay a trustworthy fact.
 */
export class RunLog {
  private records: RunRecord[];

  /**
   * Seeded with the runs a previous process already logged when a task is
   * resumed from a store, empty for a fresh task. Copied on the way in: this
   * log stays append-only and never shares an array with its caller.
   */
  constructor(initial: readonly RunRecord[] = []) {
    this.records = initial.map((r) => ({ ...r }));
  }

  record(params: {
    task_id: string;
    agent: AgentStage;
    start_time: number;
    end_time: number;
    outcome: RunOutcome;
  }): RunRecord {
    const entry: RunRecord = {
      task_id: params.task_id,
      agent: params.agent,
      start_time: params.start_time,
      end_time: params.end_time,
      duration: params.end_time - params.start_time,
      tokens: params.outcome.tokens,
      cost: params.outcome.cost,
      result: params.outcome.result,
      retry_count: params.outcome.retry_count ?? 0,
      failure_reason: params.outcome.failure_reason ?? null,
    };
    this.records.push(entry);
    return entry;
  }

  runsForTask(taskId: string): RunRecord[] {
    return this.records.filter((r) => r.task_id === taskId);
  }

  totalTokens(taskId: string): number {
    return this.runsForTask(taskId).reduce((sum, r) => sum + r.tokens, 0);
  }

  totalCost(taskId: string): number {
    return this.runsForTask(taskId).reduce((sum, r) => sum + r.cost, 0);
  }

  all(): readonly RunRecord[] {
    return this.records;
  }

  /** Renders the TASK-123-style summary shown in task-detail.md item 11 (tokens are raw counts, displayed in k). */
  summary(taskId: string): string {
    const runs = this.runsForTask(taskId);
    const toK = (n: number) => `${Math.round(n / 1000)}k`;
    const lines = runs.map((r) => `  ${r.agent.padEnd(18)} ${toK(r.tokens).padStart(6)} tokens  ${r.result}`);
    return [taskId, ...lines, "", `Total: ${toK(this.totalTokens(taskId))} tokens`].join("\n");
  }
}
