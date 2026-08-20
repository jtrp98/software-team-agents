import { AgentStage } from "../types.js";
import { classifyTask, type ClassificationInput } from "../classification/taskClassifier.js";
import { Orchestrator, type AgentExecutor } from "../orchestrator/orchestrator.js";
import { ApprovalType } from "../gates/approval.js";

export interface BenchmarkCase {
  id: string;
  classification: ClassificationInput;
  executor: AgentExecutor;
  /** Set false to test that a case correctly stalls on a human gate instead of auto-approving through it. */
  approveHumanGates?: boolean;
}

export interface BenchmarkCaseResult {
  id: string;
  status: "DEPLOYED" | "BLOCKED" | "WAITING_FOR_HUMAN";
  /** Only set when status is BLOCKED — the Orchestrator's own reason, feeding item 17's failure-pattern analysis. */
  blockedReason?: string;
  hasSecurityStage: boolean;
  securityFailedAtLeastOnce: boolean;
  tokens: number;
  cost: number;
  durationMs: number;
}

const MAX_STEPS_PER_CASE = 50;

export async function runBenchmarkCase(bc: BenchmarkCase, now: () => number = Date.now): Promise<BenchmarkCaseResult> {
  const classification = classifyTask(bc.classification);
  const orch = new Orchestrator(bc.id, classification);
  let securityFailedAtLeastOnce = false;
  orch.events.on("AGENT_COMPLETED", (e) => {
    if (e.stage === AgentStage.SECURITY && e.outcome.result === "FAIL") securityFailedAtLeastOnce = true;
  });

  let status = await orch.step(bc.executor, now);
  for (let steps = 0; status.kind !== "DEPLOYED" && status.kind !== "BLOCKED" && steps < MAX_STEPS_PER_CASE; steps++) {
    if (status.kind === "WAITING_FOR_HUMAN") {
      if (bc.approveHumanGates === false) break;
      // Keyed on approvalType, not on `to`: T20's test-planner (like project-manager
      // before it, for the "feature" pipeline) can sit between DESIGN and
      // IMPLEMENTATION, so the gate's target state is not always IMPLEMENTATION itself.
      const field = status.approvalType === ApprovalType.SCHEMA_CONFIRMATION ? "designApproved" : "humanApproved";
      orch.provideHumanApproval(field, true);
    }
    status = await orch.step(bc.executor, now);
  }

  const records = orch.runLog.all();
  return {
    id: bc.id,
    status: status.kind === "DEPLOYED" || status.kind === "BLOCKED" ? status.kind : "WAITING_FOR_HUMAN",
    blockedReason: status.kind === "BLOCKED" ? status.reason : undefined,
    hasSecurityStage: classification.pipeline.includes(AgentStage.SECURITY),
    securityFailedAtLeastOnce,
    tokens: records.reduce((sum, r) => sum + r.tokens, 0),
    cost: records.reduce((sum, r) => sum + r.cost, 0),
    durationMs: records.reduce((sum, r) => sum + r.duration, 0),
  };
}

export interface BenchmarkResult {
  size: number;
  /** Correctness: fraction of cases that reached DEPLOYED. */
  successRate: number;
  totalTokens: number;
  totalCost: number;
  totalDurationMs: number;
  /** Security: fraction of security-gated cases where security failed at least once before passing. */
  securityFailureRate: number;
  caseResults: BenchmarkCaseResult[];
}

export async function runBenchmark(cases: BenchmarkCase[]): Promise<BenchmarkResult> {
  const caseResults: BenchmarkCaseResult[] = [];
  for (const c of cases) {
    caseResults.push(await runBenchmarkCase(c));
  }

  const securityGated = caseResults.filter((r) => r.hasSecurityStage);
  const securityFailed = securityGated.filter((r) => r.securityFailedAtLeastOnce);

  return {
    size: caseResults.length,
    successRate: caseResults.length === 0 ? 0 : caseResults.filter((r) => r.status === "DEPLOYED").length / caseResults.length,
    totalTokens: caseResults.reduce((s, r) => s + r.tokens, 0),
    totalCost: caseResults.reduce((s, r) => s + r.cost, 0),
    totalDurationMs: caseResults.reduce((s, r) => s + r.durationMs, 0),
    securityFailureRate: securityGated.length === 0 ? 0 : securityFailed.length / securityGated.length,
    caseResults,
  };
}

/**
 * Consistency: runs the same set of cases `runs` times and reports the
 * fraction of cases whose final status was identical every time. A
 * deterministic executor should score 1.0; this exists to catch the case
 * where it doesn't (flaky agent behavior, non-deterministic routing bugs).
 */
export async function checkConsistency(cases: BenchmarkCase[], runs = 3): Promise<number> {
  if (cases.length === 0) return 1;
  let consistentCount = 0;
  for (const c of cases) {
    const statuses = new Set<string>();
    for (let i = 0; i < runs; i++) {
      const result = await runBenchmarkCase(c);
      statuses.add(result.status);
    }
    if (statuses.size === 1) consistentCount++;
  }
  return consistentCount / cases.length;
}

/** Regression: a named benchmark run is worse than baseline if its success rate dropped. */
export function detectRegression(baseline: BenchmarkResult, candidate: BenchmarkResult): { regressed: boolean; successRateDelta: number } {
  const successRateDelta = candidate.successRate - baseline.successRate;
  return { regressed: successRateDelta < 0, successRateDelta };
}

/** Renders the task-detail.md item 16 comparison format: benchmark_size + named success_rate rows. */
export function formatComparison(named: Record<string, BenchmarkResult>): string {
  const entries = Object.entries(named);
  const size = entries[0]?.[1]?.size ?? 0;
  const lines = entries.map(([name, r]) => `  ${name}: { success_rate: ${Math.round(r.successRate * 100)}% }`);
  return [`benchmark_size: ${size} tasks`, "", "results:", ...lines].join("\n");
}
