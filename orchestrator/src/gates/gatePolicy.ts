import { TaskState } from "../types.js";
import { canTransition, transition, type TaskMachine } from "../state/taskState.js";
import type { QaReportArtifact, SecurityReportArtifact } from "../artifacts/schemas.js";
import { canCloseWith, type QaModeDecision } from "../qa/mode.js";

/**
 * Evidence available to gate a transition. This is deliberately separate
 * from TaskMachine — the state machine (item 2) only knows the state graph,
 * it has no idea whether a design was approved or a QA report passed.
 */
export interface GateContext {
  designApproved?: boolean;
  qaReport?: QaReportArtifact;
  securityReport?: SecurityReportArtifact;
  humanApproved?: boolean;
  /**
   * QA02/QA05 — the mode decision made for the current QA round. Absent on
   * tasks that ran before the optimization layer existed (and on any run of
   * an executor that does not set it): the gate then behaves exactly as it
   * did in V1, which is what keeps this backward-compatible.
   */
  qaModeDecision?: QaModeDecision;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * The four gate conditions from task-detail.md item 6, each keyed to the edge
 * it guards. Agents never call this directly and never get to decide the
 * answer — only the orchestrator (item 13) consults it, same as canTransition.
 */
export function checkGate(from: TaskState, to: TaskState, ctx: GateContext): GateResult {
  // Gated on leaving DESIGN at all, not specifically on landing in IMPLEMENTATION: T20 put
  // test-planner (and project-manager already did, for the "feature" pipeline) between the
  // two, so a task can leave DESIGN into PLAN without ever taking the DESIGN->IMPLEMENTATION
  // edge directly. The schema has to be confirmed before *anything* downstream reads it —
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
    // QA05: a decision of FULL is only discharged by a report that says FULL.
    // Without a recorded decision this is a no-op — V1 behaviour preserved.
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
