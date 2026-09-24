import { TaskState } from "../types.js";
import { canTransition, transition, type TaskMachine } from "../state/taskState.js";
import type { QaReportArtifact, SecurityReportArtifact } from "../artifacts/schemas.js";
import { canCloseWith, type QaModeDecision } from "../qa/mode.js";
import { checkQaVerdictCoverage } from "../qa/verdict.js";
import {
  assessBusinessInput,
  businessGateReason,
  type BusinessInputEvidence,
} from "./businessInput.js";
import type { DesignGateAssessment } from "../docs/designEvidence.js";
import { gateEvidenceFrom, type ApprovalLedger } from "./approval.js";

/**
 * Evidence available to gate a transition. This is deliberately separate
 * from TaskMachine — the state machine only knows the state graph, it has
 * no idea whether a design was approved or a QA report passed.
 */
export interface GateContext {
  /**
   * Derived at check time from the persisted approval ledger
   * (`gateEvidenceFrom`) — never stored, never accepted from a caller or an
   * executor. See `StoredGateEvidence`.
   */
  requirementApproved?: boolean;
  /** Structured intake evidence. Complete confirmed input discharges only the redundant interview. */
  businessInput?: BusinessInputEvidence;
  /** Risk facts derived from design.md after SA completes. */
  designAssessment?: DesignGateAssessment;
  /** Derived from the ledger, like `requirementApproved`. */
  designApproved?: boolean;
  qaReport?: QaReportArtifact;
  securityReport?: SecurityReportArtifact;
  /** Derived from the ledger, like `requirementApproved`. */
  humanApproved?: boolean;
  /**
   * The mode decision made for the current QA round. Optional for backward
   * compatibility: when absent (executor didn't set it), the gate falls back
   * to its original behavior.
   */
  qaModeDecision?: QaModeDecision;
  /**
   * T-V8-014 - the task/AC/DES/finding ids this round's report has to give a
   * verdict for (`requiredVerdictIds`). Optional for the same reason
   * `qaModeDecision` is: a row written before the contract-bound QA package
   * has none, and inventing one would be a fabricated requirement rather than
   * a stricter gate. `withQaOptimization` already rejects an under-covered
   * report before it gets here; this is the defense-in-depth copy, so a
   * caller that composes the gate without that wrapper is still held to it.
   */
  qaVerdictRequirements?: string[];
}

/** The part of the gate context a task persists. Human approval facts are excluded: they exist only as ledger records. */
export type StoredGateEvidence = Omit<GateContext, "requirementApproved" | "designApproved" | "humanApproved">;

/**
 * The context a gate is checked against: stored evidence plus approval facts
 * derived from the ledger. Any approval key present on the stored side is
 * discarded, never merged — only a recorded human decision can supply one.
 */
export function gateContextFor(stored: StoredGateEvidence, ledger: ApprovalLedger): GateContext {
  const { requirementApproved: _r, designApproved: _d, humanApproved: _h, ...evidence } = stored as GateContext;
  return { ...evidence, ...gateEvidenceFrom(ledger) };
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

export function designGateReason(assessment: DesignGateAssessment): string {
  return `DESIGN_RISK_CONFIRMATION required — ${assessment.triggers.join(", ")}`;
}

/**
 * The gate conditions, each keyed to the edge it guards. Agents never
 * call this directly and never get to decide the answer — only the
 * orchestrator consults it, same as canTransition.
 */
export function checkGate(from: TaskState, to: TaskState, ctx: GateContext): GateResult {
  // Gated on leaving REQUIREMENT at all. Complete, provenance-bearing input
  // may skip a redundant interview, but an unresolved material business choice
  // or missing authority remains a hard stop even if a generic interview flag
  // was supplied. Incomplete/explicitly interactive input keeps the legacy
  // human-interview fallback.
  if (from === TaskState.REQUIREMENT) {
    if (ctx.businessInput) {
      const assessment = assessBusinessInput(ctx.businessInput);
      if (assessment.humanGates.length > 0) {
        return { allowed: false, reason: businessGateReason(assessment) };
      }
      if (assessment.canNormalizeWithoutInterview) return { allowed: true };
      return ctx.requirementApproved
        ? { allowed: true }
        : { allowed: false, reason: businessGateReason(assessment) };
    }
    return ctx.requirementApproved
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            "REQUIREMENT_INTERVIEW required — interactive interview required because no confirmed-input evidence was supplied",
        };
  }

  // Gated on leaving DESIGN at all, not specifically on landing in IMPLEMENTATION:
  // test-planner and project-manager sit between the two, so a task can leave
  // DESIGN into PLAN without ever taking the DESIGN->IMPLEMENTATION edge directly.
  // The schema has to be confirmed before *anything* downstream reads it —
  // a plan or a test strategy built against an unconfirmed schema is exactly as wrong as code
  // built against one.
  if (from === TaskState.DESIGN) {
    if (ctx.designAssessment?.mode === "addressable" && ctx.designAssessment.canProceedWithoutConfirmation) {
      return { allowed: true };
    }
    return ctx.designApproved
      ? { allowed: true }
      : {
          allowed: false,
          reason: ctx.designAssessment
            ? designGateReason(ctx.designAssessment)
            : "DESIGN_APPROVED required before development can start",
        };
  }

  if (from === TaskState.QA && to !== TaskState.QA_FAILED) {
    if (ctx.qaReport?.status !== "PASS") {
      return { allowed: false, reason: "QA_PASS required — qa-report.status must be PASS" };
    }
    // A decision of FULL is only discharged by a report that says FULL.
    // Without a recorded decision this is a no-op.
    const close = canCloseWith(ctx.qaModeDecision, ctx.qaReport.mode);
    if (!close.allowed) return { allowed: false, reason: close.reason };
    if (ctx.qaVerdictRequirements && ctx.qaVerdictRequirements.length > 0) {
      const coverage = checkQaVerdictCoverage({
        report: ctx.qaReport,
        required: ctx.qaVerdictRequirements,
        decision: ctx.qaModeDecision,
      });
      if (!coverage.ok) return { allowed: false, reason: `QA_VERDICT_COVERAGE required - ${coverage.problems.join(" | ")}` };
    }
    return { allowed: true };
  }

  if (from === TaskState.SECURITY && to !== TaskState.SECURITY_FAILED) {
    return ctx.securityReport?.overallStatus === "PASS"
      ? { allowed: true }
      : { allowed: false, reason: "SECURITY_PASS required — security-report.overallStatus must be PASS" };
  }

  if (from === TaskState.READY_TO_DEPLOY && to === TaskState.APPROVED) {
    return ctx.humanApproved
      ? { allowed: true }
      : { allowed: false, reason: "HUMAN_APPROVED required before production" };
  }

  return { allowed: true };
}

export class GateBlockedError extends Error {
  constructor(
    public readonly from: TaskState,
    public readonly to: TaskState,
    reason: string,
  ) {
    super(`gate blocked: ${from} -> ${to}: ${reason}`);
    this.name = "GateBlockedError";
  }
}

/**
 * The single mutator that actually moves a task forward once evidence
 * exists. Checks structural validity first (state machine), then the gate
 * condition (this file) — either failing throws, and the caller can tell
 * which by error type. No agent holds a reference to this; only the
 * orchestrator does.
 */
export function gatedTransition(machine: TaskMachine, to: TaskState, ctx: GateContext): TaskMachine {
  if (!canTransition(machine, to)) {
    // transition() throws its own descriptive error for the structural case.
    return transition(machine, to);
  }
  const gate = checkGate(machine.current, to, ctx);
  if (!gate.allowed) {
    throw new GateBlockedError(machine.current, to, gate.reason ?? "condition not met");
  }
  return transition(machine, to);
}
