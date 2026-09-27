import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const EOL = "\n";
import { classifyTask } from "../classification/taskClassifier.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { Orchestrator, type AgentExecutorRequest } from "../orchestrator/orchestrator.js";
import { AgentStage } from "../types.js";
import { createPostDevVerificationHook } from "./verificationHook.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";

function required(
  levels: string[],
): { status: "selected"; levels: string[]; reason: string; enforcement: "enforce" } {
  // V13 TASK-017 — there is no warn posture left; selections are enforced.
  return { status: "selected", levels, reason: "fixture", enforcement: "enforce" };
}

function req(stage: AgentStage): AgentExecutorRequest {
  return { stage, taskId: "T-HOOK", context: [] };
}

describe("post-Dev deterministic verification hook", () => {
  it("runs only RuntimeTask-selected checks after a code-producing stage", async () => {
    const calls: string[] = [];
    const hook = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 5, cost: 0.1, result: "PASS" } }),
      deterministicRunner: () => (id) => {
        calls.push(id);
        return { id, status: "PASS", durationMs: 1, outputSummary: "ok" };
      },
      requiredVerification: () => required(["lint", "typecheck", "unit", "build"]),
    });

    const result = await hook.executor(req(AgentStage.BACKEND_ENGINEER));
    expect(calls).toEqual(["lint", "typecheck", "unit-tests", "build"]);
    expect(result.outcome).toMatchObject({ result: "PASS", deterministic_gate: "enabled" });
    expect(result.deterministicVerification?.selection).toBeUndefined();
  });

  it("records the post-Dev selection and reason on deterministic run evidence", async () => {
    const hook = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 5, cost: 0.1, result: "PASS" } }),
      deterministicRunner: () => (id) => ({ id, status: "PASS", durationMs: 1, outputSummary: "ok" }),
      requiredVerification: () => ({
        status: "full-order",
        levels: ["lint", "typecheck", "unit", "integration", "build"],
        reason: "no build-time task type",
        enforcement: "enforce",
        task_types: [],
        selection_source: "full-order",
      }),
      changeAware: {
        changedFiles: () => ["src/routes/orders.route.ts"],
        projectRoot: defaultProjectRoot(),
        workflow: "bugfix",
        classification: { sensitiveGate: false },
      },
    });

    const ran = await hook.executor(req(AgentStage.BACKEND_ENGINEER));
    expect(ran.deterministicVerification?.selection).toMatchObject({
      source: "change-scope",
      taskTypes: ["api-endpoint"],
      levels: ["lint", "typecheck", "unit", "api", "build"],
      reason: expect.stringContaining("bounded post-implementation change scope"),
    });
  });

  it("fails closed to full order and records why when change discovery throws", async () => {
    const calls: string[] = [];
    const hook = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 5, cost: 0.1, result: "PASS" } }),
      deterministicRunner: () => (id) => {
        calls.push(id);
        return { id, status: "PASS", durationMs: 1, outputSummary: "ok" };
      },
      requiredVerification: () => required(["lint", "typecheck", "unit", "build"]),
      changeAware: {
        changedFiles: () => {
          throw new Error("git unavailable");
        },
        projectRoot: defaultProjectRoot(),
        workflow: "business-rule",
        classification: { sensitiveGate: false },
      },
    });

    const ran = await hook.executor(req(AgentStage.BACKEND_ENGINEER));
    expect(calls).toEqual(["lint", "typecheck", "unit-tests", "integration-tests", "build"]);
    expect(ran.deterministicVerification?.selection).toMatchObject({
      source: "full-order",
      reason: expect.stringContaining("git unavailable"),
    });
  });

  it("returns a red check to the same Dev stage without a QA/model call", async () => {
    const orchestrator = new Orchestrator(
      "T-TYPO-VERIFY",
      classifyTask({ isTypoOrCopyOnly: true, touchesBackend: true }),
      { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD },
    );
    let modelCalls = 0;
    let qaCalls = 0;
    const hook = createPostDevVerificationHook({
      inner: async (request) => {
        modelCalls += 1;
        if (request.stage === AgentStage.QA_ENGINEER) qaCalls += 1;
        return { outcome: { tokens: 8, cost: 0.2, result: "PASS" } };
      },
      deterministicRunner: () => (id) => id === "typecheck"
        ? { id, status: "FAIL", durationMs: 2, outputSummary: "TS2322" }
        : { id, status: "PASS", durationMs: 1, outputSummary: "ok" },
      requiredVerification: () => ({
        status: "full-order",
        levels: ["lint", "typecheck", "unit", "integration", "build"],
        reason: "unknown type keeps full order",
        enforcement: "enforce",
      }),
    });

    const status = await orchestrator.step(hook.executor);
    expect(status).toEqual({ kind: "RUNNING", stage: AgentStage.BACKEND_ENGINEER });
    expect(modelCalls).toBe(1);
    expect(qaCalls).toBe(0);
    expect(orchestrator.runLog.runsForTask("T-TYPO-VERIFY")[0]).toMatchObject({
      agent: AgentStage.BACKEND_ENGINEER,
      result: "FAIL",
      deterministic_gate: "enabled",
    });
  });

  it("blocks an all-skipped sweep - a required check missing is not a pass (V13 TASK-017)", async () => {
    const hook = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } }),
      deterministicRunner: () => () => null,
      requiredVerification: () => required(["lint", "typecheck"]),
    });
    const result = await hook.executor(req(AgentStage.FRONTEND_ENGINEER));
    expect(result.outcome.result).toBe("FAIL");
    expect(result.deterministicVerification).toMatchObject({
      status: "skipped",
      passed: false,
      enforcement: "enforce",
      missingRequired: ["lint", "typecheck"],
    });
  });

  it("binds the sweep to the change set it graded with a digest (V13 TASK-018)", async () => {
    // A real git fixture: the digest is over the change-set fingerprint the
    // sweep graded, so a later edit to the same files invalidates the record.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "verification-digest-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    try {
      git("init", "-q");
      fs.writeFileSync(path.join(root, "src.ts"), "export {}" + EOL, "utf8");
      git("add", ".");
      git("commit", "-m", "base");
      fs.writeFileSync(path.join(root, "src.ts"), "export const changed = true;" + EOL, "utf8");

      const hook = createPostDevVerificationHook({
        inner: async () => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } }),
        deterministicRunner: () => (id) => ({ id, status: "PASS", durationMs: 1, outputSummary: "ok" }),
        requiredVerification: () => required(["typecheck"]),
        changeAware: {
          changedFiles: () => ["src.ts"],
          projectRoot: defaultProjectRoot(),
          workflow: "bugfix",
          classification: { sensitiveGate: false },
          verificationRoots: [{ path: root }],
        },
      });
      const result = await hook.executor(req(AgentStage.BACKEND_ENGINEER));
      expect(result.outcome.result).toBe("PASS");
      expect(result.deterministicVerification?.changeSetDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("never runs deterministic checks around a non-code stage", async () => {
    let checks = 0;
    const hook = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 1, cost: 0, result: "PASS" } }),
      deterministicRunner: () => () => {
        checks += 1;
        return null;
      },
      requiredVerification: () => required(["lint"]),
    });
    await hook.executor(req(AgentStage.QA_ENGINEER));
    expect(checks).toBe(0);
  });

  it("runs with no disabled fallback: the hook cannot be switched off (V13 TASK-017)", async () => {
    // The module no longer exports a disabled executor; the only post-Dev
    // path is the enforcing hook, and it runs on every code-producing stage.
    const hook = createPostDevVerificationHook({
      inner: async () => ({ outcome: { tokens: 2, cost: 0, result: "PASS" } }),
      deterministicRunner: () => (id) => ({ id, status: "PASS", durationMs: 1, outputSummary: "ok" }),
      requiredVerification: () => required(["lint"]),
    });
    const result = await hook.executor(req(AgentStage.BACKEND_ENGINEER));
    expect(result.outcome).toMatchObject({ result: "PASS", deterministic_gate: "enabled" });
  });
});
