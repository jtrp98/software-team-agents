import * as path from "node:path";
import { AgentStage, TaskState } from "../types.js";
import { ApprovalType, type ApprovalRecord, type HumanDecisionRecord } from "../gates/approval.js";
import {
  NoTrustedHumanChannelError,
  UntrustedHumanDecisionError,
  type HumanDecisionSubmission,
  type HumanDecisionVerifier,
} from "../gates/humanDecision.js";
import { resolveHumanDecisionChannel } from "../gates/humanChannelConfig.js";
import { chatRelayInstructions } from "../gates/chatRelayChannel.js";
import { ApprovalDecisionError } from "../gates/approval.js";
import type { LaneAction } from "../gates/laneApproval.js";
import { LaneActRefusedError, LaneDecisionService } from "../roles/laneDecisions.js";
import type { RoleLane } from "../roles/roleLane.js";
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
  /**
   * Pending request reference for Controller presentation in chat, from
   * persisted evidence. Null until STA has published it.
   */
  announcement: { channel: string; ref: string; url: string | null } | null;
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
  /** Set when the task parked on a human gate and its channel could not announce it; the request stays pending. */
  announcementError?: string;
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

/**
 * A person's lane sign-off or acknowledgement (V13 TASK-028). Without
 * requestId, STA opens the pending lane request over the current items for
 * Controller presentation; with it, Controller relays the chat answer.
 */
export interface SemanticLaneDecisionParams {
  module: string;
  lane: RoleLane;
  action: LaneAction;
  /** Acknowledgement only: the items acknowledged. Default: what the sending lanes hand off to this lane. */
  itemIds?: readonly string[];
  requestId?: string;
  submission?: Omit<HumanDecisionSubmission, "requestId">;
  caller?: {
    kind?: string;
    id?: string;
  };
}

export interface SemanticLaneDecisionResponse {
  ok: boolean;
  module: string;
  lane: RoleLane;
  action: LaneAction;
  requestId?: string;
  /** What the request covers, as STA recorded it. */
  items?: readonly { id: string; version: number; digest: string }[];
  /** Human-facing answer format and Controller-asserted identity limitation. */
  prompt?: string;
  approved?: boolean;
  /** The request reference STA gave the Controller for presentation in chat. */
  announcement?: { channel: string; ref: string; url: string | null } | null;
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
  laneDecision(params: SemanticLaneDecisionParams): Promise<SemanticLaneDecisionResponse>;
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
  const stageEntryGuard = options.stageEntryGuard ?? createRoleLaneStageGuard({ projectRoot, ledger: store });
  const humanDecisionVerifier = options.humanDecisionVerifier ?? resolveHumanDecisionChannel();
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

  /** Publishes the task's pending request on the trusted channel; returns the failure, if any. Never decides anything. */
  async function announcePending(orch: Orchestrator): Promise<string | undefined> {
    try {
      await orch.publishPendingApproval();
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

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
          prompt: `${APPROVAL_PROMPT[pending.scope.type] ?? pending.reason}. ${chatRelayInstructions(pending.requestId)}`,
          announcement: orch.approvalPublication(pending.requestId, evidence),
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
        const announcementError = await announcePending(orch);
        const status = await getTaskSemanticStatus(params.taskId);
        return {
          ok: false,
          taskId: params.taskId,
          nextAction: `Approve pending ${pending.scope.type} gate: ${pending.reason}`,
          status,
          gate: status.requiredGate,
          denialReason: "Task is blocked on pending human approval gate",
          ...(announcementError === undefined ? {} : { announcementError }),
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
      // A gate this step opened is announced now, so the person learns of it without anyone polling.
      const announcementError = stepStatus.kind === "WAITING_FOR_HUMAN" ? await announcePending(orch) : undefined;

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
        ...(announcementError === undefined ? {} : { announcementError }),
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
      // The Controller relays an explicit chat answer. The verifier requires a
      // message reference; the pending request and ledger remain STA-owned.
      if (params.caller?.kind !== "controller") {
        throw new UntrustedHumanDecisionError(
          `Chat approval must be relayed by Controller; got ${params.caller?.kind ?? "unspecified"}`,
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

      if (params.submission?.requestId !== params.requestId) {
        return {
          ok: false, taskId: params.taskId, requestId: params.requestId, code: "refused",
          denialReason: "Submission request does not match the requested approval",
        };
      }

      try {
        // A fresh request must be presented to the human before the Controller
        // can relay an answer on a later call.
        const publication = await orch.publishPendingApproval();
        if (publication?.fresh) {
          return {
            ok: false,
            taskId: params.taskId,
            requestId: params.requestId,
            code: "announced",
            denialReason: `request announced on ${publication.channel} (${publication.url ?? publication.ref}); an authorized approver answers there first`,
          };
        }
        const { decision } = await orch.submitHumanDecision(params.submission);
        registry.refreshStateView();
        return {
          ok: true,
          taskId: params.taskId,
          requestId: params.requestId,
          approved: decision.approved,
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

    async laneDecision(params: SemanticLaneDecisionParams): Promise<SemanticLaneDecisionResponse> {
      if (params.caller?.kind !== "controller") {
        throw new UntrustedHumanDecisionError(`Chat lane decision must be relayed by Controller; got ${params.caller?.kind ?? "unspecified"}`);
      }
      const base = { module: params.module, lane: params.lane, action: params.action };
      // The lane API owns the top-level request ID. A runtime caller cannot
      // smuggle a different one through the typed Omit<> submission shape.
      if (params.submission && Object.prototype.hasOwnProperty.call(params.submission, "requestId")) {
        return { ok: false, ...base, requestId: params.requestId, code: "refused", denialReason: "Lane submission must not override the top-level request ID" };
      }
      const lanes = new LaneDecisionService({ store, verifier: humanDecisionVerifier, now });
      try {
        let requestId = params.requestId;
        if (requestId === undefined) {
          requestId = lanes.request(projectRoot, params.module, params.lane, params.action, params.itemIds).requestId;
        } else {
          const existing = store.loadLaneRequest(requestId);
          if (!existing || existing.scope.module !== params.module || existing.scope.lane !== params.lane || existing.scope.action !== params.action) {
            return { ok: false, ...base, requestId, code: "refused", denialReason: `lane request ${requestId} is not a pending ${params.lane} ${params.action} for module ${params.module}` };
          }
        }
        const record = store.loadLaneRequest(requestId)!;
        const items = record.scope.items.map((item) => ({ ...item }));
        const prompt = `${APPROVAL_PROMPT[record.scope.type]}. ${chatRelayInstructions(requestId)}`;
        const publication = await lanes.publish(requestId);
        const announcement = publication ? { channel: publication.channel, ref: publication.ref, url: publication.url } : null;
        if (publication?.fresh || (params.requestId === undefined && publication)) {
          return {
            ok: false,
            ...base,
            requestId,
            items,
            prompt,
            announcement,
            code: "announced",
            denialReason: `request announced on ${publication.channel} (${publication.url ?? publication.ref}); an authorized approver answers there first`,
          };
        }
        const { record: decided } = await lanes.submit({ ...(params.submission ?? {}), requestId });
        return { ok: true, ...base, requestId, items, prompt, announcement, approved: decided.decision!.approved };
      } catch (e) {
        if (e instanceof NoTrustedHumanChannelError) {
          return { ok: false, ...base, ...(params.requestId ? { requestId: params.requestId } : {}), code: "no-trusted-channel", denialReason: e.message };
        }
        if (e instanceof LaneActRefusedError) {
          return { ok: false, ...base, code: `not-ready:${e.code}`, denialReason: e.message };
        }
        if (e instanceof UntrustedHumanDecisionError || e instanceof ApprovalDecisionError) {
          return { ok: false, ...base, ...(params.requestId ? { requestId: params.requestId } : {}), code: "refused", denialReason: e.message };
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
