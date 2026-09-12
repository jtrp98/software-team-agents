import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { createRunId } from "../run/journal.js";
import { RuntimeCapability } from "../runtime/runtimeCapabilities.js";
import type { RuntimeCapabilityReport } from "../runtime/runtimeCapabilityDetection.js";
import { AgentStage } from "../types.js";
import { SqliteRunLedger } from "./sqliteRunLedger.js";
import { LEDGER_SCHEMA_VERSION, attemptId, type LedgerAttempt, type LedgerRun, type LedgerTask } from "./runLedger.js";
import {
  AttemptConformanceError,
  AttemptFreezeError,
  AttemptResumeError,
  adapterRouteFor,
  assertAdapterRequestMatchesAttempt,
  assertAttemptResumable,
  freezeAttempt,
  haltAttempt,
  rerouteAttempt,
  type FreezeAttemptInput,
} from "./attemptFreeze.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

let root: string;
let store: SqliteTaskStore;
let ledger: SqliteRunLedger;
let runId: string;

function capabilityReport(overrides: Partial<RuntimeCapabilityReport> = {}): RuntimeCapabilityReport {
  return {
    runtimeId: "claude-code",
    available: true,
    checks: [
      { capability: RuntimeCapability.PRE_TOOL_GUARD, claimed: true, verified: true },
      { capability: RuntimeCapability.MODEL_SELECTION, claimed: true, verified: true },
      { capability: RuntimeCapability.COST_REPORTING, claimed: true, verified: false, reason: "no probe available in this fixture" },
    ],
    missingRequired: [],
    fallbacks: [],
    ...overrides,
  };
}

function freezeInput(overrides: Partial<FreezeAttemptInput> = {}): FreezeAttemptInput {
  return {
    ledger, runId, taskId: "BE-004", stage: AgentStage.BACKEND_ENGINEER, attempt: 1,
    requested: { runtime: "claude-code", model: "claude-opus-5", effort: "high" },
    observed: { runtime: "claude-code", model: "claude-opus-5", effort: "high" },
    modelExplicit: true,
    routeBasis: "level-2;task-tier:T2/task-tier:T2",
    tier: "T2",
    adapterVersion: "claude-code@1",
    configHash: HASH_A, planHash: HASH_C, baseRevision: "abc1234",
    availability: { available: true },
    capabilityReport: capabilityReport(),
    targetWrite: true,
    writableRoots: [path.join(root, "target")],
    packetHash: HASH_B, packetPath: ".workflow/packets/BE-004/backend-engineer-1.json",
    startedAt: 2_000,
    ...overrides,
  };
}

function seedRun(): void {
  const run: LedgerRun = {
    ledger_version: LEDGER_SCHEMA_VERSION, run_id: runId, status: "REGISTERED", boundary: "qa",
    module: "orders", target_id: "orders-target", target_root: path.join(root, "target"), knowledge_root: root,
    base_branch: "main", base_sha: "abc1234", run_branch: `sta/run/${runId}`,
    requirement_hash: HASH_A, design_hash: HASH_B, plan_hash: HASH_C, config_hash: HASH_A,
    sta_version: "2.0.0", task_order: ["BE-004"], max_tasks: 1, created_at: 1_000, updated_at: 1_000, halt_reason: null,
  };
  const task: LedgerTask = {
    run_id: runId, task_id: "BE-004", status: "READY", owner: AgentStage.BACKEND_ENGINEER, phase: 1,
    depends_on: [], produces: [], consumes: [], task_hash: HASH_A, position: 0, updated_at: 1_000,
  };
  store.transaction(() => { ledger.createRun(run); ledger.registerTasks([task]); });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "v8-attempt-"));
  fs.mkdirSync(path.join(root, "target"), { recursive: true });
  store = new SqliteTaskStore(path.join(root, "state.db"));
  ledger = new SqliteRunLedger(store, { projectRoot: root });
  runId = createRunId();
  seedRun();
});

afterEach(() => {
  try { ledger.close(); } catch { /* already closed */ }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("T-V8-018 — an attempt cannot start without a complete, supported, evidenced route", () => {
  it("persists requested and observed route, Tier basis, adapter/config version, capability and guard evidence, and the packet", () => {
    const attempt = freezeAttempt(freezeInput());
    expect(attempt.attempt_id).toBe(attemptId(runId, "BE-004", AgentStage.BACKEND_ENGINEER, 1));
    expect(attempt.status).toBe("FROZEN");
    expect(attempt.requested).toEqual({ runtime: "claude-code", model: "claude-opus-5", effort: "high" });
    expect(attempt.observed).toEqual({ runtime: "claude-code", model: "claude-opus-5", effort: "high" });
    expect(attempt.route_basis).toBe("level-2;task-tier:T2/task-tier:T2");
    expect(attempt.tier).toBe("T2");
    expect(attempt.adapter_version).toBe("claude-code@1");
    expect(attempt.config_hash).toBe(HASH_A);
    expect(attempt.base_revision).toBe("abc1234");
    expect(attempt.packet_hash).toBe(HASH_B);
    expect(attempt.packet_path).toContain("backend-engineer-1.json");
    expect(attempt.guard_evidence).toEqual({ target_write: true, pre_tool_guard: true, writable_roots: [path.join(root, "target")] });
    // Unverified checks are kept, not dropped: "claimed but unconfirmed" is the
    // fact an auditor needs.
    expect(attempt.capability_evidence).toEqual([
      { capability: RuntimeCapability.PRE_TOOL_GUARD, verified: true, detail: null },
      { capability: RuntimeCapability.MODEL_SELECTION, verified: true, detail: null },
      { capability: RuntimeCapability.COST_REPORTING, verified: false, detail: "no probe available in this fixture" },
    ]);
    expect(ledger.readAttempt(attempt.attempt_id)).toEqual(attempt);
    expect(ledger.eventsForRun(runId).map((e) => e.kind)).toContain("ATTEMPT_FROZEN");
  });

  it("refuses before selection is complete and reports every missing precondition at once", () => {
    try {
      freezeAttempt(freezeInput({
        availability: undefined,
        observed: { runtime: "codex", model: "gpt-5", effort: "high" },
        capabilityReport: capabilityReport({ runtimeId: "codex", checks: [] }),
      }));
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AttemptFreezeError);
      const reasons = (error as AttemptFreezeError).reasons.join("\n");
      expect(reasons).toContain('support level "preview"');
      expect(reasons).toContain("availability was never probed");
      expect(reasons).toContain("no verified model-selection capability");
      expect(reasons).toContain("requires a verified pre-tool guard");
    }
    expect(ledger.attemptsForTask(runId, "BE-004")).toEqual([]);
  });

  it("refuses an unavailable provider rather than starting and discovering it", () => {
    expect(() => freezeAttempt(freezeInput({ availability: { available: false, reason: "binary not found" } }))).toThrow(
      /is unavailable: binary not found/,
    );
  });

  it("refuses capability evidence that describes a different runtime", () => {
    expect(() => freezeAttempt(freezeInput({ capabilityReport: capabilityReport({ runtimeId: "opencode" }) }))).toThrow(
      /capability evidence describes "opencode"/,
    );
  });

  it("refuses a Target-writing attempt without a verified pre-tool guard or with an ambiguous root", () => {
    const noGuard = capabilityReport({
      checks: [
        { capability: RuntimeCapability.PRE_TOOL_GUARD, claimed: true, verified: false, reason: "hook file absent" },
        { capability: RuntimeCapability.MODEL_SELECTION, claimed: true, verified: true },
      ],
    });
    expect(() => freezeAttempt(freezeInput({ capabilityReport: noGuard }))).toThrow(/requires a verified pre-tool guard/);
    expect(() => freezeAttempt(freezeInput({ writableRoots: [root, path.join(root, "target")] }))).toThrow(
      /exactly one writable root, resolved 2/,
    );
    // A non-writing stage is held to neither rule.
    expect(() => freezeAttempt(freezeInput({ targetWrite: false, writableRoots: [], capabilityReport: noGuard }))).not.toThrow();
  });

  it("refuses to freeze an attempt for a task this run never registered", () => {
    expect(() => freezeAttempt(freezeInput({ taskId: "FE-999" }))).toThrow(/does not exist in this ledger/);
  });
});

describe("T-V8-018 — the adapter sees exactly the frozen route", () => {
  it("builds the adapter's model/effort fields only from the ledger", () => {
    const attempt = freezeAttempt(freezeInput());
    expect(adapterRouteFor(attempt)).toEqual({ model: "claude-opus-5", modelExplicit: true, effort: "high" });
    const noEffort = freezeAttempt(freezeInput({ attempt: 2, observed: { runtime: "claude-code" }, modelExplicit: false }));
    expect(adapterRouteFor(noEffort)).toEqual({ modelExplicit: false });
  });

  it("fails closed on any divergence and names both values", () => {
    const attempt = freezeAttempt(freezeInput());
    expect(() => assertAdapterRequestMatchesAttempt(attempt, { runtimeId: "claude-code", model: "claude-opus-5", modelExplicit: true, effort: "high" })).not.toThrow();
    for (const [request, expected] of [
      [{ runtimeId: "codex", model: "claude-opus-5", modelExplicit: true, effort: "high" }, /runtime: frozen=claude-code, request=codex/],
      [{ runtimeId: "claude-code", model: "claude-sonnet-5", modelExplicit: true, effort: "high" }, /model: frozen=claude-opus-5, request=claude-sonnet-5/],
      [{ runtimeId: "claude-code", model: "claude-opus-5", modelExplicit: false, effort: "high" }, /modelExplicit: frozen=true, request=false/],
      [{ runtimeId: "claude-code", model: "claude-opus-5", modelExplicit: true, effort: "medium" }, /effort: frozen=high, request=medium/],
      [{ runtimeId: "claude-code", model: "claude-opus-5", modelExplicit: true }, /effort: frozen=high, request=null/],
    ] as const) {
      expect(() => assertAdapterRequestMatchesAttempt(attempt, request)).toThrow(AttemptConformanceError);
      expect(() => assertAdapterRequestMatchesAttempt(attempt, request)).toThrow(expected);
    }
  });
});

describe("T-V8-018 — provider failure halts; only an explicit reroute creates a new attempt", () => {
  it("records quota, timeout and unavailability as outcomes of this attempt, never as a provider change", () => {
    const quota = freezeAttempt(freezeInput());
    ledger.updateAttempt(quota.attempt_id, { status: "RUNNING" });
    const halted = haltAttempt(ledger, quota.attempt_id, "quota", "provider refused this invocation", 4_000);
    expect(halted.status).toBe("FAILED");
    expect(halted.outcome_reason).toBe("quota: provider refused this invocation");
    expect(halted.ended_at).toBe(4_000);
    // The route recorded on the attempt is untouched by its outcome.
    expect(halted.observed.runtime).toBe("claude-code");

    const unavailable = freezeAttempt(freezeInput({ attempt: 2 }));
    expect(haltAttempt(ledger, unavailable.attempt_id, "unavailable", "binary missing", 5_000).status).toBe("UNAVAILABLE");
  });

  it("supersedes the previous attempt and links the new one, preserving the old outcome", () => {
    const first = freezeAttempt(freezeInput());
    ledger.updateAttempt(first.attempt_id, { status: "RUNNING" });
    haltAttempt(ledger, first.attempt_id, "quota", "usage limit reached", 4_000);
    const second = rerouteAttempt(ledger.readAttempt(first.attempt_id)!, {
      ...freezeInput({ attempt: 2, packetPath: ".workflow/packets/BE-004/backend-engineer-2.json" }),
    });
    expect(second.reroute_of).toBe(first.attempt_id);
    expect(second.attempt).toBe(2);
    // The failed attempt keeps its real outcome; only the link records the reroute.
    expect(ledger.readAttempt(first.attempt_id)!.status).toBe("FAILED");
    expect(ledger.readAttempt(first.attempt_id)!.outcome_reason).toBe("quota: usage limit reached");
    expect(ledger.attemptsForTask(runId, "BE-004").map((a) => a.attempt)).toEqual([1, 2]);
  });

  it("marks an attempt SUPERSEDED only when it never produced an outcome", () => {
    const first = freezeAttempt(freezeInput());
    const second = rerouteAttempt(first, { ...freezeInput({ attempt: 2 }) });
    expect(ledger.readAttempt(first.attempt_id)!.status).toBe("SUPERSEDED");
    expect(ledger.readAttempt(first.attempt_id)!.outcome_reason).toContain("before this attempt produced an outcome");
    expect(second.reroute_of).toBe(first.attempt_id);
  });

  it("refuses to reroute an attempt that is still running or to reuse its number", () => {
    const first = freezeAttempt(freezeInput());
    ledger.updateAttempt(first.attempt_id, { status: "RUNNING" });
    expect(() => rerouteAttempt(ledger.readAttempt(first.attempt_id)!, { ...freezeInput({ attempt: 2 }) })).toThrow(
      /still RUNNING/,
    );
    haltAttempt(ledger, first.attempt_id, "timeout", "exceeded its budget", 4_000);
    expect(() => rerouteAttempt(ledger.readAttempt(first.attempt_id)!, { ...freezeInput({ attempt: 1 }) })).toThrow(
      /higher attempt number than 1/,
    );
  });
});

describe("T-V8-018 — resume replays the same packet or refuses", () => {
  let attempt: LedgerAttempt;
  beforeEach(() => { attempt = freezeAttempt(freezeInput()); });

  const current = { packetHash: HASH_B, configHash: HASH_A, planHash: HASH_C, baseRevision: "abc1234", runtimeId: "claude-code", adapterVersion: "claude-code@1" };

  it("resumes an unfinished attempt whose world is unchanged", () => {
    expect(() => assertAttemptResumable(attempt, current)).not.toThrow();
    ledger.updateAttempt(attempt.attempt_id, { status: "RUNNING" });
    expect(() => assertAttemptResumable(ledger.readAttempt(attempt.attempt_id)!, current)).not.toThrow();
  });

  it.each([
    ["packetHash", { packetHash: HASH_C }, /packet_hash/],
    ["configHash", { configHash: HASH_B }, /config_hash/],
    ["planHash", { planHash: HASH_A }, /plan_hash/],
    ["baseRevision", { baseRevision: "def5678" }, /base_revision/],
    ["runtimeId", { runtimeId: "codex" }, /runtime/],
    ["adapterVersion", { adapterVersion: "claude-code@2" }, /adapter_version/],
  ])("refuses %s drift", (_name, drift, matcher) => {
    expect(() => assertAttemptResumable(attempt, { ...current, ...drift })).toThrow(AttemptResumeError);
    expect(() => assertAttemptResumable(attempt, { ...current, ...drift })).toThrow(matcher);
  });

  it("refuses to resume an already-settled attempt", () => {
    ledger.updateAttempt(attempt.attempt_id, { status: "RUNNING" });
    ledger.updateAttempt(attempt.attempt_id, { status: "SUCCEEDED", ended_at: 4_000 });
    expect(() => assertAttemptResumable(ledger.readAttempt(attempt.attempt_id)!, current)).toThrow(/already settled/);
  });

  it("ignores an unresolvable expectation rather than reading it as drift", () => {
    expect(() => assertAttemptResumable(attempt, {})).not.toThrow();
  });

  it("never infers effort or guard facts into an old attempt", () => {
    const legacy = freezeAttempt(freezeInput({ attempt: 3, observed: { runtime: "claude-code" }, modelExplicit: false, targetWrite: false, writableRoots: [] }));
    expect(legacy.observed.effort).toBeNull();
    expect(legacy.observed.model).toBeNull();
    expect(legacy.guard_evidence).toEqual({ target_write: false, pre_tool_guard: true, writable_roots: [] });
    // The recorded contract is what resume is held to; nothing fills the nulls in.
    expect(ledger.readAttempt(legacy.attempt_id)!.observed).toEqual({ runtime: "claude-code", model: null, effort: null });
  });
});
