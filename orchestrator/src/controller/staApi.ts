import * as path from "node:path";
import { AgentStage, TaskState } from "../types.js";
import { ApprovalType, type ApprovalRecord, type HumanDecisionRecord } from "../gates/approval.js";
import {
  NoTrustedHumanChannelError,
  UntrustedHumanDecisionError,
  type HumanDecisionSubmission,
  type HumanDecisionVerifier,
  UNCONFIGURED_HUMAN_CHANNEL,
} from "../gates/humanDecision.js";
import { APPROVAL_PROMPT } from "../cli/verbs/approve.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { readModuleDoc } from "../agents/moduleDocs.js";
import { readWorkPlan, type WorkPlanTask } from "../docs/planGraph.js";
import { describeStatus, isTaskDone } from "../orchestrator/taskStatus.js";
import { TaskNotFoundError, type TaskStore, type PersistedTask } from "../store/taskStore.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { defaultStateDbPath } from "../store/stateView.js";
import { TaskRegistry, type TaskRegistryOptions } from "../orchestrator/taskRegistry.js";
import { createRoleLaneStageGuard, type StageEntryGuard } from "../orchestrator/stageGuards.js";
import { Orchestrator, type AgentExecutor } from "../orchestrator/orchestrator.js";
import { verifyTaskCompletion } from "../orchestrator/transitionGuard.js";
import {
  composeProductionTaskExecutor,
  taskExecutorOptionsFromArgs,
  type TaskExecutorOptions,
} from "../cli/composition/taskExecutor.js";
import { parseArgs } from "../cli.js";

/**
 * Base error for semantic STA Controller API operations.
 */
export class StaApiError extends Error {
  constructor(message: string, readonly code: string = "STA_API_ERROR") {
    super(message);
    this.name = "StaApiError";
  }
}

/**
 * Thrown when a Controller caller attempts to exceed its authority:
 * e.g. impersonate a governed role/human, supply arbitrary execution paths or roles,
 * or bypass STA's canonical governance.
 */
export class CallerAuthorityError extends StaApiError {
  constructor(message: string) {
    super(message, "CALLER_AUTHORITY_DENIED");
    this.name = "CallerAuthorityError";
  }
}

export type SemanticTaskStatusKind =
  | "RUNNING"
  | "WAITING_FOR_HUMAN"
  | "BLOCKED"
  | "DONE"
  | "PAUSED"
  | "CANCELLED";

export interface SemanticRequiredGate {
  requestId: string;
  type: ApprovalType;
  reason: string;
  prompt: string;
}

export interface SemanticTaskStatus {
  taskId: string;
  state: TaskState;
  kind: SemanticTaskStatusKind;
  currentStage: string | null;
  nextAction: string;
  requiredGate: SemanticRequiredGate | null;
  evidenceRefs: readonly string[];
  waitingOn: readonly string[];
  denialReason: string | null;
  paused: boolean;
  cancelled: boolean;
  cancelReason: string | null;
  progress: {
    pipeline: readonly string[];
    currentCursor: number;
    completedStages: readonly string[];
  };
}

export interface SemanticTaskSummary {
  taskId: string;
  state: TaskState;
  kind: string;
  currentStage: string | null;
  nextAction: string;
  waitingOn: readonly string[];
  hasPendingGate: boolean;
}

export interface SemanticOverviewResponse {
  tasks: readonly SemanticTaskSummary[];
}

export interface SemanticPlanStage {
  stage: string;
  role: string;
  artifactType?: string;
  documentPath?: string;
}

export interface SemanticPlanTask {
  id: string;
  title?: string;
  ownerRole?: string;
  dependencies: readonly string[];
  status: string;
}

export interface SemanticPlanResponse {
  taskId?: string;
  moduleName?: string;
  workflow?: string;
  stages?: readonly SemanticPlanStage[];
  tasks?: readonly SemanticPlanTask[];
}

export interface SemanticExecuteParams {
  taskId: string;
  caller?: {
    kind?: "controller" | "human" | string;
    id?: string;
    role?: string;
  };
  // Defensive type guards to forbid bypassing STA
  role?: never;
  paths?: never;
  command?: never;
  executorCommand?: never;
}

export interface SemanticExecuteResponse {
  ok: boolean;
  taskId: string;
  executedStage?: string;
  nextAction: string;
  status: SemanticTaskStatus;
  gate?: SemanticRequiredGate | null;
  evidenceRef?: string;
  denialReason?: string;
}

export interface SemanticResultAttempt {
  stage: string;
  attempt: number;
  verdict: "PASS" | "FAIL" | "ERROR" | "BLOCKED";
  denialReason?: string;
  evidenceId?: string;
}

export interface SemanticResultResponse {
  taskId: string;
  completed: boolean;
  state: TaskState;
  completionEvidenceId: string | null;
  evidenceRefs: readonly string[];
  latestAttempt: SemanticResultAttempt | null;
  stages: readonly {
    stage: string;
    attempt: number;
    complete: boolean;
    evidenceId?: string;
  }[];
  artifacts: readonly {
    type: string;
    role: string;
    path?: string;
    digest?: string;
  }[];
}

export interface SemanticApproveParams {
  taskId: string;
  requestId: string;
  submission: HumanDecisionSubmission;
  caller?: {
    kind?: string;
    id?: string;
  };
}

export interface SemanticApproveResponse {
  ok: boolean;
  taskId: string;
  requestId: string;
  approved?: boolean;
  code?: string;
  denialReason?: string;
}

export interface SemanticCancelResponse {
  ok: boolean;
  taskId: string;
  status: "CANCELLED";
  reason: string;
}

export interface StaApiOptions {
  projectRoot?: string;
  stateDb?: string;
  store?: TaskStore;
  registry?: TaskRegistry;
  humanDecisionVerifier?: HumanDecisionVerifier;
  stageEntryGuard?: StageEntryGuard;
  executorOptions?: Partial<TaskExecutorOptions>;
  /** Optional custom executor factory (e.g. for testing); defaults to production composition. */
  executorFactory?: (orchestrator: Orchestrator) => Promise<AgentExecutor> | AgentExecutor;
  now?: () => number;
}

export interface StaApi {
  status(params: { taskId: string }): Promise<SemanticTaskStatus>;
  status(params?: { taskId?: undefined }): Promise<SemanticOverviewResponse>;
  status(params?: { taskId?: string }): Promise<SemanticTaskStatus | SemanticOverviewResponse>;
  plan(params?: { taskId?: string; moduleName?: string }): Promise<SemanticPlanResponse>;
  execute(params: SemanticExecuteParams): Promise<SemanticExecuteResponse>;
  result(params: { taskId: string }): Promise<SemanticResultResponse>;
  approve(params: SemanticApproveParams): Promise<SemanticApproveResponse>;
  cancel(params: { taskId: string; reason: string }): Promise<SemanticCancelResponse>;
  close(): void;
}

/**
 * Creates the canonical STA Application Service for Controller AI (V13 TASK-021).
 * Exposes stable semantic operations and encapsulates all internal adapter,
 * execution packet, worktree, and subprocess details within the STA control plane.
 */
export function createStaApi(options: StaApiOptions = {}): StaApi {
  const projectRoot = path.resolve(options.projectRoot ?? defaultProjectRoot());
  const ownsStore = !options.store;
  const store = options.store ?? new SqliteTaskStore(options.stateDb ?? defaultStateDbPath(projectRoot));
  const stageEntryGuard = options.stageEntryGuard ?? createRoleLaneStageGuard({ projectRoot });
  const humanDecisionVerifier = options.humanDecisionVerifier ?? UNCONFIGURED_HUMAN_CHANNEL;
  const now = options.now ?? Date.now;

  const registry =
    options.registry ??
    new TaskRegistry({
      store,
      now,
      contractRoot: projectRoot,
      stageEntryGuard,
      humanDecisionVerifier,
    });

  function getOrchestrator(taskId: string): Orchestrator {
    const task = store.loadTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return registry.resume(taskId);
  }

  function deriveNextAction(
    task: PersistedTask,
    orchStatus: ReturnType<Orchestrator["status"]>,
    pending: ReturnType<Orchestrator["pendingApprovalRequest"]>,
    waitingOn: readonly string[],
  ): string {
    if (!task) return "Unknown task";
    if (task.cancelled) return `Task was cancelled: ${task.cancelReason}`;
    if (task.paused) return "Task is paused; unpause to proceed";
    if (pending) return `Approve pending ${pending.scope.type} gate: ${pending.reason}`;
    if (orchStatus.kind === "DEPLOYED") return "Task complete: deployed and verified";
    if (orchStatus.kind === "BLOCKED") return `Task blocked: ${orchStatus.reason ?? "unresolved block"}`;
    if (waitingOn.length > 0) return `Waiting on dependencies: ${waitingOn.join(", ")}`;
    if (orchStatus.kind === "RUNNING") return `Execute next stage: ${orchStatus.stage}`;
    return `Task at ${task.machine.current}`;
  }

  async function getTaskSemanticStatus(taskId: string): Promise<SemanticTaskStatus> {
    const task = store.loadTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    const orch = registry.resume(taskId);
    const orchStatus = orch.status();
    const pending = orch.pendingApprovalRequest();
    const evidence = orch.evidence();
    const waitingOn = registry.waitingOn(taskId);

    const completedStages = evidence
      .filter((e) => e.kind === "stage-completion")
      .map((e) => `${e.stage}#${e.attempt}`);

    const kind: SemanticTaskStatusKind = task.cancelled
      ? "CANCELLED"
      : task.paused
        ? "PAUSED"
        : pending
          ? "WAITING_FOR_HUMAN"
          : orchStatus.kind === "DEPLOYED"
            ? "DONE"
            : (orchStatus.kind as SemanticTaskStatusKind);

    const requiredGate: SemanticRequiredGate | null = pending
      ? {
          requestId: pending.requestId,
          type: pending.scope.type,
          reason: pending.reason,
          prompt: APPROVAL_PROMPT[pending.scope.type] ?? pending.reason,
        }
      : null;

    const nextAction = deriveNextAction(task, orchStatus, pending, waitingOn);

    return {
      taskId,
      state: task.machine.current,
      kind,
      currentStage: orchStatus.kind === "RUNNING" ? orchStatus.stage : null,
      nextAction,
      requiredGate,
      evidenceRefs: evidence.map((e) => e.evidenceId),
      waitingOn,
      denialReason: orchStatus.kind === "BLOCKED" ? (orchStatus.reason ?? null) : null,
      paused: task.paused,
      cancelled: task.cancelled,
      cancelReason: task.cancelReason,
      progress: {
        pipeline: orch.machine.pipeline,
        currentCursor: task.pipelineCursor,
        completedStages,
      },
    };
  }

  return {
    status: (async (params?: { taskId?: string }): Promise<SemanticTaskStatus | SemanticOverviewResponse> => {
      if (params?.taskId) {
        return await getTaskSemanticStatus(params.taskId);
      }
      const allTasks: PersistedTask[] = store.listTasks();
      const summaries: SemanticTaskSummary[] = allTasks.map((t: PersistedTask) => {
        const waitingOn = registry.waitingOn(t.taskId);
        const pending = t.approvals.find((a: ApprovalRecord) => a.status === "pending");
        let kind = t.cancelled ? "CANCELLED" : t.paused ? "PAUSED" : pending ? "WAITING_FOR_HUMAN" : "ACTIVE";
        if (isTaskDone(t)) kind = "DONE";
        else if (t.blockedReason) kind = "BLOCKED";

        let currentStage: string | null = null;
        if (!t.cancelled && !t.paused && !pending && !isTaskDone(t)) {
          const idx = t.pipelineCursor;
          currentStage = t.machine.pipeline[idx] ?? null;
        }

        const nextAction = pending
          ? `Approve pending ${pending.scope.type} gate`
          : waitingOn.length > 0
            ? `Waiting on dependencies: ${waitingOn.join(", ")}`
            : isTaskDone(t)
              ? "Task complete"
              : currentStage
                ? `Execute next stage: ${currentStage}`
                : `Task at ${t.machine.current}`;

        return {
          taskId: t.taskId,
          state: t.machine.current,
          kind,
          currentStage,
          nextAction,
          waitingOn,
          hasPendingGate: Boolean(pending),
        };
      });

      return { tasks: summaries };
    }) as StaApi["status"],

    async plan(params?: { taskId?: string; moduleName?: string }): Promise<SemanticPlanResponse> {
      let moduleName = params?.moduleName;
      let stages: SemanticPlanStage[] | undefined;
      let workflow: string | undefined;

      if (params?.taskId) {
        const task = store.loadTask(params.taskId);
        if (!task) throw new TaskNotFoundError(params.taskId);
        if (task.runtimeTask && "version" in task.runtimeTask && task.runtimeTask.version === 2) {
          workflow = task.runtimeTask.workflow;
          if (task.runtimeTask.workflow_plan) {
            stages = task.runtimeTask.workflow_plan.pipeline.map((stageName) => ({
              stage: stageName,
              role: stageName,
            }));
          }
        }
      }

      let tasks: SemanticPlanTask[] | undefined;
      if (moduleName) {
        const doc = readModuleDoc(projectRoot, moduleName, "plan.md");
        if (doc) {
          const parsed = readWorkPlan(doc);
          tasks = parsed.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            ownerRole: t.owner,
            dependencies: t.dependsOn,
            status: t.status,
          }));
        }
      }

      return {
        taskId: params?.taskId,
        moduleName,
        workflow,
        stages,
        tasks,
      };
    },

    async execute(params: SemanticExecuteParams): Promise<SemanticExecuteResponse> {
      // 1. Caller authority check: Controller cannot impersonate roles or dispatch arbitrary paths/commands
      const untyped = params as unknown as Record<string, unknown>;
      if (untyped.role !== undefined) {
        throw new CallerAuthorityError(
          "Controller cannot dispatch an arbitrary role: STA control plane determines the role and contract from canonical workflow state.",
        );
      }
      if (untyped.paths !== undefined) {
        throw new CallerAuthorityError(
          "Controller cannot specify execution paths: write scope is governed strictly by the active role contract.",
        );
      }
      if (untyped.command !== undefined || untyped.executorCommand !== undefined) {
        throw new CallerAuthorityError(
          "Controller cannot specify executor commands: execution details are encapsulated within the STA control plane.",
        );
      }
      if (params.caller?.role !== undefined) {
        throw new CallerAuthorityError(
          `Controller cannot impersonate governed role "${params.caller.role}".`,
        );
      }
      if (params.caller?.kind === "human") {
        throw new CallerAuthorityError("Controller cannot impersonate human authority.");
      }

      // 2. Validate task state
      const task = store.loadTask(params.taskId);
      if (!task) throw new TaskNotFoundError(params.taskId);

      const statusBefore = await getTaskSemanticStatus(params.taskId);
      if (task.cancelled) {
        return {
          ok: false,
          taskId: params.taskId,
          nextAction: statusBefore.nextAction,
          status: statusBefore,
          denialReason: `Task was cancelled: ${task.cancelReason}`,
        };
      }
      if (task.paused) {
        return {
          ok: false,
          taskId: params.taskId,
          nextAction: statusBefore.nextAction,
          status: statusBefore,
          denialReason: "Task is paused",
        };
      }

      const waitingOn = registry.waitingOn(params.taskId);
      if (waitingOn.length > 0) {
        return {
          ok: false,
          taskId: params.taskId,
          nextAction: `Waiting on dependencies: ${waitingOn.join(", ")}`,
          status: statusBefore,
          denialReason: `Dependencies not met: ${waitingOn.join(", ")}`,
        };
      }

      const orch = registry.resume(params.taskId);
      const pending = orch.pendingApprovalRequest();
      if (pending) {
        return {
          ok: false,
          taskId: params.taskId,
          nextAction: `Approve pending ${pending.scope.type} gate: ${pending.reason}`,
          status: statusBefore,
          gate: statusBefore.requiredGate,
          denialReason: "Task is blocked on pending human approval gate",
        };
      }

      const currentOrchStatus = orch.status();
      if (currentOrchStatus.kind !== "RUNNING") {
        const reason =
          currentOrchStatus.kind === "DEPLOYED"
            ? "Task already completed"
            : currentOrchStatus.kind === "BLOCKED"
              ? currentOrchStatus.reason
              : "Task waiting for human approval";
        return {
          ok: false,
          taskId: params.taskId,
          nextAction: currentOrchStatus.kind === "DEPLOYED" ? "Task complete" : reason,
          status: statusBefore,
          denialReason: reason,
        };
      }

      const stage = currentOrchStatus.stage;

      // 3. Compose executor and execute single stage step through STA
      let executor: AgentExecutor;
      if (options.executorFactory) {
        executor = await options.executorFactory(orch);
      } else {
        const cliArgs = parseArgs(["--project-root", projectRoot], projectRoot);
        const executorOpts: TaskExecutorOptions = {
          ...taskExecutorOptionsFromArgs(cliArgs),
          projectRoot,
          ...options.executorOptions,
        };
        const composition = await composeProductionTaskExecutor(executorOpts, params.taskId, orch, store);
        executor = composition.executor;
      }

      const stepStatus = await orch.step(executor);
      registry.refreshStateView();

      const statusAfter = await getTaskSemanticStatus(params.taskId);
      const latestEvidence = orch.evidence().slice(-1)[0]?.evidenceId;

      return {
        ok: stepStatus.kind === "RUNNING" || stepStatus.kind === "DEPLOYED",
        taskId: params.taskId,
        executedStage: stage,
        nextAction: statusAfter.nextAction,
        status: statusAfter,
        gate: statusAfter.requiredGate,
        evidenceRef: latestEvidence,
        denialReason: stepStatus.kind === "BLOCKED" ? stepStatus.reason : undefined,
      };
    },

    async result(params: { taskId: string }): Promise<SemanticResultResponse> {
      const task = store.loadTask(params.taskId);
      if (!task) throw new TaskNotFoundError(params.taskId);

      const orch = registry.resume(params.taskId);
      const evidence = orch.evidence();
      const verifiedCompletion = verifyTaskCompletion(store, task);
      const completed = isTaskDone(task) && verifiedCompletion.done;

      const roleRuns = evidence.filter((e) => e.kind === "role-run");
      const latestRun = roleRuns[roleRuns.length - 1];
      let latestAttempt: SemanticResultAttempt | null = null;
      if (latestRun && latestRun.payload.kind === "role-run") {
        latestAttempt = {
          stage: latestRun.stage,
          attempt: latestRun.attempt,
          verdict: (latestRun.payload.result as "PASS" | "FAIL") ?? "FAIL",
          evidenceId: latestRun.evidenceId,
        };
      }

      const stageCompletions = evidence
        .filter((e) => e.kind === "stage-completion")
        .map((e) => ({
          stage: e.stage,
          attempt: e.attempt,
          complete: true,
          evidenceId: e.evidenceId,
        }));

      const artifacts = evidence
        .filter((e) => e.kind === "artifact")
        .map((e) => {
          const payload = e.payload as Record<string, unknown>;
          return {
            type: String(payload.artifactType ?? "unknown"),
            role: e.role,
            path: typeof payload.path === "string" ? payload.path : undefined,
            digest: typeof payload.digest === "string" ? payload.digest : undefined,
          };
        });

      return {
        taskId: params.taskId,
        completed,
        state: task.machine.current,
        completionEvidenceId: task.completionEvidenceId ?? null,
        evidenceRefs: evidence.map((e) => e.evidenceId),
        latestAttempt,
        stages: stageCompletions,
        artifacts,
      };
    },

    async approve(params: SemanticApproveParams): Promise<SemanticApproveResponse> {
      // 1. Controller cannot approve as Human
      if (params.caller?.kind === "controller") {
        throw new UntrustedHumanDecisionError(
          "Controller cannot approve as Human: approval gates require trusted human authority.",
        );
      }
      if (!params.caller || params.caller.kind !== "human") {
        throw new UntrustedHumanDecisionError(
          `Approval actor must be human; got ${params.caller?.kind ?? "unspecified"}`,
        );
      }

      const task = store.loadTask(params.taskId);
      if (!task) throw new TaskNotFoundError(params.taskId);

      const orch = registry.resume(params.taskId);
      const pending = orch.pendingApprovalRequest();
      if (!pending) {
        return {
          ok: false,
          taskId: params.taskId,
          requestId: params.requestId,
          denialReason: "No pending approval request found for task",
        };
      }
      if (pending.requestId !== params.requestId) {
        return {
          ok: false,
          taskId: params.taskId,
          requestId: params.requestId,
          denialReason: `Pending request is ${pending.requestId}, not ${params.requestId}`,
        };
      }

      try {
        orch.submitHumanDecision(params.submission);
        registry.refreshStateView();
        return {
          ok: true,
          taskId: params.taskId,
          requestId: params.requestId,
          approved: params.submission.approved,
        };
      } catch (e) {
        if (e instanceof NoTrustedHumanChannelError) {
          return {
            ok: false,
            taskId: params.taskId,
            requestId: params.requestId,
            code: "no-trusted-channel",
            denialReason: e.message,
          };
        }
        if (e instanceof UntrustedHumanDecisionError || (e as Error).name === "ApprovalDecisionError") {
          return {
            ok: false,
            taskId: params.taskId,
            requestId: params.requestId,
            code: "refused",
            denialReason: (e as Error).message,
          };
        }
        throw e;
      }
    },

    async cancel(params: { taskId: string; reason: string }): Promise<SemanticCancelResponse> {
      if (!params.reason || !params.reason.trim()) {
        throw new StaApiError("Cancel requires an explicit non-empty reason.");
      }
      const task = store.loadTask(params.taskId);
      if (!task) throw new TaskNotFoundError(params.taskId);

      registry.cancel(params.taskId, params.reason.trim());
      registry.refreshStateView();

      return {
        ok: true,
        taskId: params.taskId,
        status: "CANCELLED",
        reason: params.reason.trim(),
      };
    },

    close(): void {
      if (ownsStore) {
        registry.close();
      }
    },
  };
}
