import type { AgentExecutor, AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import type { RuntimeTask } from "../orchestrator/runtimeTask.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import { AgentStage } from "../types.js";
import {
  FULL_RUNTIME_VERIFICATION_LEVELS,
  loadTestPyramid,
  refineVerificationFromScope,
  type RuntimeVerificationLevel,
} from "../testing/testPyramid.js";
import {
  renderDeterministicVerification,
  runDeterministicVerification,
  type DeterministicRunner,
  type DeterministicVerification,
} from "./deterministic.js";
import { buildQaScope, type QaScopeInput } from "./scope.js";

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
  changeAware?: {
    changedFiles: (req: AgentExecutorRequest) => Promise<readonly string[]> | readonly string[];
    scopeInputs?: (req: AgentExecutorRequest) => Partial<QaScopeInput> | undefined;
    projectRoot: string;
    workflow: string;
    classification: Pick<ClassificationResult, "sensitiveGate">;
  };
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

    let required = opts.requiredVerification(req);
    let selectionRecorded = false;
    if (required && required.status !== "deferred" && opts.changeAware) {
      selectionRecorded = true;
      try {
        const changedFiles = await opts.changeAware.changedFiles(req);
        const extra = opts.changeAware.scopeInputs?.(req) ?? {};
        const scope = buildQaScope({
          ...extra,
          taskId: req.taskId,
          changedFiles: [...changedFiles],
        });
        let pyramid = null;
        let pyramidUnavailableReason: string | undefined;
        try {
          pyramid = loadTestPyramid(opts.changeAware.projectRoot);
        } catch (error) {
          pyramidUnavailableReason = error instanceof Error ? error.message : String(error);
        }
        const knownLevels = new Set<string>([
          "lint",
          "typecheck",
          "unit",
          "integration",
          "api",
          "e2e",
          "build",
        ]);
        if (required.levels.some((level) => !knownLevels.has(level))) {
          throw new Error(`required_verification contains an unknown level: ${required.levels.filter((level) => !knownLevels.has(level)).join(", ")}`);
        }
        const refined = refineVerificationFromScope({
          selection: {
            levels: required.levels as RuntimeVerificationLevel[],
            enforcement: required.enforcement ?? "warn",
            source: required.status === "selected" ? "test-pyramid" : "full-order",
            reason: required.reason,
          },
          taskTypes: required.task_types,
          workflow: opts.changeAware.workflow,
          classification: opts.changeAware.classification,
          scope,
          pyramid,
          pyramidUnavailableReason,
        });
        required = {
          status: refined.source === "test-pyramid" ? "selected" : "full-order",
          levels: refined.levels,
          reason: refined.reason,
          enforcement: refined.enforcement,
          task_types: refined.taskTypes,
          selection_source: refined.selectionSource,
        };
      } catch (error) {
        required = {
          status: "full-order",
          levels: [...FULL_RUNTIME_VERIFICATION_LEVELS],
          reason: `change-aware selection unavailable; preserving the historical full deterministic order: ${error instanceof Error ? error.message : String(error)}`,
          enforcement: required.enforcement ?? "warn",
          task_types: required.task_types ?? [],
          selection_source: "full-order",
        };
      }
    }

    const baseVerification = await runDeterministicVerification(opts.deterministicRunner(req), {
      levels: required?.status === "deferred" ? undefined : required?.levels,
      enforcement: required?.enforcement ?? "warn",
    });
    const verification: DeterministicVerification =
      selectionRecorded && required
        ? {
            ...baseVerification,
            selection: {
              source: required.selection_source ?? required.status,
              taskTypes: required.task_types ?? [],
              levels: [...required.levels],
              reason: required.reason,
            },
          }
        : baseVerification;
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
