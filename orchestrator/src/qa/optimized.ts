import { AgentStage } from "../types.js";
import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import { failResult } from "../runtime/agentRunAssembly.js";
import { buildQaScope, type QaScopeInput } from "./scope.js";
import {
  selectQaMode,
  type QaModeDecision,
  type QaRiskSignals,
} from "./mode.js";
import {
  runDeterministicVerification,
  renderDeterministicVerification,
  type DeterministicRunner,
} from "./deterministic.js";
import {
  buildEvidencePackage,
  planRecheck,
  type EvidencePackageInput,
  type EvidenceRecord,
  type QaFindingRecord,
  type RecheckPlan,
} from "./evidence.js";

/**
 * QA01–QA06 wired around the executor seam.
 *
 * Wrapping (rather than rewriting) `createRuntimeExecutor` is what keeps this
 * opt-out-able and testable: every non-QA stage passes through untouched, and
 * a QA round gains, in order —
 *
 *   1. a change-aware scope built from this round's changed files (QA01);
 *   2. a deterministic TARGETED/FULL decision with recorded reasons (QA02),
 *      escalated when a fix reached outside the previous findings (QA06);
 *   3. deterministic verification run BEFORE any model is invoked, whose
 *      failure returns the round to implementation without spending a token
 *      on qa-engineer (QA03);
 *   4. a bounded evidence package injected as the `qa-evidence` context item
 *      the QA prompt reads first (QA04);
 *   5. the mode decision attached to the gate evidence, where `gatePolicy`
 *      enforces that a FULL decision is only discharged by a FULL report
 *      (QA05).
 *
 * Fail-closed throughout: an error producing the change list yields an empty
 * one, which `buildQaScope` declares unbounded, which selects FULL. The
 * optimization can only make verification stricter, never lighter.
 */

export interface PreviousQaRound {
  /** Open findings from the last failed round (`review.md` Open Issues). */
  findings: readonly QaFindingRecord[];
  /** Evidence produced by earlier rounds (deterministic results, prior checks). */
  evidence: readonly EvidenceRecord[];
}

export interface QaOptimizationOptions {
  inner: AgentExecutor;
  now?: () => number;
  /**
   * This round's changed files. Required because guessing them is exactly the
   * "read the whole project" behaviour this replaces; `gitChangedFiles` is the
   * production provider.
   */
  changedFiles: (req: AgentExecutorRequest) => Promise<readonly string[]> | readonly string[];
  /** Configured project checks; absent = nothing configured (recorded as skipped). */
  deterministicRunner?: DeterministicRunner;
  /** Extra risk signals beyond the classification-derived defaults. */
  riskSignals?: (req: AgentExecutorRequest) => QaRiskSignals | undefined;
  /** Previous failed round's findings/evidence; absent on round 0. */
  previousRound?: (req: AgentExecutorRequest) => PreviousQaRound | undefined;
  /** Caller extras for the evidence package (task intent, diff summary…). */
  packageInputs?: (req: AgentExecutorRequest) => Partial<EvidencePackageInput> | undefined;
  /** Scope enrichment (dependency map, knowledge refs, task-graph impact). */
  scopeInputs?: (req: AgentExecutorRequest) => Partial<QaScopeInput> | undefined;
  /** Recorded on the QA run so the explicit deterministic escape hatch is auditable. */
  deterministicGate?: "enabled" | "disabled";
}

export function withQaOptimization(opts: QaOptimizationOptions): AgentExecutor {
  const now = opts.now ?? Date.now;

  return async (req: AgentExecutorRequest): Promise<AgentExecutorResult> => {
    if (req.stage !== AgentStage.QA_ENGINEER) return opts.inner(req);

    let changedFiles: readonly string[];
    try {
      changedFiles = await opts.changedFiles(req);
    } catch {
      changedFiles = []; // unbounded → FULL, never a silent pass
    }

    const extra = opts.scopeInputs?.(req) ?? {};
    const scope = buildQaScope({
      taskId: req.taskId,
      changedFiles: [...changedFiles],
      ...extra,
    });

    const signals: QaRiskSignals = {
      ...(opts.riskSignals?.(req) ?? {}),
    };

    const previous = opts.previousRound?.(req);
    let recheck: RecheckPlan | undefined;
    if ((req.qaRound ?? 0) > 0 && previous) {
      recheck = planRecheck(previous.findings, previous.evidence, [...changedFiles]);
      if (recheck.newFilesOutsideFindings.length > 0) {
        // QA06 acceptance: a fix reaching outside the previous findings is a
        // cross-boundary change — mode selection turns this into FULL with the
        // file list recorded as the reason.
        signals.crossTargetImpact = true;
      }
    }

    const decision: QaModeDecision = selectQaMode(req.taskId, scope, signals, { now });

    const deterministic = opts.deterministicRunner
      ? await runDeterministicVerification(opts.deterministicRunner)
      : undefined;
    if (deterministic && !deterministic.passed) {
      // No LLM call happens here — the tool output IS the explanation. No
      // structured failure on purpose: recoveryPolicy's no-failure route sends
      // the round back to the implementation stage, which is who owns a red
      // typecheck.
      const failed = failResult(
        "deterministic verification failed before LLM QA — qa-engineer was not invoked. Fix these, then re-run:\n" +
          renderDeterministicVerification(deterministic).join("\n"),
      );
      return { ...failed, outcome: { ...failed.outcome, deterministic_gate: opts.deterministicGate ?? "enabled" } };
    }

    const pkgExtra = opts.packageInputs?.(req) ?? {};
    const pkg = buildEvidencePackage({
      taskId: req.taskId,
      mode: decision,
      scope,
      taskIntent: "",
      acceptanceCriteria: [],
      diffSummary: "",
      knownRisks: [],
      deterministic,
      recheck,
      ...pkgExtra,
    });

    const result = await opts.inner({
      ...req,
      context: [...req.context, { source: "qa-evidence", content: pkg }],
    });

    return {
      ...result,
      outcome: { ...result.outcome, deterministic_gate: opts.deterministicGate ?? (opts.deterministicRunner ? "enabled" : "disabled") },
      gateEvidence: { ...(result.gateEvidence ?? {}), qaModeDecision: decision },
    };
  };
}

/**
 * Deterministic risk signals from the classification the task already carries
 * (stored, survives resume). Mapping rules:
 *
 *   - schema            → the classification's own `touchesSchema` signal, which
 *     stays true whether the schema work runs alone or under a new-feature
 *     pipeline (where it no longer implies "pipeline starts at system-analyst")
 *   - deploy/migration  → single devops stage needing approval
 *   - security          → sensitiveGate
 *
 * Shared-contract/cross-target/release-gate stay caller-supplied: those are
 * facts about the change, not about the intake classification.
 */
export function riskSignalsFromClassification(c: ClassificationResult): QaRiskSignals {
  return {
    touchesSchema: c.touchesSchema === true,
    migrationOrCutover:
      c.pipeline.length === 1 && c.pipeline[0] === AgentStage.DEVOPS && c.requiresHumanApproval,
    securitySensitive: c.sensitiveGate,
  };
}
