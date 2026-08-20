import type { AgentStage } from "../types.js";
import type { RunRecord } from "../observability/runLog.js";

/**
 * Per-agent aggregate score (T30) — TASKS.md's own example: "Success 91%, First-pass 76%,
 * Rework 18%, Avg cost $0.83". Distinct from T29's benchmark metrics, which score one run of a
 * fixed case set; this scores an agent's real track record across every task it has ever run,
 * so a prompt change can be judged against actual history instead of a hand-picked sample.
 */
export interface AgentQualityScore {
  agent: AgentStage;
  /** Distinct (agent, task) pairs this agent has ever run for — the denominator of every rate below. */
  totalTasks: number;
  /** Fraction of tasks whose most recent run of this agent ended PASS — "did it eventually succeed". */
  successRate: number;
  /** Fraction of tasks where this agent's very first run on it was PASS, no retry ever needed. */
  firstPassRate: number;
  /** Fraction of tasks that needed more than one run of this agent — the complement view of firstPassRate, kept separate because "first-pass" and "rework" answer different questions (a task can need rework and still eventually succeed). */
  reworkRate: number;
  /** Mean cost per individual run (not per task) — a task reworked twice counts its cost three times, since that is real spend. */
  avgCost: number;
}

/**
 * Groups records by (agent, task_id) and scores each agent across every task it touched.
 * Records are expected in chronological order per group (RunLog's natural append order) —
 * "first run" and "most recent run" are read positionally, not by re-sorting on a timestamp
 * that a resumed/merged log might not have consistently.
 */
export function computeAgentQualityScores(records: readonly RunRecord[]): AgentQualityScore[] {
  const byAgent = new Map<AgentStage, RunRecord[]>();
  for (const r of records) {
    const list = byAgent.get(r.agent) ?? [];
    list.push(r);
    byAgent.set(r.agent, list);
  }

  const scores: AgentQualityScore[] = [];
  for (const [agent, agentRecords] of byAgent) {
    const byTask = new Map<string, RunRecord[]>();
    for (const r of agentRecords) {
      const list = byTask.get(r.task_id) ?? [];
      list.push(r);
      byTask.set(r.task_id, list);
    }
    const taskGroups = [...byTask.values()];
    const totalTasks = taskGroups.length;

    const succeeded = taskGroups.filter((g) => g[g.length - 1].result === "PASS").length;
    const firstPass = taskGroups.filter((g) => g.length === 1 && g[0].result === "PASS").length;
    const reworked = taskGroups.filter((g) => g.length > 1).length;
    const avgCost = agentRecords.reduce((sum, r) => sum + r.cost, 0) / agentRecords.length;

    scores.push({
      agent,
      totalTasks,
      successRate: totalTasks === 0 ? 0 : succeeded / totalTasks,
      firstPassRate: totalTasks === 0 ? 0 : firstPass / totalTasks,
      reworkRate: totalTasks === 0 ? 0 : reworked / totalTasks,
      avgCost,
    });
  }
  return scores;
}

/** Renders TASKS.md T30's own example line shape, one agent per line, sorted by agent name for a stable report. */
export function formatQualityScoreReport(scores: readonly AgentQualityScore[]): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const money = (n: number) => `$${n.toFixed(2)}`;
  return [...scores]
    .sort((a, b) => a.agent.localeCompare(b.agent))
    .map((s) => `${s.agent}: Success ${pct(s.successRate)}, First-pass ${pct(s.firstPassRate)}, Rework ${pct(s.reworkRate)}, Avg cost ${money(s.avgCost)}`)
    .join("\n");
}
