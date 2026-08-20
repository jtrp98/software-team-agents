import { z } from "zod";
import { AgentStage } from "../types.js";
import { ApprovalType, UnknownApprovalError } from "../gates/approval.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { StructuredFailureSchema } from "../orchestrator/failure.js";
import type { RunOutcome } from "../observability/runLog.js";
import type { AgentExecutorResult, Orchestrator, OrchestratorStatus } from "../orchestrator/orchestrator.js";

/**
 * The inbound half of T36: `Agent → Event → Orchestrator → Next Task`.
 *
 * WHAT WAS ALREADY TRUE, AND WHAT WASN'T
 *
 * `Orchestrator.reportCompletion()` has been the single entry point for "an
 * agent finished" since T01, and it deliberately does not care how that news
 * arrived — its own comment says "a direct await, a webhook, a message off a
 * queue". That was half the story. To actually call it you needed a live
 * `Orchestrator` instance, the exact `AgentStage` it was assigned to, and a
 * `timing` pair, all in the calling process. Every real caller was `step()`,
 * awaiting the executor it had just launched itself. The "message off a queue"
 * path had nowhere to enter.
 *
 * This is that entrance. It takes an event as *data* — parsed from JSON, off a
 * queue, out of an HTTP body, replayed from the store — resolves the task,
 * feeds the orchestrator, and answers with what should run next. The routing
 * decision stays exactly where it was: nothing here decides anything about a
 * task, it only carries the news in and the answer back out.
 *
 * WHY REJECTIONS ARE VALUES AND NOT EXCEPTIONS
 *
 * `reportCompletion` throws when told about a stage that isn't the assigned one
 * — correct for a direct call, where the caller is the thing that got it wrong.
 * For a queue consumer it is the wrong shape entirely: a stale or duplicated
 * message is *expected* traffic, not a bug, and a consumer that throws on one
 * stops consuming. So every failure here comes back as `{ ok: false, reason }`,
 * and the caller decides whether to drop, retry, or dead-letter it. The one
 * thing this must never do is guess: an event it cannot make sense of is
 * rejected with the reason, never applied to a task it might not belong to.
 */

/**
 * The wire form of `RunOutcome`. Loose on purpose: T26/T28 added five optional
 * metric fields to `RunOutcome` after the fact, and a strict object would have
 * silently stripped them off any event crossing this boundary — turning a new
 * measurement into a missing one with nothing to notice it. Unknown keys pass
 * through and are stored as reported.
 */
const RUN_OUTCOME_FIELDS = {
  model: z.string().optional(),
  tokens: z.number(),
  cost: z.number(),
  result: z.enum(["PASS", "FAIL"]),
  retry_count: z.number().int().nonnegative().optional(),
  failure_reason: z.string().nullable().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  context_chars: z.number().optional(),
};

const RunOutcomeSchema = z.looseObject(RUN_OUTCOME_FIELDS);

/**
 * Compile-time proof that the wire fields and the in-process type still describe
 * the same thing, in both directions. It catches the mistake that actually
 * happens — a field added to one and not the other — at build time rather than
 * as a parse failure on a live event.
 *
 * Checked against the *strict* reading of the same fields, not the loose schema
 * above: `looseObject`'s inferred type carries an index signature, which no
 * interface is assignable to, so comparing against it would only ever prove that
 * the two are different shapes. This const exists for that comparison and is not
 * used to parse anything.
 */
const StrictRunOutcomeSchema = z.object(RUN_OUTCOME_FIELDS);
type Assert<T extends true> = T;
type _SchemaFitsRunOutcome = Assert<z.infer<typeof StrictRunOutcomeSchema> extends RunOutcome ? true : false>;
type _RunOutcomeFitsSchema = Assert<RunOutcome extends z.infer<typeof StrictRunOutcomeSchema> ? true : false>;

const GateEvidenceSchema = z.object({
  designApproved: z.boolean().optional(),
  humanApproved: z.boolean().optional(),
});

const AgentResultSchema = z.object({
  outcome: RunOutcomeSchema,
  artifactType: z.enum(ArtifactType).optional(),
  /** Validated against its real artifact schema by the orchestrator, not here — one validation, in the place that owns it. */
  artifact: z.unknown().optional(),
  gateEvidence: GateEvidenceSchema.optional(),
  failure: StructuredFailureSchema.optional(),
});

export const AgentCompletedEventSchema = z.object({
  type: z.literal("AGENT_COMPLETED"),
  taskId: z.string().min(1),
  stage: z.enum(AgentStage),
  result: AgentResultSchema,
  timing: z.object({ start: z.number(), end: z.number() }),
});

export const ApprovalDecidedEventSchema = z.object({
  type: z.literal("APPROVAL_DECIDED"),
  taskId: z.string().min(1),
  approvalType: z.enum(ApprovalType),
  approved: z.boolean(),
  by: z.string().optional(),
  note: z.string().optional(),
});

export const InboundEventSchema = z.discriminatedUnion("type", [
  AgentCompletedEventSchema,
  ApprovalDecidedEventSchema,
]);
export type InboundEvent = z.infer<typeof InboundEventSchema>;

export interface DispatchAccepted {
  ok: true;
  taskId: string;
  /** Where the task stands after the event was applied. */
  status: OrchestratorStatus;
  /** The stage to run next, or null when the task is waiting, blocked or finished. This is the "→ Next Task" half. */
  next: AgentStage | null;
}

export interface DispatchRejected {
  ok: false;
  /** Null when the event was too malformed to even name a task. */
  taskId: string | null;
  reason: string;
  /** True when re-delivering the identical event later could plausibly succeed (a task not yet created); false when it never will. */
  retryable: boolean;
}

export type DispatchResult = DispatchAccepted | DispatchRejected;

/** How the router gets from a task id to a live orchestrator. Returns null for a task this store doesn't hold. */
export type TaskResolver = (taskId: string) => Orchestrator | null;

function nextStage(status: OrchestratorStatus): AgentStage | null {
  return status.kind === "RUNNING" ? status.stage : null;
}

export class AgentEventRouter {
  constructor(private readonly resolve: TaskResolver) {}

  /**
   * Applies one inbound event and reports what should happen next.
   *
   * Takes `unknown` rather than a typed event because that is what actually
   * arrives: a parsed JSON body whose shape nobody has checked. Validating at
   * the boundary is the only place it can be done once for every transport.
   */
  dispatch(raw: unknown): DispatchResult {
    const parsed = InboundEventSchema.safeParse(raw);
    if (!parsed.success) {
      const taskId = typeof (raw as { taskId?: unknown })?.taskId === "string" ? (raw as { taskId: string }).taskId : null;
      return {
        ok: false,
        taskId,
        reason:
          "event does not match any known inbound shape: " +
          parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
        // A malformed event does not become well-formed by waiting.
        retryable: false,
      };
    }

    const event = parsed.data;
    let orchestrator: Orchestrator | null;
    try {
      orchestrator = this.resolve(event.taskId);
    } catch (e) {
      // A resolver that refuses (an unmet dependency, a locked task) is a
      // "not now", not a "never" — exactly the case a queue should redeliver.
      return { ok: false, taskId: event.taskId, reason: (e as Error).message, retryable: true };
    }
    if (!orchestrator) {
      return {
        ok: false,
        taskId: event.taskId,
        reason: `no task ${event.taskId} in this store`,
        // The task may simply not have been created yet when the event overtook it.
        retryable: true,
      };
    }

    return event.type === "AGENT_COMPLETED"
      ? this.applyCompletion(orchestrator, event)
      : this.applyDecision(orchestrator, event);
  }

  private applyCompletion(
    orchestrator: Orchestrator,
    event: z.infer<typeof AgentCompletedEventSchema>,
  ): DispatchResult {
    try {
      const status = orchestrator.reportCompletion(
        event.stage,
        event.result as AgentExecutorResult,
        event.timing,
      );
      return { ok: true, taskId: event.taskId, status, next: nextStage(status) };
    } catch (e) {
      // Reaching here means the task is not assigned to that stage — a duplicate
      // delivery, or an agent reporting work nobody asked it for. Both are the
      // consumer's to drop, and neither is fixed by trying again.
      return { ok: false, taskId: event.taskId, reason: (e as Error).message, retryable: false };
    }
  }

  private applyDecision(
    orchestrator: Orchestrator,
    event: z.infer<typeof ApprovalDecidedEventSchema>,
  ): DispatchResult {
    try {
      orchestrator.decideApproval(event.approvalType, event.approved, { by: event.by, note: event.note });
    } catch (e) {
      if (e instanceof UnknownApprovalError) {
        // An answer to a question this task never asked. Redelivering will not
        // create the question, so this is terminal for the message.
        return { ok: false, taskId: event.taskId, reason: e.message, retryable: false };
      }
      throw e;
    }
    const status = orchestrator.status();
    return { ok: true, taskId: event.taskId, status, next: nextStage(status) };
  }
}
