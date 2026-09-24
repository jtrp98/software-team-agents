import { runtimeTaskFixture, FIXTURE_REVISION, fixtureTask } from "./packetFixture.testSupport.js";
import { renderCanonicalTasks } from "../docs/planTask.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentStage, TaskLevel } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { createRuntimeExecutor } from "./runtimeExecutor.js";
import { ALL_MOCK_CAPABILITIES, MockRuntimeAdapter, okResult } from "./mockAdapter.js";
import { NO_GUARDS, type RuntimeGuards } from "./runtimeAdapter.js";
import { GuardResolutionError } from "./runtimeGuards.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { buildContextCommand } from "../context/contextCommand.js";
import { buildPromptParts } from "./agentRunAssembly.js";
import { auditTrail } from "../audit/auditTrail.js";
import type { RuntimeTask } from "../orchestrator/runtimeTask.js";
import { latestExecutionPacketPath, readExecutionPacket } from "../state/runtimeArtifacts.js";
import type { ModelTierPolicy } from "./modelTiers.js";
import { SOURCE_OF_TRUTH_SENTENCE } from "../codeintel/resolver.js";
import { declareInstallationConfigOverrideChannelForTest } from "../threeRepo/installation.js";
import { decidePending, testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import { withStageEvidence } from "../evidence/stageEvidence.testSupport.js";
import { seedRealContracts } from "../testing/contractFixtures.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "../orchestrator/stageGuards.testSupport.js";

const human = { humanDecisionVerifier: testHumanVerifier(), stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD };

declareInstallationConfigOverrideChannelForTest();

// T-V6-006: `env: {}` (used below) now falls through to installation.yaml
// when STA_KNOWLEDGE_ROOT is unset — isolate it from whatever is
// real on the machine running this suite.
const STA_INSTALLATION_CONFIG_ORIGINAL = process.env.STA_INSTALLATION_CONFIG;
beforeEach(() => {
  process.env.STA_INSTALLATION_CONFIG = path.join(os.tmpdir(), "sta-runtime-executor-test-no-installation.yaml");
});
afterEach(() => {
  if (STA_INSTALLATION_CONFIG_ORIGINAL === undefined) delete process.env.STA_INSTALLATION_CONFIG;
  else process.env.STA_INSTALLATION_CONFIG = STA_INSTALLATION_CONFIG_ORIGINAL;
});

/**
 * T108's central claim, under test: the orchestrator can run agents through the
 * `RuntimeAdapter` interface without knowing which runtime is behind it, and
 * with no AI runtime installed at all.
 *
 * Every test here uses `MockRuntimeAdapter`, which spawns no process and keeps
 * its files in a `Map`. Nothing in this file mentions `claude` or `codex` except
 * as an adapter id, which is the point: if the seam leaked, one of these tests
 * would have to know something about a specific runtime to pass.
 */

function tmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-exec-"));
  seedRealContracts(root);
  return root;
}

function writeAgentFile(root: string, role: string, frontmatter: string): void {
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${role}.md`), `---\nname: ${role}\n${frontmatter}\n---\n\nbody\n`, "utf8");
}

function executorFor(runtime: MockRuntimeAdapter, over: Record<string, unknown> = {}) {
  return createRuntimeExecutor({
    runtime,
    projectRoot: tmpProject(),
    moduleName: () => "sales-crm",
    guards: () => NO_GUARDS,
    ...over,
  });
}

// T-V8-014: a passing round has to map at least one id to a verdict under
// `## Per-Task Results`; a status with no per-id verdict reads as FAIL.
const PASSING_QA = [
  "## Round 1 (FULL)",
  "- everything checks out ✅",
  "- 12 passed, 0 failed",
  "",
  "## Per-Task Results",
  "- BE-001 — ✅ Verified: order boundary matches DES-001",
].join("\n");

/** A clean review.md round for `taskId`, in `.claude/agents/reviewer.md`'s format (V13 TASK-006). */
function passingReview(taskId: string): string {
  return [
    "# review.md — sales-crm",
    "",
    "## Open Findings — all phases",
    "| ID | Severity | Location | Owner | Status | Finding |",
    "|---|---|---|---|---|---|",
    "| RV-1 | non-blocking | src/orders.ts:12 | backend-engineer | resolved | naming follows the neighbouring files now |",
    "",
    `## Review Round 1 — ${taskId}`,
    "**Verdict:** ✅ Approved",
    "",
    "## Reviewed",
    "- src/orders.ts",
  ].join("\n");
}

function addressableDesign(overrides: { compatibility?: string; schema?: string; migration?: string; security?: string; ambiguity?: string } = {}): string {
  const revision = "a".repeat(40), hash = "b".repeat(64);
  const evidence = (id: string, claim: string) => `Evidence ${id}: claim=${claim} | state=confirmed | path=src/orders.ts | symbol=orders | line=1 | revision=${revision} | basis=source | tool=rg-read | hash=${hash}`;
  return [
    "# Design", "Design evidence format: 1", "## DES-001 — Orders", "Contract:Orders.v1 — order boundary.", "DEC-001 — keep one boundary.",
    evidence("EVD-001", "DES-001"), evidence("EVD-002", "Contract:Orders.v1"), evidence("EVD-003", "DEC-001"),
    `Compatibility: ${overrides.compatibility ?? "additive-internal"}`, `Data/schema: ${overrides.schema ?? "unchanged"}`,
    `Migration/backfill: ${overrides.migration ?? "none"}`, `Security: ${overrides.security ?? "none"}`,
    "Fallback: disable the additive order boundary.", `Material ambiguity: ${overrides.ambiguity ?? "none"}`,
  ].join("\n");
}

describe("createRuntimeExecutor — what reaches the adapter (T108)", () => {
  it("T-V4-COST-006 records frontmatter effort without changing the adapter effort", async () => {
    const projectRoot = tmpProject();
    writeAgentFile(projectRoot, "backend-engineer", "model: sonnet\neffort: high");
    const runtime = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-EFFORT", context: [] });
    expect(result.outcome.effort).toBe("high");
    expect(runtime.requests[0]!.effort).toBeUndefined();
  });

  it("T-V8-012 records cache-creation tokens distinctly from cache-read tokens", async () => {
    const runtime = new MockRuntimeAdapter({
      respond: () => okResult({ usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, cacheCreationInputTokens: 25 } }),
    });
    const result = await executorFor(runtime)({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-CACHE", context: [] });
    expect(result.outcome.cache_read_tokens).toBe(10);
    expect(result.outcome.cache_creation_tokens).toBe(25);
    // Cache-creation reconciliation is additive; it does not redefine the
    // pre-existing input+output `tokens` total.
    expect(result.outcome.tokens).toBe(120);
  });

  it("T-V8-012 leaves cache-creation tokens undefined when the adapter never reports one", async () => {
    const runtime = new MockRuntimeAdapter({ respond: () => okResult({ usage: { inputTokens: 100, outputTokens: 20 } }) });
    const result = await executorFor(runtime)({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-NOCACHE", context: [] });
    expect(result.outcome.cache_creation_tokens).toBeUndefined();
  });

  it("T-V8-012 separates requested effort from the observed one, falling back when the runtime reports none", async () => {
    const runtime = new MockRuntimeAdapter({ respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([runtime]),
      routingFlags: { effort: "high" },
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-EFFORT-2", context: [] });
    expect(result.outcome.requested_effort).toBe("high");
    // No adapter today echoes effort back, so the observed value falls back to
    // the requested one — same shape `model` already had before this task.
    expect(result.outcome.effort).toBe("high");
  });

  it("T-V8-012 prefers the runtime's own observed effort over the requested one when it reports one", async () => {
    const runtime = new MockRuntimeAdapter({ respond: () => okResult({ effort: "medium" }) });
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([runtime]),
      routingFlags: { effort: "high" },
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-EFFORT-3", context: [] });
    expect(result.outcome.requested_effort).toBe("high");
    expect(result.outcome.effort).toBe("medium");
  });

  it("T-V8-012 measures instruction-surface bytes for an orchestrated run when the framework root has one", async () => {
    const root = tmpProject();
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "root instructions", "utf8");
    fs.mkdirSync(path.join(root, "policies"), { recursive: true });
    fs.writeFileSync(path.join(root, "policies", "coding.md"), "policy text", "utf8");
    writeAgentFile(root, "backend-engineer", "model: sonnet");
    const runtime = new MockRuntimeAdapter();
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-PREFIX", context: [] });
    // "root instructions" (18) + "policy text" (11) + the frontmatter'd role file body.
    expect(result.outcome.instruction_surface_bytes).toBeGreaterThan(0);
  });

  it("T-V8-012 leaves instruction-surface bytes unreported (not 0) when the role prompt cannot be read", async () => {
    const root = tmpProject(); // no CLAUDE.md, no policies/, no .claude/agents/*.md
    const runtime = new MockRuntimeAdapter();
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-NOPREFIX", context: [] });
    expect(result.outcome.instruction_surface_bytes).toBeUndefined();
  });

  it("addresses the agent by this framework's role name and the binding's own path", async () => {
    const runtime = new MockRuntimeAdapter({ id: "some-runtime" });
    const executor = executorFor(runtime);

    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0].role).toBe("backend-engineer");
    // The adapter is told where the definition lives; it is never asked to work
    // out what `backend-engineer` means or to parse frontmatter itself.
    expect(runtime.requests[0].definitionPath).toBe(".mock/agents/backend-engineer.md");
  });

  it("hands over the assembled prompt, not the raw context, so every adapter gets the same one", async () => {
    const runtime = new MockRuntimeAdapter();
    const executor = executorFor(runtime);

    await executor({
      stage: AgentStage.BACKEND_ENGINEER,
      taskId: "T-42",
      context: [{ source: ArtifactType.REQUIREMENTS, content: "REQ-001 refunds" }],
    });

    const prompt = runtime.requests[0].prompt;
    expect(prompt).toContain("Task T-42");
    expect(prompt).toContain("backend-engineer");
    expect(prompt).toContain("REQ-001 refunds");
  });

  it("persists a validated ExecutionPacket before the adapter receives it", async () => {
    const root = tmpProject();
    let existedBeforeExecute = false;
    const runtime = new MockRuntimeAdapter({
      respond: () => {
        existedBeforeExecute = latestExecutionPacketPath(root, "T-PACKET", AgentStage.BACKEND_ENGINEER) !== null;
        return okResult();
      },
    });
    const runtimeTask = runtimeTaskFixture(root);
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => ({ ...NO_GUARDS, writeAllow: ["server/**"] }),
      runtimeTask: () => runtimeTask,
      packetBaseRevision: async () => FIXTURE_REVISION,
      sliceModuleDocs: false,
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-PACKET", context: [] });
    const persistedPath = latestExecutionPacketPath(root, "T-PACKET", AgentStage.BACKEND_ENGINEER)!;
    const persisted = readExecutionPacket(persistedPath);

    expect(existedBeforeExecute).toBe(true);
    expect(result.packetPath).toBe(".workflow/packets/T-PACKET/backend-engineer-1.json");
    expect(persisted.text).toBe(runtime.requests[0].prompt);
    expect(persisted.scope.allow).toEqual(["server/**"]);
  });

  it("T-V8-011: retrieval candidates are populated from a task-specific query, not the bare module name, and verified against the real file", async () => {
    const root = tmpProject();
    const runtime = new MockRuntimeAdapter();
    const runtimeTask = runtimeTaskFixture(root);
    let seenModuleName: string | undefined;
    let seenDescription: string | undefined;
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => ({ ...NO_GUARDS, writeAllow: ["server/**"] }),
      runtimeTask: () => runtimeTask,
      packetBaseRevision: async () => FIXTURE_REVISION,
      sliceModuleDocs: false,
      codeIntelContext: async (input) => {
        seenModuleName = input.moduleName;
        seenDescription = input.query?.description;
        return {
          slices: [], used: true, queryReason: input.query?.reason ?? "",
          candidates: [{ location: { file: "src/evidence.ts", line: 1 }, symbol: "fixtureEvidence", provenance: "extracted", score: 1 }],
        };
      },
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-PACKET", context: [] });
    const persisted = readExecutionPacket(latestExecutionPacketPath(root, "T-PACKET", AgentStage.BACKEND_ENGINEER)!);

    // Generic-query replacement: the description sent for discovery is the
    // task's own query text (its Query hint from retrievalHints), not the
    // bare module name that reached codeIntelSlices before T-V8-011.
    expect(seenDescription).toContain("Locate definitions and references for the selected fixture design.");
    expect(seenDescription).not.toBe(seenModuleName);

    // The candidate is verified: real path, real hash off the current working tree.
    expect(persisted.retrieval_candidates).toEqual([{
      path: path.resolve(root, "src/evidence.ts"), symbol: "fixtureEvidence",
      provenance: "extracted discovery via findRelevantCode",
      revision: FIXTURE_REVISION, hash: expect.any(String),
    }]);
    expect(persisted.text).toContain("src/evidence.ts");
    expect(result.outcome.result).toBe("PASS");
  });

  it("T-V8-011: retrieval candidates stay empty (never block compilation) when code intelligence finds nothing or the seam is absent", async () => {
    const root = tmpProject();
    const runtime = new MockRuntimeAdapter();
    const runtimeTask = runtimeTaskFixture(root);
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => ({ ...NO_GUARDS, writeAllow: ["server/**"] }),
      runtimeTask: () => runtimeTask,
      packetBaseRevision: async () => FIXTURE_REVISION,
      sliceModuleDocs: false,
      codeIntelContext: async () => { throw new Error("provider unavailable"); },
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-PACKET", context: [] });
    const persisted = readExecutionPacket(latestExecutionPacketPath(root, "T-PACKET", AgentStage.BACKEND_ENGINEER)!);
    expect(persisted.retrieval_candidates).toEqual([]);
    expect(result.outcome.result).toBe("PASS");
  });

  it("TASK-017: a v2 packet gets the rendered code-intel evidence block (not just retrieval_candidates), from a single codeIntelContext call", async () => {
    const root = tmpProject();
    const runtime = new MockRuntimeAdapter();
    const runtimeTask = runtimeTaskFixture(root);
    let callCount = 0;
    const evidenceBlock = "## Code intelligence evidence — target `t1` (DISCOVERY ONLY)\n\nGraphify discovers → Source confirms → Compiler checks → Tests verify.\n1. [extracted] src/evidence.ts:L1 — fixtureEvidence";
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => ({ ...NO_GUARDS, writeAllow: ["server/**"] }),
      runtimeTask: () => runtimeTask,
      packetBaseRevision: async () => FIXTURE_REVISION,
      sliceModuleDocs: false,
      codeIntelContext: async (input) => {
        callCount += 1;
        return {
          slices: ["", evidenceBlock],
          used: true,
          queryReason: input.query?.reason ?? "",
          candidates: [{ location: { file: "src/evidence.ts", line: 1 }, symbol: "fixtureEvidence", provenance: "extracted", score: 1 }],
        };
      },
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-PACKET", context: [] });
    const persisted = readExecutionPacket(latestExecutionPacketPath(root, "T-PACKET", AgentStage.BACKEND_ENGINEER)!);

    expect(callCount).toBe(1);
    expect(result.outcome.result).toBe("PASS");
    expect(persisted.retrieval_candidates.length).toBeGreaterThan(0);
    expect(persisted.code_intel_evidence).toBe(evidenceBlock);
    expect(persisted.text).toContain("Code intelligence evidence");
    expect(persisted.text).toContain(SOURCE_OF_TRUTH_SENTENCE);
    // The persisted prompt is the exact bytes handed to the runtime — the
    // evidence block travelled through compilation, not a post-hoc string
    // concatenation onto an already-hashed packet.
    expect(runtime.requests[0].prompt).toBe(persisted.text);
  });

  it("passes the guard set through untouched, so the adapter can wire it into its own binding", async () => {
    const guards: RuntimeGuards = {
      writeAllow: ["src/**"],
      writeDeny: [".git/**"],
      forbidCommands: ["git"],
      exitChecks: ["code-green"],
    };
    const runtime = new MockRuntimeAdapter();
    const executor = executorFor(runtime, { guards: () => guards });

    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(runtime.requests[0].guards).toEqual(guards);
  });

  it("runs provider-neutral exit checks and fails closed instead of announcing a GUARD GAP (DES-122)", async () => {
    const runtime = new MockRuntimeAdapter({
      capabilities: ALL_MOCK_CAPABILITIES.filter((capability) => capability !== RuntimeCapability.EXIT_GUARD),
      respond: () =>
        okResult({
          guards: {
            enforced: [],
            // Even a buggy adapter that forgets to report the gap cannot skip
            // the runner: its declared capability set is the pre-spawn truth.
            unenforced: [],
          },
        }),
    });
    const executor = executorFor(runtime, {
      guards: () => ({ writeAllow: [], writeDeny: [], forbidCommands: [], exitChecks: ["code-green"] }),
      captureExitCheckBaseline: async (roots: string[]) => roots.map((root) => ({ root, fingerprint: { files: {} } })),
      exitCheckRunner: async (baselines: Array<{ root: string }>) => ({
        ok: false,
        results: [{ check: "code-green", root: baselines[0]!.root, status: "FAIL", diagnostic: "typecheck: red" }],
      }),
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("code-green");
    expect(result.outcome.failure_reason).toContain("typecheck: red");
  });

  it("refuses before adapter spawn when an unenforced exit-check baseline cannot be captured", async () => {
    const runtime = new MockRuntimeAdapter({
      capabilities: ALL_MOCK_CAPABILITIES.filter((capability) => capability !== RuntimeCapability.EXIT_GUARD),
    });
    const executor = executorFor(runtime, {
      guards: () => ({ writeAllow: [], writeDeny: [], forbidCommands: [], exitChecks: ["no-hardcoded-secret"] }),
      captureExitCheckBaseline: async () => { throw new Error("not a readable git worktree"); },
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("EXIT_CHECK_BASELINE_UNAVAILABLE");
    expect(runtime.requests).toEqual([]);
  });

  it("stays silent about exit checks when they were not requested", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runtime = new MockRuntimeAdapter({
        respond: () => okResult({ guards: { enforced: [], unenforced: [RuntimeCapability.EXIT_GUARD] } }),
      });
      const executor = executorFor(runtime, { guards: () => NO_GUARDS });
      await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("GUARD GAP"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  /**
   * T15 — a guard cannot be told by its runtime which agent is acting, so the
   * framework supplies it. Set here rather than per adapter because every
   * runtime's guards need it and no runtime provides it.
   */
  it("tells the run which role it is, in the framework's own environment variable", async () => {
    const runtime = new MockRuntimeAdapter();
    const executor = executorFor(runtime);

    await executor({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(runtime.requests[0].env?.STA_ROLE).toBe("qa-engineer");
  });

  it("defaults to `propose` autonomy — automating handoffs is not the same as removing confirmations", async () => {
    const runtime = new MockRuntimeAdapter();
    await executorFor(runtime)({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
    expect(runtime.requests[0].autonomy).toBe("propose");
  });

  it("honours stageRoots so a multi-repo project runs each stage in its own repo (T42)", async () => {
    const runtime = new MockRuntimeAdapter();
    const hub = tmpProject();
    const backendRepo = tmpProject();
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: hub,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      stageRoots: { [AgentStage.BACKEND_ENGINEER]: backendRepo },
    });

    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
    await executor({ stage: AgentStage.SYSTEM_ANALYST, taskId: "T-1", context: [] });

    expect(runtime.requests[0].cwd).toBe(backendRepo);
    expect(runtime.requests[1].cwd).toBe(hub);
  });
});

describe("model resolution — T58's seam, and the one T112 will use (T108)", () => {
  it("takes the model from the role definition's own frontmatter by default", async () => {
    const root = tmpProject();
    writeAgentFile(root, "backend-engineer", "model: sonnet\nversion: 3");
    const runtime = new MockRuntimeAdapter();
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(runtime.requests[0].model).toBe("sonnet");
    expect(result.outcome.model).toBe("sonnet");
    expect(result.outcome.promptVersion).toBe(3);
  });

  it("lets an override layer over the frontmatter — the hook T112 needs, with no routing logic here", async () => {
    const root = tmpProject();
    writeAgentFile(root, "backend-engineer", "model: sonnet");
    const runtime = new MockRuntimeAdapter();
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      model: () => "gpt-5.2-codex",
    });

    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
    expect(runtime.requests[0].model).toBe("gpt-5.2-codex");
  });

  it("sends no model at all when nothing declares one, rather than guessing a default", async () => {
    const runtime = new MockRuntimeAdapter();
    await executorFor(runtime)({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
    expect(runtime.requests[0].model).toBeUndefined();
  });

  /**
   * The log must say what ran, not what was asked for. A routing override or a
   * runtime-side substitution would otherwise be recorded as the frontmatter
   * value — the one thing an execution log must never do.
   */
  it("logs the model the runtime says it used, over the one that was requested", async () => {
    const root = tmpProject();
    writeAgentFile(root, "backend-engineer", "model: sonnet");
    const runtime = new MockRuntimeAdapter({ respond: () => okResult({ model: "sonnet-fallback-actually-used" }) });
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
    expect(result.outcome.model).toBe("sonnet-fallback-actually-used");
  });
});

describe("metrics — normalising any runtime's usage into the run log (T26/T28)", () => {
  it("sums input and output tokens and carries cache reads and cost through", async () => {
    const runtime = new MockRuntimeAdapter({
      respond: () =>
        okResult({ usage: { inputTokens: 8000, outputTokens: 500, cachedInputTokens: 6000, costUsd: 0.05 } }),
    });

    const result = await executorFor(runtime)({ stage: AgentStage.BUSINESS_ANALYST, taskId: "T-1", context: [] });

    expect(result.outcome.input_tokens).toBe(8000);
    expect(result.outcome.output_tokens).toBe(500);
    expect(result.outcome.cache_read_tokens).toBe(6000);
    expect(result.outcome.tokens).toBe(8500);
    expect(result.outcome.cost).toBe(0.05);
  });

  /**
   * A runtime without COST_REPORTING records 0, because the run log's `cost` is
   * a number by contract. The absence is expressed as the missing capability,
   * not as a fabricated figure in every row.
   */
  it("records 0 cost — not a guess — for a runtime that reports none", async () => {
    const runtime = new MockRuntimeAdapter({ respond: () => okResult({ usage: { inputTokens: 10 } }) });
    const result = await executorFor(runtime)({ stage: AgentStage.SETUP, taskId: "T-1", context: [] });
    expect(result.outcome.cost).toBe(0);
  });

  it("records context_chars from the prompt actually sent", async () => {
    const runtime = new MockRuntimeAdapter();
    const result = await executorFor(runtime)({
      stage: AgentStage.BUSINESS_ANALYST,
      taskId: "T-1",
      context: [{ source: ArtifactType.REQUIREMENTS, content: "x".repeat(500) }],
    });
    expect(result.outcome.context_chars).toBeGreaterThan(500);
    expect(result.outcome.session_kind).toBe("orchestrated");
    expect(result.outcome.static_chars).toBeTypeOf("number");
    expect(
      (result.outcome.static_chars ?? 0) +
      (result.outcome.handoff_chars ?? 0) +
      (result.outcome.doc_chars ?? 0) +
      (result.outcome.knowledge_chars ?? 0) +
      (result.outcome.code_intel_chars ?? 0) +
      (result.outcome.tool_output_chars ?? 0),
    ).toBe(result.outcome.context_chars);
  });

  it("warns for an over-budget prompt without changing a single prompt character", async () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, ".sta"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sta", "config.yaml"), "schema_version: 1\ncontext_budget:\n  roles:\n    business-analyst: 1\n", "utf8");
    const runtime = new MockRuntimeAdapter();
    const executor = executorFor(runtime, { projectRoot: root });
    const req = { stage: AgentStage.BUSINESS_ANALYST, taskId: "T-warning", context: [{ source: ArtifactType.REQUIREMENTS, content: "x".repeat(500) }] };
    const expected = buildPromptParts(req).text;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await executor(req);
      expect(runtime.requests[0].prompt).toBe(expected);
      expect(result.outcome.context_chars).toBe(expected.length);
      expect(result.outcome.context_budget_chars).toBe(1);
      expect(result.outcome.context_overflow_chars).toBe(expected.length - 1);
      expect(result.outcome.context_budget_warning).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        `[orchestrator] WARNING: business-analyst context budget exceeded: ${expected.length} chars > 1 (role); overflow=${expected.length - 1}. Prompt is unchanged (warning mode).`,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses an over-budget prompt in reject mode before executeAgent", async () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, ".sta"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sta", "config.yaml"), "schema_version: 1\ncontext_budget:\n  mode: reject\n  roles:\n    business-analyst: 1\n", "utf8");
    const runtime = new MockRuntimeAdapter();
    const executor = executorFor(runtime, { projectRoot: root });
    const result = await executor({ stage: AgentStage.BUSINESS_ANALYST, taskId: "T-reject", context: [{ source: ArtifactType.REQUIREMENTS, content: "x".repeat(500) }] });
    expect(runtime.requests).toHaveLength(0);
    expect(result.outcome).toMatchObject({ result: "FAIL", context_budget_warning: true, context_budget_chars: 1 });
  });

  it("keeps missing and invalid budget config in the warn-compatible execution path", async () => {
    const missing = new MockRuntimeAdapter();
    await executorFor(missing)({ stage: AgentStage.BUSINESS_ANALYST, taskId: "T-NO-CONFIG", context: [] });
    expect(missing.requests).toHaveLength(1);

    const root = tmpProject();
    fs.mkdirSync(path.join(root, ".sta"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sta", "config.yaml"), "schema_version: invalid\n", "utf8");
    const invalid = new MockRuntimeAdapter();
    const result = await executorFor(invalid, { projectRoot: root })({ stage: AgentStage.BUSINESS_ANALYST, taskId: "T-INVALID-CONFIG", context: [] });
    expect(result.outcome.result).toBeDefined();
    expect(invalid.requests).toHaveLength(1);
  });

  it("fails before adapter execution when HANDOFF explicitly references a forbidden document", async () => {
    const runtime = new MockRuntimeAdapter();
    const handoff = {
      task_id: "T-42", implements: [], module: "sales-crm", phase: 1,
      constraint_refs: ["security.md#Open-Findings"],
      contract_refs: { produces: [], consumes: [] }, decision_refs: [], test_refs: [],
      artifact_refs: [], open_findings: [], budget: null,
    };
    const result = await executorFor(runtime)({
      stage: AgentStage.SYSTEM_ANALYST,
      taskId: "T-42",
      context: [{ source: ArtifactType.HANDOFF, content: JSON.stringify(handoff) }],
    });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("not allowed to read \"security-report\"");
    expect(runtime.requests).toHaveLength(0);
  });

  it("fails before adapter execution when persisted HANDOFF JSON is schema-invalid", async () => {
    const runtime = new MockRuntimeAdapter();
    const result = await executorFor(runtime)({
      stage: AgentStage.SYSTEM_ANALYST,
      taskId: "T-42",
      context: [{ source: ArtifactType.HANDOFF, content: JSON.stringify({ task_id: "T-42" }) }],
    });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("failed contract validation");
    expect(runtime.requests).toHaveLength(0);
  });

  it("T-V8-011: raw HANDOFF JSON is omitted from the prompt once doc slicing already narrowed using it — its provenance stays", async () => {
    const root = tmpProject();
    const docs = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, "design.md"), [
      "# Design",
      "## Feature-by-Feature Feasibility", "safe",
      "## Risks & Dependencies", "safe",
      "## Open Questions", "none",
      "## Orders Contract — DES-001", "selected",
      "## Future Contract — DES-997", "future ".repeat(100),
      "## Future Contract — DES-998", "future ".repeat(100),
      "## Future Contract — DES-999", "future ".repeat(100),
    ].join("\n"));
    const runtime = new MockRuntimeAdapter();
    const handoff = {
      task_id: "T-1", implements: ["DES-001"], module: "sales-crm", phase: 1,
      constraint_refs: [], contract_refs: { produces: ["design.md#Orders-Contract-%E2%80%94-DES-001"], consumes: [] },
      decision_refs: [], test_refs: [], artifact_refs: [], open_findings: [], budget: null,
    };
    const result = await executorFor(runtime, { projectRoot: root, phases: () => [1] })({
      stage: AgentStage.PROJECT_MANAGER,
      taskId: "T-1",
      context: [{ source: ArtifactType.HANDOFF, content: JSON.stringify(handoff) }],
    });
    expect(result.outcome.result).toBeDefined();
    const prompt = runtime.requests[0].prompt;
    expect(prompt).toContain("slice pointed to by the structured HANDOFF");
    expect(prompt).toContain("Orders Contract");
    expect(prompt).not.toContain('"task_id":"T-1"');
    expect(prompt).not.toContain('"contract_refs"');
    expect(prompt).toContain("omitted");
  });

  it("T-V3TOK-052 property 8 — sta context fragments produce the byte-identical sta run prompt", async () => {
    const root = tmpProject();
    const docs = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, "requirement.md"), "# Req\n\n## Scope\nMVP\n", "utf8");
    fs.writeFileSync(path.join(docs, "design.md"), "# Design\n\n## Risks & Dependencies\nnone\n\n## Open Questions\nnone\n", "utf8");
    fs.writeFileSync(path.join(docs, "plan.md"), "# Plan\n\n## Plan Summary\nall\n\n## Phase 1: Work\nwork\n\n## Open Questions\nnone\n", "utf8");
    const runtime = new MockRuntimeAdapter();
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      phases: () => [1],
      guards: () => NO_GUARDS,
    });
    const req = { stage: AgentStage.BACKEND_ENGINEER, taskId: "T-ctx", context: [] };
    const command = await buildContextCommand({ role: "backend-engineer", moduleHint: "sales-crm", phases: [1], projectRoot: root, env: {} });
    await executor(req);
    const expected = buildPromptParts(req, undefined, {
      docs: command.context.docs,
      knowledge: command.context.knowledge,
      codeIntel: command.context.codeIntel,
    }).text;
    expect(runtime.requests[0].prompt).toBe(expected);
  });
});

describe("failure handling — UNAVAILABLE is not the task's fault (T108)", () => {
  it("an unavailable runtime escalates to a person instead of spending a retry", async () => {
    const runtime = new MockRuntimeAdapter({
      id: "codex",
      respond: () =>
        okResult({
          status: "UNAVAILABLE",
          exitCode: null,
          text: "",
          diagnostics: ["`codex` is not on PATH"],
        }),
    });

    const result = await executorFor(runtime)({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.failure?.category).toBe("infrastructure");
    expect(result.failure?.requiresHuman).toBe(true);
    // The distinction that matters: re-running the owner cannot install a binary.
    expect(result.failure?.retryable).toBe(false);
    expect(result.failure?.reason).toMatch(/not on PATH/);
  });

  it("an ERROR is a plain task failure, with no structured failure attached, so normal retry applies", async () => {
    const runtime = new MockRuntimeAdapter({
      respond: () => okResult({ status: "ERROR", exitCode: 1, text: "the agent gave up" }),
    });

    const result = await executorFor(runtime)({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.failure).toBeUndefined();
    expect(result.outcome.failure_reason).toMatch(/the agent gave up/);
  });

  it("a TIMEOUT fails the round and says which runtime and role timed out", async () => {
    const runtime = new MockRuntimeAdapter({
      id: "claude-code",
      respond: () => okResult({ status: "TIMEOUT", exitCode: null, text: "", diagnostics: ["exceeded 30m"] }),
    });

    const result = await executorFor(runtime)({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/claude-code/);
    expect(result.outcome.failure_reason).toMatch(/qa-engineer/);
    expect(result.outcome.failure_reason).toMatch(/exceeded 30m/);
  });

  /**
   * `executeAgent` is contracted never to throw. When one does anyway, that is
   * an adapter bug — and it still must not take the task down, so it lands as a
   * FAIL naming the adapter rather than the agent.
   */
  it("an adapter that throws is reported as an adapter fault, not as the agent failing", async () => {
    const broken = new MockRuntimeAdapter({ id: "broken" });
    broken.executeAgent = async () => {
      throw new Error("kaboom");
    };

    const result = await executorFor(broken)({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/adapter "broken" threw/);
  });

  it("refuses to start at all when the role's write scope cannot be resolved", async () => {
    const runtime = new MockRuntimeAdapter();
    const executor = executorFor(runtime, {
      guards: (role: string) => {
        throw new GuardResolutionError(role, new Error("contracts/backend-engineer.yaml is missing"));
      },
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    // The run never reached the runtime: an agent must not start with an
    // unknown write scope.
    expect(runtime.requests).toHaveLength(0);
    expect(result.outcome.failure_reason).toMatch(/cannot resolve guards/);
  });
});

describe("document verdicts read back through the workspace (T108)", () => {
  it("reads qa.md out of the runtime's own workspace and produces a QA artifact", async () => {
    const runtime = new MockRuntimeAdapter({
      files: { "_docs/module/sales-crm/qa.md": PASSING_QA },
    });

    const result = await executorFor(runtime)({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("PASS");
    expect(result.artifactType).toBe(ArtifactType.QA_REPORT);
    expect((result.artifact as { status: string }).status).toBe("PASS");
  });

  /**
   * The whole reason the workspace is part of the interface: the QA verdict came
   * out of a `Map`, not off the orchestrator's disk. A runtime driven somewhere
   * the orchestrator's own `fs` cannot see still works.
   */
  it("never touches the local filesystem to do it", async () => {
    const runtime = new MockRuntimeAdapter({
      files: { "_docs/module/sales-crm/qa.md": PASSING_QA },
    });
    const root = tmpProject();
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    });

    const result = await executor({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.artifactType).toBe(ArtifactType.QA_REPORT);
    expect(fs.existsSync(path.join(root, "_docs", "module", "sales-crm", "qa.md"))).toBe(false);
  });

  it("fails closed when the runtime reported success but no qa.md exists", async () => {
    const runtime = new MockRuntimeAdapter();
    const result = await executorFor(runtime)({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.artifactType).toBeUndefined();
    expect(result.outcome.failure_reason).toMatch(/qa\.md doesn't exist/);
  });

  /** V13 TASK-006 cutover: QA's report is `qa.md`; a stale `review.md` is not QA's and is never read in its place. */
  it("ignores a passing review.md left on disk — only qa.md is QA's report", async () => {
    const runtime = new MockRuntimeAdapter({
      files: { "_docs/module/sales-crm/review.md": PASSING_QA },
    });
    const result = await executorFor(runtime)({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.artifactType).toBeUndefined();
    expect(result.outcome.failure_reason).toMatch(/qa\.md doesn't exist/);
  });

  /** V13 TASK-006: the reviewer's verdict is the review.md STA reads back, never the runtime's exit status. */
  it("fails closed when the reviewer reported success but no review.md exists, escalating rather than guessing an owner", async () => {
    const runtime = new MockRuntimeAdapter();
    const result = await executorFor(runtime)({ stage: AgentStage.REVIEWER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.artifactType).toBeUndefined();
    expect(result.outcome.failure_reason).toMatch(/review\.md doesn't exist/);
    expect(result.failure).toMatchObject({ owner: AgentStage.HUMAN, requiresHuman: true });
    // The attempt was still dispatched under a resolved contract.
    expect(result.outcome.contract_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores a passing qa.md for the reviewer — only review.md is the reviewer's report", async () => {
    const runtime = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/qa.md": PASSING_QA } });
    const result = await executorFor(runtime)({ stage: AgentStage.REVIEWER, taskId: "T-1", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/review\.md doesn't exist/);
  });

  it("reads the reviewer's PASS from review.md into a review-report artifact", async () => {
    const runtime = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/review.md": passingReview("T-1") } });
    const result = await executorFor(runtime)({ stage: AgentStage.REVIEWER, taskId: "T-1", context: [] });
    expect(result.outcome.result).toBe("PASS");
    expect(result.artifactType).toBe(ArtifactType.REVIEW_REPORT);
    expect(result.artifact).toMatchObject({ taskId: "T-1", verdict: "PASS", reviewed: ["src/orders.ts"] });
  });

  it("reads a Changes requested review.md as FAIL routed to the finding's owner", async () => {
    const changes = passingReview("T-1")
      .replace("**Verdict:** ✅ Approved", "**Verdict:** ❌ Changes requested")
      .replace("| RV-1 | non-blocking | src/orders.ts:12 | backend-engineer | resolved |", "| RV-1 | blocking | src/orders.ts:12 | backend-engineer | open |");
    const runtime = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/review.md": changes } });
    const result = await executorFor(runtime)({ stage: AgentStage.REVIEWER, taskId: "T-1", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.artifactType).toBe(ArtifactType.REVIEW_REPORT);
    expect(result.failure).toMatchObject({ owner: AgentStage.BACKEND_ENGINEER, category: "implementation", requiresHuman: false });
  });

  it("a review.md whose Approved round lists nothing reviewed is a FAIL, not a PASS", async () => {
    const empty = passingReview("T-1").replace("## Reviewed\n- src/orders.ts", "## Reviewed");
    const runtime = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/review.md": empty } });
    const result = await executorFor(runtime)({ stage: AgentStage.REVIEWER, taskId: "T-1", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/reviewed nothing/);
  });

  it("fails a business-analyst run that wrote no requirement.md, despite exit 0", async () => {
    const runtime = new MockRuntimeAdapter();
    const result = await executorFor(runtime)({ stage: AgentStage.BUSINESS_ANALYST, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/requirement\.md doesn't exist/);
  });

  it("passes a business-analyst run whose requirement.md exists in the runtime workspace", async () => {
    const runtime = new MockRuntimeAdapter({
      files: { "_docs/module/sales-crm/requirement.md": "# Requirement\n\n## Interview Summary\nanswered\n" },
    });
    const result = await executorFor(runtime)({ stage: AgentStage.BUSINESS_ANALYST, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("PASS");
  });

  it("each doc-producing stage is checked against its own artifact, not someone else's", async () => {
    const runtime = new MockRuntimeAdapter({
      files: {
        "_docs/module/sales-crm/requirement.md": "# Requirement\n\n## Core Features\nREQ-001\n",
        "_docs/module/sales-crm/design.md": addressableDesign(),
        "_docs/module/sales-crm/plan.md": renderCanonicalTasks([fixtureTask({ id: "BE-001", traceability: ["REQ-001", "AC-007.2", "DES-001"], retrievalHints: "Hypothesis: The order boundary is likely relevant; confirm it.\nQuery: Locate the order boundary.\nProvenance: DES-001" })]),
        "_docs/module/sales-crm/test-plan.md": "# Test plan\n\n## Coverage\nTP-001\n",
        "_docs/module/sales-crm/uxui/design.md": "# UX\n\n## Draft\nUX-001\n",
      },
    });
    const executor = executorFor(runtime);

    for (const stage of [
      AgentStage.BUSINESS_ANALYST,
      AgentStage.SYSTEM_ANALYST,
      AgentStage.PROJECT_MANAGER,
      AgentStage.TEST_PLANNER,
      AgentStage.UXUI_DESIGNER,
    ]) {
      const result = await executor({ stage, taskId: "T-1", context: [] });
      expect(result.outcome.result).toBe("PASS");
      expect(result.artifactType).toBe(ArtifactType.HANDOFF);
    }

    // An engineer owns no module document — its verdict stays exit-status only.
    const engineer = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
    expect(engineer.outcome.result).toBe("PASS");
  });

  it("rejects a system-analyst document that omits the current design evidence contract", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runtime = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/design.md": "# Design only\n" } });
      const result = await executorFor(runtime)({ stage: AgentStage.SYSTEM_ANALYST, taskId: "T-1", context: [] });
      expect(result.outcome.result).toBe("FAIL");
      expect(result.artifactType).toBeUndefined();
      expect(result.outcome.failure_reason).toContain("invalid addressable design evidence");
    } finally {
      error.mockRestore();
    }
  });

  it("writes the runtime-derived BA handoff into the orchestrator artifactStore", async () => {
    const runtime = new MockRuntimeAdapter({
      files: { "_docs/module/sales-crm/requirement.md": "# Requirement\n\n## Core Features\nREQ-001\n" },
    });
    const orch = new Orchestrator(
      "T-BA-HANDOFF",
      classifyTask({ isNewFeatureModuleOrProject: true, touchesBackend: true }),
      human,
    );
    await orch.step(executorFor(runtime));
    const stored = orch.snapshot().artifacts[ArtifactType.HANDOFF];
    expect(stored).toBeDefined();
    expect(JSON.parse(stored)).toMatchObject({ task_id: "T-BA-HANDOFF", implements: ["REQ-001"] });
    expect(auditTrail(orch.store, "T-BA-HANDOFF").find((event) => event.type === "AGENT_COMPLETED")?.output).toContain("handoff");
  });

  it("fails a test-planner run that left an empty test-plan.md behind", async () => {
    const runtime = new MockRuntimeAdapter({
      files: { "_docs/module/sales-crm/test-plan.md": "   \n" },
    });
    const result = await executorFor(runtime)({ stage: AgentStage.TEST_PLANNER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/test-plan\.md doesn't exist \(or is empty\)/);
  });

  it("routes a failed round to the owner qa-engineer named, through the interface (T06)", async () => {
    const failedReview = [
      "## Open Issues — all phases",
      "| issue | phase | routes to | blocking | rounds |",
      "|---|---|---|---|---|",
      "| BE-004 response shape ไม่ตรง design | Phase 2 | backend-engineer | blocking | 1 |",
      "",
      "## Verification Summary (current round)",
      "Phase 2 (FULL) ❌ ไม่ผ่าน",
    ].join("\n");
    const runtime = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/qa.md": failedReview } });

    const result = await executorFor(runtime)({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.failure?.owner).toBe(AgentStage.BACKEND_ENGINEER);
    expect(result.failure?.affected).toContain("BE-004");
  });

  it("reads security.md the same way and attaches an unresolved finding as a human stop", async () => {
    const securityMd = ["## Open Findings — all rounds", "- 🔴 🔵 SEC-001 JWT ไม่ verify signature"].join("\n");
    const runtime = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/security.md": securityMd } });

    const result = await executorFor(runtime)({ stage: AgentStage.SECURITY, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.artifactType).toBe(ArtifactType.SECURITY_REPORT);
    expect(result.failure?.requiresHuman).toBe(true);
  });

  it("a workspace that throws is treated as a missing document — fail closed, never as a pass", async () => {
    const runtime = new MockRuntimeAdapter();
    runtime.workspace.readFile = async () => {
      throw new Error("workspace unreachable");
    };

    const result = await executorFor(runtime)({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });
    expect(result.outcome.result).toBe("FAIL");
  });
});

describe("the orchestrator drives a whole task through the interface (T108)", () => {
  /** Steps to completion, answering every human gate "yes" — the same helper shape the T55 integration suite uses. */
  async function runToCompletion(orch: Orchestrator, executor: Parameters<Orchestrator["step"]>[0], maxSteps = 20) {
    // The composition's post-Dev sweep and reports stand in for the hooks a real run wires (V13 TASK-003).
    const evidenced = withStageEvidence(executor);
    for (let i = 0; i < maxSteps; i++) {
      const status = await orch.step(evidenced);
      if (status.kind === "WAITING_FOR_HUMAN") {
        decidePending(orch, true);
        continue;
      }
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") return status;
    }
    throw new Error("runToCompletion exceeded maxSteps");
  }

  it("reaches DEPLOYED with no AI runtime installed and no knowledge of which adapter is behind the seam", async () => {
    const runtime = new MockRuntimeAdapter({
      id: "not-a-real-runtime",
      files: { "_docs/module/sales-crm/qa.md": PASSING_QA, "_docs/module/sales-crm/review.md": passingReview("T-RUNTIME") },
      respond: () => okResult({ usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } }),
    });

    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-RUNTIME", classification, human);
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    });

    const status = await runToCompletion(orch, executor);

    expect(status.kind).toBe("DEPLOYED");
    // Every stage the classification asked for actually ran, through the adapter.
    expect(runtime.rolesRun()).toEqual(classification.pipeline.map((s) => s.toString()));
  });

  it("T-V3R-032 compatibility evidence: wiring a no-config registry preserves stage sequence, runtime and model", async () => {
    const projectRoot = tmpProject();
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    for (const stage of classification.pipeline) writeAgentFile(projectRoot, stage, "model: sonnet");

    async function execute(withRegistry: boolean) {
      const taskId = `T-COMPAT-${withRegistry ? "AFTER" : "BEFORE"}`;
      const runtime = new MockRuntimeAdapter({
        id: "claude-code",
        models: ["sonnet"],
        files: { "_docs/module/sales-crm/qa.md": PASSING_QA, "_docs/module/sales-crm/review.md": passingReview(taskId) },
      });
      const orch = new Orchestrator(taskId, classification, human);
      const executor = createRuntimeExecutor({
        runtime,
        projectRoot,
        moduleName: () => "sales-crm",
        guards: () => NO_GUARDS,
        ...(withRegistry ? { registry: new RuntimeRegistry([runtime]) } : {}),
      });
      const status = await runToCompletion(orch, executor);
      return {
        status: status.kind,
        trace: runtime.requests.map((request) => ({ stage: request.role, runtime: runtime.id, model: request.model })),
      };
    }

    const before = await execute(false);
    const after = await execute(true);
    expect(after).toEqual(before);
    expect(after.trace).toEqual(classification.pipeline.map((stage) => ({ stage, runtime: "claude-code", model: "sonnet" })));
  });

  it("the same task on a second, differently-named adapter behaves identically", async () => {
    const results: string[] = [];

    for (const id of ["claude-code", "codex"]) {
      const files = { "_docs/module/sales-crm/qa.md": PASSING_QA, "_docs/module/sales-crm/review.md": passingReview(`T-${id}`) };
      const runtime = new MockRuntimeAdapter({ id, files });
      const orch = new Orchestrator(`T-${id}`, classifyTask({ isClearBugFix: true, touchesBackend: true }), { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD });
      const executor = createRuntimeExecutor({
        runtime,
        projectRoot: tmpProject(),
        moduleName: () => "sales-crm",
        guards: () => NO_GUARDS,
      });
      const status = await runToCompletion(orch, executor);
      results.push(status.kind);
    }

    // The claim V1.6 exists to make: swapping the runtime changes nothing the
    // orchestrator can observe.
    expect(results).toEqual(["DEPLOYED", "DEPLOYED"]);
  });

  /**
   * The payoff of separating UNAVAILABLE from ERROR, at a stage that routes
   * failures: escalated on the first one, rather than retried until the budget
   * is spent on a binary that was never going to appear.
   */
  it("an unavailable runtime stops the task for a person at a stage that routes failures", async () => {
    const runtime = new MockRuntimeAdapter({
      id: "codex",
      respond: (req) =>
        req.role === "qa-engineer"
          ? okResult({ status: "UNAVAILABLE", exitCode: null, text: "", diagnostics: ["not installed"] })
          : okResult(),
    });

    const orch = new Orchestrator("T-UNAVAIL", classifyTask({ isClearBugFix: true, touchesBackend: true }), { stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD });
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    });

    const evidenced = withStageEvidence(executor);
    let status = await orch.step(evidenced);
    for (let i = 0; status.kind === "RUNNING" && i < 20; i++) status = await orch.step(evidenced);

    expect(status.kind).toBe("BLOCKED");
    expect(orch.recovery?.kind).toBe("ESCALATE");
  });

  /**
   * Pinning a real limit rather than leaving it to be discovered later.
   *
   * The orchestrator consults a structured failure only at `qa-engineer` and
   * `security` (see `reportCompletion`'s `failureKind`); at any other stage a
   * FAIL leaves the stage assigned for a retry (V13 TASK-003: it never advances). So the UNAVAILABLE/ERROR distinction is
   * carried faithfully in the record, but only *acted on* at those two stages.
   * That is pre-existing routing behaviour from T01/T06, not something T108
   * changed — and changing it would be a change to failure routing, which
   * belongs with T111's fallback work, not here.
   */
  it("carries the unavailable failure on the record even at a stage the orchestrator does not route", async () => {
    const runtime = new MockRuntimeAdapter({
      id: "codex",
      respond: () => okResult({ status: "UNAVAILABLE", exitCode: null, text: "", diagnostics: ["not installed"] }),
    });
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(result.failure?.requiresHuman).toBe(true);
    expect(result.failure?.retryable).toBe(false);
  });
});

/**
 * T112, proven the same way T108 proved the interface itself: run the same
 * executor twice, once with `opts.registry` unset (old behaviour, single fixed
 * runtime) and once with it set and a `.sta/config.yaml`-style override routing
 * a role to a *second* registered mock runtime. If routing worked, the second
 * run's request lands on the other adapter — nothing about `runtimeExecutor.ts`
 * needed to know either runtime's name for this to happen.
 */
describe("createRuntimeExecutor — three-repo guard enforcement", () => {
  function scopedFixture(taskId: string) {
    const bindingRoot = tmpProject(), knowledgeRoot = tmpProject(), targetRoot = tmpProject();
    const runtimeTask = runtimeTaskFixture(knowledgeRoot, { taskId, targetRoot, allow: [] });
    return { bindingRoot, knowledgeRoot, targetRoot, runtimeTask };
  }
  it("does not start a Target-write run when the runtime lacks a pre-tool guard", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code", capabilities: [RuntimeCapability.NAMED_AGENTS] });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const scoped = scopedFixture("T-target");
    const task = {
      runtimeTask: scoped.runtimeTask,
      taskId: "T-target",
      classification,
      targetBindings: { targets: [{ target_id: "api", role: AgentStage.BACKEND_ENGINEER }] },
    } as never;
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([runtime]),
      packetBaseRevision: async () => FIXTURE_REVISION,
      threeRepoTask: () => ({ task, roots: { bindingRoot: scoped.bindingRoot, knowledgeRoot: scoped.knowledgeRoot, knowledgeRootName: "default", workRoots: [{ targetId: "api", path: scoped.targetRoot, access: "write" }] } }),
    });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-target", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain('runtime "claude-code"');
    expect(result.outcome.failure_reason).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(runtime.requests).toHaveLength(0);
  });

  it("T-V6-015 (inert today — no real runtime this framework ships lacks INTERACTIVE_PROMPTS except antigravity, and no real .sta/config.yaml sets routing.order): refuses business-analyst on a runtime that cannot receive interactive prompts", async () => {
    const runtime = new MockRuntimeAdapter({ id: "antigravity", capabilities: [RuntimeCapability.NAMED_AGENTS] });
    const result = await executorFor(runtime)({ stage: AgentStage.BUSINESS_ANALYST, taskId: "T-1", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain('runtime "antigravity"');
    expect(result.outcome.failure_reason).toContain("cannot receive interactive prompts");
    expect(runtime.requests).toHaveLength(0);
  });

  it("T-V6-015: does not gate system-analyst on INTERACTIVE_PROMPTS — the same incapable runtime runs it", async () => {
    const runtime = new MockRuntimeAdapter({ id: "antigravity", capabilities: [RuntimeCapability.NAMED_AGENTS] });
    await executorFor(runtime)({ stage: AgentStage.SYSTEM_ANALYST, taskId: "T-1", context: [] });
    expect(runtime.requests).toHaveLength(1);
  });

  it("runs a Target-writing stage in its canonical Target root while retaining explicit scope", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }) });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const scoped = scopedFixture("T-target");
    const task = { runtimeTask: scoped.runtimeTask, taskId: "T-target", classification, targetBindings: { targets: [{ target_id: "api", role: AgentStage.BACKEND_ENGINEER }] } } as never;
    const executor = createRuntimeExecutor({ runtime, projectRoot: tmpProject(), moduleName: () => "sales-crm", guards: () => NO_GUARDS,
      packetBaseRevision: async () => FIXTURE_REVISION,
      threeRepoTask: () => ({ task, roots: { bindingRoot: scoped.bindingRoot, knowledgeRoot: scoped.knowledgeRoot, knowledgeRootName: "default", workRoots: [{ targetId: "api", path: scoped.targetRoot, access: "write" }] } }), });
    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-target", context: [] });
    expect(runtime.requests[0]).toMatchObject({ cwd: scoped.targetRoot, bindingRoot: scoped.bindingRoot, knowledgeRoot: scoped.knowledgeRoot, workRoots: [{ targetId: "api", path: scoped.targetRoot, access: "write" }] });
    // T-WG7 — the Knowledge root rides on the env so hooks/prompts can name it.
    expect(runtime.requests[0]!.env).toMatchObject({ STA_ROLE: "backend-engineer", STA_KNOWLEDGE_ROOT: scoped.knowledgeRoot });
  });

  it("V11 TASK-019 — a stage's env carries the selected root name beside the path (DR §5 env/launch)", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }) });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const scoped = scopedFixture("T-root-name");
    const task = { runtimeTask: scoped.runtimeTask, taskId: "T-root-name", classification, targetBindings: { targets: [{ target_id: "api", role: AgentStage.BACKEND_ENGINEER }] } } as never;
    const executor = createRuntimeExecutor({ runtime, projectRoot: tmpProject(), moduleName: () => "sales-crm", guards: () => NO_GUARDS,
      packetBaseRevision: async () => FIXTURE_REVISION,
      threeRepoTask: () => ({ task, roots: { bindingRoot: scoped.bindingRoot, knowledgeRoot: scoped.knowledgeRoot, knowledgeRootName: "work", workRoots: [{ targetId: "api", path: scoped.targetRoot, access: "write" }] } }), });
    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-root-name", context: [] });
    expect(runtime.requests[0]!.env).toMatchObject({ STA_KNOWLEDGE_ROOT: scoped.knowledgeRoot, STA_KNOWLEDGE_ROOT_NAME: "work" });
  });

  it("V11 TASK-019 — an installed run whose selection came back incomplete refuses to launch (fail-closed)", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }) });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const scoped = scopedFixture("T-half-selection");
    const task = { runtimeTask: scoped.runtimeTask, taskId: "T-half-selection", classification, targetBindings: { targets: [{ target_id: "api", role: AgentStage.BACKEND_ENGINEER }] } } as never;
    const executor = createRuntimeExecutor({ runtime, projectRoot: tmpProject(), moduleName: () => "sales-crm", guards: () => NO_GUARDS,
      packetBaseRevision: async () => FIXTURE_REVISION,
      threeRepoTask: () => ({ task, roots: { bindingRoot: scoped.bindingRoot, knowledgeRoot: scoped.knowledgeRoot, knowledgeRootName: undefined as unknown as string, workRoots: [{ targetId: "api", path: scoped.targetRoot, access: "write" }] } }), });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-half-selection", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/Knowledge root selection is incomplete/);
    expect(runtime.requests).toHaveLength(0);
  });

  it("V11 TASK-019 — two sessions on different roots get their own env pair and never each other's (DR §8.3)", async () => {
    const selections = [
      { name: "personal", knowledgeRoot: tmpProject() },
      { name: "work", knowledgeRoot: tmpProject() },
    ];
    const pairs: { path?: string; name?: string }[] = [];
    for (const selected of selections) {
      const runtime = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }) });
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      const scoped = scopedFixture(`T-isolation-${selected.name}`);
      const task = { runtimeTask: scoped.runtimeTask, taskId: `T-isolation-${selected.name}`, classification, targetBindings: { targets: [{ target_id: "api", role: AgentStage.BACKEND_ENGINEER }] } } as never;
      const executor = createRuntimeExecutor({ runtime, projectRoot: tmpProject(), moduleName: () => "sales-crm", guards: () => NO_GUARDS,
        packetBaseRevision: async () => FIXTURE_REVISION,
        threeRepoTask: () => ({ task, roots: { bindingRoot: scoped.bindingRoot, knowledgeRoot: selected.knowledgeRoot, knowledgeRootName: selected.name, workRoots: [{ targetId: "api", path: scoped.targetRoot, access: "write" }] } }), });
      await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: `T-isolation-${selected.name}`, context: [] });
      expect(runtime.requests[0]!.env).toMatchObject({ STA_KNOWLEDGE_ROOT: selected.knowledgeRoot, STA_KNOWLEDGE_ROOT_NAME: selected.name });
      pairs.push({ path: runtime.requests[0]!.env?.STA_KNOWLEDGE_ROOT, name: runtime.requests[0]!.env?.STA_KNOWLEDGE_ROOT_NAME });
    }
    expect(pairs[0]!.path).not.toBe(pairs[1]!.path);
    expect(pairs[0]!.name).not.toBe(pairs[1]!.name);
  });

  it("T-V1-16 two-Target isolation: the guard env carries only the write-access root, never the read-only sibling", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }) });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
    const scoped = scopedFixture("T-two");
    const task = { runtimeTask: scoped.runtimeTask, taskId: "T-two", classification, targetBindings: { targets: [{ target_id: "api", role: AgentStage.BACKEND_ENGINEER }, { target_id: "web", role: AgentStage.FRONTEND_ENGINEER }] } } as never;
    const otherTargetRoot = tmpProject();
    const workRoots = [
      { targetId: "api", path: scoped.targetRoot, access: "write" as const },
      { targetId: "web", path: otherTargetRoot, access: "read" as const },
    ];
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      packetBaseRevision: async () => FIXTURE_REVISION,
      threeRepoTask: () => ({ task, roots: { bindingRoot: scoped.bindingRoot, knowledgeRoot: scoped.knowledgeRoot, knowledgeRootName: "default", workRoots } }),
    });
    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-two", context: [] });
    const writable = JSON.parse(runtime.requests[0]!.env!.STA_WRITABLE_WORK_ROOTS!);
    expect(writable).toEqual([scoped.targetRoot]);
    expect(JSON.stringify(writable)).not.toContain(otherTargetRoot);
    expect(JSON.parse(runtime.requests[0]!.env!.STA_TARGET_WORK_ROOTS!)).toEqual([
      { targetId: "api", path: scoped.targetRoot, access: "write" },
      { targetId: "web", path: otherTargetRoot, access: "read" },
    ]);
  });

  it("T-V9-012 refuses instead of falling back when an engineer has only a bound read-only Target", async () => {
    const runtime = new MockRuntimeAdapter({
      id: "claude-code",
      respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }),
    });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const scoped = scopedFixture("T-read-only");
    scoped.runtimeTask.scope = {
      status: "unavailable",
      reason: "no stage work root was resolved",
      work_roots: [],
    };
    scoped.runtimeTask.design_evidence = [];
    const task = {
      runtimeTask: scoped.runtimeTask,
      taskId: "T-read-only",
      classification,
      targetBindings: { targets: [{ target_id: "web", role: AgentStage.FRONTEND_ENGINEER }] },
    } as never;
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      packetBaseRevision: async () => FIXTURE_REVISION,
      threeRepoTask: () => ({
        task,
        roots: {
          bindingRoot: scoped.bindingRoot,
          knowledgeRoot: scoped.knowledgeRoot,
          knowledgeRootName: "default",
          workRoots: [{ targetId: "web", path: scoped.targetRoot, access: "read" }],
        },
      }),
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-read-only", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/Target "web".*bound read-only.*backend-engineer/);
    expect(runtime.requests).toHaveLength(0);
  });

  it("T-V9-012 runs both admitted shapes with packet roots equal to each stage's single guard root", async () => {
    for (const shape of ["split", "fullstack"] as const) {
      const runtime = new MockRuntimeAdapter({
        id: "claude-code",
        respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }),
      });
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
      const scoped = scopedFixture(`T-${shape}`);
      const frontendRoot = shape === "split" ? tmpProject() : scoped.targetRoot;
      scoped.runtimeTask.scope.work_roots = [
        { stage: AgentStage.BACKEND_ENGINEER, target_id: shape === "split" ? "api" : "mvc", root: scoped.targetRoot, allow: [] },
        { stage: AgentStage.FRONTEND_ENGINEER, target_id: shape === "split" ? "web" : "mvc", root: frontendRoot, allow: [] },
      ];
      const task = {
        runtimeTask: scoped.runtimeTask,
        taskId: `T-${shape}`,
        classification,
        targetBindings: {
          targets: [
            { target_id: shape === "split" ? "api" : "mvc", role: AgentStage.BACKEND_ENGINEER },
            { target_id: shape === "split" ? "web" : "mvc", role: AgentStage.FRONTEND_ENGINEER },
          ],
        },
      } as never;
      const rootsFor = (stage: AgentStage) => shape === "split"
        ? [
            { targetId: "api", path: scoped.targetRoot, access: stage === AgentStage.BACKEND_ENGINEER ? "write" as const : "read" as const },
            { targetId: "web", path: frontendRoot, access: stage === AgentStage.FRONTEND_ENGINEER ? "write" as const : "read" as const },
          ]
        : [{ targetId: "mvc", path: scoped.targetRoot, access: "write" as const }];
      const executor = createRuntimeExecutor({
        runtime,
        projectRoot: tmpProject(),
        moduleName: () => "sales-crm",
        guards: () => NO_GUARDS,
        packetBaseRevision: async () => FIXTURE_REVISION,
        threeRepoTask: (_taskId, stage) => ({
          task,
          roots: { bindingRoot: scoped.bindingRoot, knowledgeRoot: scoped.knowledgeRoot, knowledgeRootName: "default", workRoots: rootsFor(stage) },
        }),
      });

      for (const stage of [AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]) {
        const result = await executor({ stage, taskId: `T-${shape}`, context: [] });
        expect(result.outcome.result, `${shape}/${stage}`).toBe("PASS");
        const request = runtime.requests.at(-1)!;
        const expectedRoot = stage === AgentStage.BACKEND_ENGINEER ? scoped.targetRoot : frontendRoot;
        expect(request.cwd).toBe(expectedRoot);
        expect(JSON.parse(request.env!.STA_WRITABLE_WORK_ROOTS!)).toEqual([expectedRoot]);
        expect(readExecutionPacket(path.resolve(scoped.knowledgeRoot, result.packetPath!)).scope.roots).toEqual([expectedRoot]);
      }
    }
  });

  it("V10 TASK-009 admits more than one writable Target in an engineer invocation and scopes the packet to all of them", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }) });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const scoped = scopedFixture("T-plural-write");
    const second = tmpProject();
    scoped.runtimeTask.scope.work_roots = [
      { stage: AgentStage.BACKEND_ENGINEER, target_id: "api", root: scoped.targetRoot, access: "write", allow: [] },
      { stage: AgentStage.BACKEND_ENGINEER, target_id: "worker", root: second, access: "write", allow: [] },
    ];
    const task = {
      runtimeTask: scoped.runtimeTask,
      taskId: "T-plural-write",
      classification,
      targetBindings: { targets: [{ target_id: "api", role: AgentStage.BACKEND_ENGINEER }, { target_id: "worker", role: AgentStage.BACKEND_ENGINEER }] },
    } as never;
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      packetBaseRevision: async () => FIXTURE_REVISION,
      threeRepoTask: () => ({
        task,
        roots: {
          bindingRoot: scoped.bindingRoot,
          knowledgeRoot: scoped.knowledgeRoot,
          knowledgeRootName: "default",
          workRoots: [
            { targetId: "api", path: scoped.targetRoot, access: "write" },
            { targetId: "worker", path: second, access: "write" },
          ],
        },
      }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-plural-write", context: [] });

    expect(result.outcome.result).toBe("PASS");
    // V10 TASK-025 — the packet persists under the Knowledge root, never the
    // Framework binding root.
    const packet = readExecutionPacket(path.resolve(scoped.knowledgeRoot, result.packetPath!));
    expect([...packet.scope.roots].sort()).toEqual([scoped.targetRoot, second].sort());
    expect(JSON.parse(runtime.requests[0]!.env!.STA_WRITABLE_WORK_ROOTS!).sort()).toEqual([scoped.targetRoot, second].sort());
    // The primary root alone selects the cwd; the second is writable, not the
    // working directory.
    expect(runtime.requests[0]!.cwd).toBe(scoped.targetRoot);
    // The packet must not be persisted into any Target the task can write.
    expect(path.resolve(scoped.knowledgeRoot, result.packetPath!).startsWith(scoped.targetRoot)).toBe(false);
    expect(path.resolve(scoped.knowledgeRoot, result.packetPath!).startsWith(second)).toBe(false);
  });

  it("V10 TASK-009 keeps the packet out of every bound Target, not only the primary one", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code", respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }) });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const scoped = scopedFixture("T-forbidden-second");
    // V10 TASK-025 — the runtime-state root is the Knowledge root, so the
    // hostile shape is that root physically sitting inside a Target; only a
    // `forbiddenRoots` list covering the non-primary roots catches it.
    const second = tmpProject();
    const knowledgeInsideSecond = path.join(second, "knowledge");
    fs.mkdirSync(knowledgeInsideSecond, { recursive: true });
    scoped.runtimeTask.scope.work_roots = [
      { stage: AgentStage.BACKEND_ENGINEER, target_id: "api", root: scoped.targetRoot, access: "write", allow: [] },
      { stage: AgentStage.BACKEND_ENGINEER, target_id: "worker", root: second, access: "write", allow: [] },
    ];
    const task = {
      runtimeTask: scoped.runtimeTask,
      taskId: "T-forbidden-second",
      classification,
      targetBindings: { targets: [{ target_id: "api", role: AgentStage.BACKEND_ENGINEER }, { target_id: "worker", role: AgentStage.BACKEND_ENGINEER }] },
    } as never;
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      packetBaseRevision: async () => FIXTURE_REVISION,
      threeRepoTask: () => ({
        task,
        roots: {
          bindingRoot: scoped.bindingRoot,
          knowledgeRoot: knowledgeInsideSecond,
          knowledgeRootName: "default",
          workRoots: [
            { targetId: "api", path: scoped.targetRoot, access: "write" },
            { targetId: "worker", path: second, access: "write" },
          ],
        },
      }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-forbidden-second", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/execution packet storage must remain Local Runtime State/);
    expect(runtime.requests).toHaveLength(0);
  });

  it("V10 TASK-009 still refuses an engineer invocation with no writable Target at all", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code" });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const scoped = scopedFixture("T-no-write");
    const task = { runtimeTask: scoped.runtimeTask, taskId: "T-no-write", classification, targetBindings: { targets: [] } } as never;
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      threeRepoTask: () => ({
        task,
        roots: {
          bindingRoot: scoped.bindingRoot,
          knowledgeRoot: scoped.knowledgeRoot,
          knowledgeRootName: "default",
          workRoots: [{ targetId: "api", path: scoped.targetRoot, access: "read" }],
        },
      }),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-no-write", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/Target "api" is bound read-only for this backend-engineer invocation/);
    expect(result.outcome.failure_reason).toMatch(/at least one writable Target must be resolved/);
    expect(runtime.requests).toHaveLength(0);
  });
});

describe("createRuntimeExecutor — T112 opt-in cross-runtime routing", () => {
  it("without opts.registry, every run goes to the fixed runtime exactly as before T112", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code" });
    const executor = executorFor(runtime);

    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(runtime.requests).toHaveLength(1);
  });

  it("with opts.registry and no routing.by_role override, still goes to the fixed runtime (its id doubles as the default)", async () => {
    const primary = new MockRuntimeAdapter({ id: "claude-code" });
    const secondary = new MockRuntimeAdapter({ id: "codex" });
    const registry = new RuntimeRegistry([primary, secondary]);
    const executor = executorFor(primary, { registry });

    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(primary.requests).toHaveLength(1);
    expect(secondary.requests).toHaveLength(0);
  });

  it("records requested == actual and automatic precedence on the no-config production path", async () => {
    const projectRoot = tmpProject();
    writeAgentFile(projectRoot, "backend-engineer", "model: sonnet");
    const runtime = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const executor = createRuntimeExecutor({
      runtime,
      registry: new RuntimeRegistry([runtime]),
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-NO-CONFIG", context: [] });
    expect(result.outcome).toMatchObject({
      runtime: "claude-code",
      model: "sonnet",
      requested_runtime: "claude-code",
      requested_model: "sonnet",
      routing_basis: expect.stringContaining("level-4;tier=runtime-default,model=legacy-frontmatter"),
      fallback_count: 0,
    });
  });

  it("fails closed when a cast task has no model-tiers.yaml to resolve it", async () => {
    const projectRoot = tmpProject();
    writeAgentFile(projectRoot, "backend-engineer", "model: sonnet");
    const runtime = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] });
    const executor = createRuntimeExecutor({
      runtime,
      registry: new RuntimeRegistry([runtime]),
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      planTier: () => "T4",
    });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-NO-TIER-TABLE", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("model-tiers.yaml is missing");
    expect(runtime.requests).toHaveLength(0);
  });

  it("T-V4-CAST-001 — a --model routing flag reaches the adapter as an explicit override; a resolved default does not", async () => {
    const projectRoot = tmpProject();
    writeAgentFile(projectRoot, "backend-engineer", "model: sonnet");
    const runtime = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet", "opus"] });
    const base = {
      runtime,
      registry: new RuntimeRegistry([runtime]),
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    };

    await createRuntimeExecutor(base)({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-DEFAULT", context: [] });
    expect(runtime.requests[0].model).toBe("sonnet");
    expect(runtime.requests[0].modelExplicit ?? false).toBe(false);

    await createRuntimeExecutor({ ...base, routingFlags: { model: "opus" } })(
      { stage: AgentStage.BACKEND_ENGINEER, taskId: "T-OVERRIDE", context: [] },
    );
    expect(runtime.requests[1].model).toBe("opus");
    expect(runtime.requests[1].modelExplicit).toBe(true);
  });

  it("carries the parsed design assessment from SA output into the runtime gate", async () => {
    const lowRisk = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/design.md": addressableDesign() } });
    const low = await executorFor(lowRisk)({ stage: AgentStage.SYSTEM_ANALYST, taskId: "T-LOW", context: [] });
    expect(low.outcome.result).toBe("PASS");
    expect(low.gateEvidence?.designAssessment).toMatchObject({ triggers: [], canProceedWithoutConfirmation: true });

    const schema = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/design.md": addressableDesign({ schema: "additive", migration: "required" }) } });
    const high = await executorFor(schema)({ stage: AgentStage.SYSTEM_ANALYST, taskId: "T-SCHEMA", context: [] });
    expect(high.outcome.result).toBe("PASS");
    expect(high.gateEvidence?.designAssessment).toMatchObject({ triggers: ["schema", "migration"], canProceedWithoutConfirmation: false });
  });

  it("fails an SA run that declares addressable format with incomplete claim evidence", async () => {
    const invalid = addressableDesign().replace("DEC-001 — keep one boundary.\n", "");
    const runtime = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/design.md": invalid } });
    const result = await executorFor(runtime)({ stage: AgentStage.SYSTEM_ANALYST, taskId: "T-BAD-DESIGN", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("invalid addressable design evidence");
  });

  it("T-V8-005 — forwards central role policy to the adapter and records the effective effort/basis, not stale frontmatter", async () => {
    const projectRoot = tmpProject();
    writeAgentFile(projectRoot, "backend-engineer", "model: stale-frontmatter\neffort: stale-frontmatter");
    const runtime = new MockRuntimeAdapter({ id: "claude-code", models: ["central-model"] });
    const modelPolicy = {
      tiers: {
        T5: { reserved: false, camps: { anthropic: { model: "central-model", effort: "high", notes: "human choice" } } },
      },
      roleDefaults: { "backend-engineer": "T5" },
      legacyRoleDefaults: false,
    } as unknown as ModelTierPolicy;
    const result = await createRuntimeExecutor({
      runtime,
      registry: new RuntimeRegistry([runtime]),
      projectRoot,
      modelPolicy,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-POLICY", context: [] });

    expect(runtime.requests[0]).toMatchObject({ model: "central-model", effort: "high", modelExplicit: true });
    expect(result.outcome).toMatchObject({ model: "central-model", effort: "high", requested_model: "central-model" });
    expect(result.outcome.routing_basis).toContain("role-default-tier:T5");
    expect(result.outcome.routing_basis).not.toContain("stale-frontmatter");
  });

  it("T-V8-005 — replays a frozen persisted route without re-resolving today's Tier policy or frontmatter", async () => {
    const projectRoot = tmpProject();
    writeAgentFile(projectRoot, "backend-engineer", "model: changed-later\neffort: changed-later");
    const runtime = new MockRuntimeAdapter({ id: "claude-code", models: ["frozen-model"] });
    const frozenBasis = "level-4;tier=T5,model=role-default-tier:T5,effort=role-default-tier:T5";
    const result = await createRuntimeExecutor({
      runtime,
      registry: new RuntimeRegistry([runtime]),
      routingFlags: { runtime: "claude-code", model: "frozen-model", effort: "medium" },
      frozenModelRoute: true,
      frozenRoutingBasis: frozenBasis,
      planTier: () => "T4",
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-FROZEN", context: [] });

    expect(runtime.requests[0]).toMatchObject({ model: "frozen-model", effort: "medium", modelExplicit: true });
    expect(result.outcome).toMatchObject({ model: "frozen-model", effort: "medium", routing_basis: frozenBasis });
  });

  it("refuses an unavailable selected runtime before adapter start and preserves the probe reason", async () => {
    const exactReason = "claude executable unavailable — exact diagnostic";
    const runtime = new MockRuntimeAdapter({
      id: "claude-code",
      probe: { available: false, reason: exactReason },
    });
    const result = await executorFor(runtime, { registry: new RuntimeRegistry([runtime]) })({
      stage: AgentStage.BACKEND_ENGINEER,
      taskId: "T-UNAVAILABLE-PROBE",
      context: [],
    });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain(exactReason);
    expect(runtime.requests).toEqual([]);
  });

  // The support-level gate guards the one automatic route (precedence 4, the
  // named default runner), which is the only route nobody chose explicitly.
  it("refuses an automatic below-supported route before either adapter starts", async () => {
    const projectRoot = tmpProject();
    const preview = new MockRuntimeAdapter({ id: "opencode" });
    const other = new MockRuntimeAdapter({ id: "claude-code" });
    const result = await createRuntimeExecutor({
      runtime: preview,
      registry: new RuntimeRegistry([preview, other]),
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-SUPPORT-GATE", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain('support level "experimental"');
    expect(preview.requests).toEqual([]);
    expect(other.requests).toEqual([]);
  });

  it("lets routing.allow_below_supported opt one runtime past the automatic support gate", async () => {
    const projectRoot = tmpProject();
    fs.mkdirSync(path.join(projectRoot, ".sta"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".sta", "config.yaml"), "schema_version: 1\nrouting:\n  allow_below_supported: [opencode]\n", "utf8");
    const preview = new MockRuntimeAdapter({ id: "opencode" });
    const result = await createRuntimeExecutor({
      runtime: preview,
      registry: new RuntimeRegistry([preview]),
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-SUPPORT-OPTIN", context: [] });
    expect(result.outcome.result).toBe("PASS");
    expect(preview.requests).toHaveLength(1);
  });

  // V12 promotion: codex is `supported`, so the automatic default route reaches it
  // without `routing.allow_below_supported` — the opt-in for it is now redundant.
  it("an automatic route to a runtime promoted to supported needs no opt-in (codex, V12 promotion)", async () => {
    const projectRoot = tmpProject();
    const promoted = new MockRuntimeAdapter({ id: "codex" });
    const result = await createRuntimeExecutor({
      runtime: promoted,
      registry: new RuntimeRegistry([promoted]),
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-SUPPORT-PROMOTED", context: [] });
    expect(result.outcome.result).toBe("PASS");
    expect(promoted.requests).toHaveLength(1);
  });

  // An unavailable route stops the stage rather than executing a different
  // runtime, and the second registered adapter is never reached.
  it("refuses an unavailable route without executing any other registered runtime", async () => {
    const projectRoot = tmpProject();
    fs.mkdirSync(path.join(projectRoot, ".sta"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".sta", "config.yaml"),
      "schema_version: 1\nrouting:\n  allow_below_supported: [codex]\n",
      "utf8",
    );
    const unavailable = new MockRuntimeAdapter({
      id: "claude-code",
      probe: { available: false, reason: "automatic runtime unavailable" },
    });
    const other = new MockRuntimeAdapter({ id: "codex" });
    const result = await createRuntimeExecutor({
      runtime: unavailable,
      registry: new RuntimeRegistry([unavailable, other]),
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-NO-PHASE-4", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome).toMatchObject({
      requested_runtime: "claude-code",
      runtime: "claude-code",
      fallback_count: 0,
    });
    expect(result.outcome.failure_reason).toContain("automatic runtime unavailable");
    expect(result.outcome.fallback_reason).toBeUndefined();
    expect(unavailable.requests).toEqual([]);
    expect(other.requests).toEqual([]);
  });

  it("routes a run to the second registered runtime when .sta/config.yaml's routing.by_role names it", async () => {
    const projectRoot = tmpProject();
    fs.mkdirSync(path.join(projectRoot, ".sta"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".sta", "config.yaml"),
      "schema_version: 1\nrouting:\n  by_role:\n    backend-engineer: codex:o4-mini\n",
      "utf8",
    );
    const primary = new MockRuntimeAdapter({ id: "claude-code" });
    const secondary = new MockRuntimeAdapter({ id: "codex", models: ["o4-mini"] });
    const registry = new RuntimeRegistry([primary, secondary]);
    const executor = createRuntimeExecutor({
      runtime: primary,
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry,
    });

    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(primary.requests).toHaveLength(0);
    expect(secondary.requests).toHaveLength(1);
    expect(secondary.requests[0].model).toBe("o4-mini");
  });

  // `routing.by_role` naming a runtime nobody registered fails closed before
  // any adapter starts, instead of quietly running somewhere the config did
  // not ask for.
  it("fails closed, naming the unregistered runtime, when routing.by_role names one nobody registered", async () => {
    const projectRoot = tmpProject();
    fs.mkdirSync(path.join(projectRoot, ".sta"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".sta", "config.yaml"),
      "schema_version: 1\nrouting:\n  by_role:\n    backend-engineer: ghost-runtime:some-model\n",
      "utf8",
    );
    const primary = new MockRuntimeAdapter({
      id: "claude-code",
      respond: () => okResult({ status: "ERROR", exitCode: 1, text: "boom" }),
    });
    const registry = new RuntimeRegistry([primary]);
    const executor = createRuntimeExecutor({
      runtime: primary,
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry,
    });

    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(primary.requests).toHaveLength(0);
    expect(result.outcome.result).toBe("FAIL");
    expect((result.outcome as { failure_reason?: string }).failure_reason).toContain("not registered");
    expect((result.outcome as { failure_reason?: string }).failure_reason).toContain("ghost-runtime");
  });
});

describe("createRuntimeExecutor — T-V6-014 routing.order at precedence level 4", () => {
  function orderedProject(routing: string): string {
    const projectRoot = tmpProject();
    writeAgentFile(projectRoot, "backend-engineer", "model: sonnet");
    fs.mkdirSync(path.join(projectRoot, ".sta"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".sta", "config.yaml"), routing, "utf8");
    return projectRoot;
  }

  const ORDER = "schema_version: 1\nrouting:\n  order: [claude-code, codex]\n  fallback_on: unavailable\n  allow_below_supported: [codex]\n";

  function pair(firstStatus: "UNAVAILABLE" | "ERROR" | "TIMEOUT", secondUnavailable = false) {
    const first = new MockRuntimeAdapter({
      id: "claude-code",
      models: ["sonnet"],
      respond: () => okResult({ status: firstStatus, exitCode: firstStatus === "UNAVAILABLE" ? null : 1, diagnostics: ["usage limit reached"] }),
    });
    const second = new MockRuntimeAdapter({
      id: "codex",
      models: ["sonnet"],
      respond: () => (secondUnavailable ? okResult({ status: "UNAVAILABLE", exitCode: null, diagnostics: ["codex quota exhausted"] }) : okResult()),
    });
    return { first, second };
  }

  function run(projectRoot: string, adapters: MockRuntimeAdapter[], over: Record<string, unknown> = {}) {
    return createRuntimeExecutor({
      runtime: adapters[0]!,
      registry: new RuntimeRegistry(adapters),
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      ...over,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-ORDER", context: [] });
  }

  it("[ACCEPTANCE] UNAVAILABLE hops to the next entry and records the hop", async () => {
    const { first, second } = pair("UNAVAILABLE");
    const result = await run(orderedProject(ORDER), [first, second]);

    expect(result.outcome).toMatchObject({
      result: "PASS",
      runtime: "codex",
      requested_runtime: "claude-code",
      routing_basis: "level-4;tier=runtime-default,model=legacy-frontmatter,effort=runtime-default",
      fallback_count: 1,
    });
    expect(result.outcome.fallback_reason).toContain("usage limit reached");
    expect(result.outcome.fallback_reason).toContain('moved this stage to "codex"');
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it.each(["ERROR", "TIMEOUT"] as const)("[ACCEPTANCE] %s never hops, even with an order configured", async (status) => {
    const { first, second } = pair(status);
    const result = await run(orderedProject(ORDER), [first, second]);

    expect(result.outcome).toMatchObject({ result: "FAIL", runtime: "claude-code", fallback_count: 0 });
    expect(result.outcome.fallback_reason).toBeUndefined();
    expect(second.requests).toEqual([]);
  });

  it("[ACCEPTANCE] exhaustion stops with every attempt named, and does not loop", async () => {
    const { first, second } = pair("UNAVAILABLE", true);
    const result = await run(orderedProject(ORDER), [first, second]);

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("routing.order is exhausted");
    expect(result.outcome.failure_reason).toContain("claude-code: usage limit reached");
    expect(result.outcome.failure_reason).toContain("codex: codex quota exhausted");
    expect(result.failure?.requiresHuman).toBe(true);
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it("exhaustion by availability probe escalates to a person rather than spending a retry", async () => {
    const projectRoot = orderedProject(ORDER);
    const first = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"], probe: { available: false, reason: "claude offline" } });
    const second = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"], probe: { available: false, reason: "codex offline" } });
    const result = await run(projectRoot, [first, second]);

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("routing.order is exhausted");
    expect(result.outcome.failure_reason).toContain("claude offline");
    expect(result.outcome.failure_reason).toContain("codex offline");
    expect(result.failure?.requiresHuman).toBe(true);
    expect(first.requests).toEqual([]);
    expect(second.requests).toEqual([]);
  });

  it("--runtime (level 1) wins outright — the order is not consulted", async () => {
    const { first, second } = pair("UNAVAILABLE");
    const result = await run(orderedProject(ORDER), [first, second], { routingFlags: { runtime: "claude-code" } });

    expect(result.outcome).toMatchObject({
      result: "FAIL",
      routing_basis: "level-1;tier=runtime-default,model=legacy-frontmatter,effort=runtime-default",
      fallback_count: 0,
    });
    expect(second.requests).toEqual([]);
  });

  it("routing.by_role (level 2) wins outright and still carries modelExplicit and effort", async () => {
    const config = `${ORDER}  by_role:\n    backend-engineer:\n      runtime: claude-code\n      model: opus\n      effort: high\n`;
    const first = new MockRuntimeAdapter({
      id: "claude-code",
      models: ["sonnet", "opus"],
      respond: () => okResult({ status: "UNAVAILABLE", exitCode: null, diagnostics: ["usage limit reached"] }),
    });
    const second = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] });
    const result = await run(orderedProject(config), [first, second]);

    expect(result.outcome).toMatchObject({
      result: "FAIL",
      routing_basis: "level-2;tier=runtime-default,model=operator-model,effort=operator-effort",
      fallback_count: 0,
    });
    expect(first.requests[0]).toMatchObject({ model: "opus", modelExplicit: true, effort: "high" });
    expect(second.requests).toEqual([]);
  });

  it("a config with no routing.order behaves exactly as today: one candidate, no hop", async () => {
    const { first, second } = pair("UNAVAILABLE");
    const result = await run(orderedProject("schema_version: 1\n"), [first, second]);

    expect(result.outcome).toMatchObject({ result: "FAIL", runtime: "claude-code", fallback_count: 0 });
    expect(result.outcome.fallback_reason).toBeUndefined();
    expect(result.failure?.requiresHuman).toBe(true);
    expect(second.requests).toEqual([]);
  });

  const sensitive = () => ({
    level: TaskLevel.MEDIUM,
    pipeline: [AgentStage.BACKEND_ENGINEER],
    requiresHumanApproval: false,
    sensitiveGate: true,
    reasons: [],
  });

  it("[ADR-025 #4] a switch inside a security-gate phase is written into qa.md and into the run log", async () => {
    const { first, second } = pair("UNAVAILABLE");
    second.workspace.files.set("_docs/module/sales-crm/qa.md", "# qa.md\n\n## Open Issues — all phases\n\n- none\n");
    const result = await run(orderedProject(ORDER), [first, second], { classification: sensitive });

    expect(result.outcome).toMatchObject({ result: "PASS", runtime: "codex", fallback_count: 1 });
    expect(result.outcome.fallback_reason).toContain("ADR-025 #4");

    const review = second.workspace.files.get("_docs/module/sales-crm/qa.md")!;
    expect(review).toContain("## Open Issues — all phases");
    expect(review).toContain("## Camp switch — verification invalidated");
    expect(review).toContain("claude-code → codex");
    expect(review).toContain("does not inherit this phase");
  });

  it("[ADR-025 #4] a switch whose invalidation cannot be recorded is refused, not laundered", async () => {
    const { first, second } = pair("UNAVAILABLE");
    vi.spyOn(second.workspace, "writeFile").mockRejectedValue(new Error("qa.md is read-only here"));
    const result = await run(orderedProject(ORDER), [first, second], { classification: sensitive });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("refusing the routing.order hop");
    expect(result.outcome.failure_reason).toContain("qa.md is read-only here");
    expect(result.outcome.fallback_count).toBe(0);
    expect(second.requests).toEqual([]);
  });

  it("[INTEGRATION] with Claude Code forced unavailable, the stage runs on antigravity and the log shows one hop", async () => {
    const projectRoot = orderedProject(
      "schema_version: 1\nrouting:\n  order: [claude-code, antigravity, codex]\n  fallback_on: unavailable\n  allow_below_supported: [antigravity, codex]\n",
    );
    const claude = new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"], probe: { available: false, reason: "usage limit reached for this subscription" } });
    const agy = new MockRuntimeAdapter({ id: "antigravity", models: ["sonnet"] });
    const codex = new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] });
    const result = await run(projectRoot, [claude, agy, codex]);

    expect(result.outcome).toMatchObject({
      result: "PASS",
      runtime: "antigravity",
      requested_runtime: "claude-code",
      routing_basis: "level-4;tier=runtime-default,model=legacy-frontmatter,effort=runtime-default",
      fallback_count: 1,
    });
    expect(result.outcome.fallback_reason).toContain("usage limit reached for this subscription");
    expect(agy.requests).toHaveLength(1);
    expect(claude.requests).toEqual([]);
    expect(codex.requests).toEqual([]);
  });

  it("a phase with no security gate hops without touching qa.md", async () => {
    const { first, second } = pair("UNAVAILABLE");
    const result = await run(orderedProject(ORDER), [first, second]);

    expect(result.outcome.fallback_count).toBe(1);
    expect(second.workspace.files.has("_docs/module/sales-crm/qa.md")).toBe(false);
  });
});

/**
 * V13 TASK-005 — the contract dispatch preflight: `resolveAuthoritativeContract`
 * runs before any guard/work-root resolution, refuses fail-closed on a
 * mismatch, and binds the digest it checked to every attempt (PASS or FAIL).
 */
describe("createRuntimeExecutor — contract dispatch preflight (V13 TASK-005)", () => {
  it("refuses dispatch, before any guard resolution, when the on-disk contract disagrees with the registry", async () => {
    const root = tmpProject();
    const contractFile = path.join(root, "contracts", "backend-engineer.yaml");
    const contract = fs.readFileSync(contractFile, "utf8").replace(
      "capabilities: [read, write_code, test]",
      "capabilities: [read, write_code, test, deploy]",
    );
    fs.writeFileSync(contractFile, contract, "utf8");
    const guards = vi.fn(() => NO_GUARDS);
    const runtime = new MockRuntimeAdapter({ respond: () => okResult() });
    const result = await createRuntimeExecutor({ runtime, projectRoot: root, moduleName: () => "sales-crm", guards })({
      stage: AgentStage.BACKEND_ENGINEER,
      taskId: "T-CONTRACT-MISMATCH",
      context: [],
    });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("disagrees with the registry");
    expect(guards).not.toHaveBeenCalled();
    expect(runtime.requests).toEqual([]);
  });

  it("refuses dispatch for a stage nobody wrote a contract for at all", async () => {
    const root = tmpProject();
    fs.rmSync(path.join(root, "contracts", "backend-engineer.yaml"));
    const guards = vi.fn(() => NO_GUARDS);
    const runtime = new MockRuntimeAdapter({ respond: () => okResult() });
    const result = await createRuntimeExecutor({ runtime, projectRoot: root, moduleName: () => "sales-crm", guards })({
      stage: AgentStage.BACKEND_ENGINEER,
      taskId: "T-CONTRACT-MISSING",
      context: [],
    });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("no contract file");
    expect(guards).not.toHaveBeenCalled();
  });

  it("binds the resolved contract digest — sha256 of the exact on-disk bytes — to a PASS outcome", async () => {
    const root = tmpProject();
    const expectedDigest = createHash("sha256").update(fs.readFileSync(path.join(root, "contracts", "backend-engineer.yaml"))).digest("hex");
    const runtime = new MockRuntimeAdapter({ respond: () => okResult() });
    const result = await executorFor(runtime, { projectRoot: root })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-CONTRACT-DIGEST", context: [] });
    expect(result.outcome.result).toBe("PASS");
    expect(result.outcome.contract_digest).toBe(expectedDigest);
    expect(expectedDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the resolved contract digest to a FAIL outcome too, not only a PASS", async () => {
    const root = tmpProject();
    const expectedDigest = createHash("sha256").update(fs.readFileSync(path.join(root, "contracts", "backend-engineer.yaml"))).digest("hex");
    const runtime = new MockRuntimeAdapter({ respond: () => ({ status: "ERROR" as const, exitCode: 1, text: "boom", usage: {}, guards: { enforced: [], unenforced: [] }, diagnostics: [] }) });
    const result = await executorFor(runtime, { projectRoot: root })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-CONTRACT-DIGEST-FAIL", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.contract_digest).toBe(expectedDigest);
  });

  it("stale contract attempt: refuses a retry/resume of this exact stage whose on-disk contract changed since the prior recorded attempt", async () => {
    const root = tmpProject();
    const guards = vi.fn(() => NO_GUARDS);
    const runtime = new MockRuntimeAdapter({ respond: () => okResult() });
    const result = await createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards,
      // Simulates a prior attempt of this exact stage recorded a digest that
      // no longer matches the freshly re-resolved on-disk contract — the
      // "role-run" evidence a retry/resume would find via
      // `contractDigestForStage(store.evidenceForTask(taskId), stage)`.
      priorContractDigest: () => "f".repeat(64),
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-STALE-CONTRACT", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain("changed since a prior attempt of this stage");
    expect(guards).not.toHaveBeenCalled();
    expect(runtime.requests).toEqual([]);
  });

  it("does not refuse when the prior recorded digest matches today's on-disk contract — the ordinary same-contract retry", async () => {
    const root = tmpProject();
    const digest = createHash("sha256").update(fs.readFileSync(path.join(root, "contracts", "backend-engineer.yaml"))).digest("hex");
    const runtime = new MockRuntimeAdapter({ respond: () => okResult() });
    const result = await executorFor(runtime, { projectRoot: root, priorContractDigest: () => digest })({
      stage: AgentStage.BACKEND_ENGINEER,
      taskId: "T-SAME-CONTRACT",
      context: [],
    });
    expect(result.outcome.result).toBe("PASS");
  });
});
