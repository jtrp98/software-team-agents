import { AgentStage, TaskState } from "../types.js";
import type { Finding, FindingCategory } from "../artifacts/finding.js";
import type { TaskGraph } from "../graph/taskGraph.js";
import type { QaRiskSignals } from "../qa/mode.js";

/**
 * T-V8-015 — one deterministic route per failure category, with the reason on
 * the record.
 *
 * `routeFailure` (`orchestrator/failure.ts`) already answers "which stage do
 * we go back to" from a `StructuredFailure`, and that stays: it is the state
 * machine's question. What it cannot answer is what T-V8-013 made expressible
 * — given a durable `Finding`, what does the *repair* consist of, what else
 * does it invalidate, and does the round that follows it have to be FULL.
 *
 * The five routes are deliberately closed. A category with no route is an
 * escalation, never a guess: a repair sent to the wrong owner is the failure
 * mode that produces loops (an engineer re-guessing at a decision that was
 * never theirs), and `V8-PROBLEM-ANALYSIS.md` §14 fixes the mapping rather
 * than leaving it to whoever reports the failure.
 */

export type RepairRouteKind =
  /** Implementation/test defect: the original owner receives packet + finding + diff + invalidated evidence. */
  | "delta-repair"
  /** Contract/design gap: system-analyst only, then recompile the affected descendants. BA is not rerun. */
  | "recompile-descendants"
  /** A business decision is genuinely missing: business-analyst, and only then. */
  | "business-decision"
  /** Provider/quota/runtime unavailability: halt and resume the same stage. Not a defect. */
  | "halt-and-resume"
  /** No safe automatic route exists. */
  | "escalate";

export interface RepairRoute {
  kind: RepairRouteKind;
  /** Whose work must change. `"human"` for the two stopping routes. */
  owner: AgentStage | "human";
  /** The state the task returns to, when the route moves it. */
  toState?: TaskState;
  /** Graph descendants whose compiled packets and evidence this repair invalidates — never the whole plan. */
  invalidates: string[];
  /** Whether the verification round after this repair must be FULL. */
  requiresFullQa: boolean;
  /** Whether this failure consumes a QA/security *defect* retry. False for infrastructure. */
  consumesDefectRetry: boolean;
  /** The recorded rationale — one sentence naming the category and the rule that chose this route. */
  reason: string;
}

/** Facts about what the repair itself touched. Booleans, supplied by the caller — never inferred from prose here. */
export interface RepairChangeFacts {
  /** Files the repair changed that no finding named — `planRecheck().newFilesOutsideFindings`. */
  newFilesOutsideFinding?: readonly string[];
  changesSharedContract?: boolean;
  touchesSchema?: boolean;
  securitySensitive?: boolean;
}

export interface RouteRepairInput {
  /**
   * The defect being repaired. A full `Finding` when one exists; the bare
   * shape otherwise, because `deriveFinding` refuses to mint a Finding for an
   * infrastructure failure at all (T-V8-013) — so the infrastructure route
   * has to be reachable without one.
   */
  finding: Pick<Finding, "task_id" | "category" | "owner" | "retryable" | "requires_human"> | { task_id: string; category: FindingCategory; owner: AgentStage; retryable: boolean; requires_human: boolean };
  pipeline: readonly AgentStage[];
  /** The canonical task graph. Absent leaves `invalidates` empty rather than guessed. */
  graph?: TaskGraph;
  /**
   * True only when a person has established that the requirement genuinely
   * lacks a business decision. A requirement-category finding on its own is
   * not evidence of that — it is often a misread requirement, and rerunning
   * BA for one is the "unnecessary BA rerun" this task's risk names.
   */
  businessDecisionMissing?: boolean;
  repairChanges?: RepairChangeFacts;
}

/** Descendants only. An upstream change never invalidates the whole plan, and never its own dependencies. */
export function invalidationSetFor(graph: TaskGraph | undefined, taskId: string): string[] {
  if (!graph || !graph.nodes.has(taskId)) return [];
  return [...graph.descendantsOf(taskId)].sort();
}

function fullQaReasons(facts: RepairChangeFacts | undefined): string[] {
  const reasons: string[] = [];
  if (facts?.touchesSchema) reasons.push("schema change");
  if (facts?.changesSharedContract) reasons.push("shared-contract change");
  if (facts?.securitySensitive) reasons.push("security-sensitive change");
  if ((facts?.newFilesOutsideFinding?.length ?? 0) > 0) {
    reasons.push(`change outside the finding's scope (${facts!.newFilesOutsideFinding!.join(", ")})`);
  }
  return reasons;
}

export function routeRepair(input: RouteRepairInput): RepairRoute {
  const { finding } = input;
  const facts = input.repairChanges;
  const escalations = fullQaReasons(facts);
  const requiresFullQa = escalations.length > 0;
  const fullSuffix = requiresFullQa ? `; the next QA round must be FULL (${escalations.join("; ")})` : "";
  const base = { invalidates: [] as string[], requiresFullQa, consumesDefectRetry: true };

  // 1. Infrastructure first, and it outranks everything below — including
  //    `requires_human`. A provider outage is not a defect with a
  //    fix-verify-close lifecycle, so it must not reach a route that spends a
  //    defect retry, whatever else the record says about it.
  if (finding.category === "infrastructure") {
    return {
      ...base,
      kind: "halt-and-resume",
      owner: "human",
      requiresFullQa: false,
      consumesDefectRetry: false,
      reason:
        "infrastructure/quota failure: halt and resume the same stage once the provider is available — " +
        "it consumes no defect retry, because there is no defect to fix",
    };
  }

  if (finding.requires_human) {
    return { ...base, kind: "escalate", owner: "human", reason: `${finding.category} failure requires a human decision${fullSuffix}` };
  }
  if (!finding.retryable) {
    return { ...base, kind: "escalate", owner: "human", reason: `${finding.category} failure is not retryable, so no automatic repair round can help${fullSuffix}` };
  }

  switch (finding.category) {
    case "implementation":
    case "test": {
      if (!input.pipeline.includes(finding.owner)) {
        return {
          ...base,
          kind: "escalate",
          owner: "human",
          reason: `${finding.category} failure is owned by ${finding.owner}, which is not in this task's pipeline (${input.pipeline.join(" -> ")})${fullSuffix}`,
        };
      }
      return {
        ...base,
        kind: "delta-repair",
        owner: finding.owner,
        toState: TaskState.IMPLEMENTATION,
        reason: `${finding.category} defect returns to its original owner ${finding.owner} with a delta repair packet (original packet + exact finding + current diff + invalidated evidence)${fullSuffix}`,
      };
    }

    case "contract": {
      if (!input.pipeline.includes(AgentStage.SYSTEM_ANALYST)) {
        return {
          ...base,
          kind: "escalate",
          owner: "human",
          reason: `contract failure belongs to system-analyst, which is not in this task's pipeline (${input.pipeline.join(" -> ")})${fullSuffix}`,
        };
      }
      const invalidates = invalidationSetFor(input.graph, finding.task_id);
      return {
        kind: "recompile-descendants",
        owner: AgentStage.SYSTEM_ANALYST,
        toState: TaskState.DESIGN,
        invalidates,
        // A changed contract is a shared-contract change by definition, so the
        // round that verifies the recompiled descendants is always FULL.
        requiresFullQa: true,
        consumesDefectRetry: true,
        reason:
          `contract failure returns to system-analyst and recompiles ${invalidates.length} graph descendant(s)` +
          `${invalidates.length > 0 ? ` (${invalidates.join(", ")})` : ""}; business-analyst is not rerun for a contract gap; ` +
          "the next QA round must be FULL (contract change)",
      };
    }

    case "requirement": {
      if (!input.businessDecisionMissing) {
        return {
          ...base,
          kind: "escalate",
          owner: "human",
          reason:
            "requirement failure with no confirmed missing business decision: a person triages it rather than business-analyst " +
            `re-deriving a requirement that may simply have been misread${fullSuffix}`,
        };
      }
      if (!input.pipeline.includes(AgentStage.BUSINESS_ANALYST)) {
        return {
          ...base,
          kind: "escalate",
          owner: "human",
          reason: `a business decision is missing but business-analyst is not in this task's pipeline (${input.pipeline.join(" -> ")})${fullSuffix}`,
        };
      }
      return {
        ...base,
        kind: "business-decision",
        owner: AgentStage.BUSINESS_ANALYST,
        toState: TaskState.REQUIREMENT,
        invalidates: invalidationSetFor(input.graph, finding.task_id),
        reason: `a business decision is genuinely missing, so business-analyst owns it${fullSuffix}`,
      };
    }

    case "unknown":
    default:
      return {
        ...base,
        kind: "escalate",
        owner: "human",
        reason: `an unclassified failure has no deterministic owner route; a person triages it rather than the pipeline guessing${fullSuffix}`,
      };
  }
}

/** The FULL trigger a repair route contributes to the next round's mode selection. */
export function repairQaSignals(route: RepairRoute): QaRiskSignals {
  return route.requiresFullQa ? { releaseGateRequiresFull: true } : {};
}

/** One-line audit rendering for the run log and route matrix evidence. */
export function describeRepairRoute(route: RepairRoute): string {
  return (
    `${route.kind} -> ${route.owner}` +
    (route.toState ? ` (${route.toState})` : "") +
    `; invalidates ${route.invalidates.length > 0 ? route.invalidates.join(", ") : "nothing"}` +
    `; FULL QA ${route.requiresFullQa ? "required" : "not required"}` +
    `; defect retry ${route.consumesDefectRetry ? "consumed" : "not consumed"}` +
    `; ${route.reason}`
  );
}
