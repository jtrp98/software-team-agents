import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("T-V3R-040 execution-mode matrix", () => {
  it("absent config resolves Single on claude-code", async () => {
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
    expect(result.outcome).toMatchObject({ result: "PASS", runtime: "claude-code", requested_runtime: "claude-code", fallback_count: 0 });
    expect(claude.requests).toHaveLength(1);
    expect(codex.requests).toHaveLength(0);
  });

  it("Single unavailable stops with requiresHuman and consumes no handoff", async () => {
    const root = project();
    const claude = new MockRuntimeAdapter({ id: "claude-code", probe: { available: false, reason: "single missing" } });
    const codex = new MockRuntimeAdapter({ id: "codex" });
    const result = await createRuntimeExecutor({
      runtime: claude,
      registry: new RuntimeRegistry([claude, codex]),
      routingMode: "single",
      allowHandoff: true,
      allowPaidFallback: false,
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });
    expect(result.outcome).toMatchObject({ result: "FAIL", fallback_count: 0 });
    expect(result.failure).toMatchObject({ requiresHuman: true, retryable: false });
    expect(result.outcome.failure_reason).toMatch(/paid API fallback is disabled/i);
    expect(claude.requests).toHaveLength(0);
    expect(codex.requests).toHaveLength(0);
  });

  it("Single UNAVAILABLE blocks the orchestrator without advancing or consuming a retry", async () => {
    const root = project();
    const claude = new MockRuntimeAdapter({ id: "claude-code", probe: { available: false, reason: "single missing" } });
    const executor = createRuntimeExecutor({
      runtime: claude,
      registry: new RuntimeRegistry([claude]),
      routingMode: "single",
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

  it("Manual requires both runner and model to be explicitly named", () => {
    const root = project();
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["gpt-5"] });
    const registry = new RuntimeRegistry([claude, codex]);
    const missingModel = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: root,
      registry,
      mode: "manual",
      config: { schema_version: 1, routing: { by_role: { "backend-engineer": { runtime: "codex" } } } },
    });
    expect(missingModel.error).toContain("explicitly named runner and model");
    expect(missingModel.selected).toBeUndefined();

    const exact = resolveRuntimeRoute({
      role: "backend-engineer",
      stage: AgentStage.BACKEND_ENGINEER,
      projectRoot: root,
      registry,
      mode: "manual",
      config: { schema_version: 1, routing: { by_role: { "backend-engineer": { runtime: "codex", model: "gpt-5" } } } },
    });
    expect(exact.candidates.map((candidate) => [candidate.runtime.id, candidate.model])).toEqual([["codex", "gpt-5"]]);
  });

  it("Manual executes only the runner and model the user named", async () => {
    const root = project(
      "schema_version: 1\nexecution:\n  mode: manual\nrouting:\n  by_role:\n    backend-engineer:\n      runtime: codex\n      model: gpt-5\n",
    );
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["gpt-5"] });
    const result = await createRuntimeExecutor({
      runtime: claude,
      registry: new RuntimeRegistry([claude, codex]),
      routingMode: "manual",
      allowHandoff: true,
      allowPaidFallback: false,
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });

    expect(result.outcome).toMatchObject({
      result: "PASS",
      requested_runtime: "codex",
      runtime: "codex",
      fallback_count: 0,
    });
    expect(claude.requests).toHaveLength(0);
    expect(codex.requests).toHaveLength(1);
    expect(codex.requests[0]?.model).toBe("gpt-5");
  });
});

describe("T-V3R-041 fallback evidence matrix", () => {
  const autoConfig =
    "schema_version: 1\nexecution:\n  mode: auto\n  allow_handoff: true\n  allow_paid_fallback: false\nrouting:\n  order: [claude-code, codex, opencode]\n  allow_below_supported: [codex, opencode]\n";

  it("records a multi-hop UNAVAILABLE plus capability skip before executing the eligible runtime", async () => {
    const root = project(autoConfig);
    const unavailable = new MockRuntimeAdapter({
      id: "claude-code",
      models: ["sonnet"],
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
      routingMode: "auto",
      allowHandoff: true,
      allowPaidFallback: false,
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
      threeRepoTask: () => targetTask(root),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });

    expect(result.outcome).toMatchObject({
      result: "PASS",
      requested_runtime: "claude-code",
      runtime: "opencode",
      fallback_count: 2,
    });
    expect(result.outcome.fallback_reason).toContain("subscription offline");
    expect(result.outcome.fallback_reason).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(unavailable.requests).toHaveLength(1);
    expect(weak.requests).toHaveLength(0);
    expect(good.requests).toHaveLength(1);

    // INV-6 log-scan assertion: persist the completed run through the real
    // observability seam, then reject any requested/actual change whose row
    // lacks a reason or positive hop count.
    const log = new RunLog();
    log.record({
      task_id: "T-MATRIX",
      agent: AgentStage.BACKEND_ENGINEER,
      start_time: 0,
      end_time: 1,
      outcome: result.outcome,
    });
    for (const row of log.runsForTask("T-MATRIX")) {
      if (row.runtime !== row.requested_runtime) {
        expect(row.fallback_reason).toBeTruthy();
        expect(row.fallback_count).toBeGreaterThan(0);
      }
    }
  });

  it("allow_handoff false produces zero hops", async () => {
    const root = project(autoConfig.replace("allow_handoff: true", "allow_handoff: false"));
    const first = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ status: "UNAVAILABLE", diagnostics: ["offline"] }) });
    const second = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] });
    const result = await createRuntimeExecutor({
      runtime: first,
      registry: new RuntimeRegistry([first, second]),
      routingMode: "auto",
      allowHandoff: false,
      allowPaidFallback: false,
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });
    expect(result.outcome).toMatchObject({ result: "FAIL", fallback_count: 0 });
    expect(result.failure?.requiresHuman).toBe(true);
    expect(second.requests).toHaveLength(0);
  });

  it.each(["ERROR", "TIMEOUT"] as const)("never falls back on %s", async (status: RuntimeRunStatus) => {
    const root = project(autoConfig);
    const first = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ status, exitCode: 1, diagnostics: [status] }) });
    const second = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] });
    const result = await createRuntimeExecutor({
      runtime: first,
      registry: new RuntimeRegistry([first, second]),
      routingMode: "auto",
      allowHandoff: true,
      allowPaidFallback: false,
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });
    expect(result.outcome).toMatchObject({ result: "FAIL", fallback_count: 0 });
    expect(second.requests).toHaveLength(0);
  });

  it("all local runners unavailable stops and names the disabled paid path", async () => {
    const root = project(autoConfig);
    const adapters = ["claude-code", "codex", "opencode"].map((id) => new MockRuntimeAdapter({
      id,
      models: ["sonnet"],
      probe: { available: false, reason: `${id} offline` },
    }));
    const result = await createRuntimeExecutor({
      runtime: adapters[0]!,
      registry: new RuntimeRegistry(adapters),
      routingMode: "auto",
      allowHandoff: true,
      allowPaidFallback: false,
      projectRoot: root,
      moduleName: () => "phase-4",
      guards: () => NO_GUARDS,
      sliceModuleDocs: false,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-MATRIX", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/paid API fallback is disabled/i);
    expect(result.failure?.requiresHuman).toBe(true);
    expect(adapters.every((adapter) => adapter.requests.length === 0)).toBe(true);
  });
});
