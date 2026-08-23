import { AgentStage } from "../types.js";

export interface RunRecord {
  task_id: string;
  agent: AgentStage;
  start_time: number;
  end_time: number;
  duration: number;
  /** Which model actually ran this stage (T26) — from `.claude/agents/<role>.md`'s frontmatter, not guessed. Null when the executor didn't resolve one (e.g. a test stub). */
  model: string | null;
  /** Which prompt version ran this stage (T57) — from the same file's `version:` frontmatter field. Null when absent (an agent file that predates T57, or a test stub) — log-only, never selects which prompt actually runs. */
  promptVersion: number | null;
  tokens: number;
  cost: number;
  result: "PASS" | "FAIL";
  retry_count: number;
  failure_reason: string | null;
  /** T28 breakdown of `tokens` — undefined callers (older executors, test stubs) still just get the combined total above. */
  input_tokens: number | null;
  output_tokens: number | null;
  /** Prompt-cache tokens read this run, per the CLI's own usage report (T28) — null when the executor doesn't report one. */
  cache_read_tokens: number | null;
  /** Size (characters) of the prompt actually sent this run (T28) — the context-size half of "token/context tracking", independent of the response's token usage. */
  context_chars: number | null;
  /** QA07 — the verify mode this qa-engineer round ran in, from its own report. Null for every non-QA stage (and for QA runs that predate the field). */
  qa_mode: "FULL" | "TARGETED" | null;
}

export interface RunOutcome {
  model?: string;
  promptVersion?: number;
  tokens: number;
  cost: number;
  result: "PASS" | "FAIL";
  retry_count?: number;
  failure_reason?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  context_chars?: number;
  qa_mode?: "FULL" | "TARGETED";
}

/**
 * In-memory recorder for the per-run metrics item 11 requires. Deliberately
 * append-only and never mutates a past record — item 15 (Run History) reads
 * this same log to answer "why did it fail / how many rounds / how much
 * token" per task, so a record written here must stay a trustworthy fact.
 *
 * `model`/`input_tokens`/`output_tokens`/`cache_read_tokens`/`context_chars` (T26/T28) are all
 * optional on the way in (`RunOutcome`) and nullable on the way out (`RunRecord`) rather than
 * required: an executor that doesn't resolve/report one (a test stub, an older executor build)
 * should not have to fabricate a value it doesn't have — `null` says "not reported", not "zero".
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
      model: params.outcome.model ?? null,
      promptVersion: params.outcome.promptVersion ?? null,
      tokens: params.outcome.tokens,
      cost: params.outcome.cost,
      result: params.outcome.result,
      retry_count: params.outcome.retry_count ?? 0,
      failure_reason: params.outcome.failure_reason ?? null,
      input_tokens: params.outcome.input_tokens ?? null,
      output_tokens: params.outcome.output_tokens ?? null,
      cache_read_tokens: params.outcome.cache_read_tokens ?? null,
      context_chars: params.outcome.context_chars ?? null,
      qa_mode: params.outcome.qa_mode ?? null,
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

  /**
   * Cost per agent for one task, TASKS.md T27's own example format
   * ("BA $0.20, Backend $1.20, … Total $3.55"). Sums by agent first — a task
   * an agent ran twice (a retry round) reports once, combined, not once per run.
   */
  costSummary(taskId: string): string {
    return renderCostSummary(this.runsForTask(taskId), this.totalCost(taskId));
  }

  /**
   * The same breakdown across every task belonging to one feature/module — T27
   * frames the example as "per feature", and a feature is usually more than one
   * task by the time it reaches `qa-engineer`. Callers pass the task IDs that
   * make up the feature (e.g. every `plan.md` task under one module folder).
   */
  costSummaryAcrossTasks(taskIds: readonly string[]): string {
    const runs = taskIds.flatMap((id) => this.runsForTask(id));
    const total = taskIds.reduce((sum, id) => sum + this.totalCost(id), 0);
    return renderCostSummary(runs, total);
  }
}

function renderCostSummary(runs: readonly RunRecord[], total: number): string {
  const byAgent = new Map<AgentStage, number>();
  for (const r of runs) {
    byAgent.set(r.agent, (byAgent.get(r.agent) ?? 0) + r.cost);
  }
  const money = (n: number) => `$${n.toFixed(2)}`;
  const parts = [...byAgent.entries()].map(([agent, cost]) => `${agent}: ${money(cost)}`);
  parts.push(`Total: ${money(total)}`);
  return parts.join(", ");
}
