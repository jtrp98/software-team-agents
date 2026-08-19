import { AgentStage, TaskState } from "../types.js";
import type { ClassificationResult } from "../classification/taskClassifier.js";
import {
  STAGE_TO_STATE,
  forceBlock,
  forwardState,
  transition,
  type TaskMachine,
} from "../state/taskState.js";
import { MAX_RETRY, initTaskRun, recordFailure, type TaskRun } from "../retry/retryPolicy.js";
import { checkGate, type GateContext } from "../gates/gatePolicy.js";
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
}

/** The pluggable seam: item 13 is a pure coordinator, it never runs an agent itself. */
export type AgentExecutor = (req: AgentExecutorRequest) => Promise<AgentExecutorResult> | AgentExecutorResult;

export type OrchestratorStatus =
  | { kind: "RUNNING"; stage: AgentStage }
  | { kind: "WAITING_FOR_HUMAN"; from: TaskState; to: TaskState; reason: string }
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
  WAITING_FOR_HUMAN: { taskId: string; from: TaskState; to: TaskState; reason: string };
  TASK_BLOCKED: { taskId: string; reason: string };
  TASK_DEPLOYED: { taskId: string };
}

function stageState(stage: AgentStage | undefined): TaskState | undefined {
  if (stage === undefined) return undefined;
  if (stage === AgentStage.DEVOPS) return TaskState.READY_TO_DEPLOY;
  return STAGE_TO_STATE[stage];
}

function assertCanProduce(stage: AgentStage, artifactType: ArtifactType): void {
  if (!AGENT_REGISTRY[stage].outputs.includes(artifactType)) {
    throw new Error(`${stage} is not registered (item 9) to produce ${artifactType}`);
  }
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
 */
export class Orchestrator {
  readonly runLog = new RunLog();
  readonly events = new EventBus<OrchestratorEventMap>();
  readonly taskId: string;
  private readonly pipeline: AgentStage[];
  private readonly implementationStartIndex: number;
  private readonly budget: Budget;
  private run: TaskRun;
  private gateContext: GateContext = {};
  private artifactStore: Partial<Record<ContextCategory, string>> = {};
  private pipelineCursor = 0;
  private blockedReason: string | undefined;
  private lastStatusKey: string | undefined;

  constructor(taskId: string, classification: ClassificationResult, opts?: { budget?: Budget }) {
    this.taskId = taskId;
    this.pipeline = classification.pipeline;
    this.run = initTaskRun(classification.pipeline, classification.requiresHumanApproval);
    this.budget = opts?.budget ?? DEFAULT_BUDGET;
    this.implementationStartIndex = this.pipeline.findIndex(
      (s) => s === AgentStage.BACKEND_ENGINEER || s === AgentStage.FRONTEND_ENGINEER,
    );
  }

  get machine(): TaskMachine {
    return this.run.machine;
  }

  get retries(): { qa: number; security: number } {
    return this.run.retries;
  }

  /** Supplies human evidence for the one gate an executor can never supply itself. */
  provideHumanApproval(field: "designApproved" | "humanApproved", value: boolean): void {
    this.gateContext = { ...this.gateContext, [field]: value };
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
          this.events.emit("AGENT_ASSIGNED", { taskId: this.taskId, stage: status.stage });
          break;
        case "WAITING_FOR_HUMAN":
          this.events.emit("WAITING_FOR_HUMAN", {
            taskId: this.taskId,
            from: status.from,
            to: status.to,
            reason: status.reason,
          });
          break;
        case "BLOCKED":
          this.events.emit("TASK_BLOCKED", { taskId: this.taskId, reason: status.reason });
          break;
        case "DEPLOYED":
          this.events.emit("TASK_DEPLOYED", { taskId: this.taskId });
          break;
      }
    }
    return status;
  }

  /**
   * Advances as far as it can without running an agent: skips through states
   * whose pipeline work is already done, and through ungated edges. Stops at
   * the next agent to run, a gate that needs a human, or a terminal state.
   */
  private advance(): OrchestratorStatus {
    for (;;) {
      const current = this.run.machine.current;
      if (current === TaskState.DEPLOYED) return this.emitAndReturn({ kind: "DEPLOYED" });
      if (current === TaskState.BLOCKED) {
        return this.emitAndReturn({ kind: "BLOCKED", reason: this.blockedReason ?? "blocked" });
      }

      const stage = this.pipeline[this.pipelineCursor];
      if (stage !== undefined && stageState(stage) === current) {
        return this.emitAndReturn({ kind: "RUNNING", stage });
      }

      const next = forwardState(this.run.machine);
      if (!next) {
        this.blockedReason ??= "no forward state available";
        return this.emitAndReturn({ kind: "BLOCKED", reason: this.blockedReason });
      }

      const gate = checkGate(current, next, this.gateContext);
      if (!gate.allowed) {
        return this.emitAndReturn({
          kind: "WAITING_FOR_HUMAN",
          from: current,
          to: next,
          reason: gate.reason ?? "gate not satisfied",
        });
      }

      this.run = { ...this.run, machine: transition(this.run.machine, next) };
      if (this.run.machine.current === TaskState.BLOCKED) {
        this.blockedReason ??= "unclassifiable task — needs human triage";
      }
    }
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

    this.events.emit("AGENT_COMPLETED", { taskId: this.taskId, stage, outcome: result.outcome });
    this.runLog.record({
      task_id: this.taskId,
      agent: stage,
      start_time: timing.start,
      end_time: timing.end,
      outcome: result.outcome,
    });

    try {
      assertBudget(this.runLog, this.taskId, this.budget);
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        this.run = { ...this.run, machine: forceBlock(this.run.machine) };
        this.blockedReason = e.message;
        return this.emitAndReturn({ kind: "BLOCKED", reason: this.blockedReason });
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

    const failureKind = stage === AgentStage.QA_ENGINEER ? "qa" : stage === AgentStage.SECURITY ? "security" : null;
    if (failureKind && result.outcome.result === "FAIL") {
      this.run = recordFailure(this.run, failureKind);
      if (this.implementationStartIndex !== -1) {
        this.pipelineCursor = this.implementationStartIndex;
      }
      if (this.run.machine.current === TaskState.BLOCKED) {
        this.blockedReason = `${failureKind} retry limit (${MAX_RETRY}) exceeded`;
      }
    }

    return this.advance();
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
