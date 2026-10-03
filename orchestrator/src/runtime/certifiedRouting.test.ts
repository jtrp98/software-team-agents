import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { LedgerAttempt } from "../ledger/runLedger.js";
import { seedRealContracts } from "../testing/contractFixtures.js";
import { createRuntimeExecutor } from "./runtimeExecutor.js";
import { ALL_MOCK_CAPABILITIES, MockRuntimeAdapter, okResult } from "./mockAdapter.js";
import { NO_GUARDS, type RuntimeAdapter } from "./runtimeAdapter.js";
import { EXECUTOR_LIFECYCLE_CAPABILITIES, RuntimeCapability } from "./runtimeCapabilities.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { governedExecutorGap, resolveRuntimeRoute } from "./runtimeRouting.js";
import { isUnattendedTargetWriteCertified, RUNTIME_IDS } from "./runtimeSupport.js";
import { createProductionRuntimeRegistry } from "../cli/composition/runtimeRegistry.js";
import { FIXTURE_REVISION, runtimeTaskFixture } from "./packetFixture.testSupport.js";

/**
 * V13 TASK-016 — governed writes are routed only to certified, capable,
 * available executors, and the executor (runtime + version) is pinned to the
 * attempt. Replacing the executor between attempts changes nothing about the
 * role, contract or packet the attempt carries.
 */

const RUN_ID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function project(role = "backend-engineer"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "certified-routing-"));
  seedRealContracts(root);
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "agents", `${role}.md`), "---\nmodel: sonnet\nversion: 1\n---\nbody", "utf8");
  return root;
}

/** A certified runtime id whose adapter can run a prompt but is no executor: no lifecycle capabilities. */
function bareRunner(id: string): MockRuntimeAdapter {
  return new MockRuntimeAdapter({
    id,
    models: ["sonnet"],
    capabilities: [RuntimeCapability.NAMED_AGENTS, RuntimeCapability.PRE_TOOL_GUARD],
    respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }),
  });
}

/** Probe/execute only — no lifecycle port methods at all. */
function portless(id: string): RuntimeAdapter {
  const inner = new MockRuntimeAdapter({ id, models: ["sonnet"] });
  return {
    id: inner.id,
    displayName: inner.displayName,
    binding: inner.binding,
    capabilities: inner.capabilities,
    models: inner.models,
    workspace: inner.workspace,
    probe: () => inner.probe(),
    executeAgent: (req) => inner.executeAgent(req),
  };
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
    adapter_version: "sta@test",
    runtime_version: null,
    config_hash: HASH_A, plan_hash: HASH_B, base_revision: "abc1234",
    capability_evidence: [],
    guard_evidence: { target_write: false, pre_tool_guard: true, writable_roots: [] },
    packet_hash: HASH_A, packet_path: ".workflow/packets/BE-004/backend-engineer-1.json",
    started_at: 1_000, ended_at: null, outcome_reason: null, usage: null, reroute_of: null,
    ...overrides,
  };
}

describe("TASK-016 — selection requires certification, capability and availability for a governed write", () => {
  it("names the governed-executor gap for a portless adapter and for one missing lifecycle capabilities", () => {
    expect(governedExecutorGap(portless("codex"))).toMatch(/does not implement the executor lifecycle port/);
    expect(governedExecutorGap(bareRunner("codex"))).toMatch(/attempt-resume, attempt-cancel, evidence-collection/);
    expect(governedExecutorGap(new MockRuntimeAdapter({ id: "codex" }))).toBeNull();
  });

  it("refuses a certified runtime whose adapter is not a governed executor", () => {
    for (const weak of [bareRunner("claude-code"), portless("claude-code")]) {
      const result = resolveRuntimeRoute({
        role: "backend-engineer",
        stage: AgentStage.BACKEND_ENGINEER,
        projectRoot: project(),
        registry: new RuntimeRegistry([weak]),
        config: null,
        flags: { runtime: "claude-code" },
        availability: { "claude-code": { available: true } },
        hasTargetWrite: true,
      });
      expect(result.selected).toBeUndefined();
      expect(result.error).toMatch(/refusing a governed-write route/);
    }
  });

  it("an analysis route is not held to the governed-write executor rule", () => {
    const result = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: project(),
      registry: new RuntimeRegistry([bareRunner("claude-code")]),
      config: null,
      availability: { "claude-code": { available: true } },
      hasTargetWrite: false,
    });
    expect(result.selected?.runtime.id).toBe("claude-code");
  });

  // V13 TASK-027 R14C (a1): Claude Code is the only certified governed-write (owner decision 2026-10-03)
  // executor, so the walk passes an uncertified-but-capable one to reach it.
  it("routing.order walks past an uncertified executor to the next certified, capable one", () => {
    const result = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: project(),
      registry: new RuntimeRegistry([new MockRuntimeAdapter({ id: "opencode", models: ["sonnet"] }), new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] })]),
      config: { schema_version: 1, routing: { order: ["opencode", "claude-code"] } },
      availability: { opencode: { available: true }, "claude-code": { available: true } },
      hasTargetWrite: true,
      modelPolicy: null,
    });
    expect(result.selected?.runtime.id).toBe("claude-code");
    expect(result.attempts[0]!.skipReason).toMatch(/runtime "opencode" is not certified for unattended Target writes/);
  });

  it("refuses an uncertified runtime for a governed write even when named explicitly, but lets it run analysis", () => {
    const opencode = new MockRuntimeAdapter({ id: "opencode", models: ["sonnet"] });
    const write = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: project(),
      registry: new RuntimeRegistry([opencode]),
      config: null,
      flags: { runtime: "opencode" },
      availability: { opencode: { available: true } },
      hasTargetWrite: true,
    });
    expect(write.selected).toBeUndefined();
    expect(write.error).toContain('runtime "opencode" is not certified for unattended Target writes');

    const analysis = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: project(),
      registry: new RuntimeRegistry([opencode]),
      config: null,
      flags: { runtime: "opencode" },
      availability: { opencode: { available: true } },
      hasTargetWrite: false,
    });
    expect(analysis.selected?.runtime.id).toBe("opencode");
  });

  // ZCode's engineer path is the same admitted post-run write guard Codex
  // uses: routing asks it for POST_RUN_WRITE_GUARD instead of pre-tool
  // certification, and a candidate without that capability is cut.
  it("routes ZCode engineer stages on its post-run write path, and cuts an adapter lacking the capability", () => {
    const capable = new MockRuntimeAdapter({ id: "zcode", models: ["sonnet"] });
    for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]) {
      const route = resolveRuntimeRoute({
        role: stage,
        stage,
        projectRoot: project(),
        registry: new RuntimeRegistry([capable]),
        config: null,
        flags: { runtime: "zcode" },
        availability: { zcode: { available: true } },
        hasTargetWrite: true,
      });
      expect(route.error).toBeUndefined();
      expect(route.selected?.runtime.id).toBe("zcode");
    }

    const incapable = new MockRuntimeAdapter({
      id: "zcode",
      models: ["sonnet"],
      capabilities: ALL_MOCK_CAPABILITIES.filter((capability) => capability !== RuntimeCapability.POST_RUN_WRITE_GUARD),
    });
    const refused = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: project(),
      registry: new RuntimeRegistry([incapable]),
      config: null,
      flags: { runtime: "zcode" },
      availability: { zcode: { available: true } },
      hasTargetWrite: true,
    });
    expect(refused.selected).toBeUndefined();
    expect(refused.error).toContain("post-run-write-guard");
  });

  it("routes Antigravity engineer stages on its post-run write path, and cuts an adapter lacking the capability", () => {
    const capable = new MockRuntimeAdapter({ id: "antigravity", models: ["gemini-2.5-pro"] });
    for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]) {
      const route = resolveRuntimeRoute({
        role: stage,
        stage,
        projectRoot: project(),
        registry: new RuntimeRegistry([capable]),
        config: null,
        flags: { runtime: "antigravity" },
        availability: { antigravity: { available: true } },
        hasTargetWrite: true,
      });
      expect(route.error).toBeUndefined();
      expect(route.selected?.runtime.id).toBe("antigravity");
    }

    const incapable = new MockRuntimeAdapter({
      id: "antigravity",
      models: ["gemini-2.5-pro"],
      capabilities: ALL_MOCK_CAPABILITIES.filter((capability) => capability !== RuntimeCapability.POST_RUN_WRITE_GUARD),
    });
    const refused = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: project(),
      registry: new RuntimeRegistry([incapable]),
      config: null,
      flags: { runtime: "antigravity" },
      availability: { antigravity: { available: true } },
      hasTargetWrite: true,
    });
    expect(refused.selected).toBeUndefined();
    expect(refused.error).toContain("post-run-write-guard");
  });

  it("refuses an unavailable executor, and an order walk skips it as infrastructure", () => {
    const single = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: project(),
      registry: new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] })]),
      config: null,
      flags: { runtime: "claude-code" },
      availability: { "claude-code": { available: false, reason: "binary not found" } },
      hasTargetWrite: true,
    });
    // The executor classifies a sole unavailable candidate as UNAVAILABLE with the probe's reason.
    expect(single.diagnostics.join(" ")).toContain('runtime "claude-code" is unavailable: binary not found');

    const walked = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: project(),
      registry: new RuntimeRegistry([new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] }), new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] })]),
      config: { schema_version: 1, routing: { order: ["claude-code", "codex"] } },
      availability: { "claude-code": { available: false, reason: "binary not found" }, "codex": { available: true } },
      // An analysis route: the only certified governed-write executor is the unavailable one.
      hasTargetWrite: false,
      modelPolicy: null,
    });
    expect(walked.selected?.runtime.id).toBe("codex");
    expect(walked.attempts[0]).toMatchObject({ runtimeId: "claude-code", unavailable: true });
  });

  it("every production executor implements the port and declares the lifecycle; only certified ones take governed writes", () => {
    const registry = createProductionRuntimeRegistry(project());
    expect(registry.ids().sort()).toEqual([...RUNTIME_IDS].sort());
    for (const runtime of registry.list()) {
      expect(governedExecutorGap(runtime), runtime.id).toBeNull();
      for (const capability of EXECUTOR_LIFECYCLE_CAPABILITIES) expect(runtime.capabilities.has(capability), runtime.id).toBe(true);
    }
    // V13 TASK-031 added Claude Code (whole-process Codex sandbox + OS network lock, Windows).
    expect(RUNTIME_IDS.filter(isUnattendedTargetWriteCertified)).toEqual(["claude-code"]);
  });
});

describe("TASK-016 — the executor gate and the per-attempt version pin", () => {
  it.each([true, false])("dispatches Codex Target writes only when the result confirms the post-run guard: %s", async (confirmed) => {
    const root = project();
    const runtime = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"], respond: () => okResult({ guards: { enforced: confirmed ? [RuntimeCapability.POST_RUN_WRITE_GUARD] : [], unenforced: [RuntimeCapability.PRE_TOOL_GUARD] } }) });
    const result = await createRuntimeExecutor({
      runtime, projectRoot: root, moduleName: () => "sales-crm", guards: () => ({ ...NO_GUARDS, writeAllow: ["src/**"] }),
      registry: new RuntimeRegistry([runtime]), packetBaseRevision: async () => FIXTURE_REVISION,
      runtimeTask: (taskId, stage) => runtimeTaskFixture(root, { taskId, stage, allow: ["src/**"], moduleName: "sales-crm" }),
      frozenAttempt: frozen({ requested: { runtime: "codex", model: "sonnet", effort: "high" }, observed: { runtime: "codex", model: "sonnet", effort: "high" }, guard_evidence: { target_write: true, pre_tool_guard: false, writable_roots: [root] } }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe(confirmed ? "PASS" : "FAIL");
    expect(runtime.requests).toHaveLength(1);
    if (confirmed) expect(result.postflightGuard?.ok).toBe(true);
    else expect(result.outcome.failure_reason).toMatch(/did not confirm post-run-write-guard/);
  });

  it.each([true, false])("dispatches ZCode Target writes only when the result confirms the post-run guard: %s", async (confirmed) => {
    const root = project();
    const runtime = new MockRuntimeAdapter({ id: "zcode", models: ["sonnet"], respond: () => okResult({ guards: { enforced: confirmed ? [RuntimeCapability.POST_RUN_WRITE_GUARD] : [], unenforced: [RuntimeCapability.PRE_TOOL_GUARD] } }) });
    const result = await createRuntimeExecutor({
      runtime, projectRoot: root, moduleName: () => "sales-crm", guards: () => ({ ...NO_GUARDS, writeAllow: ["src/**"] }),
      registry: new RuntimeRegistry([runtime]), packetBaseRevision: async () => FIXTURE_REVISION,
      runtimeTask: (taskId, stage) => runtimeTaskFixture(root, { taskId, stage, allow: ["src/**"], moduleName: "sales-crm" }),
      frozenAttempt: frozen({ requested: { runtime: "zcode", model: "sonnet", effort: "high" }, observed: { runtime: "zcode", model: "sonnet", effort: "high" }, guard_evidence: { target_write: true, pre_tool_guard: false, writable_roots: [root] } }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe(confirmed ? "PASS" : "FAIL");
    expect(runtime.requests).toHaveLength(1);
    if (confirmed) expect(result.postflightGuard?.ok).toBe(true);
    else expect(result.outcome.failure_reason).toMatch(/did not confirm post-run-write-guard/);
  });

  it.each([true, false])("dispatches Antigravity Target writes only when the result confirms the post-run guard: %s", async (confirmed) => {
    const root = project();
    const runtime = new MockRuntimeAdapter({ id: "antigravity", models: ["gemini-2.5-pro"], respond: () => okResult({ guards: { enforced: confirmed ? [RuntimeCapability.POST_RUN_WRITE_GUARD] : [], unenforced: [RuntimeCapability.PRE_TOOL_GUARD] } }) });
    const result = await createRuntimeExecutor({
      runtime, projectRoot: root, moduleName: () => "sales-crm", guards: () => ({ ...NO_GUARDS, writeAllow: ["src/**"] }),
      registry: new RuntimeRegistry([runtime]), packetBaseRevision: async () => FIXTURE_REVISION,
      runtimeTask: (taskId, stage) => runtimeTaskFixture(root, { taskId, stage, allow: ["src/**"], moduleName: "sales-crm" }),
      frozenAttempt: frozen({ requested: { runtime: "antigravity", model: "gemini-2.5-pro", effort: "high" }, observed: { runtime: "antigravity", model: "gemini-2.5-pro", effort: "high" }, guard_evidence: { target_write: true, pre_tool_guard: false, writable_roots: [root] } }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe(confirmed ? "PASS" : "FAIL");
    expect(runtime.requests).toHaveLength(1);
    if (confirmed) expect(result.postflightGuard?.ok).toBe(true);
    else expect(result.outcome.failure_reason).toMatch(/did not confirm post-run-write-guard/);
  });

  it("refuses a frozen governed write on a certified runtime that is no governed executor", async () => {
    const root = project();
    const weak = bareRunner("claude-code");
    const result = await createRuntimeExecutor({
      runtime: weak,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([weak]),
      packetBaseRevision: async () => FIXTURE_REVISION,
      runtimeTask: (taskId, stage) => runtimeTaskFixture(root, { taskId, stage, allow: [], moduleName: "sales-crm" }),
      frozenAttempt: frozen({
        requested: { runtime: "claude-code", model: "sonnet", effort: "high" },
        observed: { runtime: "claude-code", model: "sonnet", effort: "high" },
        guard_evidence: { target_write: true, pre_tool_guard: true, writable_roots: ["C:/target"] },
      }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/executor lifecycle capabilities/);
    expect(weak.requests).toHaveLength(0);
  });

  it("refuses to replay a frozen attempt on an executor whose version drifted", async () => {
    const root = project();
    const upgraded = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"], probe: { available: true, version: "2.2.0" }, respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime: upgraded,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([upgraded]),
      packetBaseRevision: async () => FIXTURE_REVISION,
      runtimeTask: (taskId, stage) => runtimeTaskFixture(root, { taskId, stage, allow: [], moduleName: "sales-crm" }),
      frozenAttempt: frozen({ runtime_version: "2.1.0" }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("pinned runtime \"claude-code\" at version 2.1.0");
    expect(result.outcome.failure_reason).toContain("now reports 2.2.0");
    expect(upgraded.requests).toHaveLength(0);
  });

  it("dispatches a frozen attempt on the pinned version and records that version on the run", async () => {
    const root = project();
    const pinned = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"], probe: { available: true, version: "2.1.0" }, respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime: pinned,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([pinned]),
      packetBaseRevision: async () => FIXTURE_REVISION,
      runtimeTask: (taskId, stage) => runtimeTaskFixture(root, { taskId, stage, allow: [], moduleName: "sales-crm" }),
      frozenAttempt: frozen({ runtime_version: "2.1.0" }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.result).toBe("PASS");
    expect(result.outcome.runtime_version).toBe("2.1.0");
    expect(pinned.requests).toHaveLength(1);
  });

  it("records the selected executor's version on an unfrozen routed run", async () => {
    const root = project();
    const runtime = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"], probe: { available: true, version: "9.9.9" }, respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([runtime]),
      packetBaseRevision: async () => FIXTURE_REVISION,
      runtimeTask: (taskId, stage) => runtimeTaskFixture(root, { taskId, stage, allow: [], moduleName: "sales-crm" }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });
    expect(result.outcome.runtime_version).toBe("9.9.9");
  });

  it("replacing the executor between attempts keeps role, stage, contract and packet — only the executor changes", async () => {
    const root = project();
    // Claude Code is the one certified governed-write runtime (owner decision
    // 2026-10-03), so the replacement is a different executor build of it.
    const first = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"], probe: { available: true, version: "2.1.0" }, respond: () => okResult() });
    const second = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"], probe: { available: true, version: "2.2.0" }, respond: () => okResult() });
    const run = (attempt: LedgerAttempt, executor: MockRuntimeAdapter) =>
      createRuntimeExecutor({
        runtime: executor,
        projectRoot: root,
        moduleName: () => "sales-crm",
        guards: () => NO_GUARDS,
        registry: new RuntimeRegistry([executor]),
        packetBaseRevision: async () => FIXTURE_REVISION,
        runtimeTask: (taskId, stage) => runtimeTaskFixture(root, { taskId, stage, allow: [], moduleName: "sales-crm" }),
        frozenAttempt: attempt,
      })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "BE-004", context: [] });

    const attemptOne = frozen({ runtime_version: "2.1.0" });
    const one = await run(attemptOne, first);
    // An explicit reroute: a new, linked attempt on another certified executor.
    const attemptTwo = frozen({
      attempt_id: `${RUN_ID}:BE-004:backend-engineer:2`,
      attempt: 2,
      requested: { runtime: "claude-code", model: "sonnet", effort: "high" },
      observed: { runtime: "claude-code", model: "sonnet", effort: "high" },
      runtime_version: "2.2.0",
      reroute_of: attemptOne.attempt_id,
    });
    const two = await run(attemptTwo, second);

    expect(one.outcome.result).toBe("PASS");
    expect(two.outcome.result).toBe("PASS");
    expect(one.outcome.runtime).toBe("claude-code");
    expect(two.outcome.runtime).toBe("claude-code");
    expect([one.outcome.runtime_version, two.outcome.runtime_version]).toEqual(["2.1.0", "2.2.0"]);
    const [a] = first.requests;
    const [b] = second.requests;
    // Role, task/stage binding, contract and the packet body are the attempt's,
    // not the executor's — replacing the executor changed none of them.
    expect(b!.role).toBe(a!.role);
    expect(b!.taskId).toBe(a!.taskId);
    expect(b!.stage).toBe(a!.stage);
    expect(b!.prompt.replace(/:2\b/g, ":1").replace(/attempt 2\b/g, "attempt 1")).toBe(a!.prompt);
    expect(b!.guards).toEqual(a!.guards);
    expect(two.outcome.contract_digest).toBe(one.outcome.contract_digest);
    // Each executor minted its own attempt identity for its own dispatch.
    expect(two.outcome.attempt_id).not.toBe(one.outcome.attempt_id);
  });
});
