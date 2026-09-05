import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStage } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { RunLog } from "../observability/runLog.js";
import { createRuntimeExecutor } from "./runtimeExecutor.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { MockRuntimeAdapter, okResult } from "./mockAdapter.js";
import { NO_GUARDS, type RuntimeRunStatus } from "./runtimeAdapter.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { resolveRuntimeRoute } from "./runtimeRouting.js";
import * as contextBudget from "../context/contextBudget.js";

const roots: string[] = [];
function project(config?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "execution-modes-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "agents", "backend-engineer.md"), "---\nmodel: sonnet\nversion: 1\n---\nrole", "utf8");
  if (config) {
    fs.mkdirSync(path.join(root, ".sta"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sta", "config.yaml"), config, "utf8");
  }
  return root;
}
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function targetTask(root: string) {
  return {
    task: { taskId: "T-MATRIX" } as never,
    roots: {
      bindingRoot: root,
      knowledgeRoot: path.join(root, "knowledge"),
      workRoots: [{ targetId: "target", path: path.join(root, "target"), access: "write" as const }],
    },
  };
}

/**
 * T-V5-040 replaces T-V3R-040's three-mode matrix. Execution modes, the handoff
 * candidate chain and the legacy `model_routing` spelling are removed, so the
 * matrix is now the three surviving route sources — flag (precedence 1),
 * `routing.by_role` (2), default runtime plus frontmatter model (4) — and the
 * property that every route resolves exactly one runtime.
 */
describe("T-V5-040 one-route matrix", () => {
  it("absent config resolves the default route on claude-code", async () => {
    const root = project();
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] });
    const result = await createRuntimeExecutor({
      runtime: claude,
      registry: new RuntimeRegistry([claude, codex]),
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });
    expect(result.outcome).toMatchObject({
      result: "PASS",
      runtime: "claude-code",
      requested_runtime: "claude-code",
      routing_basis: "level-4",
      fallback_count: 0,
    });
    expect(claude.requests).toHaveLength(1);
    expect(codex.requests).toHaveLength(0);
  });

  it("an unavailable route stops with requiresHuman and never reaches another runtime", async () => {
    const root = project();
    const claude = new MockRuntimeAdapter({ id: "claude-code", probe: { available: false, reason: "single missing" } });
    const codex = new MockRuntimeAdapter({ id: "codex" });
    const result = await createRuntimeExecutor({
      runtime: claude,
      registry: new RuntimeRegistry([claude, codex]),
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });
    expect(result.outcome).toMatchObject({ result: "FAIL", fallback_count: 0 });
    expect(result.failure).toMatchObject({ requiresHuman: true, retryable: false });
    expect(result.outcome.failure_reason).toMatch(/single missing/i);
    expect(claude.requests).toHaveLength(0);
    expect(codex.requests).toHaveLength(0);
  });

  it("an unavailable route blocks the orchestrator without advancing or consuming a retry", async () => {
    const root = project();
    const claude = new MockRuntimeAdapter({ id: "claude-code", probe: { available: false, reason: "single missing" } });
    const executor = createRuntimeExecutor({
      runtime: claude,
      registry: new RuntimeRegistry([claude]),
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    });
    const orch = new Orchestrator("T-SINGLE-STOP", classifyTask({ isClearBugFix: true, touchesBackend: true }));
    const assigned = orch.status();
    expect(assigned).toMatchObject({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
    const stopped = await orch.step(executor);
    expect(stopped.kind).toBe("BLOCKED");
    expect(orch.retries).toEqual({ qa: 0, security: 0 });
    expect(orch.recovery?.kind).toBe("ESCALATE");
    expect(claude.requests).toHaveLength(0);
  });

  it("routing.by_role resolves exactly one candidate, at precedence 2", () => {
    const root = project();
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["gpt-5"] });
    const registry = new RuntimeRegistry([claude, codex]);
    const exact = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: root,
      registry,
      config: { schema_version: 1, routing: { by_role: { "backend-engineer": { runtime: "codex", model: "gpt-5" } } } },
    });
    expect(exact.precedenceLevel).toBe(2);
    expect(exact.candidates.map((candidate) => [candidate.runtime.id, candidate.model])).toEqual([["codex", "gpt-5"]]);

    // A per-role entry naming only a runtime keeps the role's frontmatter model
    // instead of refusing: strict Manual mode, which required both to be named,
    // is gone with the modes.
    const runtimeOnly = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: root,
      registry,
      config: { schema_version: 1, routing: { by_role: { "backend-engineer": { runtime: "codex" } } } },
    });
    expect(runtimeOnly.error).toBeUndefined();
    expect(runtimeOnly.candidates.map((candidate) => [candidate.runtime.id, candidate.model])).toEqual([["codex", "sonnet"]]);
  });

  it("an unregistered routing.by_role runtime fails closed instead of substituting the default", () => {
    const root = project();
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const route = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: root,
      registry: new RuntimeRegistry([claude]),
      config: { schema_version: 1, routing: { by_role: { "backend-engineer": "ghost-runtime:some-model" } } },
    });
    expect(route.selected).toBeUndefined();
    expect(route.error).toBeTruthy();
    expect(route.candidates).toEqual([]);
    expect(route.diagnostics.join(" | ")).toContain('runtime "ghost-runtime" is not registered');
  });

  it("routing.by_role executes only the runner and model it names", async () => {
    const root = project(
      "schema_version: 1\nrouting:\n  by_role:\n    backend-engineer:\n      runtime: codex\n      model: gpt-5\n",
    );
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["gpt-5"] });
    const result = await createRuntimeExecutor({
      runtime: claude,
      registry: new RuntimeRegistry([claude, codex]),
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });

    expect(result.outcome).toMatchObject({
      result: "PASS",
      requested_runtime: "codex",
      runtime: "codex",
      routing_basis: "level-2",
      fallback_count: 0,
    });
    expect(claude.requests).toHaveLength(0);
    expect(codex.requests).toHaveLength(1);
    expect(codex.requests[0]?.model).toBe("gpt-5");
  });

  it("an explicit --runtime flag outranks routing.by_role", async () => {
    const root = project(
      "schema_version: 1\nrouting:\n  by_role:\n    backend-engineer:\n      runtime: codex\n      model: gpt-5\n",
    );
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["gpt-5"] });
    const result = await createRuntimeExecutor({
      runtime: claude,
      registry: new RuntimeRegistry([claude, codex]),
      routingFlags: { runtime: "claude-code" },
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });

    expect(result.outcome).toMatchObject({ result: "PASS", runtime: "claude-code", routing_basis: "level-1" });
    expect(codex.requests).toHaveLength(0);
    expect(claude.requests).toHaveLength(1);
  });
});

describe("T-V5-040 fail-closed evidence matrix", () => {
  // What used to be `execution.mode: auto` plus `routing.order`. Both keys are
  // now inert and must still load; the assertions below are that they change
  // nothing about where the run goes.
  const inertAutoConfig =
    "schema_version: 1\nexecution:\n  mode: auto\n  allow_handoff: true\n  allow_paid_fallback: false\nrouting:\n  order: [claude-code, codex, opencode]\n  allow_below_supported: [codex, opencode]\n";

  it("a UNAVAILABLE result on a Target-write stage stops the task with no second runtime tried", async () => {
    const root = project(inertAutoConfig);
    const unavailable = new MockRuntimeAdapter({
      id: "claude-code",
      models: ["sonnet"],
      capabilities: [RuntimeCapability.PRE_TOOL_GUARD, RuntimeCapability.MODEL_SELECTION],
      respond: () => okResult({ status: "UNAVAILABLE", exitCode: null, diagnostics: ["subscription offline"] }),
    });
    const weak = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"], capabilities: [RuntimeCapability.MODEL_SELECTION] });
    const good = new MockRuntimeAdapter({
      id: "opencode",
      models: ["sonnet"],
      capabilities: [RuntimeCapability.PRE_TOOL_GUARD, RuntimeCapability.MODEL_SELECTION],
      respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }),
    });
    const result = await createRuntimeExecutor({
      runtime: unavailable,
      registry: new RuntimeRegistry([unavailable, weak, good]),
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
      threeRepoTask: () => targetTask(root),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });

    expect(result.outcome).toMatchObject({
      result: "FAIL",
      requested_runtime: "claude-code",
      runtime: "claude-code",
      fallback_count: 0,
    });
    expect(result.outcome.failure_reason).toContain("subscription offline");
    expect(result.failure?.requiresHuman).toBe(true);
    expect(unavailable.requests).toHaveLength(1);
    expect(weak.requests).toHaveLength(0);
    expect(good.requests).toHaveLength(0);

    // INV-6 log-scan assertion, kept: a row whose actual runtime differs from
    // the requested one must carry a reason and a positive hop count. With one
    // route the two are always equal, which the scan below now also proves.
    const log = new RunLog();
    log.record({
      task_id: "T-MATRIX",
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: 0,
      end_time: 1,
      outcome: result.outcome,
    });
    for (const row of log.runsForTask("T-MATRIX")) {
      expect(row.runtime).toBe(row.requested_runtime);
      if (row.runtime !== row.requested_runtime) {
        expect(row.fallback_reason).toBeTruthy();
        expect(row.fallback_count).toBeGreaterThan(0);
      }
    }
  });

  it("an inert allow_handoff: true still produces zero hops", async () => {
    const root = project(inertAutoConfig);
    const first = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ status: "UNAVAILABLE", diagnostics: ["offline"] }) });
    const second = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] });
    const result = await createRuntimeExecutor({
      runtime: first,
      registry: new RuntimeRegistry([first, second]),
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });
    expect(result.outcome).toMatchObject({ result: "FAIL", fallback_count: 0 });
    expect(result.outcome.fallback_reason).toBeUndefined();
    expect(result.failure?.requiresHuman).toBe(true);
    expect(second.requests).toHaveLength(0);
  });

  it.each(["ERROR", "TIMEOUT"] as const)("never falls back on %s", async (status: RuntimeRunStatus) => {
    const root = project(inertAutoConfig);
    const first = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ status, exitCode: 1, diagnostics: [status] }) });
    const second = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] });
    const result = await createRuntimeExecutor({
      runtime: first,
      registry: new RuntimeRegistry([first, second]),
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });
    expect(result.outcome).toMatchObject({ result: "FAIL", fallback_count: 0 });
    expect(second.requests).toHaveLength(0);
  });

  // T-V5-039 / T-V5-040 — there is no paid path and no candidate chain to name
  // any more: an unavailable runner stops the task for a person, full stop.
  it("all local runners unavailable stops with no further candidate to try", async () => {
    const root = project(inertAutoConfig);
    const adapters = ["claude-code", "codex", "opencode"].map((id) => new MockRuntimeAdapter({
      id,
      models: ["sonnet"],
      probe: { available: false, reason: `${id} offline` },
    }));
    const result = await createRuntimeExecutor({
      runtime: adapters[0]!,
      registry: new RuntimeRegistry(adapters),
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/offline/i);
    expect(result.failure?.requiresHuman).toBe(true);
    expect(adapters.every((adapter) => adapter.requests.length === 0)).toBe(true);
  });

  it("T-V4-COST-005 a budget-inadmissible route fails closed instead of moving to another runtime", async () => {
    const root = project(`${inertAutoConfig}context_budget:\n  mode: reject\n`);
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] });
    const resolver = vi.spyOn(contextBudget, "resolveContextBudgetFromProject")
      .mockReturnValue({ chars: 1, source: "role" });
    try {
      const result = await createRuntimeExecutor({
        runtime: claude,
        registry: new RuntimeRegistry([claude, codex]),
        projectRoot: root,
        moduleName: () => "phase-4",
        guards: () => NO_GUARDS,
        sliceModuleDocs: false,
      })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-BUDGET-CLOSED", context: [] });
      expect(result.outcome).toMatchObject({ result: "FAIL", runtime: "claude-code", fallback_count: 0 });
      expect(result.outcome.failure_reason).toContain("context_chars budget rejected");
      expect(claude.requests).toEqual([]);
      expect(codex.requests).toEqual([]);
    } finally {
      resolver.mockRestore();
    }
  });

  it("T-V4-COST-005 records the budget-inadmissible candidate as a structured rejection and fails closed", async () => {
    const root = project(`${inertAutoConfig}context_budget:\n  mode: reject\n  roles:\n    backend-engineer: 1\n`);
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] });
    const result = await createRuntimeExecutor({
      runtime: claude,
      registry: new RuntimeRegistry([claude, codex]),
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-BUDGET-SKIP", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("context_chars budget rejected");
    expect(result.outcome.failure_reason).toContain("claude-code");
    expect(claude.requests).toEqual([]);
    expect(codex.requests).toEqual([]);
  });

  // T-V5-039 / T-V5-040 — `execution.allow_paid_fallback` is inert now that the
  // paid runtime is never registered, and so is `routing.order`: an extra
  // runtime present in the registry but absent from the route is never
  // auto-appended as a candidate, regardless of either key's value. This is the
  // removal of both the paid-only special case and the whole candidate chain.
  it.each([false, true])("an unlisted registered runtime is never auto-appended to the fallback chain (allow_paid_fallback=%s)", async (allowPaidFallback) => {
    const root = project(
      `${inertAutoConfig.replace("allow_paid_fallback: false", `allow_paid_fallback: ${allowPaidFallback}`)}context_budget:\n  mode: reject\n  roles:\n    backend-engineer: 1\n`,
    );
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] });
    const extra = new MockRuntimeAdapter({ id: "extra-runtime", models: ["sonnet"] });
    const result = await createRuntimeExecutor({
      runtime: claude,
      registry: new RuntimeRegistry([claude, codex, extra]),
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-PAID-BUDGET", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.fallback_count).toBe(0);
    expect(claude.requests).toEqual([]);
    expect(codex.requests).toEqual([]);
    expect(extra.requests).toEqual([]);
    expect(result.outcome.fallback_reason).toBeUndefined();
  });
});
