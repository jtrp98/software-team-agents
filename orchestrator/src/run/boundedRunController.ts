import type { LedgerAttempt, LedgerRun, LedgerTask, RunLedger } from "../ledger/runLedger.js";
import type { DeterministicVerification } from "../qa/deterministic.js";
import type { RuntimeAgentResult } from "../runtime/runtimeAdapter.js";
import { AgentStage } from "../types.js";
import { GuardedRunSession } from "../git/guardedRun.js";
import type { GitCommandLayer } from "../git/commandLayer.js";
import type { SecretScanner } from "../git/checkpoint.js";

export const MAX_AUTOMATIC_REPAIR_ROUNDS = 2;

export type ControllerExitKind = "COMPLETED" | "GATE" | "HALTED" | "INTERRUPTED" | "REFUSED";

export interface ControllerResult {
  kind: ControllerExitKind;
  runId: string;
  reason: string;
  launchedAttempts: number;
  qaRounds: number;
}

export interface PreparedTargetAttempt {
  kind: "attempt";
  /** Already frozen in the ledger; preparation is the just-in-time packet/route boundary. */
  attempt: LedgerAttempt;
  taskDescription: string;
  allowedPathGlobs: readonly string[];
  secretScanner?: SecretScanner;
}

export type PrepareTaskResult = PreparedTargetAttempt | { kind: "gate"; reason: string } | { kind: "halt"; reason: string };

export type AttemptExecutionResult =
  | {
      kind: "completed";
      adapter: Pick<RuntimeAgentResult, "status" | "exitCode">;
      verification: DeterministicVerification;
      usage?: LedgerAttempt["usage"];
    }
  | { kind: "halt"; reason: string; category: "quota" | "unavailable" | "runtime" | "deterministic" }
  | { kind: "interrupted"; reason: string };

export interface RepairInstruction {
  taskId: string;
  owner: AgentStage;
  reason: string;
  findingIds: readonly string[];
  invalidates: readonly string[];
  requiresHuman: boolean;
}

export type QaControllerResult =
  | { kind: "pass"; evidence: string }
  | { kind: "repair"; evidence: string; repair: RepairInstruction }
  | { kind: "gate"; reason: string }
  | { kind: "halt"; reason: string };

export interface BoundedRunServices {
  /** Compiles/persists the immutable packet and freezes its route immediately before launch. */
  prepareTask(task: LedgerTask, context: { repair: RepairInstruction | null }): Promise<PrepareTaskResult>;
  executeAttempt(prepared: PreparedTargetAttempt): Promise<AttemptExecutionResult>;
  runQa(input: { run: LedgerRun; tasks: readonly LedgerTask[]; round: number }): Promise<QaControllerResult>;
  /** Analysis/contract repair is proposal-only and receives no Git session. */
  runAnalysisRepair?(instruction: RepairInstruction): Promise<{ kind: "completed" } | { kind: "gate"; reason: string } | { kind: "halt"; reason: string }>;
}

export interface BoundedRunControllerOptions {
  ledger: RunLedger;
  runId: string;
  runtimeStateRoot: string;
  services: BoundedRunServices;
  git?: GitCommandLayer;
  now?: () => number;
}

const TARGET_WRITERS = new Set<AgentStage>([AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]);

function attemptStatusFor(category: "quota" | "unavailable" | "runtime" | "deterministic"): "FAILED" | "UNAVAILABLE" {
  return category === "unavailable" ? "UNAVAILABLE" : "FAILED";
}

/**
 * T-V8-020 — the one foreground sequential controller.
 *
 * CLI parsing deliberately does not live here (T-V8-021). The controller owns
 * the fixed-ledger DAG, one in-flight attempt, deterministic/checkpoint order,
 * coherent QA, two-round repair ceiling and every durable exit.
 */
export class BoundedRunController {
  private readonly ledger: RunLedger;
  private readonly now: () => number;
  private session: GuardedRunSession | null = null;
  private launchedAttempts = 0;
  private qaRounds = 0;
  private repairForTask = new Map<string, RepairInstruction>();

  constructor(private readonly options: BoundedRunControllerOptions) {
    this.ledger = options.ledger;
    this.now = options.now ?? Date.now;
  }

  async run(): Promise<ControllerResult> {
    const run = this.ledger.readRun(this.options.runId);
    if (!run) return this.result("REFUSED", `run ${this.options.runId} does not exist`);
    if (["COMPLETED", "REFUSED", "CANCELLED", "STALE"].includes(run.status)) {
      return this.result(run.status === "COMPLETED" ? "COMPLETED" : "REFUSED", `run is already ${run.status}`);
    }
    if (run.status === "AWAITING_HUMAN") {
      return this.result("GATE", run.halt_reason ?? "run is awaiting a recorded human decision");
    }
    this.qaRounds = this.ledger.eventsForRun(run.run_id).filter((event) => event.kind === "QA_ROUND_STARTED").length;

    try {
      await this.reconcileInterruptedCheckpoint(run);
      for (;;) {
        const taskResult = await this.runReadyTasks(run);
        if (taskResult) return taskResult;

        const readiness = this.ledger.readiness(run.run_id);
        if (readiness.blocked.length > 0) return this.gate(run, `blocked task(s): ${readiness.blocked.join(", ")}`);
        if (readiness.waiting.length > 0) {
          return this.halt(run, `fixed DAG has no ready task; waiting: ${readiness.waiting.map((item) => `${item.task_id}<-${item.waiting_on.join(",")}`).join("; ")}`);
        }

        this.qaRounds += 1;
        this.append(run, null, "QA_ROUND_STARTED", `coherent checkpoint set; round ${this.qaRounds}`, { round: this.qaRounds });
        const qa = await this.options.services.runQa({ run: this.ledger.readRun(run.run_id)!, tasks: this.ledger.readTasks(run.run_id), round: this.qaRounds });
        if (qa.kind === "pass") {
          this.ledger.transaction(() => {
            for (const task of this.ledger.readTasks(run.run_id)) {
              if (task.status === "CHECKPOINTED") this.ledger.setTaskStatus(run.run_id, task.task_id, "DONE", { reason: qa.evidence });
            }
            this.ledger.setRunStatus(run.run_id, "COMPLETED", { reason: `QA PASS: ${qa.evidence}` });
          });
          return this.result("COMPLETED", qa.evidence);
        }
        if (qa.kind === "gate") return this.gate(run, qa.reason);
        if (qa.kind === "halt") return this.halt(run, qa.reason);

        const completedRepairRounds = this.ledger.eventsForRun(run.run_id).filter((event) => event.kind === "QA_REPAIR_SCHEDULED").length;
        if (completedRepairRounds >= MAX_AUTOMATIC_REPAIR_ROUNDS) {
          return this.gate(run, `ordinary automatic repair limit (${MAX_AUTOMATIC_REPAIR_ROUNDS}) reached; ${qa.repair.reason}`);
        }
        if (qa.repair.requiresHuman) return this.gate(run, qa.repair.reason);
        if (run.boundary !== "done") {
          return this.halt(run, `${run.boundary} boundary reached after QA; repair remains: ${qa.repair.reason}`);
        }

        this.append(run, qa.repair.taskId, "QA_REPAIR_SCHEDULED", qa.repair.reason, {
          owner: qa.repair.owner,
          findings: [...qa.repair.findingIds],
          invalidates: [...qa.repair.invalidates],
          round: completedRepairRounds + 1,
        });
        if (!TARGET_WRITERS.has(qa.repair.owner)) {
          if (!this.options.services.runAnalysisRepair) return this.gate(run, `repair owner ${qa.repair.owner} has no configured analysis repair service`);
          const analysis = await this.options.services.runAnalysisRepair(qa.repair);
          if (analysis.kind === "gate") return this.gate(run, analysis.reason);
          if (analysis.kind === "halt") return this.halt(run, analysis.reason);
        }
        this.requeueRepair(run, qa.repair);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const current = this.ledger.readRun(run.run_id);
      if (current && current.status === "RUNNING") this.ledger.setRunStatus(run.run_id, "HALTED", { reason });
      return this.result(this.ledger.readRun(run.run_id)?.status === "HALTED" ? "HALTED" : "REFUSED", reason);
    } finally {
      this.session?.close();
    }
  }

  private async runReadyTasks(run: LedgerRun): Promise<ControllerResult | null> {
    for (;;) {
      const readiness = this.ledger.readiness(run.run_id);
      if (readiness.ready.length === 0) return null;
      const taskId = readiness.ready[0]!;
      const task = this.ledger.readTask(run.run_id, taskId)!;
      if (task.status !== "READY") this.ledger.setTaskStatus(run.run_id, taskId, "READY", { reason: "fixed DAG dependencies are checkpointed" });
      const prepared = await this.options.services.prepareTask(this.ledger.readTask(run.run_id, taskId)!, {
        repair: this.repairForTask.get(taskId) ?? null,
      });
      if (prepared.kind === "gate") {
        this.ledger.setTaskStatus(run.run_id, taskId, "BLOCKED", { reason: prepared.reason });
        return this.gate(run, prepared.reason);
      }
      if (prepared.kind === "halt") return this.halt(run, prepared.reason);
      const frozen = this.ledger.readAttempt(prepared.attempt.attempt_id);
      if (!frozen || frozen.status !== "FROZEN" || frozen.packet_hash !== prepared.attempt.packet_hash) {
        return this.halt(run, `prepareTask did not leave immutable attempt ${prepared.attempt.attempt_id} frozen in the ledger`);
      }
      if (!this.session) {
        this.session = await GuardedRunSession.open({
          ledger: this.ledger,
          runId: run.run_id,
          runtimeStateRoot: this.options.runtimeStateRoot,
          git: this.options.git,
          firstAttempt: frozen,
          now: this.now,
        });
      }
      this.session.beginTask(frozen);
      this.launchedAttempts += 1;
      const execution = await this.options.services.executeAttempt(prepared);
      if (execution.kind === "interrupted") {
        this.session.haltActiveAttempt(frozen, execution.reason, "ABANDONED");
        return this.result("INTERRUPTED", execution.reason);
      }
      if (execution.kind === "halt") {
        this.session.haltActiveAttempt(frozen, execution.reason, attemptStatusFor(execution.category));
        return this.result("HALTED", execution.reason);
      }
      await this.session.checkpoint({
        attempt: frozen,
        adapter: execution.adapter,
        runVerification: async () => execution.verification,
        taskDescription: prepared.taskDescription,
        allowedPathGlobs: prepared.allowedPathGlobs,
        secretScanner: prepared.secretScanner,
        usage: execution.usage,
      });
      this.repairForTask.delete(taskId);
    }
  }

  private async reconcileInterruptedCheckpoint(run: LedgerRun): Promise<void> {
    const verifying = this.ledger.readTasks(run.run_id).filter((task) => task.status === "VERIFYING");
    if (verifying.length === 0) return;
    if (verifying.length !== 1) throw new Error(`one-writer invariant violated: ${verifying.length} tasks are VERIFYING`);
    const task = verifying[0]!;
    const attempt = this.ledger.attemptsForTask(run.run_id, task.task_id).find((item) => item.status === "RUNNING");
    if (!attempt) throw new Error(`task ${task.task_id} is VERIFYING without one RUNNING attempt`);
    this.session = await GuardedRunSession.open({
      ledger: this.ledger, runId: run.run_id, runtimeStateRoot: this.options.runtimeStateRoot,
      git: this.options.git, firstAttempt: attempt, now: this.now,
    });
    await this.session.reconcileHeadCheckpoint(attempt);
  }

  private requeueRepair(run: LedgerRun, repair: RepairInstruction): void {
    const ids = new Set([repair.taskId, ...repair.invalidates]);
    for (const taskId of run.task_order) {
      if (!ids.has(taskId)) continue;
      const task = this.ledger.readTask(run.run_id, taskId);
      if (!task) throw new Error(`repair names task ${taskId} outside the fixed run`);
      if (task.status === "CHECKPOINTED" || task.status === "FAILED" || task.status === "BLOCKED") {
        this.ledger.setTaskStatus(run.run_id, taskId, "READY", { reason: `targeted repair: ${repair.reason}` });
        this.repairForTask.set(taskId, repair);
      }
    }
  }

  private gate(run: LedgerRun, reason: string): ControllerResult {
    const current = this.ledger.readRun(run.run_id);
    if (current && ["REGISTERED", "RUNNING", "HALTED"].includes(current.status)) {
      this.ledger.setRunStatus(run.run_id, "AWAITING_HUMAN", { reason });
    }
    return this.result("GATE", reason);
  }

  private halt(run: LedgerRun, reason: string): ControllerResult {
    const current = this.ledger.readRun(run.run_id);
    if (current && ["REGISTERED", "RUNNING"].includes(current.status)) this.ledger.setRunStatus(run.run_id, "HALTED", { reason });
    return this.result("HALTED", reason);
  }

  private append(run: LedgerRun, taskId: string | null, kind: string, reason: string, payload: Record<string, unknown>): void {
    this.ledger.appendEvent({ run_id: run.run_id, task_id: taskId, at: this.now(), kind, actor: "bounded-run-controller", reason, from: null, to: null, payload });
  }

  private result(kind: ControllerExitKind, reason: string): ControllerResult {
    return { kind, runId: this.options.runId, reason, launchedAttempts: this.launchedAttempts, qaRounds: this.qaRounds };
  }
}
