import { createHash } from "node:crypto";
import type { RuntimeAdapter, RuntimeAgentRequest, RuntimeAgentResult, RuntimeProbe, RuntimeRunStatus } from "./runtimeAdapter.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";

/**
 * V13 TASK-013 — the certified executor lifecycle port.
 *
 * `RuntimeAdapter` is the execution seam: probe, then run one agent. It was
 * never a *lifecycle* seam — resume, cancel and result/evidence collection
 * had no place in the interface, so every runtime that could not do them was
 * indistinguishable from one that simply had not been asked. This port makes
 * the whole lifecycle explicit, per `req.md` §22:
 *
 *   capability probe → prepare → execute → resume / cancel → collect result → collect evidence
 *
 * WHO HOLDS WHAT
 *
 *   STA Core sees only this port and the normalized types below. Every
 *   subprocess, session, worktree, hook and envelope detail stays in the
 *   adapter — including the attempt id's *format*, which each runtime mints
 *   for itself. A core module that reaches for a runtime's flag vocabulary or
 *   envelope shape is a boundary violation, and the contract suite scans for
 *   it (`executorPort.contract.test.ts`).
 *
 *   The request an adapter `prepare`s is the prepared role packet plus the
 *   scoped workspace grant STA already resolved: `RuntimeAgentRequest.prompt`
 *   is the compiled packet text, `guards`/`workRoots`/`env` are the scope, and
 *   the adapter holds nothing it did not receive from STA.
 *
 * TYPED REFUSALS, NEVER APPROXIMATIONS
 *
 *   An operation a runtime cannot perform comes back as
 *   `ExecutorPortRefusalError` naming the operation — before any spawn, never
 *   as a fabricated success, a silent "completed", or a new attempt that
 *   claims a resumed one's identity. Refusal is the honest answer until
 *   TASK-014/015 implement the real lifecycle per adapter; the shared
 *   contract suite asserts exactly that for every implementation.
 */

/** How a cancel ended, normalized across runtimes. */
export type ExecutorCancelStatus =
  /** The attempt stopped before finishing its work. */
  | "cancelled"
  /** The attempt had already finished (or was never running) — nothing to stop. */
  | "already-finished"
  /** The runtime could not stop it; the refusal names why. */
  | "refused";

export interface ExecutorCancelOutcome {
  readonly status: ExecutorCancelStatus;
  /** One line a person can act on — recorded with the attempt, never interpreted by Core. */
  readonly detail?: string;
}

/**
 * A reference to one attempt an adapter started or restored. `sessionRef` is
 * deliberately opaque — a session id, a worktree path, a process handle, or
 * absent for runtimes with neither; Core persists it and hands it back, and
 * never opens it.
 */
export interface ExecutorAttemptRef {
  /** The adapter that owns this attempt. */
  readonly runtimeId: string;
  /** Adapter-minted, stable for the life of the attempt — the key resume/cancel/collect are answered under. */
  readonly attemptId: string;
  readonly sessionRef?: string;
  readonly taskId?: string;
  readonly stage?: string;
}

export interface PreparedExecutorAttempt extends ExecutorAttemptRef {
  /** Milliseconds at prepare — the attempt's identity is fixed before any spawn. */
  readonly preparedAt: number;
}

/** Normalized evidence for a finished attempt, in the port's shape — never the runtime's envelope. */
export interface ExecutorEvidence {
  readonly attemptId: string;
  readonly runtimeId: string;
  /** The attempt's final normalized result; null when no result envelope exists (cancel before completion, crash without one). */
  readonly result: RuntimeAgentResult | null;
  /** Adapter-native log or transcript references, opaque to Core. */
  readonly logs: readonly string[];
  readonly sessionRef?: string;
  /**
   * V13 TASK-014 — the files this attempt actually changed, captured by the
   * adapter itself from the work roots before and after its run (read-only git
   * inspection plus content digests, the same source `exitCheckRunner` uses) —
   * never read off the agent's report. Undefined, never an empty list, when
   * the workspace could not be snapshotted (not a git checkout, git unusable).
   */
  readonly changedFiles?: readonly string[];
  readonly collectedAt: number;
}

/** Why the port refused a lifecycle operation. */
export type ExecutorRefusalCode =
  /** The runtime declares no capability for this operation. */
  | "unsupported-operation"
  /** The reference names no attempt this adapter knows. */
  | "unknown-attempt"
  /** The attempt was cancelled — it can neither execute nor resume under this id. */
  | "attempt-cancelled"
  /** The runtime itself is unusable right now. */
  | "runtime-unavailable";

export class ExecutorPortRefusalError extends Error {
  constructor(
    public readonly code: ExecutorRefusalCode,
    public readonly operation: "prepare" | "execute" | "resume" | "cancel" | "collectResult" | "collectEvidence",
    public readonly runtimeId: string,
    reason: string,
  ) {
    super(`executor "${runtimeId}" refused ${operation} (${code}): ${reason}`);
    this.name = "ExecutorPortRefusalError";
  }
}

/**
 * The lifecycle port. Every certified executor conforms to this — the four
 * existing adapters through TASK-014's conformance work, ZCode through
 * TASK-015 — and STA Core calls nothing past it.
 */
export interface ExecutorPort extends RuntimeAdapter {
  /**
   * Validates the prepared packet + scope against this runtime and mints the
   * attempt identity. Must be called before `execute`; a runtime that cannot
   * run the packet refuses here, before any spawn.
   */
  prepare(req: RuntimeAgentRequest): Promise<PreparedExecutorAttempt>;
  /** Runs a prepared attempt. Same result contract as `executeAgent`, tied to the attempt id. */
  execute(attempt: PreparedExecutorAttempt): Promise<RuntimeAgentResult>;
  /** Continues a previously started attempt from its persisted reference. */
  resume(ref: ExecutorAttemptRef): Promise<RuntimeAgentResult>;
  /** Stops an in-flight attempt and reports the normalized outcome. */
  cancel(ref: ExecutorAttemptRef): Promise<ExecutorCancelOutcome>;
  /** The finished attempt's result envelope, when one exists. */
  collectResult(ref: ExecutorAttemptRef): Promise<RuntimeAgentResult | null>;
  /** Normalized evidence for the finished attempt. */
  collectEvidence(ref: ExecutorAttemptRef): Promise<ExecutorEvidence>;
}

/** The lifecycle operations an adapter must declare a capability for. */
export const CAPABILITY_FOR_OPERATION: Readonly<
  Record<"resume" | "cancel" | "collectResult" | "collectEvidence", RuntimeCapability>
> = Object.freeze({
  resume: RuntimeCapability.ATTEMPT_RESUME,
  cancel: RuntimeCapability.ATTEMPT_CANCEL,
  collectResult: RuntimeCapability.EVIDENCE_COLLECTION,
  collectEvidence: RuntimeCapability.EVIDENCE_COLLECTION,
});

/**
 * Deterministic attempt id for adapters that have no native session concept —
 * derived from the request identity so `prepare` twice yields the same
 * attempt, and a forged id cannot survive a changed packet. Adapters with a
 * native session mint their own; this is the port's floor, not its ceiling.
 */
export function deterministicAttemptId(runtimeId: string, req: RuntimeAgentRequest): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        runtimeId,
        req.role,
        req.cwd,
        req.taskId ?? null,
        req.stage ?? null,
        createHash("sha256").update(req.prompt).digest("hex"),
      ]),
    )
    .digest("hex");
  return `atm_${hash.slice(0, 32)}`;
}

/** The one refusal every unimplemented operation returns — same shape, named operation. */
export function refusedOperation(
  runtimeId: string,
  operation: "resume" | "cancel" | "collectResult" | "collectEvidence",
  capabilities: ReadonlySet<RuntimeCapability>,
  detail?: string,
): never {
  const capability = CAPABILITY_FOR_OPERATION[operation];
  if (capabilities.has(capability)) {
    // Declared but not implemented is a contract bug in the adapter itself —
    // refused rather than guessed, and naming the lie.
    throw new ExecutorPortRefusalError("unsupported-operation", operation, runtimeId, detail ?? `declares ${capability} but implements no ${operation}`);
  }
  throw new ExecutorPortRefusalError(
    "unsupported-operation",
    operation,
    runtimeId,
    detail ?? `does not declare ${capability} — the operation is refused, not approximated`,
  );
}

/**
 * Lifts a probe/execute-only adapter onto the port with honest refusals for
 * every lifecycle operation it has not declared. This is scaffolding for the
 * TASK-014 conformance round and the contract suite — it adds no capability
 * the wrapped adapter did not claim, and the suite holds it to exactly that.
 * The request prepared for an attempt is kept by the wrapper so `execute`
 * replays the same packet; nothing else about the attempt exists.
 */
export function executeOnlyLifecycle(adapter: RuntimeAdapter): ExecutorPort {
  const refuse = (operation: "resume" | "cancel" | "collectResult" | "collectEvidence"): never =>
    refusedOperation(adapter.id, operation, adapter.capabilities);
  const prepared = new Map<string, RuntimeAgentRequest>();
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    binding: adapter.binding,
    capabilities: adapter.capabilities,
    models: adapter.models,
    workspace: adapter.workspace,
    probe: (): Promise<RuntimeProbe> => adapter.probe(),
    // The core still drives the single-shot seam until the conformance round
    // rewires dispatch onto prepare/execute; the wrapper passes it through
    // unchanged rather than adding a second behavior.
    executeAgent: (req: RuntimeAgentRequest): Promise<RuntimeAgentResult> => adapter.executeAgent(req),
    prepare: async (req: RuntimeAgentRequest): Promise<PreparedExecutorAttempt> => {
      const attemptId = deterministicAttemptId(adapter.id, req);
      prepared.set(attemptId, req);
      return {
        runtimeId: adapter.id,
        attemptId,
        taskId: req.taskId,
        stage: req.stage,
        preparedAt: Date.now(),
      };
    },
    execute: async (attempt: PreparedExecutorAttempt): Promise<RuntimeAgentResult> => {
      const req = prepared.get(attempt.attemptId);
      if (!req) {
        throw new ExecutorPortRefusalError("unknown-attempt", "execute", adapter.id, `attempt ${attempt.attemptId} was never prepared by this adapter`);
      }
      return adapter.executeAgent(req);
    },
    resume: async (_ref: ExecutorAttemptRef): Promise<RuntimeAgentResult> => refuse("resume"),
    cancel: async (_ref: ExecutorAttemptRef): Promise<ExecutorCancelOutcome> => refuse("cancel"),
    collectResult: async (_ref: ExecutorAttemptRef): Promise<RuntimeAgentResult | null> => refuse("collectResult"),
    collectEvidence: async (_ref: ExecutorAttemptRef): Promise<ExecutorEvidence> => refuse("collectEvidence"),
  };
}

/** The status constants the port normalizes on, re-exported for the contract suite's readability. */
export type { RuntimeRunStatus };

/**
 * Whether this adapter implements the lifecycle port itself. Structural, on
 * purpose: the composition root constructs adapters as `RuntimeAdapter`s and
 * the port is a superset of that interface, so the honest question is "can
 * this object answer prepare/resume/cancel/collect" — not a registry of which
 * class was supposed to implement what.
 */
export function isExecutorPort(adapter: RuntimeAdapter): adapter is ExecutorPort {
  return (
    "prepare" in adapter &&
    "resume" in adapter &&
    "cancel" in adapter &&
    "collectResult" in adapter &&
    "collectEvidence" in adapter &&
    typeof adapter.prepare === "function" &&
    typeof (adapter as ExecutorPort).resume === "function" &&
    typeof (adapter as ExecutorPort).cancel === "function" &&
    typeof (adapter as ExecutorPort).collectResult === "function" &&
    typeof (adapter as ExecutorPort).collectEvidence === "function"
  );
}

/**
 * The one view STA Core dispatches through. An adapter that implements the
 * port is used as-is; a probe/execute-only adapter is lifted onto the port by
 * `executeOnlyLifecycle`, which answers every lifecycle operation it has not
 * declared with a typed refusal. Either way the caller holds an
 * `ExecutorPort` — there is no second, port-less dispatch path to fall into.
 */
export function executorPortFor(adapter: RuntimeAdapter): ExecutorPort {
  return isExecutorPort(adapter) ? adapter : executeOnlyLifecycle(adapter);
}
