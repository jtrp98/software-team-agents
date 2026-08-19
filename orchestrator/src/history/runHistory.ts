import { RunLog, type RunRecord } from "../observability/runLog.js";
import type { AgentStage } from "../types.js";

/**
 * Groups per-agent RunLog records (item 11) into numbered attempts per task —
 * "Run #1 / #2 / #3" from task-detail.md item 15. A new attempt is a
 * fresh RunLog: a task that got BLOCKED and was restarted by a human gets a
 * second attempt, not more rows appended to the first.
 */
export class RunHistory {
  private attempts = new Map<string, RunLog[]>();

  record(taskId: string, log: RunLog): void {
    const list = this.attempts.get(taskId) ?? [];
    list.push(log);
    this.attempts.set(taskId, list);
  }

  attemptsFor(taskId: string): RunLog[] {
    return this.attempts.get(taskId) ?? [];
  }

  attemptCount(taskId: string): number {
    return this.attemptsFor(taskId).length;
  }

  private allRecords(taskId: string): RunRecord[] {
    return this.attemptsFor(taskId).flatMap((log) => log.runsForTask(taskId));
  }

  totalTokens(taskId: string): number {
    return this.allRecords(taskId).reduce((sum, r) => sum + r.tokens, 0);
  }

  /** "Agent ไหน fail?" — every agent with at least one FAIL record, across every attempt. */
  failedAgents(taskId: string): AgentStage[] {
    const seen = new Set<AgentStage>();
    for (const r of this.allRecords(taskId)) {
      if (r.result === "FAIL") seen.add(r.agent);
    }
    return [...seen];
  }

  /** "ทำไม fail?" — every recorded failure_reason, across every attempt, in order. */
  failureReasons(taskId: string): string[] {
    return this.allRecords(taskId)
      .filter((r): r is RunRecord & { failure_reason: string } => r.result === "FAIL" && r.failure_reason !== null)
      .map((r) => r.failure_reason);
  }

  /** "แก้ไปกี่รอบ?" — total FAIL rounds across every attempt (each one triggered a fix-and-recheck). */
  retryRoundsUsed(taskId: string): number {
    return this.allRecords(taskId).filter((r) => r.result === "FAIL").length;
  }

  /** Multi-attempt summary combining each attempt's item-11 format under a "Run #N" heading. */
  summary(taskId: string): string {
    const attempts = this.attemptsFor(taskId);
    return attempts.map((log, i) => `Run #${i + 1}\n${log.summary(taskId)}`).join("\n\n");
  }
}
