import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import type { RuntimeTask } from "../orchestrator/runtimeTask.js";
import { AgentStage } from "../types.js";
import {
  renderDeterministicVerification,
  runDeterministicVerification,
  type DeterministicRunner,
  type DeterministicVerification,
} from "./deterministic.js";

const CODE_PRODUCING_STAGES = new Set<AgentStage>([
  AgentStage.BACKEND_ENGINEER,
  AgentStage.FRONTEND_ENGINEER,
]);

type RequiredVerification = RuntimeTask["required_verification"];

export interface PostDevVerificationOptions {
  inner: AgentExecutor;
  /** A fresh runner per sweep; each ProjectRunner caches only within that sweep. */
  deterministicRunner: (req: AgentExecutorRequest) => DeterministicRunner;
  requiredVerification: (req: AgentExecutorRequest) => RequiredVerification | null | undefined;
}

export interface PostDevVerificationHook {
  executor: AgentExecutor;
  verificationFor(req: AgentExecutorRequest): DeterministicVerification | undefined;
}

/** Compatibility path: no verification runs; only the existing audit field is made explicit on Dev records. */
export function withPostDevVerificationDisabled(inner: AgentExecutor): AgentExecutor {
  return async (req) => {
    const result = await inner(req);
    if (!CODE_PRODUCING_STAGES.has(req.stage)) return result;
    return {
      ...result,
      outcome: { ...result.outcome, deterministic_gate: "disabled" },
    };
  };
}

/**
 * Runs deterministic verification immediately after a successful code-producing
 * stage. The expensive call has already happened; a red check returns a marked
 * failure which the orchestrator keeps at the same Dev stage, without invoking
 * QA or any other model.
 */
export function createPostDevVerificationHook(opts: PostDevVerificationOptions): PostDevVerificationHook {
  const evidence = new Map<string, DeterministicVerification>();

  const executor: AgentExecutor = async (req): Promise<AgentExecutorResult> => {
    const result = await opts.inner(req);
    if (!CODE_PRODUCING_STAGES.has(req.stage) || result.outcome.result === "FAIL") return result;

    const required = opts.requiredVerification(req);
    const verification = await runDeterministicVerification(opts.deterministicRunner(req), {
      levels: required?.status === "deferred" ? undefined : required?.levels,
      enforcement: required?.enforcement ?? "warn",
    });
    evidence.set(req.taskId, verification);

    if (verification.passed) {
      return {
        ...result,
        outcome: { ...result.outcome, deterministic_gate: "enabled" },
      };
    }

    const failureReason =
      "deterministic verification failed after Dev — no QA/model call was made. Fix these, then re-run:\n" +
      renderDeterministicVerification(verification).join("\n");
    return {
      ...result,
      outcome: {
        ...result.outcome,
        result: "FAIL",
        failure_reason: failureReason,
        deterministic_gate: "enabled",
      },
      postDevVerificationFailed: true,
    };
  };

  return {
    executor,
    verificationFor: (req) => evidence.get(req.taskId),
  };
}
