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
import { selectQaEffort } from "./riskGate.js";
import type { TaskLevel } from "../types.js";
import { ArtifactType, type QaReportArtifact } from "../artifacts/schemas.js";
import {
  renderDeterministicVerification,
  type DeterministicVerification,
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
 *   3. the post-Dev deterministic result supplied as evidence (QA03);
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
  /** Result captured by the stage-agnostic post-Dev verification hook. */
  deterministicVerification?: (req: AgentExecutorRequest) => DeterministicVerification | undefined;
  /** Extra risk signals beyond the classification-derived defaults. */
  riskSignals?: (req: AgentExecutorRequest) => QaRiskSignals | undefined;
  /** Stored deterministic classification level used by the orthogonal effort gate. */
  taskLevel?: (req: AgentExecutorRequest) => TaskLevel | undefined;
  /** Low-risk skip is opt-in; absent preserves the pre-V3 model-QA path. */
  allowQaSkip?: boolean;
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
    const effort = selectQaEffort(opts.taskLevel?.(req), signals, { allowSkip: opts.allowQaSkip });

    const deterministic = opts.deterministicVerification?.(req);
    // T-V5-036 (F-20) — the run-log field records what happened, not what was
    // requested: "enabled" only where the sweep actually produced a result.
    // `opts.deterministicGate` still governs the *prompt wording* below (the
    // caller's stated intent for this round), but the outcome is derived from
    // the real `deterministic` value so a caller that requested "enabled" and
    // got no result back (e.g. no code-producing stage ran first) is never
    // reported as having run the gate.
    const gateOutcome: "enabled" | "disabled" = deterministic ? "enabled" : "disabled";
    if (deterministic && !deterministic.passed) {
      // No LLM call happens here — the tool output IS the explanation. No
      // structured failure on purpose: recoveryPolicy's no-failure route sends
      // the round back to the implementation stage, which is who owns a red
      // typecheck.
      const failed = failResult(
        "deterministic verification failed before LLM QA — qa-engineer was not invoked. Fix these, then re-run:\n" +
          renderDeterministicVerification(deterministic).join("\n"),
      );
      return {
        ...failed,
        outcome: {
          ...failed.outcome,
          qa_effort: effort.effort,
          deterministic_gate: gateOutcome,
        },
      };
    }

    if (effort.effort === "skip") {
      if (!deterministic?.passed) {
        const failed = failResult(
          "QA effort selected skip, but no passing deterministic verification was available; refusing to close without evidence",
        );
        return {
          ...failed,
          outcome: { ...failed.outcome, qa_effort: "skip", deterministic_gate: gateOutcome },
          gateEvidence: { ...(failed.gateEvidence ?? {}), qaModeDecision: decision },
        };
      }
      const report: QaReportArtifact = {
        taskId: req.taskId,
        status: "PASS",
        mode: decision.mode,
        requirements: {},
        tests: { passed: deterministic.ran.length, failed: deterministic.failures.length },
        evidence: renderDeterministicVerification(deterministic),
        risks: [],
        hasAutomatedTests: deterministic.ran.some((check) => check.id === "unit-tests" || check.id === "integration-tests"),
        unverifiedBehaviour: [],
      };
      return {
        outcome: { tokens: 0, cost: 0, result: "PASS", qa_effort: "skip", deterministic_gate: gateOutcome },
        artifactType: ArtifactType.QA_REPORT,
        artifact: report,
        gateEvidence: { qaModeDecision: decision },
      };
    }

    const pkgExtra = opts.packageInputs?.(req) ?? {};
    const pkg = buildEvidencePackage({
      taskId: req.taskId,
      mode: decision,
      effort,
      deterministicGate: opts.deterministicGate ?? (opts.deterministicVerification ? "enabled" : "disabled"),
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
      outcome: {
        ...result.outcome,
        qa_effort: effort.effort,
        deterministic_gate: gateOutcome,
      },
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
