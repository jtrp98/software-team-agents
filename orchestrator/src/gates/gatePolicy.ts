import { TaskState } from "../types.js";
import { canTransition, transition, type TaskMachine } from "../state/taskState.js";
import type { QaReportArtifact, SecurityReportArtifact } from "../artifacts/schemas.js";
import { canCloseWith, type QaModeDecision } from "../qa/mode.js";
import {
  assessBusinessInput,
  businessGateReason,
  type BusinessInputEvidence,
} from "./businessInput.js";

/**
 * Evidence available to gate a transition. This is deliberately separate
 * from TaskMachine — the state machine only knows the state graph, it has
 * no idea whether a design was approved or a QA report passed.
 */
export interface GateContext {
  /** The interactive requirement fallback was answered by a person. */
  requirementApproved?: boolean;
  /** Structured intake evidence. Complete confirmed input discharges only the redundant interview. */
  businessInput?: BusinessInputEvidence;
  designApproved?: boolean;
  qaReport?: QaReportArtifact;
  securityReport?: SecurityReportArtifact;
  humanApproved?: boolean;
  /**
   * The mode decision made for the current QA round. Optional for backward
   * compatibility: when absent (executor didn't set it), the gate falls back
   * to its original behavior.
   */
  qaModeDecision?: QaModeDecision;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
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
    return ctx.designApproved
      ? { allowed: true }
      : { allowed: false, reason: "DESIGN_APPROVED required before development can start" };
  }

  if (from === TaskState.QA && to !== TaskState.QA_FAILED) {
    if (ctx.qaReport?.status !== "PASS") {
      return { allowed: false, reason: "QA_PASS required — qa-report.status must be PASS" };
    }
    // A decision of FULL is only discharged by a report that says FULL.
    // Without a recorded decision this is a no-op.
    const close = canCloseWith(ctx.qaModeDecision, ctx.qaReport.mode);
    return close.allowed ? { allowed: true } : { allowed: false, reason: close.reason };
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
