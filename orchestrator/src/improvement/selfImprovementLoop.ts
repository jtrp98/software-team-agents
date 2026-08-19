import type { BenchmarkCase, BenchmarkResult } from "../evaluation/benchmark.js";
import { detectRegression, runBenchmark } from "../evaluation/benchmark.js";

/** "Failure Patterns" from task-detail.md item 17 — BLOCKED cases grouped by the reason they blocked on. */
export interface FailurePattern {
  reason: string;
  count: number;
  caseIds: string[];
}

export function analyzeFailurePatterns(result: BenchmarkResult): FailurePattern[] {
  const groups = new Map<string, string[]>();
  for (const c of result.caseResults) {
    if (c.status !== "BLOCKED") continue;
    const key = c.blockedReason ?? "unknown";
    const arr = groups.get(key) ?? [];
    arr.push(c.id);
    groups.set(key, arr);
  }
  return [...groups.entries()]
    .map(([reason, caseIds]) => ({ reason, count: caseIds.length, caseIds }))
    .sort((a, b) => b.count - a.count);
}

export type ProposalStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "APPLIED";

/** "Improvement Proposal" — a rule/skill change suggested from a failure pattern, never applied on its own say-so. */
export interface ImprovementProposal {
  id: string;
  reason: string;
  description: string;
  status: ProposalStatus;
}

export function proposeImprovement(pattern: FailurePattern, id: string, description: string): ImprovementProposal {
  return { id, reason: pattern.reason, description, status: "PROPOSED" };
}

export class ProposalStateError extends Error {
  constructor(proposal: ImprovementProposal, action: string) {
    super(`cannot ${action} proposal ${proposal.id}: it is ${proposal.status}, not the expected state`);
    this.name = "ProposalStateError";
  }
}

/** "Human Approval" — the one and only place a proposal's fate is decided; nothing here can auto-approve itself. */
export function decideProposal(proposal: ImprovementProposal, approved: boolean): ImprovementProposal {
  if (proposal.status !== "PROPOSED") {
    throw new ProposalStateError(proposal, "decide");
  }
  return { ...proposal, status: approved ? "APPROVED" : "REJECTED" };
}

/**
 * "Update Rules/Skills" — marks a proposal applied. This function does not
 * and cannot touch actual rule/skill files itself (that's a human/engineer
 * action outside this system); it only enforces that nothing reaches APPLIED
 * without having passed through APPROVED first.
 */
export function markApplied(proposal: ImprovementProposal): ImprovementProposal {
  if (proposal.status !== "APPROVED") {
    throw new ProposalStateError(proposal, "apply");
  }
  return { ...proposal, status: "APPLIED" };
}

export interface ImprovementCycleResult {
  before: BenchmarkResult;
  patterns: FailurePattern[];
  /** Only present once re-evaluation has actually run (i.e. after an approved proposal was applied and re-run). */
  after?: BenchmarkResult;
  regressed?: boolean;
}

/**
 * Runs the closed loop from task-detail.md item 17:
 * Results -> Evaluation -> Failure Patterns -> (caller proposes/approves/applies)
 * -> Evaluation again. The human-approval step is not something this
 * function can skip past: `applyAndReevaluate` only accepts proposals whose
 * status is already APPLIED, which only markApplied() can produce, which
 * only accepts APPROVED, which only decideProposal() can produce.
 */
export async function evaluateAndFindPatterns(cases: BenchmarkCase[]): Promise<ImprovementCycleResult> {
  const before = await runBenchmark(cases);
  const patterns = analyzeFailurePatterns(before);
  return { before, patterns };
}

export async function applyAndReevaluate(
  cycle: ImprovementCycleResult,
  appliedProposals: ImprovementProposal[],
  reRunCases: BenchmarkCase[],
): Promise<ImprovementCycleResult> {
  for (const p of appliedProposals) {
    if (p.status !== "APPLIED") {
      throw new ProposalStateError(p, "re-evaluate with an unapplied");
    }
  }
  const after = await runBenchmark(reRunCases);
  const { regressed } = detectRegression(cycle.before, after);
  return { ...cycle, after, regressed };
}
