import { AgentStage } from "../types.js";
import type { ChangeSetFingerprint } from "../qa/changeSource.js";

export interface RunRecord {
  task_id: string;
  agent: AgentStage;
  start_time: number;
  end_time: number;
  duration: number;
  /** Which model actually ran this stage — from `.claude/agents/<role>.md`'s frontmatter, not guessed. Null when the executor didn't resolve one (e.g. a test stub). */
  model: string | null;
  /** Which prompt version ran this stage — from the same file's `version:` frontmatter field. Null when absent (or a test stub) — log-only, never selects which prompt actually runs. */
  promptVersion: number | null;
  /** Agent-frontmatter reasoning effort; distinct from the QA risk gate's qa_effort. */
  effort: string | null;
  tokens: number;
  cost: number;
  result: "PASS" | "FAIL";
  retry_count: number;
  failure_reason: string | null;
  /** Breakdown of `tokens` — undefined callers (older executors, test stubs) still just get the combined total above. */
  input_tokens: number | null;
  output_tokens: number | null;
  /** Prompt-cache tokens read this run, per the CLI's own usage report — null when the executor doesn't report one. */
  cache_read_tokens: number | null;
  /** Size (characters) of the prompt actually sent this run — the context-size half of "token/context tracking", independent of the response's token usage. */
  context_chars: number | null;
  /** Deterministic input-token approximation from context_chars; null for historical rows. */
  estimated_input_tokens: number | null;
  /** Runtime id reported by the executor/session launcher. Null for historical rows. */
  runtime: string | null;
  /** Runtime requested before routing/fallback. Null when that decision was not reported. */
  requested_runtime: string | null;
  /** Model requested before routing/fallback. Null when that decision was not reported. */
  requested_model: string | null;
  /** Precedence level that selected the route. Null for older and unreported runs. */
  routing_basis: string | null;
  /** Why the requested route changed. Null means no reason was reported, not that fallback did not occur. */
  fallback_reason: string | null;
  /** Number of fallback hops. Null when routing did not report a count. */
  fallback_count: number | null;
  /** Whether this row came from an orchestrated stage or an interactive role session. */
  session_kind: "orchestrated" | "interactive" | null;
  /** Prompt composition fields are null when that path did not measure the component, never a fabricated zero. */
  static_chars: number | null;
  /** Exact always-on instruction bytes measured before an interactive runtime launched. */
  instruction_surface_bytes?: number | null;
  handoff_chars: number | null;
  doc_chars: number | null;
  /** Full module-document bytes before ContextManager sliced this prompt. */
  doc_chars_before: number | null;
  knowledge_chars: number | null;
  code_intel_chars: number | null;
  tool_output_chars: number | null;
  /** Warning-mode context threshold and outcome; null means no authoritative budget was configured. */
  context_budget_chars: number | null;
  context_budget_source: "role" | "model_context_window" | null;
  context_overflow_chars: number | null;
  context_budget_warning: boolean | null;
  /** Complete priority-class accounting. These sum exactly to context_chars when measured. */
  context_base_chars: number | null;
  context_task_chars: number | null;
  context_safety_chars: number | null;
  context_docs_chars: number | null;
  context_knowledge_chars: number | null;
  context_code_chars: number | null;
  context_tool_output_chars: number | null;
  context_reserve_chars: number | null;
  /** The verify mode this qa-engineer round ran in, from its own report. Null for every non-QA stage (and for QA runs that predate the field). */
  qa_mode: "FULL" | "TARGETED" | null;
  /** Orthogonal model-reasoning effort selected by the deterministic risk gate. */
  qa_effort: "skip" | "lightweight" | "full" | null;
  /** Whether this optimized QA round ran deterministic checks, or used the explicit escape hatch. */
  deterministic_gate: "enabled" | "disabled" | null;
  /** Source snapshot captured for a QA/security verdict; null when absent. */
  verification_fingerprint?: ChangeSetFingerprint | null;
}

export interface RunOutcome {
  model?: string;
  promptVersion?: number;
  effort?: string;
  tokens: number;
  cost: number;
  result: "PASS" | "FAIL";
  retry_count?: number;
  failure_reason?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  context_chars?: number;
  estimated_input_tokens?: number;
  runtime?: string;
  requested_runtime?: string;
  requested_model?: string;
  routing_basis?: string;
  fallback_reason?: string;
  fallback_count?: number;
  session_kind?: "orchestrated" | "interactive";
  static_chars?: number;
  instruction_surface_bytes?: number;
  handoff_chars?: number;
  doc_chars?: number;
  doc_chars_before?: number;
  knowledge_chars?: number;
  code_intel_chars?: number;
  tool_output_chars?: number;
  context_budget_chars?: number;
  context_budget_source?: "role" | "model_context_window";
  context_overflow_chars?: number;
  context_budget_warning?: boolean;
  context_base_chars?: number;
  context_task_chars?: number;
  context_safety_chars?: number;
  context_docs_chars?: number;
  context_knowledge_chars?: number;
  context_code_chars?: number;
  context_tool_output_chars?: number;
  context_reserve_chars?: number;
  qa_mode?: "FULL" | "TARGETED";
  qa_effort?: "skip" | "lightweight" | "full";
  deterministic_gate?: "enabled" | "disabled";
  verification_fingerprint?: ChangeSetFingerprint;
}

const NOT_REPORTED = "not reported";

function reported(value: string | number | null): string {
  return value === null ? NOT_REPORTED : String(value);
}

/**
 * One canonical requested-to-actual route rendering for status, list, and
 * audit views. Nullable historical fields are deliberately explicit: blank
 * output would make an unknown route look like a same-runner decision.
 */
export function formatRunRouting(run: RunRecord): string {
  const effort = reported(run.effort);
  return `runner=${reported(run.requested_runtime)} → ${reported(run.runtime)} ` +
    `model=${reported(run.requested_model)} → ${reported(run.model)} ` +
    `effort=${effort} basis=${reported(run.routing_basis)} fallback_count=${reported(run.fallback_count)} ` +
    `fallback_reason=${reported(run.fallback_reason)}`;
}

/**
 * In-memory recorder for per-run metrics. Deliberately append-only and never
 * mutates a past record — Run History reads this same log to answer "why did
 * it fail / how many rounds / how much token" per task, so a record written
 * here must stay a trustworthy fact.
 *
 * `model`/`input_tokens`/`output_tokens`/`cache_read_tokens`/`context_chars` are all
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
      effort: params.outcome.effort ?? null,
      tokens: params.outcome.tokens,
      cost: params.outcome.cost,
      result: params.outcome.result,
      retry_count: params.outcome.retry_count ?? 0,
      failure_reason: params.outcome.failure_reason ?? null,
      input_tokens: params.outcome.input_tokens ?? null,
      output_tokens: params.outcome.output_tokens ?? null,
      cache_read_tokens: params.outcome.cache_read_tokens ?? null,
      context_chars: params.outcome.context_chars ?? null,
      estimated_input_tokens: params.outcome.estimated_input_tokens ?? null,
      runtime: params.outcome.runtime ?? null,
      requested_runtime: params.outcome.requested_runtime ?? null,
      requested_model: params.outcome.requested_model ?? null,
      routing_basis: params.outcome.routing_basis ?? null,
      fallback_reason: params.outcome.fallback_reason ?? null,
      fallback_count: params.outcome.fallback_count ?? null,
      session_kind: params.outcome.session_kind ?? null,
      static_chars: params.outcome.static_chars ?? null,
      instruction_surface_bytes: params.outcome.instruction_surface_bytes ?? null,
      handoff_chars: params.outcome.handoff_chars ?? null,
      doc_chars: params.outcome.doc_chars ?? null,
      doc_chars_before: params.outcome.doc_chars_before ?? null,
      knowledge_chars: params.outcome.knowledge_chars ?? null,
      code_intel_chars: params.outcome.code_intel_chars ?? null,
      tool_output_chars: params.outcome.tool_output_chars ?? null,
      context_budget_chars: params.outcome.context_budget_chars ?? null,
      context_budget_source: params.outcome.context_budget_source ?? null,
      context_overflow_chars: params.outcome.context_overflow_chars ?? null,
      context_budget_warning: params.outcome.context_budget_warning ?? null,
      context_base_chars: params.outcome.context_base_chars ?? null,
      context_task_chars: params.outcome.context_task_chars ?? null,
      context_safety_chars: params.outcome.context_safety_chars ?? null,
      context_docs_chars: params.outcome.context_docs_chars ?? null,
      context_knowledge_chars: params.outcome.context_knowledge_chars ?? null,
      context_code_chars: params.outcome.context_code_chars ?? null,
      context_tool_output_chars: params.outcome.context_tool_output_chars ?? null,
      context_reserve_chars: params.outcome.context_reserve_chars ?? null,
      qa_mode: params.outcome.qa_mode ?? null,
      qa_effort: params.outcome.qa_effort ?? null,
      deterministic_gate: params.outcome.deterministic_gate ?? null,
      ...(params.outcome.verification_fingerprint ? { verification_fingerprint: params.outcome.verification_fingerprint } : {}),
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

  /** Renders the TASK-123-style summary (tokens are raw counts, displayed in k). */
  summary(taskId: string): string {
    const runs = this.runsForTask(taskId);
    const toK = (n: number) => `${Math.round(n / 1000)}k`;
    const lines = runs.map((r) =>
      `  ${r.agent.padEnd(18)} ${toK(r.tokens).padStart(6)} tokens  ${r.result}  ${formatRunRouting(r)}`,
    );
    return [taskId, ...lines, "", `Total: ${toK(this.totalTokens(taskId))} tokens`].join("\n");
  }

  /**
   * Cost per agent for one task, formatted per agent plus total
   * ("BA $0.20, Backend $1.20, … Total $3.55"). Sums by agent first — a task
   * an agent ran twice (a retry round) reports once, combined, not once per run.
   */
  costSummary(taskId: string): string {
    return renderCostSummary(this.runsForTask(taskId), this.totalCost(taskId));
  }

  /**
   * The same breakdown across every task belonging to one feature/module — a feature is usually more than one
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
