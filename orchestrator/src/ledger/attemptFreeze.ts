import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import type { RuntimeCapabilityReport } from "../runtime/runtimeCapabilityDetection.js";
import { RUNTIME_SUPPORT, type RuntimeId } from "../runtime/runtimeSupport.js";
import type { RuntimeAgentRequest } from "../runtime/runtimeAdapter.js";
import type { AgentStage } from "../types.js";
import {
  attemptId,
  type LedgerAttempt,
  type RunLedger,
} from "./runLedger.js";

/**
 * T-V8-018 — freeze the whole execution contract before an attempt starts.
 *
 * The rule this file exists to make mechanical: **a route is chosen once, and
 * whatever the adapter is handed must be exactly what the ledger recorded.**
 * Before it, "which model actually ran" was reconstructed after the fact from
 * run-log columns an adapter might or might not have populated, and a
 * `routing.order` hop could move a stage to a different provider mid-attempt
 * with only a diagnostic line to show for it. An audit cannot be built on
 * either.
 *
 * The freeze is not a second routing policy. `runtimeRouting.ts` still decides
 * *which* candidate wins; this records the decision, refuses to start without
 * the evidence that decision requires, and refuses any later invocation that
 * does not match it. An explicit reroute is a first-class, linked new attempt —
 * never an edit to the frozen one.
 */

export class AttemptFreezeError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`attempt cannot start:\n- ${reasons.join("\n- ")}`);
    this.name = "AttemptFreezeError";
  }
}

export class AttemptConformanceError extends Error {
  constructor(public readonly attemptId: string, public readonly differences: readonly string[]) {
    super(
      `adapter request for attempt ${attemptId} does not match the frozen route:\n- ${differences.join("\n- ")}\n` +
        "halt and create an explicit new attempt rather than invoking a runtime the ledger did not record",
    );
    this.name = "AttemptConformanceError";
  }
}

export class AttemptResumeError extends Error {
  constructor(public readonly attemptId: string, public readonly drift: readonly string[]) {
    super(
      `attempt ${attemptId} cannot resume: ${drift.join("; ")} — ` +
        "compile a new attempt against current inputs rather than replaying a packet against a different world",
    );
    this.name = "AttemptResumeError";
  }
}

/** Provider outcomes that halt a run without ever silently becoming a different provider. */
export const HALTING_ATTEMPT_OUTCOMES = ["quota", "timeout", "unavailable", "provider-change"] as const;
export type HaltingAttemptOutcome = (typeof HALTING_ATTEMPT_OUTCOMES)[number];

export interface FreezeAttemptInput {
  ledger: RunLedger;
  runId: string;
  taskId: string;
  stage: AgentStage;
  attempt: number;
  requested: { runtime: string; model?: string; effort?: string };
  observed: { runtime: string; model?: string; effort?: string };
  modelExplicit: boolean;
  routeBasis: string;
  tier?: string;
  adapterVersion: string;
  configHash: string;
  planHash: string;
  baseRevision: string;
  /** The availability probe result resolved *before* this call. A stale or absent probe refuses. */
  availability: { available: boolean; reason?: string } | undefined;
  capabilityReport: RuntimeCapabilityReport;
  targetWrite: boolean;
  writableRoots: readonly string[];
  packetHash: string;
  packetPath: string;
  startedAt: number;
  rerouteOf?: string;
}

function verifiedCapabilities(report: RuntimeCapabilityReport): Set<RuntimeCapability> {
  return new Set(report.checks.filter((check) => check.verified).map((check) => check.capability));
}

/**
 * Validates and persists one frozen attempt.
 *
 * The refusals are deliberately all evaluated before any of them throws, so an
 * operator sees every missing precondition at once rather than fixing them one
 * failed run at a time.
 */
export function freezeAttempt(input: FreezeAttemptInput): LedgerAttempt {
  const reasons: string[] = [];
  const support = Object.prototype.hasOwnProperty.call(RUNTIME_SUPPORT, input.observed.runtime)
    ? RUNTIME_SUPPORT[input.observed.runtime as RuntimeId]
    : null;
  if (!support) reasons.push(`runtime "${input.observed.runtime}" is not a known runtime`);
  else if (support.level !== "supported") {
    reasons.push(
      `runtime "${input.observed.runtime}" has support level "${support.level}"; V8 admits only "supported" runtimes to an unattended Target-writing attempt`,
    );
  }
  if (!input.availability) {
    reasons.push("candidate availability was never probed; selection must complete before an attempt starts, not during it");
  } else if (!input.availability.available) {
    reasons.push(`runtime "${input.observed.runtime}" is unavailable: ${input.availability.reason ?? "no reason reported"}`);
  }
  if (input.capabilityReport.runtimeId !== input.observed.runtime) {
    reasons.push(
      `capability evidence describes "${input.capabilityReport.runtimeId}" but the selected runtime is "${input.observed.runtime}"`,
    );
  }
  const verified = verifiedCapabilities(input.capabilityReport);
  if (input.modelExplicit && !verified.has(RuntimeCapability.MODEL_SELECTION)) {
    reasons.push(
      `route names an explicit model but "${input.observed.runtime}" has no verified model-selection capability; the adapter could silently use another model`,
    );
  }
  if (input.targetWrite) {
    if (!verified.has(RuntimeCapability.PRE_TOOL_GUARD)) {
      reasons.push(`a Target-writing attempt requires a verified pre-tool guard; "${input.observed.runtime}" has none`);
    }
    if (input.writableRoots.length !== 1) {
      reasons.push(`a Target-writing attempt requires exactly one writable root, resolved ${input.writableRoots.length}`);
    }
  }
  if (reasons.length > 0) throw new AttemptFreezeError(reasons);

  const record: LedgerAttempt = {
    attempt_id: attemptId(input.runId, input.taskId, input.stage, input.attempt),
    run_id: input.runId,
    task_id: input.taskId,
    stage: input.stage,
    attempt: input.attempt,
    status: "FROZEN",
    requested: {
      runtime: input.requested.runtime,
      model: input.requested.model ?? null,
      effort: input.requested.effort ?? null,
    },
    observed: {
      runtime: input.observed.runtime,
      model: input.observed.model ?? null,
      effort: input.observed.effort ?? null,
    },
    model_explicit: input.modelExplicit,
    route_basis: input.routeBasis,
    tier: input.tier ?? null,
    adapter_version: input.adapterVersion,
    config_hash: input.configHash,
    plan_hash: input.planHash,
    base_revision: input.baseRevision,
    // Every check is kept, verified or not: "this capability was claimed and
    // could not be confirmed" is exactly the fact an auditor needs, and
    // dropping the unverified rows would leave a report that looks complete.
    capability_evidence: input.capabilityReport.checks.map((check) => ({
      capability: check.capability,
      verified: check.verified,
      detail: check.reason ?? null,
    })),
    guard_evidence: {
      target_write: input.targetWrite,
      pre_tool_guard: verified.has(RuntimeCapability.PRE_TOOL_GUARD),
      writable_roots: [...input.writableRoots],
    },
    packet_hash: input.packetHash,
    packet_path: input.packetPath,
    started_at: input.startedAt,
    ended_at: null,
    outcome_reason: null,
    usage: null,
    reroute_of: input.rerouteOf ?? null,
  };
  input.ledger.freezeAttempt(record);
  return record;
}

/**
 * The only sanctioned way to build the model/effort half of an adapter request.
 *
 * Callers pass the rest of `RuntimeAgentRequest` themselves; these three fields
 * come from the ledger so there is no code path where an adapter can observe a
 * value the record does not contain.
 */
export function adapterRouteFor(attempt: LedgerAttempt): Pick<RuntimeAgentRequest, "model" | "modelExplicit" | "effort"> {
  return {
    ...(attempt.observed.model === null ? {} : { model: attempt.observed.model }),
    modelExplicit: attempt.model_explicit,
    ...(attempt.observed.effort === null ? {} : { effort: attempt.observed.effort }),
  };
}

/** Fails closed if an adapter is about to be invoked with anything the ledger did not freeze. */
export function assertAdapterRequestMatchesAttempt(
  attempt: LedgerAttempt,
  request: { runtimeId: string; model?: string; modelExplicit?: boolean; effort?: string },
): void {
  const differences: string[] = [];
  const compare = (name: string, actual: unknown, frozen: unknown): void => {
    if (actual !== frozen) differences.push(`${name}: frozen=${String(frozen)}, request=${String(actual)}`);
  };
  compare("runtime", request.runtimeId, attempt.observed.runtime);
  compare("model", request.model ?? null, attempt.observed.model);
  compare("modelExplicit", request.modelExplicit ?? false, attempt.model_explicit);
  compare("effort", request.effort ?? null, attempt.observed.effort);
  if (differences.length > 0) throw new AttemptConformanceError(attempt.attempt_id, differences);
}

/**
 * Ends an attempt on a provider outcome that must never become a silent
 * reroute. The run halts; a person or an explicit `--reroute` decides what
 * happens next.
 */
export function haltAttempt(
  ledger: RunLedger,
  id: string,
  outcome: HaltingAttemptOutcome,
  reason: string,
  endedAt: number,
): LedgerAttempt {
  return ledger.updateAttempt(id, {
    status: outcome === "unavailable" || outcome === "provider-change" ? "UNAVAILABLE" : "FAILED",
    ended_at: endedAt,
    outcome_reason: `${outcome}: ${reason}`,
  });
}

/**
 * An operator's explicit decision to try a different route.
 *
 * The previous attempt is never edited or deleted: its outcome, usage and
 * evidence stay exactly as recorded, and the new attempt points back at it with
 * `reroute_of`. That linkage is what makes "why did this task run twice on two
 * providers" answerable later.
 *
 * Only an attempt that never produced an outcome is marked SUPERSEDED. One that
 * already ended — FAILED on quota, UNAVAILABLE on an outage — keeps that status,
 * because overwriting a real outcome with "superseded" would delete the very
 * reason the reroute happened.
 */
export function rerouteAttempt(previous: LedgerAttempt, next: Omit<FreezeAttemptInput, "runId" | "taskId" | "stage" | "rerouteOf">): LedgerAttempt {
  if (previous.status === "RUNNING") {
    throw new AttemptFreezeError([
      `attempt ${previous.attempt_id} is still RUNNING; reconcile its outcome before rerouting so no two attempts claim the same in-flight work`,
    ]);
  }
  if (next.attempt <= previous.attempt) {
    throw new AttemptFreezeError([`a reroute must use a higher attempt number than ${previous.attempt}`]);
  }
  if (previous.status === "FROZEN") {
    next.ledger.updateAttempt(previous.attempt_id, {
      status: "SUPERSEDED",
      outcome_reason: "explicitly rerouted by an operator before this attempt produced an outcome",
    });
  }
  return freezeAttempt({
    ...next,
    runId: previous.run_id,
    taskId: previous.task_id,
    stage: previous.stage,
    rerouteOf: previous.attempt_id,
  });
}

/**
 * Refuses to resume an unfinished attempt whose inputs no longer match.
 *
 * A resumed attempt replays an *immutable packet*. If the packet, route, config
 * or base revision has moved underneath it, replaying it would ask a model to
 * act on a description of a repository that no longer exists — which is worse
 * than starting over, because the result looks like a legitimate attempt.
 */
export function assertAttemptResumable(
  attempt: LedgerAttempt,
  current: { packetHash?: string; configHash?: string; planHash?: string; baseRevision?: string; runtimeId?: string; adapterVersion?: string },
): void {
  const drift: string[] = [];
  const compare = (name: string, frozen: unknown, actual: unknown): void => {
    if (actual === undefined) return;
    if (frozen !== actual) drift.push(`${name} (frozen=${String(frozen)}, current=${String(actual)})`);
  };
  compare("packet_hash", attempt.packet_hash, current.packetHash);
  compare("config_hash", attempt.config_hash, current.configHash);
  compare("plan_hash", attempt.plan_hash, current.planHash);
  compare("base_revision", attempt.base_revision, current.baseRevision);
  compare("runtime", attempt.observed.runtime, current.runtimeId);
  compare("adapter_version", attempt.adapter_version, current.adapterVersion);
  if (drift.length > 0) throw new AttemptResumeError(attempt.attempt_id, drift);
  if (attempt.status !== "FROZEN" && attempt.status !== "RUNNING") {
    throw new AttemptResumeError(attempt.attempt_id, [`its status is ${attempt.status}, which is already settled`]);
  }
}
