import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { createRuntimeExecutor } from "./runtimeExecutor.js";
import { MockRuntimeAdapter, okResult } from "./mockAdapter.js";
import type { RuntimeGuards } from "./runtimeAdapter.js";
import { runtimeTaskFixture, FIXTURE_REVISION } from "./packetFixture.testSupport.js";
import { declareInstallationConfigOverrideChannelForTest } from "../threeRepo/installation.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";
import { seedRealContracts } from "../testing/contractFixtures.js";
import { testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import type { EvidenceRecord } from "../evidence/evidenceStore.js";

/**
 * V13 TASK-017 — the mandatory postflight, at the dispatch boundary: STA
 * grades the executor port's changed-files evidence against the enforced
 * scope before an OK result is accepted, and a missing check blocks. The
 * mock adapter snapshots its own workspace around the run, exactly like the
 * real adapters do, so these tests exercise the whole evidence path.
 */

declareInstallationConfigOverrideChannelForTest();

const SCOPE: RuntimeGuards = {
  writeAllow: ["src/**"],
  writeDeny: [],
  forbidCommands: ["git"],
  exitChecks: [],
};

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "postflight-exec-"));
  seedRealContracts(projectRoot);
  process.env.STA_INSTALLATION_CONFIG = path.join(os.tmpdir(), "sta-postflight-test-no-installation.yaml");
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3 });
  delete process.env.STA_INSTALLATION_CONFIG;
});

const req = { stage: AgentStage.BACKEND_ENGINEER, taskId: "T-POSTFLIGHT", context: [] };

function executorFor(runtime: MockRuntimeAdapter, over: Record<string, unknown> = {}) {
  return createRuntimeExecutor({
    runtime,
    projectRoot,
    moduleName: () => "sales-crm",
    guards: () => SCOPE,
    ...over,
  });
}

/** An adapter whose run writes `file` into its own (snapshot) workspace before reporting OK. */
function writingRuntime(file: string, content = "export {}"): MockRuntimeAdapter {
  let adapter: MockRuntimeAdapter;
  adapter = new MockRuntimeAdapter({
    respond: async () => {
      await adapter.workspace.writeFile(file, content);
      return okResult();
    },
  });
  return adapter;
}

describe("runtimeExecutor postflight scope check (V13 TASK-017)", () => {
  it("accepts a run whose changed files are inside the enforced scope", async () => {
    const result = await executorFor(writingRuntime("src/orders.ts"))(req);
    expect(result.outcome.result).toBe("PASS");
    expect(result.postflightGuard).toMatchObject({ ok: true, checked: 1 });
    expect(result.postflightGuard?.violations).toEqual([]);
  });

  it("refuses a run that changed a file outside its scope, despite the runtime reporting OK", async () => {
    const runtime = writingRuntime("_docs/module/sales-crm/requirement.md", "forged");
    const result = await executorFor(runtime)(req);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("postflight");
    expect(result.outcome.failure_reason).toContain("not covered by this role's write paths");
    expect(result.postflightGuard).toMatchObject({ ok: false, checked: 1 });
  });

  it("refuses an OK whose changed files are unknown because the executor could not snapshot", async () => {
    const runtime = new MockRuntimeAdapter({});
    // The honest unavailable-snapshot shape: evidence exists, changedFiles does not.
    runtime.collectEvidence = async (ref) => ({
      attemptId: ref.attemptId,
      runtimeId: runtime.id,
      result: null,
      logs: [],
      collectedAt: 0,
    });
    const result = await executorFor(runtime)(req);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("required postflight check missing");
    expect(result.postflightGuard).toMatchObject({ ok: false, checked: 0 });
  });

  it("refuses an OK when the executor provides no changed-files evidence at all", async () => {
    const runtime = new MockRuntimeAdapter({ capabilities: [] });
    const result = await executorFor(runtime)(req);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("required postflight check missing");
    expect(result.outcome.failure_reason).toContain("EVIDENCE_COLLECTION");
  });

  it("persists the postflight verdict as scope-postflight evidence of the attempt", async () => {
    const orchestrator = new Orchestrator("T-POSTFLIGHT-EVIDENCE", classifyTask({ isTypoOrCopyOnly: true, touchesBackend: true }), {
      humanDecisionVerifier: testHumanVerifier(),
      stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD,
    });
    await orchestrator.step(executorFor(writingRuntime("src/orders.ts")));
    const records: EvidenceRecord[] = orchestrator.evidence();
    const postflight = records.filter((record) => record.payload.kind === "scope-postflight");
    expect(postflight).toHaveLength(1);
    expect(postflight[0]).toMatchObject({
      stage: AgentStage.BACKEND_ENGINEER,
      role: "orchestrator",
      kind: "scope-postflight",
    });
    expect(postflight[0].payload).toMatchObject({ ok: true, checked: 1 });
    // The verdict is bound to the role-run of the same attempt.
    expect(postflight[0].refs).toHaveLength(1);
    const roleRun = records.find((record) => record.evidenceId === postflight[0].refs[0]);
    expect(roleRun?.payload.kind).toBe("role-run");
  });

  it("binds the postflight verdict to the dispatch contract digest", async () => {
    const result = await executorFor(writingRuntime("src/orders.ts"))(req);
    expect(result.outcome.contract_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.postflightGuard?.contractDigest).toBe(result.outcome.contract_digest);
  });

  it("does not grade a stage whose guard scope grants no writes (explicit NO_GUARDS callers)", async () => {
    const runtime = new MockRuntimeAdapter({});
    const result = await executorFor(runtime, {
      guards: () => ({ writeAllow: [], writeDeny: [], forbidCommands: [], exitChecks: [] }),
    })(req);
    expect(result.outcome.result).toBe("PASS");
    expect(result.postflightGuard).toBeUndefined();
  });

  it("grades a governed v2 task against the packet-narrowed scope end to end", async () => {
    const runtimeTask = runtimeTaskFixture(projectRoot, { taskId: "T-POSTFLIGHT", allow: ["src/**"] });
    const result = await executorFor(writingRuntime("src/orders.ts"), {
      runtimeTask: () => runtimeTask,
      runtimeStateRoot: projectRoot,
      packetBaseRevision: async () => FIXTURE_REVISION,
    })(req);
    expect(result.outcome.result).toBe("PASS");
    expect(result.postflightGuard?.ok).toBe(true);
  });

  it("refuses a governed v2 task whose run edits outside the packet scope", async () => {
    const runtimeTask = runtimeTaskFixture(projectRoot, { taskId: "T-POSTFLIGHT", allow: ["server/**"] });
    const result = await executorFor(writingRuntime("src/orders.ts"), {
      runtimeTask: () => runtimeTask,
      runtimeStateRoot: projectRoot,
      packetBaseRevision: async () => FIXTURE_REVISION,
      guards: () => ({ ...SCOPE, writeAllow: ["server/**"] }),
    })(req);
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("postflight");
    expect(result.outcome.failure_reason).toContain("not covered by this role's write paths");
  });
});
