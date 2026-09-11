import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { createRuntimeExecutor } from "./runtimeExecutor.js";
import { MockRuntimeAdapter, okResult } from "./mockAdapter.js";
import { NO_GUARDS } from "./runtimeAdapter.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import type { LedgerAttempt } from "../ledger/runLedger.js";

/**
 * T-V8-018, at the seam that matters: the ledger record is what the adapter
 * gets. These tests drive the *real* executor rather than the freeze helper, so
 * they fail if a future change reintroduces re-resolution or a `routing.order`
 * hop underneath a frozen attempt.
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RUN_ID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "frozen-attempt-"));
}

function frozen(overrides: Partial<LedgerAttempt> = {}): LedgerAttempt {
  return {
    attempt_id: `${RUN_ID}:BE-004:backend-engineer:1`,
    run_id: RUN_ID, task_id: "BE-004", stage: AgentStage.BACKEND_ENGINEER, attempt: 1, status: "FROZEN",
    requested: { runtime: "claude-code", model: "sonnet", effort: "high" },
    observed: { runtime: "claude-code", model: "sonnet", effort: "high" },
    model_explicit: true,
    route_basis: "level-2;task-tier:T2/task-tier:T2",
    tier: "T2",
    adapter_version: "claude-code@1",
    config_hash: HASH_A, plan_hash: HASH_B, base_revision: "abc1234",
    capability_evidence: [],
    guard_evidence: { target_write: false, pre_tool_guard: true, writable_roots: [] },
    packet_hash: HASH_A, packet_path: ".workflow/packets/BE-004/backend-engineer-1.json",
    started_at: 1_000, ended_at: null, outcome_reason: null, usage: null, reroute_of: null,
    ...overrides,
  };
}

describe("T-V8-018 — the executor hands the adapter exactly the frozen route", () => {
  it("uses the ledger's runtime/model/effort instead of re-resolving a route", async () => {
    const chosen = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet", "opus"], respond: () => okResult() });
    const other = new MockRuntimeAdapter({ id: "codex", models: ["gpt-5"], respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime: other,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([chosen, other]),
      // Operator flags that would otherwise win are deliberately present: a
      // frozen attempt outranks them, because the decision already happened.
      routingFlags: { runtime: "codex", model: "gpt-5", effort: "low" },
      frozenAttempt: frozen(),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });

    expect(result.outcome.result).toBe("PASS");
    expect(other.requests).toHaveLength(0);
    expect(chosen.requests).toHaveLength(1);
    expect(chosen.requests[0]!.model).toBe("sonnet");
    expect(chosen.requests[0]!.modelExplicit).toBe(true);
    expect(chosen.requests[0]!.effort).toBe("high");
    expect(result.outcome.runtime).toBe("claude-code");
    expect(result.outcome.requested_runtime).toBe("claude-code");
    expect(result.outcome.routing_basis).toBe("level-2;task-tier:T2/task-tier:T2");
    // A frozen attempt has no fallback queue at all: zero hops, and no reason.
    expect(result.outcome.fallback_count).toBe(0);
    expect(result.outcome.fallback_reason).toBeUndefined();
  });

  it("refuses when the frozen runtime is not registered in this process", async () => {
    const only = new MockRuntimeAdapter({ id: "codex", respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime: only,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([only]),
      frozenAttempt: frozen(),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain('names runtime "claude-code", which is not registered');
    expect(only.requests).toHaveLength(0);
  });

  it("refuses a frozen attempt that belongs to another task or stage", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"], respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([runtime]),
      frozenAttempt: frozen({ task_id: "FE-010" }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("belongs to FE-010/backend-engineer");
    expect(runtime.requests).toHaveLength(0);
  });

  it("T-V8-031 refuses a previously frozen non-Claude Target-write attempt after support policy is enforced", async () => {
    const runtime = new MockRuntimeAdapter({ id: "opencode", models: ["glm-4.7"], respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([runtime]),
      frozenAttempt: frozen({
        requested: { runtime: "opencode", model: "glm-4.7", effort: "high" },
        observed: { runtime: "opencode", model: "glm-4.7", effort: "high" },
        guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: ["C:/target"] },
      }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain('runtime "opencode" is not certified for unattended Target writes');
    expect(runtime.requests).toHaveLength(0);
  });

  it("sends the ledger's model even when it is not this executor's own default, and conformance agrees", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"], respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([runtime]),
      // The frozen route is the only source of `model`, so the conformance
      // check immediately before the invocation can only pass — which is the
      // point: under a frozen attempt there is no code path that could hand the
      // adapter a different value for it to catch.
      frozenAttempt: frozen({ observed: { runtime: "claude-code", model: "opus", effort: "high" } }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe("PASS");
    expect(runtime.requests[0]!.model).toBe("opus");
  });

  it("halts on an unavailable frozen provider instead of hopping to the next candidate", async () => {
    const unavailable = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"], probe: { available: false, reason: "binary not found" } });
    const spare = new MockRuntimeAdapter({ id: "codex", models: ["gpt-5"], respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime: unavailable,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([unavailable, spare]),
      frozenAttempt: frozen(),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(spare.requests).toHaveLength(0);
    expect(result.failure?.category).toBe("infrastructure");
  });
});
