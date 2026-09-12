import type { ClassificationResult } from "../classification/taskClassifier.js";
import { ApprovalType, type ApprovalRecord } from "../gates/approval.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import { requiredCapabilitiesFor } from "../runtime/runtimeRouting.js";
import { TaskLevel, type AgentStage } from "../types.js";
import type { BusinessInputEvidence } from "../gates/businessInput.js";

/**
 * T-V8-029 — the surviving half of the retired wave `evaluateAutoEligibility`.
 *
 * The old ten-clause evaluator was the wave runner's private admission test.
 * Eight of its clauses are now enforced by the unified run's own authorities,
 * earlier and against durable records rather than a re-read of `plan.md`:
 *
 * | retired clause | who enforces it now |
 * |---|---|
 * | A owner is a Target writer | `git/guardedRun.ts` `assertTargetAttempt` |
 * | B plan row is `pending` | *nobody, by design* — plan Status cells are a human view; the ledger task status is execution truth |
 * | C dependency evidence | `ledger/runLedger.ts` `readiness()` over the frozen DAG |
 * | G runtime support + guard capabilities | `ledger/attemptFreeze.ts` `freezeAttempt` |
 * | H exactly one writable Target root | `freezeAttempt` and `assertTargetAttempt` |
 * | I a deterministic check can actually run | `qa/verificationHook.ts` plus the controller's missing-verification halt |
 * | J clean, exact run branch | `GuardedRunSession.open` / `assertCleanExactBranch` |
 *
 * What had no replacement — and is therefore kept here rather than deleted —
 * is the part that decides whether a *human* still owns this task: its
 * classification gates, its approval ledger, an owner stage that cannot run
 * without a person to answer prompts, and an explicit `sta pause`/`sta cancel`
 * override. Those four are the fixed V8 boundary ("continue automatically only
 * when no material business, schema, breaking-contract, security, or
 * configured approval gate exists"), so this is the one place that answers it.
 *
 * It returns a gate, never a silent skip: the caller stops the run and records
 * the reason for a person.
 */

export type UnattendedGateKind = "human-override" | "classification-gate" | "approval" | "interactive";

export interface UnattendedGateFailure {
  kind: UnattendedGateKind;
  reason: string;
}

/**
 * What a persisted task actually carries. `isProductionDeployOrMigration` and
 * `touchesSensitiveArea` are intake-only signals that never reach
 * `ClassificationResult`; they stay optional so a caller holding raw intake can
 * pass them, and are simply absent for a persisted task.
 */
export interface UnattendedGateClassification
  extends Pick<ClassificationResult, "level" | "pipeline" | "requiresHumanApproval" | "sensitiveGate" | "touchesSchema"> {
  isProductionDeployOrMigration?: boolean;
  touchesSensitiveArea?: boolean;
}

export interface UnattendedGateInput {
  taskId: string;
  /** The stage this attempt would actually launch — not the whole pipeline, because a bounded run launches one owner per task. */
  owner: AgentStage;
  classification: UnattendedGateClassification | null;
  /** Trusted persisted intake, which decides whether a BA stage still needs a person. */
  businessInput: BusinessInputEvidence | null;
  approvals: readonly Pick<ApprovalRecord, "type" | "required" | "status">[] | null;
  paused?: boolean;
  cancelled?: boolean;
  cancelReason?: string | null;
}

export function evaluateUnattendedGate(input: UnattendedGateInput): UnattendedGateFailure[] {
  const failures: UnattendedGateFailure[] = [];

  if (input.cancelled) {
    failures.push({ kind: "human-override", reason: `a person cancelled this task (${input.cancelReason ?? "no reason recorded"})` });
  }
  if (input.paused) {
    failures.push({ kind: "human-override", reason: "a person paused this task; resume it explicitly before it runs unattended" });
  }

  if (!input.classification) {
    failures.push({ kind: "classification-gate", reason: "classification could not be loaded; an unknown gate is treated as a gate" });
  } else {
    const signals = [
      ["touchesSchema", input.classification.touchesSchema],
      ["isProductionDeployOrMigration", input.classification.isProductionDeployOrMigration],
      ["touchesSensitiveArea", input.classification.touchesSensitiveArea],
      ["requiresHumanApproval", input.classification.requiresHumanApproval],
      ["sensitiveGate", input.classification.sensitiveGate],
      [`level=${TaskLevel.LARGE_CRITICAL}`, input.classification.level === TaskLevel.LARGE_CRITICAL],
    ].filter(([, enabled]) => enabled === true).map(([name]) => name);
    if (signals.length > 0) {
      failures.push({ kind: "classification-gate", reason: `classification sets ${signals.join(", ")}` });
    }
  }

  if (input.approvals === null) {
    failures.push({ kind: "approval", reason: "approval ledger could not be loaded" });
  } else {
    const known = new Set<string>(Object.values(ApprovalType));
    const unanswered = input.approvals.filter((approval) =>
      !known.has(approval.type) || (approval.required && approval.status !== "approved"),
    );
    if (unanswered.length > 0) {
      failures.push({
        kind: "approval",
        reason: `unanswered or rejected approvals remain: ${unanswered.map((approval) => `${approval.type}:${approval.status}`).join(", ")}`,
      });
    }
  }

  if (requiredCapabilitiesFor(input.owner, false, input.businessInput ?? undefined).includes(RuntimeCapability.INTERACTIVE_PROMPTS)) {
    failures.push({ kind: "interactive", reason: `owner stage ${input.owner} requires interactive prompts, which an unattended run cannot answer` });
  }

  return failures;
}

export function renderUnattendedGate(taskId: string, failures: readonly UnattendedGateFailure[]): string {
  return [
    `task ${taskId} is not eligible for unattended execution; a person owns the next step:`,
    ...failures.map((failure) => `- [${failure.kind}] ${failure.reason}`),
  ].join("\n");
}
