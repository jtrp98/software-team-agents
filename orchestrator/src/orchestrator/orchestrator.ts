import { AgentStage, TaskState } from "../types.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import { forceBlock, forwardState, recoverTo, transition, type TaskMachine } from "../state/taskState.js";
import { MAX_RETRY, initTaskRun, recordFailure, type TaskRun } from "../retry/retryPolicy.js";
import { decideRecovery, type RecoveryAction } from "../retry/recoveryPolicy.js";
import { routeRepair, type RepairRoute } from "../retry/repairRoute.js";
import { policyFor } from "../escalation/escalationPolicy.js";
import { routeFailure } from "./failure.js";
import { z } from "zod";
import { checkGate, gateContextFor, type StoredGateEvidence } from "../gates/gatePolicy.js";
import {
  ApprovalDecisionError,
  ApprovalType,
  applyHumanDecision,
  approvalTypeForEdge,
  findApproval,
  findApprovalRequest,
  requestApproval,
  withdrawApproval,
  type ApprovalLedger,
  type ApprovalRecord,
} from "../gates/approval.js";
import {
  UNCONFIGURED_HUMAN_CHANNEL,
  assertVerifierOutput,
  type HumanDecisionSubmission,
  type HumanDecisionVerifier,
} from "../gates/humanDecision.js";
import { DesignGateAssessmentSchema } from "../docs/designEvidence.js";
import { QaModeDecisionSchema } from "../qa/mode.js";
import {
  ArtifactType,
  validateArtifact,
  type QaReportArtifact,
  type SecurityReportArtifact,
  type ValidatableArtifactType,
} from "../artifacts/schemas.js";
import { selectContext, type ContextCategory, type ContextItem } from "../context/contextSelection.js";
import { RunLog, type RunOutcome } from "../observability/runLog.js";
import { assertBudget, BudgetExceededError, DEFAULT_BUDGET, type Budget } from "../cost/costControl.js";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { Permission } from "../agents/permissions.js";
import { assertPermission } from "../agents/permissionPolicy.js";
import { EventBus } from "../events/eventBus.js";
import { verdictEventFor, type DomainEventMap } from "../events/domainEvents.js";
import { describeEvent } from "../audit/auditTrail.js";
import { assertIndependentVerdict } from "../review/reviewSeparation.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { TaskNotFoundError, newPersistedTask, type KnowledgeRootIdentity, type PersistedTask, type TaskStore } from "../store/taskStore.js";
import type { TargetBindings } from "../threeRepo/taskBindings.js";
import { Environment } from "../environment/environment.js";
import { type StructuredFailure } from "./failure.js";
import { isAgentAssignedAt, stageStateOf } from "./taskStatus.js";
import type { RuntimeTask } from "./runtimeTask.js";
import {
  assessBusinessInput,
  businessGateReason,
  BusinessInputEvidenceSchema,
  type BusinessInputEvidence,
} from "../gates/businessInput.js";
import { contentHash } from "../artifacts/executionPacket.js";
import {
  DeterministicVerificationSchema,
  buildEvidence,
  type EvidencePayload,
  type EvidenceRecord,
} from "../evidence/evidenceStore.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import {
  approvalEvidenceFor,
  decideStageCompletion,
  decideTaskCompletion,
  latestAttempt,
  unmetStateExit,
  verifyTaskCompletion,
  type StageCompletionDecision,
} from "./transitionGuard.js";

const CODE_PRODUCING_STAGES: ReadonlySet<AgentStage> = new Set([AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]);

/** The persisted deterministic sweep a QA round is handed, with the evidence id it came from. */
export interface PersistedVerificationRef {
  evidenceId: string;
  verification: DeterministicVerification;
}

export interface AgentExecutorRequest {
  stage: AgentStage;
  taskId: string;
  context: ContextItem[];
  /** Only set when stage is DEVOPS: which of the two runs this is, so the executor's prompt can say so. See `isAgentAssignedAt` in taskStatus.ts. */
  deployPhase?: "prepare" | "execute";
  /**
   * The QA retry count at the time this round starts (0 for the first
   * round). Only set for QA_ENGINEER; the optimization wrapper uses it to
   * build the recheck plan instead of re-verifying from scratch.
   */
  qaRound?: number;
  /** Bounded intake evidence, supplied only to the BA stage. */
  businessInput?: BusinessInputEvidence;
  /**
   * QA_ENGINEER only: the post-Dev deterministic sweep of the latest completed
   * code-producing attempt, read by STA from the durable evidence store - so a
   * QA round started by a fresh process sees exactly what the Dev process ran.
   * Absent when no such record exists; nothing substitutes for it.
   */
  deterministicVerification?: PersistedVerificationRef;
}

export interface AgentExecutorResult {
  outcome: RunOutcome;
  artifactType?: ValidatableArtifactType;
  artifact?: unknown;
  /** Runtime-state path of the exact packet used for this attempt. */
  packetPath?: string;
  /**
   * STA-derived gate facts relayed from the execution composition (design
   * risk assessment, QA mode decision, QA verdict requirements). Strictly
   * validated: approval facts, reports and business input can never arrive
   * this way — see `ExecutorGateEvidenceSchema`.
   */
  gateEvidence?: ExecutorGateEvidence;
  /**
   * The deterministic sweep STA's post-Dev hook ran for a code-producing
   * stage (`qa/verificationHook.ts`). The orchestrator persists it as
   * evidence of this attempt in the same transaction as the completion;
   * after that the store - not this object - is the source of truth.
   */
  deterministicVerification?: DeterministicVerification;
  /**
   * A failure as structured data: what broke, who owns it, whether a person
   * must look. The agent supplies the facts; the orchestrator decides where
   * the task goes next (see failure.ts). Optional — omitting it keeps the
   * original behaviour of sending a failed round back to the first
   * implementation stage.
   */
  failure?: StructuredFailure;
}

/**
 * The only gate facts an executor result may carry. Strict: any other key —
 * `requirementApproved`, `designApproved`, `humanApproved`, a report, business
 * input — is refused, so a forged executor result cannot supply approval.
 */
export const ExecutorGateEvidenceSchema = z.strictObject({
  designAssessment: DesignGateAssessmentSchema.optional(),
  qaModeDecision: QaModeDecisionSchema.optional(),
  qaVerdictRequirements: z.array(z.string().min(1)).optional(),
});
export type ExecutorGateEvidence = z.infer<typeof ExecutorGateEvidenceSchema>;

/** The pluggable seam: the orchestrator is a pure coordinator, it never runs an agent itself. */
export type AgentExecutor = (req: AgentExecutorRequest) => Promise<AgentExecutorResult> | AgentExecutorResult;

export type OrchestratorStatus =
  | { kind: "RUNNING"; stage: AgentStage }
  | {
      kind: "WAITING_FOR_HUMAN";
      from: TaskState;
      to: TaskState;
      reason: string;
      approvalType: ApprovalType | null;
      /** The pending request a trusted human decision must name. Null only for an edge no approval type answers. */
      requestId: string | null;
    }
  | { kind: "BLOCKED"; reason: string }
  | { kind: "DEPLOYED" };

/**
 * Every routing decision is also an event, not only a return value — an agent
 * finishing routes to the next stage the same way a completion event does.
 *
 * The five below are the *lifecycle*: which stage is up, which finished, why the
 * machine stopped. `domainEvents.ts` extends the map with the *domain* events —
 * the verdicts, the approvals, and what a deploy cost — which carry facts these
 * five cannot express (see events/domainEvents.ts for what each adds and why
 * neither set replaces the other).
 */
export interface OrchestratorEventMap extends DomainEventMap {
  /** `inputs` is the artifact categories this stage is actually handed — the same slice `step()` passes to the executor. */
  AGENT_ASSIGNED: { taskId: string; stage: AgentStage; inputs: ContextCategory[] };
  /** `artifactType` is what the stage produced, or null for a stage whose work is only code on disk. */
  AGENT_COMPLETED: { taskId: string; stage: AgentStage; outcome: RunOutcome; artifactType: ValidatableArtifactType | null; packetPath: string | null };
  WAITING_FOR_HUMAN: { taskId: string; from: TaskState; to: TaskState; reason: string; approvalType: ApprovalType | null; requestId: string | null };
  TASK_BLOCKED: { taskId: string; reason: string };
  TASK_DEPLOYED: { taskId: string; completionEvidenceId: string };
  /** STA recorded that a stage attempt satisfied every required evidence (`transitionGuard.ts`). */
  STAGE_COMPLETED: { taskId: string; stage: AgentStage; attempt: number; evidenceId: string; refs: string[] };
  /** A stage attempt ended without its required evidence; the cursor stays on the stage. */
  STAGE_INCOMPLETE: { taskId: string; stage: AgentStage; attempt: number; missing: string[] };
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
  /** local/dev/staging/production. Defaults to `Environment.LOCAL` when not given (a fresh task) or not stored (an old row, see taskStore.ts). */
  environment?: Environment;
  /** Immutable Target identity captured on task creation. */
  targetBindings?: TargetBindings;
  /** Knowledge-root identity frozen at intake (DR §5); null when no installation file existed. */
  knowledgeRoot?: KnowledgeRootIdentity | null;
  /** Deterministic execution contract built by TaskRegistry before persistence. */
  runtimeTask?: RuntimeTask | null;
  /** Validated business intake used to select confirmed-input versus interactive BA mode. */
  businessInput?: BusinessInputEvidence;
  /**
   * The trusted human channel that authenticates approval decisions. Defaults
   * to `UNCONFIGURED_HUMAN_CHANNEL`, which refuses every decision — STA fails
   * closed until a real channel is integrated.
   */
  humanDecisionVerifier?: HumanDecisionVerifier;
}

function assertCanProduce(stage: AgentStage, artifactType: ValidatableArtifactType): void {
  if (!AGENT_REGISTRY[stage].outputs.includes(artifactType)) {
    throw new Error(`${stage} is not registered (item 9) to produce ${artifactType}`);
  }
  // A verdict specifically must come from a role that did not do the work.
  // Checked separately from the registry lookup above on purpose — that one
  // asks "is this in the table?", this one asks "is this a review of your own
  // work?", and only the second still holds if someone edits the table.
  assertIndependentVerdict(stage, artifactType);
}

function rejectionReason(record: ApprovalRecord): string {
  const decision = record.decision;
  return (
    `${record.scope.type} request ${record.requestId} was rejected` +
    `${decision ? ` by ${decision.actor.id} via ${decision.source.channel}` : ""}` +
    `${decision?.note ? `: ${decision.note}` : ""}`
  );
}

function implementationStart(pipeline: AgentStage[]): number {
  return pipeline.findIndex((s) => s === AgentStage.BACKEND_ENGINEER || s === AgentStage.FRONTEND_ENGINEER);
}

/**
 * The central controller: state management, routing, retry handling, gate
 * enforcement, context assembly, and agent selection — all composed from
 * their owning modules, none of it reimplemented here. This is the only thing
 * that decides what runs next (CLAUDE.md: "no agent invokes the next one"),
 * and no agent holds a reference to transition()/gatedTransition()/
 * recordFailure() itself.
 *
 * Communication is event-driven: reportCompletion() is the one entry point an
 * agent's completion reaches the orchestrator through, and every routing
 * decision it makes is also emitted on `events`, not only returned — step()
 * is a convenience wrapper over reportCompletion() for callers that do want a
 * direct call/await relationship.
 *
 * It is also durable: every state change is written through to a `TaskStore`
 * before the caller is told about it, so a closed terminal or a crashed
 * process resumes from where it stopped (`Orchestrator.resume`) instead of
 * re-running a pipeline whose expensive stages already ran. Approvals a
 * person gave are part of that stored state — resuming must never re-ask a
 * question that was already answered.
 */
export class Orchestrator {
  readonly runLog: RunLog;
  readonly events = new EventBus<OrchestratorEventMap>();
  readonly taskId: string;
  readonly store: TaskStore;
  readonly dependsOn: string[];
  readonly classification: ClassificationResult;
  readonly runtimeTask: RuntimeTask | null;
  private readonly pipeline: AgentStage[];
  private readonly implementationStartIndex: number;
  private readonly budget: Budget;
  private readonly now: () => number;
  private readonly createdAt: number;
  private run: TaskRun;
  private gateContext: StoredGateEvidence;
  private readonly humanDecisionVerifier: HumanDecisionVerifier;
  private artifactStore: Partial<Record<ContextCategory, string>>;
  private pipelineCursor: number;
  private blockedReason: string | undefined;
  private lastFailure: StructuredFailure | null;
  private approvals: ApprovalLedger;
  private lastStatusKey: string | undefined;
  /**
   * Pause/cancel — managed by `TaskRegistry.pause()`/`cancel()` directly against the
   * store, never by this class itself (they are a human override, orthogonal to the pipeline's
   * own state machine). Carried here only so a `snapshot()` taken mid-run echoes back whatever
   * was loaded instead of silently resetting it to false/null on the next save.
   */
  private paused: boolean;
  private cancelled: boolean;
  private cancelReason: string | null;
  /** local/dev/staging/production. Set once at creation, carried through resume/snapshot like paused/cancelled above; nothing in the state machine reads it — it exists to be told to agents, not to gate anything. */
  private taskEnvironment: Environment;
  /** True once devops's "prepare" run has completed at READY_TO_DEPLOY. See `isAgentAssignedAt` in taskStatus.ts for what this distinguishes and why. */
  private deployPrepared: boolean;
  private readonly targetBindings: TargetBindings;
  /**
   * The Knowledge-root identity frozen at intake (DR §5). Not state the state
   * machine reads — like `targetBindings`, it is carried so `snapshot()`
   * echoes back what was loaded instead of silently dropping the freeze the
   * next time the row is saved.
   */
  private readonly knowledgeRoot: KnowledgeRootIdentity | null;
  /** The state the task was in when the current failure arrived, captured before retryPolicy moves it. */
  private stateBeforeFailure: TaskState = TaskState.CREATED;
  /** What the last failure resolved to. Exposed for the CLI and the run log; not persisted — it is derived, not state. */
  private lastRecovery: RecoveryAction | null = null;
  /**
   * The deterministic repair route for the most recent failure (T-V8-015).
   * Process-local, exactly like `lastRecovery`: it is a derivation of the
   * persisted `lastFailure`, so a resumed task recomputes it rather than
   * reading a second stored copy that could drift from the failure it
   * describes. `invalidates` is empty here because this class holds no task
   * graph; the descendant set is computed by whoever owns the graph, from the
   * same `invalidationSetFor`.
   */
  private lastRepairRoute: RepairRoute | null = null;
  /** The `task-completion` evidence id written when the task reached DEPLOYED; null until then. */
  private completionEvidenceId: string | null;
  /** The completion decision for the most recent stage attempt - derived and process-local, for callers explaining a stop. */
  private lastStageDecision: { stage: AgentStage; attempt: number; decision: StageCompletionDecision } | null = null;
  /** Depth of the open `atomic()` unit; events reach listeners only once it commits. */
  private atomicDepth = 0;
  private pendingEmits: Array<() => void> = [];

  constructor(taskId: string, classification: ClassificationResult, opts?: OrchestratorOptions) {
    const restore = opts?.restore;
    this.taskId = taskId;
    this.now = opts?.now ?? Date.now;
    this.store = opts?.store ?? new MemoryTaskStore();
    this.budget = opts?.budget ?? DEFAULT_BUDGET;
    this.classification = classification;
    this.runtimeTask = restore?.runtimeTask ?? opts?.runtimeTask ?? null;
    this.createdAt = restore?.createdAt ?? this.now();
    this.dependsOn = restore ? [...restore.dependsOn] : [...(opts?.dependsOn ?? [])];
    this.pipeline = restore ? restore.machine.pipeline : classification.pipeline;
    this.implementationStartIndex = implementationStart(this.pipeline);
    this.humanDecisionVerifier = opts?.humanDecisionVerifier ?? UNCONFIGURED_HUMAN_CHANNEL;

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
      this.taskEnvironment = restore.environment;
      this.deployPrepared = restore.deployPrepared;
      this.targetBindings = restore.targetBindings;
      this.knowledgeRoot = restore.knowledgeRoot ?? null;
      this.completionEvidenceId = restore.completionEvidenceId;
      // Seeded from the store so budget accounting counts what the
      // earlier process already spent — a resumed task must not get a fresh
      // token allowance just because it restarted.
      this.runLog = new RunLog(this.store.runsForTask(taskId));
    } else {
      this.run = initTaskRun(classification.pipeline, classification.requiresHumanApproval);
      this.gateContext = opts?.businessInput
        ? { businessInput: BusinessInputEvidenceSchema.parse(opts.businessInput) }
        : {};
      this.artifactStore = {};
      this.pipelineCursor = 0;
      this.blockedReason = undefined;
      this.lastFailure = null;
      this.approvals = [];
      this.paused = false;
      this.cancelled = false;
      this.cancelReason = null;
      this.taskEnvironment = opts?.environment ?? Environment.LOCAL;
      this.deployPrepared = false;
      this.targetBindings = opts?.targetBindings ?? { targets: [] };
      this.knowledgeRoot = opts?.knowledgeRoot ?? null;
      this.completionEvidenceId = null;
      this.runLog = new RunLog();
      this.store.createTask(
        newPersistedTask({
          taskId,
          dependsOn: this.dependsOn,
          classification,
          machine: this.run.machine,
          now: this.createdAt,
          environment: this.taskEnvironment,
          targetBindings: opts?.targetBindings,
          runtimeTask: this.runtimeTask,
          gateContext: this.gateContext,
          knowledgeRoot: this.knowledgeRoot,
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

  /** Which of local/dev/staging/production this task targets. */
  get environment(): Environment {
    return this.taskEnvironment;
  }

  /** How the most recent failure was resolved, or null if none has happened in this process. */
  get recovery(): RecoveryAction | null {
    return this.lastRecovery;
  }

  /** The deterministic repair route for the most recent failure, or null if none has happened in this process. */
  get repairRoute(): RepairRoute | null {
    return this.lastRepairRoute;
  }

  /** The exact row this orchestrator would persist right now. */
  snapshot(): PersistedTask {
    return {
      taskId: this.taskId,
      createdAt: this.createdAt,
      updatedAt: this.now(),
      dependsOn: [...this.dependsOn],
      classification: this.classification,
      runtimeTask: this.runtimeTask,
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
      environment: this.taskEnvironment,
      deployPrepared: this.deployPrepared,
      targetBindings: this.targetBindings,
      knowledgeRoot: this.knowledgeRoot,
      completionEvidenceId: this.completionEvidenceId,
    };
  }

  /** Every persisted evidence record of this task, re-validated on read. */
  evidence(): EvidenceRecord[] {
    return this.store.evidenceForTask(this.taskId);
  }

  /** Why the most recent stage attempt did or did not complete (null before any attempt in this process). */
  get stageDecision(): { stage: AgentStage; attempt: number; decision: StageCompletionDecision } | null {
    return this.lastStageDecision;
  }

  /**
   * Runs `fn` as one unit against the store and this object's state: every
   * store write inside it (task row, run, events, evidence) commits together
   * in one `TaskStore.transaction`, and on any throw both the store and the
   * in-memory fields are restored to what they were before. Listeners hear
   * the unit's events only after it commits, so nobody observes a transition
   * that was rolled back. Nested calls join the open unit.
   */
  private atomic<T>(fn: () => T): T {
    if (this.atomicDepth > 0) return fn();
    const saved = {
      run: this.run,
      gateContext: { ...this.gateContext },
      artifactStore: { ...this.artifactStore },
      pipelineCursor: this.pipelineCursor,
      blockedReason: this.blockedReason,
      lastFailure: this.lastFailure,
      approvals: this.approvals,
      lastStatusKey: this.lastStatusKey,
      deployPrepared: this.deployPrepared,
      stateBeforeFailure: this.stateBeforeFailure,
      lastRecovery: this.lastRecovery,
      lastRepairRoute: this.lastRepairRoute,
      completionEvidenceId: this.completionEvidenceId,
      lastStageDecision: this.lastStageDecision,
      runCount: this.runLog.size(),
    };
    this.atomicDepth += 1;
    let result: T;
    try {
      result = this.store.transaction(fn);
    } catch (error) {
      this.atomicDepth -= 1;
      this.pendingEmits = [];
      this.run = saved.run;
      this.gateContext = saved.gateContext;
      this.artifactStore = saved.artifactStore;
      this.pipelineCursor = saved.pipelineCursor;
      this.blockedReason = saved.blockedReason;
      this.lastFailure = saved.lastFailure;
      this.approvals = saved.approvals;
      this.lastStatusKey = saved.lastStatusKey;
      this.deployPrepared = saved.deployPrepared;
      this.stateBeforeFailure = saved.stateBeforeFailure;
      this.lastRecovery = saved.lastRecovery;
      this.lastRepairRoute = saved.lastRepairRoute;
      this.completionEvidenceId = saved.completionEvidenceId;
      this.lastStageDecision = saved.lastStageDecision;
      this.runLog.truncate(saved.runCount);
      throw error;
    }
    this.atomicDepth -= 1;
    const emits = this.pendingEmits;
    this.pendingEmits = [];
    for (const deliver of emits) deliver();
    return result;
  }

  /** Builds and appends one evidence record of this task inside the open unit. */
  private recordEvidence(params: {
    stage: AgentStage;
    attempt: number;
    role: string;
    subject: string;
    payload: EvidencePayload;
    refs?: string[];
  }): EvidenceRecord {
    return this.store.appendEvidence(
      buildEvidence({
        taskId: this.taskId,
        stage: params.stage,
        attempt: params.attempt,
        role: params.role,
        subject: params.subject,
        payload: params.payload,
        refs: params.refs ?? [],
        recordedAt: this.now(),
      }),
    );
  }

  /**
   * The persisted deterministic sweep of the most recently completed
   * code-producing attempt - what a QA round verifies against. Read from the
   * store, so it is the same answer in the process that ran Dev and in any
   * process started after that one exited.
   */
  persistedVerification(records: readonly EvidenceRecord[] = this.evidence()): PersistedVerificationRef | undefined {
    const completions = records.filter((r) => r.kind === "stage-completion" && CODE_PRODUCING_STAGES.has(r.stage));
    const latest = completions[completions.length - 1];
    if (!latest) return undefined;
    const record = records.find(
      (r) => r.kind === "deterministic-verification" && r.stage === latest.stage && r.attempt === latest.attempt,
    );
    if (!record || record.payload.kind !== "deterministic-verification") return undefined;
    return { evidenceId: record.evidenceId, verification: record.payload.verification as DeterministicVerification };
  }

  private persist(): void {
    this.store.saveTask(this.snapshot());
  }

  /** The full approval ledger for this task — what was asked, what was answered, when, and by whom. */
  get approvalLedger(): ApprovalRecord[] {
    return [...this.approvals];
  }

  /** The request a human decision must currently name, if any. */
  pendingApprovalRequest(): ApprovalRecord | null {
    return this.approvals.find((a) => a.status === "pending") ?? null;
  }

  /**
   * Records a human answer to a pending request — the only way an approval
   * state is ever set. The configured trusted channel must authenticate the
   * submission (the default channel refuses everything), and the ledger then
   * refuses an unknown, settled, superseded, wrong-scope or replayed decision.
   * Nothing is written unless every check passes.
   *
   * A rejection is an answer, not an absence: it is stored as `rejected`, and
   * `advance()` blocks the task on it rather than posing the same question on
   * the next poll.
   */
  submitHumanDecision(submission: HumanDecisionSubmission): void {
    this.atomic(() => this.applySubmittedDecision(submission));
  }

  private applySubmittedDecision(submission: HumanDecisionSubmission): void {
    const request = findApprovalRequest(this.approvals, submission.requestId);
    if (!request) {
      throw new ApprovalDecisionError(
        "unknown-request",
        `no approval request ${submission.requestId} was opened for task ${this.taskId} — a decision cannot precede the question`,
      );
    }
    if (request.status !== "pending") {
      throw new ApprovalDecisionError("not-pending", `approval request ${request.requestId} is already ${request.status}`);
    }
    const now = this.now();
    const verified = assertVerifierOutput(
      this.humanDecisionVerifier,
      submission,
      this.humanDecisionVerifier.verify(request, submission, now),
    );
    this.approvals = applyHumanDecision(this.approvals, verified);
    // The decision is evidence too: the ledger says a person answered, this
    // record puts the answer in the chain a transition and Done reference.
    this.recordEvidence({
      stage: AgentStage.HUMAN,
      attempt: 1,
      role: "human",
      subject: request.requestId,
      payload: {
        kind: "approval-decision",
        requestId: request.requestId,
        decisionId: verified.decision.decisionId,
        type: request.scope.type,
        approved: verified.decision.approved,
        actorId: verified.decision.actor.id,
        channel: verified.decision.source.channel,
        evidenceRef: verified.decision.source.evidenceRef,
      },
    });
    this.persist();
    // The answer is an event too — otherwise a listener could observe every
    // question the pipeline ever asked and never learn what a person said back.
    this.emitAndStore("APPROVAL_DECIDED", {
      taskId: this.taskId,
      requestId: request.requestId,
      type: request.scope.type,
      approved: verified.decision.approved,
      actorId: verified.decision.actor.id,
      channel: verified.decision.source.channel,
      evidenceRef: verified.decision.source.evidenceRef,
      decisionId: verified.decision.decisionId,
      note: verified.decision.note,
    });
  }

  /**
   * Replaces BA intake through the trusted host seam. This is the only way an
   * exact human answer can discharge a material-business gate: approving the
   * generic gate flag alone never manufactures the missing decision.
   */
  provideBusinessInput(input: BusinessInputEvidence): void {
    this.atomic(() => this.replaceBusinessInput(input));
  }

  private replaceBusinessInput(input: BusinessInputEvidence): void {
    if (this.run.machine.current !== TaskState.REQUIREMENT) {
      throw new Error(
        `business input can only be replaced at REQUIREMENT; current state is ${this.run.machine.current}`,
      );
    }
    const parsed = BusinessInputEvidenceSchema.parse(input);
    const changed =
      JSON.stringify(this.gateContext.businessInput) !== JSON.stringify(parsed);
    this.gateContext = { ...this.gateContext, businessInput: parsed };
    if (changed) {
      const baIndex = this.pipeline.indexOf(AgentStage.BUSINESS_ANALYST);
      if (baIndex !== -1) this.pipelineCursor = baIndex;
    }
    const pending = findApproval(this.approvals, ApprovalType.REQUIREMENT_INTERVIEW);
    if (
      assessBusinessInput(parsed).canNormalizeWithoutInterview &&
      pending?.status === "pending"
    ) {
      // Evidence discharges the gate; no person answered. Closing the request as
      // withdrawn records that without manufacturing a human approval.
      const reason = "discharged by updated confirmed-input evidence";
      this.approvals = withdrawApproval(this.approvals, pending.requestId, { now: this.now(), reason });
      this.persist();
      this.emitAndStore("APPROVAL_WITHDRAWN", { taskId: this.taskId, requestId: pending.requestId, type: pending.scope.type, reason });
      return;
    }
    this.persist();
  }

  /**
   * Opens a human decision and announces it (emits APPROVAL_REQUIRED).
   *
   * The emit rides on `requestApproval`'s own idempotence: it returns the ledger
   * unchanged when this type is already open or already answered, and `advance()`
   * is polled, so an unguarded emit here would append an identical event to the
   * store on every single `status()` call. Comparing the reference is what makes
   * "a question was opened" a one-time fact rather than a per-poll one.
   */
  private openApproval(params: { type: ApprovalType; reason: string; from?: TaskState; to?: TaskState }): ApprovalRecord {
    const before = this.approvals;
    this.approvals = requestApproval(before, { ...params, taskId: this.taskId, now: this.now() });
    const record = findApproval(this.approvals, params.type)!;
    if (this.approvals !== before) this.emitAndStore("APPROVAL_REQUIRED", { taskId: this.taskId, approval: record });
    return record;
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
          this.emitAndStore("AGENT_ASSIGNED", {
            taskId: this.taskId,
            stage: status.stage,
            // The same selection step() will hand the executor. Recorded here so the
            // trail says what the agent was given, not just that it was given something.
            inputs: selectContext(status.stage, this.artifactStore).map((item) => item.source),
          });
          break;
        case "WAITING_FOR_HUMAN":
          this.emitAndStore("WAITING_FOR_HUMAN", {
            taskId: this.taskId,
            from: status.from,
            to: status.to,
            reason: status.reason,
            approvalType: status.approvalType,
            requestId: status.requestId,
          });
          break;
        case "BLOCKED":
          this.emitAndStore("TASK_BLOCKED", { taskId: this.taskId, reason: status.reason });
          break;
        case "DEPLOYED":
          this.emitAndStore("TASK_DEPLOYED", { taskId: this.taskId, completionEvidenceId: this.completionEvidenceId! });
          // Same moment, different fact: TASK_DEPLOYED is the transition,
          // DEPLOY_COMPLETED is what reaching it cost.
          this.emitAndStore("DEPLOY_COMPLETED", this.deploySummary());
          break;
      }
    }
    return status;
  }

  /**
   * What this task cost to reach DEPLOYED, read off the run log rather than
   * recomputed by whoever is listening.
   *
   * `runs` counts every agent run including redone rounds, while `stages` lists
   * each stage once — so `runs > stages.length` is the signal that work was
   * repeated, a fact a bare "DEPLOYED" tells nobody.
   */
  private deploySummary(): DomainEventMap["DEPLOY_COMPLETED"] {
    const runs = this.runLog.runsForTask(this.taskId);
    const stages: AgentStage[] = [];
    for (const run of runs) if (!stages.includes(run.agent)) stages.push(run.agent);
    return {
      taskId: this.taskId,
      stages,
      runs: runs.length,
      totalTokens: this.runLog.totalTokens(this.taskId),
      totalCost: this.runLog.totalCost(this.taskId),
      durationMs:
        runs.length === 0
          ? 0
          : Math.max(...runs.map((r) => r.end_time)) - Math.min(...runs.map((r) => r.start_time)),
    };
  }

  /**
   * Every emitted event is also appended to the store: the audit trail of who
   * was asked to do what, and why a task stopped.
   *
   * The audit fields are derived once, here, by the module that knows every
   * payload shape (`audit/auditTrail.ts`) rather than assembled by hand at each
   * emit site — a per-site sprinkle is exactly how two events end up disagreeing
   * about what "actor" means.
   */
  private emitAndStore<K extends keyof OrchestratorEventMap & string>(type: K, payload: OrchestratorEventMap[K]): void {
    if (this.atomicDepth > 0) this.pendingEmits.push(() => this.events.emit(type, payload));
    else this.events.emit(type, payload);
    const record = payload as unknown as Record<string, unknown>;
    this.store.appendEvent({
      taskId: this.taskId,
      at: this.now(),
      type,
      payload: record,
      ...describeEvent(type, record),
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
      if (current === TaskState.DEPLOYED) {
        // Done is DEPLOYED *and* verified completion evidence; a row whose
        // evidence does not back it is reported as blocked, never as Done.
        const verified = verifyTaskCompletion(this.store, {
          taskId: this.taskId,
          machine: this.run.machine,
          completionEvidenceId: this.completionEvidenceId,
        });
        if (!verified.done) {
          return this.settle({ kind: "BLOCKED", reason: `DEPLOYED is not backed by completion evidence: ${verified.reason}` });
        }
        return this.settle({ kind: "DEPLOYED" });
      }
      if (current === TaskState.BLOCKED) {
        return this.settle({ kind: "BLOCKED", reason: this.blockedReason ?? "blocked" });
      }

      const stage = this.pipeline[this.pipelineCursor];
      // A pre-classified material business question has no reason to spend a BA
      // run before the authorized owner answers it. Park at REQUIREMENT with
      // the exact question; once trusted evidence is updated, BA runs once to
      // normalize that meaningful requirement version.
      if (
        current === TaskState.REQUIREMENT &&
        stage === AgentStage.BUSINESS_ANALYST &&
        this.gateContext.businessInput
      ) {
        const assessment = assessBusinessInput(this.gateContext.businessInput);
        if (assessment.humanGates.length > 0) {
          const next = forwardState(this.run.machine);
          if (!next) {
            this.blockedReason = "material business gate has no forward state";
            return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
          }
          const reason = businessGateReason(assessment);
          const existing = findApproval(this.approvals, ApprovalType.REQUIREMENT_INTERVIEW);
          if (existing?.status === "rejected") {
            this.blockedReason = rejectionReason(existing);
            this.run = { ...this.run, machine: forceBlock(this.run.machine) };
            return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
          }
          const request = this.openApproval({
            type: ApprovalType.REQUIREMENT_INTERVIEW,
            reason,
            from: current,
            to: next,
          });
          return this.settle({
            kind: "WAITING_FOR_HUMAN",
            from: current,
            to: next,
            reason,
            approvalType: ApprovalType.REQUIREMENT_INTERVIEW,
            requestId: request.status === "pending" ? request.requestId : null,
          });
        }
      }
      if (stage !== undefined && isAgentAssignedAt(stage, current, this.deployPrepared)) {
        return this.settle({ kind: "RUNNING", stage });
      }

      const next = forwardState(this.run.machine);
      if (!next) {
        this.blockedReason ??= "no forward state available";
        return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
      }

      // Approval facts come from the persisted ledger at the moment of the check, never from stored booleans.
      const gate = checkGate(current, next, gateContextFor(this.gateContext, this.approvals));
      if (!gate.allowed) {
        const reason = gate.reason ?? "gate not satisfied";
        const approvalType = approvalTypeForEdge(current, next);
        let requestId: string | null = null;

        if (approvalType) {
          const existing = findApproval(this.approvals, approvalType);
          // A rejection is a decision. Re-asking it would turn "no" into "not yet".
          if (existing?.status === "rejected") {
            this.blockedReason = rejectionReason(existing);
            this.run = { ...this.run, machine: forceBlock(this.run.machine) };
            return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
          }
          const request = this.openApproval({ type: approvalType, reason, from: current, to: next });
          requestId = request.status === "pending" ? request.requestId : null;
        }

        return this.settle({ kind: "WAITING_FOR_HUMAN", from: current, to: next, reason, approvalType, requestId });
      }

      const refusal = this.guardForward(current, next);
      if (refusal) {
        this.blockedReason = `transition ${current} -> ${next} refused: ${refusal}`;
        this.run = { ...this.run, machine: forceBlock(this.run.machine) };
        return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
      }
      this.run = { ...this.run, machine: transition(this.run.machine, next) };
      if (this.run.machine.current === TaskState.BLOCKED) {
        this.blockedReason ??= "unclassifiable task — needs human triage";
      }
    }
  }

  /**
   * The evidence half of the one forward-transition guard (the gate half is
   * `checkGate` just before it in `advance()`). Leaving a state requires a
   * recorded completion for every stage that ran in it, an approved edge
   * requires the decision's evidence record, and entering DEPLOYED requires
   * the whole task to satisfy `decideTaskCompletion` - whose evidence ids are
   * then written as the `task-completion` record in this same unit. Returns
   * the refusal reason, or null when the move is justified.
   */
  private guardForward(current: TaskState, next: TaskState): string | null {
    const records = this.evidence();
    const missing = unmetStateExit({ state: current, pipeline: this.pipeline, cursor: this.pipelineCursor, records });
    const approvalType = approvalTypeForEdge(current, next);
    const approval = approvalType ? findApproval(this.approvals, approvalType) : undefined;
    if (approval?.status === "approved") missing.push(...approvalEvidenceFor([approval], records).missing);
    if (missing.length > 0) return missing.join("; ");
    if (next !== TaskState.DEPLOYED) return null;

    const done = decideTaskCompletion({ pipeline: this.pipeline, approvals: this.approvals, records });
    if (!done.done) return `task is not complete - ${done.missing.join("; ")}`;
    const completion = this.recordEvidence({
      stage: AgentStage.HUMAN,
      attempt: 1,
      role: "orchestrator",
      subject: "task",
      payload: { kind: "task-completion", pipeline: [...this.pipeline] },
      refs: done.evidenceIds,
    });
    this.completionEvidenceId = completion.evidenceId;
    return null;
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
    return this.atomic(() => this.advance());
  }

  /**
   * The event-driven entry point: call this once an agent has
   * finished, wherever that news comes from — a direct await, a webhook, a
   * message off a queue. Throws if `stage` isn't the one currently assigned,
   * since the orchestrator — not the caller — decides who runs next.
   */
  reportCompletion(
    stage: AgentStage,
    result: AgentExecutorResult,
    timing: { start: number; end: number },
  ): OrchestratorStatus {
    return this.atomic(() => this.completeAttempt(stage, result, timing));
  }

  /**
   * One stage attempt, applied as one unit (see `atomic`): the run record, its
   * events, every evidence record of the attempt, STA's completion decision
   * and the resulting state all commit together, or - on any refusal - none
   * of them does.
   */
  private completeAttempt(
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

    // Refusals come first and throw; the unit rolls back, so a forged or
    // malformed result leaves no run, event, evidence or gate state behind.
    let gateEvidence: ExecutorGateEvidence | undefined;
    if (result.gateEvidence !== undefined) {
      const evidence = ExecutorGateEvidenceSchema.safeParse(result.gateEvidence);
      if (!evidence.success) {
        throw new Error(
          `${stage}: executor gateEvidence refused - only designAssessment, qaModeDecision and qaVerdictRequirements are accepted; ` +
            `approvals, reports and business input cannot be supplied by an executing agent (${evidence.error.message})`,
        );
      }
      gateEvidence = evidence.data;
    }
    let artifact: { type: ValidatableArtifactType; stored: string; verdict: string | null } | undefined;
    if (result.artifactType !== undefined && result.artifact !== undefined) {
      assertCanProduce(stage, result.artifactType);
      const validated = validateArtifact(result.artifactType, result.artifact);
      const verdict =
        result.artifactType === ArtifactType.QA_REPORT
          ? (validated as QaReportArtifact).status
          : result.artifactType === ArtifactType.SECURITY_REPORT
            ? (validated as SecurityReportArtifact).overallStatus
            : null;
      artifact = { type: result.artifactType, stored: JSON.stringify(validated), verdict };
    }
    let verification: z.infer<typeof DeterministicVerificationSchema> | undefined;
    if (result.deterministicVerification !== undefined) {
      if (!CODE_PRODUCING_STAGES.has(stage)) {
        throw new Error(`${stage}: only a code-producing stage carries a post-Dev deterministic verification`);
      }
      verification = DeterministicVerificationSchema.parse(result.deterministicVerification);
    }

    const current = this.run.machine.current;
    const priorEvidence = this.evidence();
    const attempt = latestAttempt(priorEvidence, stage) + 1;
    const deployPhase = stage === AgentStage.DEVOPS ? (current === TaskState.APPROVED ? "execute" : "prepare") : null;

    this.emitAndStore("AGENT_COMPLETED", {
      taskId: this.taskId,
      stage,
      outcome: result.outcome,
      artifactType: result.artifactType ?? null,
      packetPath: result.packetPath ?? null,
    });
    // The mode a QA round ran in is recorded with its cost - only a literal
    // FULL/TARGETED counts, so an invalid value logs as "not recorded".
    const rawQaMode =
      result.artifactType === ArtifactType.QA_REPORT
        ? (result.artifact as { mode?: unknown } | undefined)?.mode
        : undefined;
    const record = this.runLog.record({
      task_id: this.taskId,
      agent: stage,
      start_time: timing.start,
      end_time: timing.end,
      outcome: {
        ...result.outcome,
        qa_mode: rawQaMode === "FULL" || rawQaMode === "TARGETED" ? rawQaMode : undefined,
      },
    });
    this.store.appendRun(record);

    // The attempt's evidence, as STA observed it. A QA run references the
    // persisted sweep it was handed (the same derivation `step()` used).
    const role = AGENT_REGISTRY[stage].role;
    const consumed = stage === AgentStage.QA_ENGINEER ? this.persistedVerification(priorEvidence)?.evidenceId : undefined;
    const roleRun = this.recordEvidence({
      stage,
      attempt,
      role,
      subject: "run",
      payload: {
        kind: "role-run",
        result: result.outcome.result,
        failureReason: result.outcome.failure_reason ?? null,
        runtime: result.outcome.runtime ?? null,
        model: result.outcome.model ?? null,
        packetPath: result.packetPath ?? null,
        deployPhase,
        startedAt: timing.start,
        endedAt: timing.end,
        contractDigest: result.outcome.contract_digest ?? null,
      },
      refs: consumed ? [consumed] : [],
    });
    if (artifact) {
      this.artifactStore[artifact.type] = artifact.stored;
      const parsed = JSON.parse(artifact.stored) as unknown;
      if (artifact.type === ArtifactType.QA_REPORT) this.gateContext.qaReport = parsed as QaReportArtifact;
      if (artifact.type === ArtifactType.SECURITY_REPORT) this.gateContext.securityReport = parsed as SecurityReportArtifact;
      this.recordEvidence({
        stage,
        attempt,
        role,
        subject: artifact.type,
        payload: {
          kind: "artifact",
          artifactType: artifact.type,
          contentDigest: contentHash(artifact.stored),
          location: `task-store:${this.taskId}/artifacts/${artifact.type}`,
          verdict: artifact.verdict,
        },
        refs: [roleRun.evidenceId],
      });
    }
    if (verification) {
      this.recordEvidence({
        stage,
        attempt,
        role: "orchestrator",
        subject: "post-dev-verification",
        payload: { kind: "deterministic-verification", verification },
        refs: [roleRun.evidenceId],
      });
    }
    if (gateEvidence) this.gateContext = { ...this.gateContext, ...gateEvidence };

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

    // STA's completion decision for this attempt, from persisted evidence only.
    const decision = decideStageCompletion(stage, attempt, this.evidence());
    this.lastStageDecision = { stage, attempt, decision };
    if (decision.complete) {
      const completion = this.recordEvidence({
        stage,
        attempt,
        role: "orchestrator",
        subject: "completion",
        payload: { kind: "stage-completion", satisfied: decision.satisfied },
        refs: decision.evidenceIds,
      });
      this.emitAndStore("STAGE_COMPLETED", {
        taskId: this.taskId,
        stage,
        attempt,
        evidenceId: completion.evidenceId,
        refs: completion.refs,
      });
    } else {
      this.emitAndStore("STAGE_INCOMPLETE", { taskId: this.taskId, stage, attempt, missing: decision.missing });
    }

    // Only a complete attempt moves the task on. A failed or incomplete one
    // leaves the cursor on the stage (a retry runs it again); the failure
    // routes below are the only other thing that may move it, and none of
    // them moves it forward. devops's "prepare" completion does not advance
    // the cursor - the same slot runs "execute" once the task is APPROVED.
    const isDevopsPrepareCompletion = stage === AgentStage.DEVOPS && current === TaskState.READY_TO_DEPLOY;
    const requiresHumanStop =
      result.outcome.result === "FAIL" &&
      result.failure?.requiresHuman === true &&
      result.failure.category === "infrastructure";
    if (isDevopsPrepareCompletion) {
      if (decision.complete) this.deployPrepared = true;
    } else if (decision.complete) {
      this.pipelineCursor += 1;
    }
    if (result.outcome.result === "FAIL" && result.failure) {
      this.lastFailure = result.failure;
    }

    // Infrastructure UNAVAILABLE is a STOP at every stage, not only at the
    // QA/security failure routers. It consumes neither a retry round nor the
    // pipeline cursor, so an explicit human resume retries the same stage.
    if (requiresHumanStop) {
      this.lastRecovery = { kind: "ESCALATE", strategy: "escalate_to_human", reason: result.failure!.reason };
      this.run = { ...this.run, machine: forceBlock(this.run.machine) };
      this.blockedReason = result.failure!.reason;
      this.emitVerdict(stage, result);
      return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
    }

    // A failed "execute" — the actual deploy/migration command, and the health check
    // devops.md requires right after it — must never be silently treated as a successful
    // deploy. devops has no retry budget and no automatic recovery route (unlike qa/security
    // just below): re-running a failed deploy command without a person looking is exactly the
    // kind of destructive automation CLAUDE.md forbids, so this blocks immediately and points
    // at deploy.md's Rollback runbook rather than guessing at an undo.
    if (stage === AgentStage.DEVOPS && this.run.machine.current === TaskState.APPROVED && result.outcome.result === "FAIL") {
      this.run = { ...this.run, machine: forceBlock(this.run.machine) };
      this.blockedReason =
        "deploy execute failed (or its post-deploy health check did) — see deploy.md's Rollback runbook " +
        "before deciding whether to retry; this task will not auto-retry or auto-rollback.";
    }

    const failureKind = stage === AgentStage.QA_ENGINEER ? "qa" : stage === AgentStage.SECURITY ? "security" : null;
    if (failureKind && result.outcome.result === "FAIL") {
      this.stateBeforeFailure = this.run.machine.current;
      // An infrastructure outcome moves the state but not the defect budget
      // (T-V8-015). The `requiresHumanStop` branch above already covered the
      // UNAVAILABLE case; this covers an infrastructure failure reported
      // without `requiresHuman`, which previously spent a retry round.
      this.run = recordFailure(this.run, failureKind, {
        countsAsDefect: result.failure?.category !== "infrastructure",
      });
      this.applyFailureRoute(failureKind, result.failure);
    }

    // The UX/UI consultant does not fail the way a verifier does — its
    // "FAIL" is a question that is not its to answer (is this UI worth building
    // → business-analyst; can it be built → system-analyst). That is pipeline
    // navigation, not a defect round: it never enters recordFailure's retry
    // budgets and never touches a QA_FAILED-style state. Without a structured
    // failure the pre-existing prose handoff stands and the pipeline advances —
    // only an explicit, classified question routes back.
    if (stage === AgentStage.UXUI_DESIGNER && result.outcome.result === "FAIL" && result.failure) {
      return this.routeUxuiQuestionBack(result.failure);
    }

    // Verdict events, emitted after the route is decided so a failed round
    // carries the decision with it. A PASS outcome that lacked its required
    // evidence is no verdict at all - STAGE_INCOMPLETE already says so.
    if (decision.complete || result.outcome.result === "FAIL") this.emitVerdict(stage, result);

    return this.advance();
  }

  /**
   * Emits QA_PASSED/QA_FAILED/SECURITY_PASSED/SECURITY_FAILED for a stage that
   * verifies something, and nothing at all for a stage that doesn't.
   *
   * An engineer finishing is an AGENT_COMPLETED and no more: giving it a verdict
   * would make "passed" mean two different things depending on who emitted it —
   * "I ran without erroring" for a producer, "I checked someone else's work and
   * it holds" for a reviewer. Those are not the same claim, and independent
   * verdicts rest on their being kept apart.
   */
  private emitVerdict(stage: AgentStage, result: AgentExecutorResult): void {
    const passed = result.outcome.result !== "FAIL";
    const type = verdictEventFor(stage, passed);
    if (!type) return;

    const round = stage === AgentStage.QA_ENGINEER ? this.run.retries.qa : this.run.retries.security;
    if (type === "QA_PASSED" || type === "SECURITY_PASSED") {
      this.emitAndStore(type, { taskId: this.taskId, stage, round });
      return;
    }
    this.emitAndStore(type, {
      taskId: this.taskId,
      stage,
      round,
      failure: result.failure ?? null,
      recovery: this.lastRecovery,
    });
  }

  /**
   * Decides what happens after a failed round, and applies it.
   *
   * The decision itself lives in retry/recoveryPolicy.ts and is pure; this only
   * carries it out. Keeping those apart matters because the decision is the part
   * worth reviewing: RETRY, RECOVER, ROLLBACK, ESCALATE and ABORT are five
   * different answers. The agent that reported the failure makes none of these
   * calls — it supplies facts, the orchestrator draws the conclusion.
   */
  private applyFailureRoute(failureKind: "qa" | "security", failure: StructuredFailure | undefined): void {
    // Recorded alongside the recovery action, not instead of it: the action
    // says which state the task moves to, the route says what the repair
    // consists of, what it invalidates, and whether the round after it has to
    // be FULL. Both are derived from the same failure, and both are audit
    // records rather than instructions to any agent.
    this.lastRepairRoute = failure
      ? routeRepair({
          finding: {
            task_id: this.taskId,
            category: failure.category,
            owner: failure.owner,
            retryable: failure.retryable,
            requires_human: failure.requiresHuman,
          },
          pipeline: this.pipeline,
        })
      : null;
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
        // risk-triggered gates previously left no trace of having been reached.
        this.openApproval({
          type: failureKind === "qa" ? ApprovalType.QA_FAILURE : ApprovalType.SECURITY_RISK,
          reason: action.reason,
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

  /**
   * Applies a UX/UI question's structured failure: RECOVER sends the
   * task back to business-analyst/system-analyst exactly like a qa-reported
   * contract gap — same guarded back-edge, same cursor arithmetic. Everything
   * else stops for a person, because these are the fail-closed edges:
   *  - a severity the escalation policy never handles autonomously (critical),
   *  - an owner that is not in this pipeline at all (a bugfix has no BA/SA to
   *    return to), or
   *  - a state the machine cannot legally reach backwards from here.
   * No retry budget is consumed on any path: an answer is being sought, not a
   * defect re-run.
   */
  private routeUxuiQuestionBack(failure: StructuredFailure): OrchestratorStatus {
    const severity = policyFor(failure.severity);
    if (!severity.autonomous || severity.stop_pipeline) {
      this.run = { ...this.run, machine: forceBlock(this.run.machine) };
      this.blockedReason =
        `severity "${failure.severity}" is never handled autonomously — a person decides: ${failure.reason}`;
      return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
    }

    const route = routeFailure(failure, this.pipeline);
    switch (route.kind) {
      case "RECOVER": {
        try {
          this.run = { ...this.run, machine: recoverTo(this.run.machine, route.toState) };
        } catch (e) {
          // recoverTo refuses states this task never passed through — a
          // small-change pipeline without BA/SA upstream. Stop loudly rather
          // than let the question evaporate.
          this.run = { ...this.run, machine: forceBlock(this.run.machine) };
          this.blockedReason = `cannot route the UX/UI question back to ${route.stage}: ${(e as Error).message}`;
          return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
        }
        const index = this.pipeline.indexOf(route.stage);
        this.pipelineCursor = index === -1 ? this.implementationStartIndex : index;
        break;
      }
      default:
        // RETRY_STAGE (an engineer owns it) and ESCALATE are both "no automatic
        // move answers this" — stop with the reason instead of looping.
        this.run = { ...this.run, machine: forceBlock(this.run.machine) };
        this.blockedReason = route.reason;
        return this.settle({ kind: "BLOCKED", reason: this.blockedReason });
    }
    return this.advance();
  }

  /** Convenience wrapper for callers that want a direct call/await relationship instead of listening on `events`. */
  async step(executor: AgentExecutor, now: () => number = Date.now): Promise<OrchestratorStatus> {
    const status = this.status();
    if (status.kind !== "RUNNING") return status;

    const { stage } = status;
    const context = selectContext(stage, this.artifactStore);
    // At the moment this status was returned, DEVOPS is only ever assigned at exactly one
    // of these two states (see isAgentAssignedAt) — so the current state alone tells us which run.
    const deployPhase: AgentExecutorRequest["deployPhase"] =
      stage === AgentStage.DEVOPS ? (this.run.machine.current === TaskState.APPROVED ? "execute" : "prepare") : undefined;
    // The retry count is the round number a recheck plan is built from.
    const qaRound = stage === AgentStage.QA_ENGINEER ? this.run.retries.qa : undefined;
    // The capability gate's one destructive moment: devops about to run the real
    // deploy/migration command must hold the `deploy` permission its contract
    // declares. A contract edited to drop it stops the launch here — fail closed,
    // not as a prompt-level request the model could talk its way past.
    if (stage === AgentStage.DEVOPS && deployPhase === "execute") {
      assertPermission(stage, Permission.DEPLOY);
    }
    const start = now();
    const result = await executor({
      stage,
      taskId: this.taskId,
      context,
      deployPhase,
      qaRound,
      businessInput:
        stage === AgentStage.BUSINESS_ANALYST
          ? this.gateContext.businessInput
          : undefined,
      deterministicVerification: stage === AgentStage.QA_ENGINEER ? this.persistedVerification() : undefined,
    });
    const end = now();

    return this.reportCompletion(stage, result, { start, end });
  }
}
