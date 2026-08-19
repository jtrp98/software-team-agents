import { TaskState } from "../types.js";
import { canTransition, transition, type TaskMachine } from "../state/taskState.js";
import type { QaReportArtifact, SecurityReportArtifact } from "../artifacts/schemas.js";

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
  if (from === TaskState.DESIGN && to === TaskState.IMPLEMENTATION) {
    return ctx.designApproved
      ? { allowed: true }
      : { allowed: false, reason: "DESIGN_APPROVED required before development can start" };
  }

  if (from === TaskState.QA && to !== TaskState.QA_FAILED) {
    return ctx.qaReport?.status === "PASS"
      ? { allowed: true }
      : { allowed: false, reason: "QA_PASS required — qa-report.status must be PASS" };
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
