import { AgentStage, TaskState } from "../types.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import { forceBlock, forwardState, recoverTo, transition, type TaskMachine } from "../state/taskState.js";
import { MAX_RETRY, initTaskRun, recordFailure, type TaskRun } from "../retry/retryPolicy.js";
import { decideRecovery, type RecoveryAction } from "../retry/recoveryPolicy.js";
import { checkGate, type GateContext } from "../gates/gatePolicy.js";
import {
  ApprovalType,
  approvalTypeForEdge,
  decideApproval as decideApprovalRecord,
  findApproval,
  gateEvidenceFrom,
  requestApproval,
  type ApprovalLedger,
  type ApprovalRecord,
} from "../gates/approval.js";
import {
  ArtifactType,
  validateArtifact,
  type QaReportArtifact,
  type SecurityReportArtifact,
} from "../artifacts/schemas.js";
import { selectContext, type ContextCategory, type ContextItem } from "../context/contextSelection.js";
import { RunLog, type RunOutcome } from "../observability/runLog.js";
import { assertBudget, BudgetExceededError, DEFAULT_BUDGET, type Budget } from "../cost/costControl.js";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { EventBus } from "../events/eventBus.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { TaskNotFoundError, newPersistedTask, type PersistedTask, type TaskStore } from "../store/taskStore.js";
import { type StructuredFailure } from "./failure.js";
import { stageStateOf } from "./taskStatus.js";

export interface AgentExecutorRequest {
  stage: AgentStage;
  taskId: string;
  context: ContextItem[];
}

export interface AgentExecutorResult {
  outcome: RunOutcome;
  artifactType?: ArtifactType;
  artifact?: unknown;
  /** Evidence a human, not this agent, actually supplied (e.g. relayed approval) — rare; usually set via provideHumanApproval instead. */
  gateEvidence?: Partial<GateContext>;
  /**
   * A failure as structured data: what broke, who owns it, whether a person
   * must look. The agent supplies the facts; the orchestrator decides where
   * the task goes next (see failure.ts). Optional — omitting it keeps the
   * original behaviour of sending a failed round back to the first
   * implementation stage.
   */
  failure?: StructuredFailure;
}

/** The pluggable seam: item 13 is a pure coordinator, it never runs an agent itself. */
export type AgentExecutor = (req: AgentExecutorRequest) => Promise<AgentExecutorResult> | AgentExecutorResult;

export type OrchestratorStatus =
  | { kind: "RUNNING"; stage: AgentStage }
  | { kind: "WAITING_FOR_HUMAN"; from: TaskState; to: TaskState; reason: string; approvalType: ApprovalType | null }
  | { kind: "BLOCKED"; reason: string }
  | { kind: "DEPLOYED" };

/**
 * Item 14: every routing decision is also an event, not only a return value —
 * "Developer finished -> emit IMPLEMENTATION_COMPLETED -> orchestrator routes
 * -> QA" from task-detail.md maps to AGENT_COMPLETED in, AGENT_ASSIGNED out.
 */
export interface OrchestratorEventMap {
  AGENT_ASSIGNED: { taskId: string; stage: AgentStage };
  AGENT_COMPLETED: { taskId: string; stage: AgentStage; outcome: RunOutcome };
  WAITING_FOR_HUMAN: { taskId: string; from: TaskState; to: TaskState; reason: string; approvalType: ApprovalType | null };
  TASK_BLOCKED: { taskId: string; reason: string };
  TASK_DEPLOYED: { taskId: string };
}

export interface OrchestratorOptions {
  budget?: Budget;
  /**
   * Where this task's state is kept. Defaults to a private in-memory store —
   * fine for a test, useless for a real run that has to survive the process.
   */
  store?: TaskStore;
  /** Task ids that must reach DEPLOYED first. Enforced by orchestrator/taskRegistry.ts, recorded here. */
  dependsOn?: string[];
  now?: () => number;
  /**
   * Internal: rebuild from stored state instead of creating a new task.
   * Use `Orchestrator.resume()` / the registry rather than passing this by hand.
   */
  restore?: PersistedTask;
}

function assertCanProduce(stage: AgentStage, artifactType: ArtifactType): void {
  if (!AGENT_REGISTRY[stage].outputs.includes(artifactType)) {
    throw new Error(`${stage} is not registered (item 9) to produce ${artifactType}`);
  }
}

function implementationStart(pipeline: AgentStage[]): number {
  return pipeline.findIndex((s) => s === AgentStage.BACKEND_ENGINEER || s === AgentStage.FRONTEND_ENGINEER);
}

/**
 * The central controller (item 13): state management, routing, retry
 * handling, gate enforcement, context assembly, and agent selection — all
 * composed from items 1-12, none of it reimplemented here. Structurally
 * replaces CLAUDE.md's "no agent invokes the next one" rule: this is now the
 * only thing that decides what runs next, and no agent holds a reference to
 * transition()/gatedTransition()/recordFailure() itself.
 *
 * Communication is event-driven (item 14): reportCompletion() is the one
 * entry point an agent's completion reaches the orchestrator through, and
 * every routing decision it makes is also emitted on `events`, not only
 * returned — step() is a convenience wrapper over reportCompletion() for
 * callers that do want a direct call/await relationship.
 *
 * Since T01 it is durable as well: every state change is written through to a
 * `TaskStore` before the caller is told about it, so a closed terminal or a
 * crashed process resumes from where it stopped (`Orchestrator.resume`)
 * instead of re-running a pipeline whose expensive stages already ran.
 * Approvals a person gave are part of that stored state — resuming must never
 * re-ask a question that was already answered.
 */
export class Orchestrator {
  readonly runLog: RunLog;
  readonly events = new EventBus<OrchestratorEventMap>();
  readonly taskId: string;
  readonly store: TaskStore;
  readonly dependsOn: string[];
  readonly classification: ClassificationResult;
  private readonly pipeline: AgentStage[];
  private readonly implementationStartIndex: number;
  private readonly budget: Budget;
  private readonly now: () => number;
  private readonly createdAt: number;
  private run: TaskRun;
  private gateContext: GateContext;
  private artifactStore: Partial<Record<ContextCategory, string>>;
  private pipelineCursor: number;
  private blockedReason: string | undefined;
  private lastFailure: StructuredFailure | null;
  private approvals: ApprovalLedger;
  private lastStatusKey: string | undefined;
  /**
   * T31's pause/cancel — managed by `TaskRegistry.pause()`/`cancel()` directly against the
   * store, never by this class itself (they are a human override, orthogonal to the pipeline's
   * own state machine). Carried here only so a `snapshot()` taken mid-run echoes back whatever
   * was loaded instead of silently resetting it to false/null on the next save.
   */
  private paused: boolean;
  private cancelled: boolean;
  private cancelReason: string | null;
  /** The state the task was in when the current failure arrived, captured before retryPolicy moves it. */
  private stateBeforeFailure: TaskState = TaskState.CREATED;
  /** What the last failure resolved to (T07). Exposed for the CLI and the run log; not persisted — it is derived, not state. */
  private lastRecovery: RecoveryAction | null = null;

  constructor(taskId: string, classification: ClassificationResult, opts?: OrchestratorOptions) {
    const restore = opts?.restore;
    this.taskId = taskId;
    this.now = opts?.now ?? Date.now;
    this.store = opts?.store ?? new MemoryTaskStore();
    this.budget = opts?.budget ?? DEFAULT_BUDGET;
    this.classification = classification;
    this.createdAt = restore?.createdAt ?? this.now();
    this.dependsOn = restore ? [...restore.dependsOn] : [...(opts?.dependsOn ?? [])];
    this.pipeline = restore ? restore.machine.pipeline : classification.pipeline;
    this.implementationStartIndex = implementationStart(this.pipeline);

    if (restore) {
      this.run = { machine: restore.machine, retries: { ...restore.retries } };
      this.gateContext = { ...restore.gateContext };
      this.artifactStore = { ...restore.artifacts } as Partial<Record<ContextCategory, string>>;
      this.pipelineCursor = restore.pipelineCursor;
      this.blockedReason = restore.blockedReason ?? undefined;
      this.lastFailure = restore.lastFailure;
      this.approvals = [...restore.approvals];
      this.paused = restore.paused;
      this.cancelled = restore.cancelled;
      this.cancelReason = restore.cancelReason;
      // Seeded from the store so budget accounting (item 12) counts what the
      // earlier process already spent — a resumed task must not get a fresh
      // token allowance just because it restarted.
      this.runLog = new RunLog(this.store.runsForTask(taskId));
    } else {
      this.run = initTaskRun(classification.pipeline, classification.requiresHumanApproval);
      this.gateContext = {};
      this.artifactStore = {};
      this.pipelineCursor = 0;
      this.blockedReason = undefined;
      this.lastFailure = null;
      this.approvals = [];
      this.paused = false;
      this.cancelled = false;
      this.cancelReason = null;
      this.runLog = new RunLog();
      this.store.createTask(
        newPersistedTask({
          taskId,
          dependsOn: this.dependsOn,
          classification,
          machine: this.run.machine,
          now: this.createdAt,
        }),
      );
    }
  }

  /**
   * Rebuilds an orchestrator from stored state. The task continues with the
   * state, retry counts, approvals, artifacts and spend it already had —
   * nothing is replayed and no agent is re-run, because a stage that already
   * cost a model run must not be paid for twice.
   */
  static resume(
    taskId: string,
    store: TaskStore,
    opts?: Omit<OrchestratorOptions, "store" | "dependsOn" | "restore">,
  ): Orchestrator {
    const stored = store.loadTask(taskId);
    if (!stored) throw new TaskNotFoundError(taskId);
    return Orchestrator.fromPersisted(stored, store, opts);
  }

  /** Same as resume(), for a caller that already holds the row (the registry lists every task in one query). */
  static fromPersisted(
    stored: PersistedTask,
    store: TaskStore,
    opts?: Omit<OrchestratorOptions, "store" | "dependsOn" | "restore">,
  ): Orchestrator {
    return new Orchestrator(stored.taskId, stored.classification, { ...opts, store, restore: stored });
  }

  get machine(): TaskMachine {
    return this.run.machine;
  }

  get retries(): { qa: number; security: number } {
    return this.run.retries;
  }

  /** How the most recent failure was resolved (T07), or null if none has happened in this process. */
  get recovery(): RecoveryAction | null {
    return this.lastRecovery;
  }

  /** The exact row this orchestrator would persist right now. */
  snapshot(): PersistedTask {
    return {
      taskId: this.taskId,
      createdAt: this.createdAt,
      updatedAt: this.now(),
      dependsOn: [...this.dependsOn],
      classification: this.classification,
      machine: this.run.machine,
      retries: { ...this.run.retries },
      gateContext: { ...this.gateContext },
      artifacts: { ...this.artifactStore } as Record<string, string>,
      approvals: [...this.approvals],
      pipelineCursor: this.pipelineCursor,
      blockedReason: this.blockedReason ?? null,
      lastFailure: this.lastFailure,
      paused: this.paused,
      cancelled: this.cancelled,
      cancelReason: this.cancelReason,
    };
  }

  private persist(): void {
    this.store.saveTask(this.snapshot());
  }

  /** The full approval ledger for this task — what was asked, what was answered, when, and by whom. */
  get approvalLedger(): ApprovalRecord[] {
    return [...this.approvals];
  }

  /**
   * Records a person's answer to an approval this task actually asked for.
   *
   * A rejection is an answer, not an absence: it is stored as `rejected`, and
   * `advance()` blocks the task on it rather than posing the same question on
   * the next poll. Before T08 `provideHumanApproval(field, false)` was
   * indistinguishable from never having asked, so a "no" degraded into a
   * re-prompt until someone eventually said yes.
   */
  decideApproval(
    type: ApprovalType,
    approved: boolean,
    opts: { by?: string; note?: string } = {},
  ): void {
    this.approvals = decideApprovalRecord(this.approvals, {
      type,
      approved,
      now: this.now(),
      by: opts.by,
      note: opts.note,
    });
    this.syncGateEvidence();
    this.persist();
  }

  /**
   * The pre-T08 entry point, kept working: it maps a gate field back to the
   * approval type that feeds it. Callers that know which of the five decisions
   * they are answering should use `decideApproval` — this cannot express a
   * rejection distinctly, which is the whole reason T08 exists.
   */
  provideHumanApproval(field: "designApproved" | "humanApproved", value: boolean): void {
    const type = field === "designApproved" ? ApprovalType.SCHEMA_CONFIRMATION : ApprovalType.DEPLOY;
    if (!findApproval(this.approvals, type)) {
      // The gate has not been reached yet, so there is no question to answer.
      // Record the evidence directly, as this method always did.
      this.gateContext = { ...this.gateContext, [field]: value };
      this.persist();
      return;
    }
    this.decideApproval(type, value);
  }

  /** Keeps the gate's booleans equal to the ledger — the ledger is the source, these are the derivation. */
  private syncGateEvidence(): void {
    this.gateContext = { ...this.gateContext, ...gateEvidenceFrom(this.approvals) };
  }

  private statusKey(status: OrchestratorStatus): string {
    switch (status.kind) {
      case "RUNNING":
        return `RUNNING:${status.stage}`;
      case "WAITING_FOR_HUMAN":
        return `WAITING:${status.from}->${status.to}`;
      case "BLOCKED":
        return `BLOCKED:${status.reason}`;
      case "DEPLOYED":
        return "DEPLOYED";
    }
  }

  /** Emits the event matching a status, but only once per distinct status — repeated polling never re-fires the same event. */
  private emitAndReturn(status: OrchestratorStatus): OrchestratorStatus {
    const key = this.statusKey(status);
    if (key !== this.lastStatusKey) {
      this.lastStatusKey = key;
      switch (status.kind) {
        case "RUNNING":
          this.emitAndStore("AGENT_ASSIGNED", { taskId: this.taskId, stage: status.stage });
          break;
        case "WAITING_FOR_HUMAN":
          this.emitAndStore("WAITING_FOR_HUMAN", {
            taskId: this.taskId,
            from: status.from,
            to: status.to,
            reason: status.reason,
            approvalType: status.approvalType,
          });
          break;
        case "BLOCKED":
          this.emitAndStore("TASK_BLOCKED", { taskId: this.taskId, reason: status.reason });
          break;
        case "DEPLOYED":
          this.emitAndStore("TASK_DEPLOYED", { taskId: this.taskId });
          break;
      }
    }
    return status;
  }

  /** Every emitted event is also appended to the store: the audit trail of who was asked to do what, and why a task stopped. */
  private emitAndStore<K extends keyof OrchestratorEventMap & string>(type: K, payload: OrchestratorEventMap[K]): void {
    this.events.emit(type, payload);
    this.store.appendEvent({
      taskId: this.taskId,
      at: this.now(),
      type,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  /**
   * Advances as far as it can without running an agent: skips through states
   * whose pipeline work is already done, and through ungated edges. Stops at
   * the next agent to run, a gate that needs a human, or a terminal state.
   */
  private advance(): OrchestratorStatus {
    for (;;) {
      const current = this.run.machine.current;
      if (current === TaskState.DEPLOYED) return this.settle({ kind: "DEPLOYED" });
      if (current === TaskState.BLOCKED) {
        return this.settle({ kind: "BLOCKED", reason: this.blockedReason ?? "blocked" });
      }

      const stage = this.pipeline[this.pipelineCursor];
      if (stage !== undefined && stageStateOf(stage) === current) {
        return this.settle({ kind: "RUNNING", stage });
      }

      const next = forwardState(this.run.machine);
      if (!next) {
        this.blockedReason ??= "no forward state available";
        return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
      }

      const gate = checkGate(current, next, this.gateContext);
      if (!gate.allowed) {
        const reason = gate.reason ?? "gate not satisfied";
        const approvalType = approvalTypeForEdge(current, next);

        if (approvalType) {
          const existing = findApproval(this.approvals, approvalType);
          // A rejection is a decision. Re-asking it would turn "no" into "not yet".
          if (existing?.status === "rejected") {
            this.blockedReason =
              `${approvalType} was rejected${existing.decidedBy ? ` by ${existing.decidedBy}` : ""}` +
              `${existing.note ? `: ${existing.note}` : ""}`;
            this.run = { ...this.run, machine: forceBlock(this.run.machine) };
            return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
          }
          this.approvals = requestApproval(this.approvals, {
            type: approvalType,
            reason,
            now: this.now(),
            from: current,
            to: next,
          });
        }

        return this.settle({ kind: "WAITING_FOR_HUMAN", from: current, to: next, reason, approvalType });
      }

      this.run = { ...this.run, machine: transition(this.run.machine, next) };
      if (this.run.machine.current === TaskState.BLOCKED) {
        this.blockedReason ??= "unclassifiable task — needs human triage";
      }
    }
  }

  /**
   * Writes the state that produced this status *before* the caller is told
   * about it. The ordering matters: a crash between "told the caller QA runs
   * next" and "wrote that down" would resume onto the wrong stage.
   */
  private settle(status: OrchestratorStatus): OrchestratorStatus {
    this.persist();
    return this.emitAndReturn(status);
  }

  status(): OrchestratorStatus {
    return this.advance();
  }

  /**
   * The event-driven entry point (item 14): call this once an agent has
   * finished, wherever that news comes from — a direct await, a webhook, a
   * message off a queue. Throws if `stage` isn't the one currently assigned,
   * since the orchestrator — not the caller — decides who runs next.
   */
  reportCompletion(
    stage: AgentStage,
    result: AgentExecutorResult,
    timing: { start: number; end: number },
  ): OrchestratorStatus {
    const assigned = this.advance();
    if (assigned.kind !== "RUNNING" || assigned.stage !== stage) {
      throw new Error(
        `reportCompletion(${stage}): not currently assigned to ${stage} (current status: ${this.statusKey(assigned)})`,
      );
    }

    this.emitAndStore("AGENT_COMPLETED", { taskId: this.taskId, stage, outcome: result.outcome });
    const record = this.runLog.record({
      task_id: this.taskId,
      agent: stage,
      start_time: timing.start,
      end_time: timing.end,
      outcome: result.outcome,
    });
    this.store.appendRun(record);

    try {
      assertBudget(this.runLog, this.taskId, this.budget);
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        this.run = { ...this.run, machine: forceBlock(this.run.machine) };
        this.blockedReason = e.message;
        return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
      }
      throw e;
    }

    if (result.artifactType !== undefined && result.artifact !== undefined) {
      assertCanProduce(stage, result.artifactType);
      const validated = validateArtifact(result.artifactType, result.artifact);
      this.artifactStore[result.artifactType] = JSON.stringify(validated);
      if (result.artifactType === ArtifactType.QA_REPORT) {
        this.gateContext.qaReport = validated as QaReportArtifact;
      }
      if (result.artifactType === ArtifactType.SECURITY_REPORT) {
        this.gateContext.securityReport = validated as SecurityReportArtifact;
      }
    }
    if (result.gateEvidence) {
      this.gateContext = { ...this.gateContext, ...result.gateEvidence };
    }

    this.pipelineCursor += 1;
    if (result.outcome.result === "FAIL" && result.failure) {
      this.lastFailure = result.failure;
    }

    const failureKind = stage === AgentStage.QA_ENGINEER ? "qa" : stage === AgentStage.SECURITY ? "security" : null;
    if (failureKind && result.outcome.result === "FAIL") {
      this.stateBeforeFailure = this.run.machine.current;
      this.run = recordFailure(this.run, failureKind);
      this.applyFailureRoute(failureKind, result.failure);
    }

    return this.advance();
  }

  /**
   * Decides what happens after a failed round, and applies it.
   *
   * The decision itself lives in retry/recoveryPolicy.ts and is pure; this only
   * carries it out. Keeping those apart matters because the decision is the part
   * worth reviewing: RETRY, RECOVER, ROLLBACK, ESCALATE and ABORT are five
   * different answers, and before T07 the pipeline could only express two of
   * them. The agent that reported the failure makes none of these calls — it
   * supplies facts, the orchestrator draws the conclusion.
   */
  private applyFailureRoute(failureKind: "qa" | "security", failure: StructuredFailure | undefined): void {
    const action = decideRecovery({
      failure,
      kind: failureKind,
      run: this.run,
      pipeline: this.pipeline,
      currentState: this.stateBeforeFailure,
    });
    this.lastRecovery = action;

    if (this.run.machine.current === TaskState.BLOCKED) {
      // retryPolicy already forced BLOCKED because the budget is spent. No
      // recovery decision may override that, so record why and stop here.
      this.blockedReason = action.kind === "ABORT" ? action.reason : `${failureKind} retry limit (${MAX_RETRY}) exceeded`;
      return;
    }

    switch (action.kind) {
      case "ESCALATE":
      case "ABORT":
        // Both stop the task, but a person still has to be told *what* they are
        // being asked about. Recording the approval gives the stop a type and a
        // reason in the ledger instead of only an opaque BLOCKED string — these
        // are two of CLAUDE.md's five always-human points, and they were the two
        // that left no trace of having been reached.
        this.approvals = requestApproval(this.approvals, {
          type: failureKind === "qa" ? ApprovalType.QA_FAILURE : ApprovalType.SECURITY_RISK,
          reason: action.reason,
          now: this.now(),
        });
        this.run = { ...this.run, machine: forceBlock(this.run.machine) };
        this.blockedReason = action.reason;
        return;

      case "ROLLBACK":
        this.run = { ...this.run, machine: recoverTo(this.run.machine, action.toState) };
        this.pipelineCursor = this.cursorForState(action.toState);
        return;

      case "RECOVER": {
        // The backward edge is guarded (taskState.recoverTo): it can only reach a
        // state this task genuinely passed through. If it cannot, that is a real
        // inconsistency and stopping is the honest answer, not improvising forward.
        try {
          this.run = { ...this.run, machine: recoverTo(this.run.machine, action.toState) };
        } catch (e) {
          this.run = { ...this.run, machine: forceBlock(this.run.machine) };
          this.blockedReason = `cannot recover to ${action.toState}: ${(e as Error).message}`;
          return;
        }
        const index = this.pipeline.indexOf(action.stage);
        this.pipelineCursor = index === -1 ? this.implementationStartIndex : index;
        return;
      }

      case "RETRY": {
        const index = this.pipeline.indexOf(action.stage);
        this.pipelineCursor = index === -1 ? this.implementationStartIndex : index;
        return;
      }
    }
  }

  /** First pipeline position whose stage occupies `state` — where the cursor must sit after moving the machine there. */
  private cursorForState(state: TaskState): number {
    const index = this.pipeline.findIndex((stage) => stageStateOf(stage) === state);
    return index === -1 ? this.implementationStartIndex : index;
  }

  /** Convenience wrapper for callers that want a direct call/await relationship instead of listening on `events`. */
  async step(executor: AgentExecutor, now: () => number = Date.now): Promise<OrchestratorStatus> {
    const status = this.advance();
    if (status.kind !== "RUNNING") return status;

    const { stage } = status;
    const context = selectContext(stage, this.artifactStore);
    const start = now();
    const result = await executor({ stage, taskId: this.taskId, context });
    const end = now();

    return this.reportCompletion(stage, result, { start, end });
  }
}
