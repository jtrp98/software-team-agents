import { z } from "zod";
import { AgentStage, TaskState } from "../types.js";
import { STAGE_TO_STATE } from "../state/taskState.js";

/**
 * A failure reported by an agent, as structured data rather than prose.
 *
 * The *orchestrator* decides where a failure routes, not the agent that hit
 * it. An agent says what broke and who owns it; it never says "send this
 * back to backend-engineer" — that conclusion is drawn here, from the
 * pipeline the task actually has.
 *
 * Producing one of these from a real `review.md`/`security.md` (classifying
 * prose into a category/owner) is deliberately not done here — an executor
 * that has no structured failure to report simply omits it, and routing
 * falls back to legacy behaviour.
 */
export const StructuredFailureSchema = z.object({
  category: z.enum(["implementation", "contract", "requirement", "infrastructure", "test", "unknown"]),
  /** The agent whose work must change. Not necessarily the agent that found it. */
  owner: z.enum(AgentStage),
  severity: z.enum(["low", "medium", "high", "critical"]),
  /** False when re-running the owner cannot plausibly fix it (a design gap, a missing decision). */
  retryable: z.boolean(),
  reason: z.string().min(1),
  /** Task/requirement ids this failure touches, e.g. ["BE-004"]. */
  affected: z.array(z.string()),
  requiresHuman: z.boolean(),
});
export type StructuredFailure = z.infer<typeof StructuredFailureSchema>;

export function validateStructuredFailure(data: unknown): StructuredFailure {
  return StructuredFailureSchema.parse(data);
}

/** Where a structured failure sends the task next, as decided by the orchestrator. */
export type FailureRoute =
  /** Re-run the stage that owns it — the failure is that stage's to fix. */
  | { kind: "RETRY_STAGE"; stage: AgentStage; reason: string }
  /**
   * Go back to an *earlier* stage: the failure was never the implementing
   * stage's to fix. A contract gap belongs to `system-analyst` at DESIGN, an
   * undecided business rule to `business-analyst` at REQUIREMENT — the state
   * machine's guarded backward edge (`recoverTo`) makes this possible.
   */
  | { kind: "RECOVER"; stage: AgentStage; toState: TaskState; reason: string }
  | { kind: "ESCALATE"; reason: string };

/** States a failure may be sent back to, earliest first. Ordering matters: it is the search order for the nearest owner. */
const RECOVERABLE_STATES: TaskState[] = [TaskState.REQUIREMENT, TaskState.DESIGN, TaskState.PLAN];

/**
 * Resolves a failure to a route within *this* task's pipeline.
 *
 * Escalates rather than guessing in three cases, all of which are a human's
 * call and not something to paper over:
 *  - the failure says so (`requiresHuman`, or `retryable: false`);
 *  - the owner isn't in this task's pipeline at all;
 *  - the owner's stage occupies a TaskState the machine has no back-edge to.
 *
 * The escalation case is reserved for owners whose state genuinely has no path
 * back (a stage that runs *after* the failure, or one outside the forward
 * sequence) — everything else routes back via RECOVER instead.
 */
export function routeFailure(failure: StructuredFailure, pipeline: AgentStage[]): FailureRoute {
  if (failure.requiresHuman) {
    return { kind: "ESCALATE", reason: `${failure.category} failure requires a human decision: ${failure.reason}` };
  }
  if (!failure.retryable) {
    return { kind: "ESCALATE", reason: `${failure.category} failure is not retryable: ${failure.reason}` };
  }

  const index = pipeline.indexOf(failure.owner);
  if (index === -1) {
    return {
      kind: "ESCALATE",
      reason: `${failure.owner} owns this failure but is not in this task's pipeline (${pipeline.join(" -> ")}): ${failure.reason}`,
    };
  }

  const ownerState = STAGE_TO_STATE[failure.owner];

  if (ownerState === TaskState.IMPLEMENTATION) {
    return { kind: "RETRY_STAGE", stage: failure.owner, reason: failure.reason };
  }

  if (ownerState && RECOVERABLE_STATES.includes(ownerState)) {
    return { kind: "RECOVER", stage: failure.owner, toState: ownerState, reason: failure.reason };
  }

  return {
    kind: "ESCALATE",
    reason:
      `${failure.owner} owns this failure, but the state machine has no path back to ` +
      `${ownerState ?? "its state"} from a failed round — needs human triage: ${failure.reason}`,
  };
}
