import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { ApprovalType } from "../gates/approval.js";
import { createRuntimeExecutor } from "./runtimeExecutor.js";
import { MockRuntimeAdapter, okResult } from "./mockAdapter.js";
import { NO_GUARDS, type RuntimeGuards } from "./runtimeAdapter.js";
import { GuardResolutionError } from "./runtimeGuards.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { RuntimeCapability } from "./runtimeCapabilities.js";
import { buildContextCommand } from "../context/contextCommand.js";
import { buildPromptParts } from "./agentRunAssembly.js";
import { auditTrail } from "../audit/auditTrail.js";
import type { RuntimeTask } from "../orchestrator/runtimeTask.js";
import { latestExecutionPacketPath, readExecutionPacket } from "../state/runtimeArtifacts.js";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "runtime-exec-"));
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

const PASSING_REVIEW = ["## Round 1 (FULL)", "- everything checks out ✅", "- 12 passed, 0 failed"].join("\n");

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
    const runtimeTask: RuntimeTask = {
      task_id: "T-PACKET",
      workflow: "bugfix",
      pm_mode: "lightweight",
      why: "persist packet",
      goal: "persist packet",
      source_of_truth: { status: "unavailable", paths: [], reason: "fixture" },
      dependencies: { task_ids: [], plan_readiness: "untracked", waiting_on: [], reason: "fixture" },
      scope: {
        status: "resolved",
        work_roots: [{
          stage: AgentStage.BACKEND_ENGINEER,
          target_id: "legacy",
          root,
          allow: [{ contract_glob: "server/**", effective_glob: path.join(root, "server", "**") }],
        }],
        reason: null,
      },
      do_not_touch: [".git/**"],
      acceptance_criteria: { status: "resolved", items: ["packet round-trips"], reason: null },
      required_verification: { status: "deferred", levels: [], reason: "fixture" },
      evidence_required: ["packet JSON"],
      stop_conditions: ["STOP on invalid packet"],
    };
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => ({ ...NO_GUARDS, writeAllow: ["server/**"] }),
      runtimeTask: () => runtimeTask,
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

  it("announces a GUARD GAP when exit checks were requested but the runtime enforces none in-band (T-OC7)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runtime = new MockRuntimeAdapter({
        respond: () =>
          okResult({
            guards: {
              enforced: [],
              unenforced: [RuntimeCapability.EXIT_GUARD],
              reason: "no verified Stop-hook equivalent",
            },
          }),
      });
      const executor = executorFor(runtime, {
        guards: () => ({ writeAllow: [], writeDeny: [], forbidCommands: [], exitChecks: ["code-green"] }),
      });
      await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("GUARD GAP"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("code-green"));
    } finally {
      errorSpy.mockRestore();
    }
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

    expect(runtime.requests[0].env?.AGENTCLAUDE_ROLE).toBe("qa-engineer");
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

  it("does not invoke a downstream agent when the opt-in T114 role handoff has not happened", async () => {
    const root = tmpProject();
    const runtime = new MockRuntimeAdapter();
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: root,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      enforceRoleWorkflow: true,
    });

    const result = await executor({ stage: AgentStage.SYSTEM_ANALYST, taskId: "T-114", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/no knowledge\/ directory/);
    expect(runtime.requests).toEqual([]);
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
  it("reads review.md out of the runtime's own workspace and produces a QA artifact", async () => {
    const runtime = new MockRuntimeAdapter({
      files: { "_docs/module/sales-crm/review.md": PASSING_REVIEW },
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
      files: { "_docs/module/sales-crm/review.md": PASSING_REVIEW },
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
    expect(fs.existsSync(path.join(root, "_docs", "module", "sales-crm", "review.md"))).toBe(false);
  });

  it("fails closed when the runtime reported success but no review.md exists", async () => {
    const runtime = new MockRuntimeAdapter();
    const result = await executorFor(runtime)({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.artifactType).toBeUndefined();
    expect(result.outcome.failure_reason).toMatch(/review\.md doesn't exist/);
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
        "_docs/module/sales-crm/design.md": "# Design\n\n## Orders Contract — DES-001\nrule\n",
        "_docs/module/sales-crm/plan.md": "# Plan\n\n## Phase 1: x\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-001 (DES-001) — x | pending | backend-engineer | — |\n",
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

  it("logs a derivation note but keeps a doc-stage run passing when optional references are absent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runtime = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/design.md": "# Design only\n" } });
      const result = await executorFor(runtime)({ stage: AgentStage.SYSTEM_ANALYST, taskId: "T-1", context: [] });
      expect(result.outcome.result).toBe("PASS");
      expect(result.artifactType).toBe(ArtifactType.HANDOFF);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("HANDOFF NOTE"));
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
    const runtime = new MockRuntimeAdapter({ files: { "_docs/module/sales-crm/review.md": failedReview } });

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
    for (let i = 0; i < maxSteps; i++) {
      const status = await orch.step(executor);
      if (status.kind === "WAITING_FOR_HUMAN") {
        const field = status.approvalType === ApprovalType.SCHEMA_CONFIRMATION ? "designApproved" : "humanApproved";
        orch.provideHumanApproval(field, true);
        continue;
      }
      if (status.kind === "DEPLOYED" || status.kind === "BLOCKED") return status;
    }
    throw new Error("runToCompletion exceeded maxSteps");
  }

  it("reaches DEPLOYED with no AI runtime installed and no knowledge of which adapter is behind the seam", async () => {
    const runtime = new MockRuntimeAdapter({
      id: "not-a-real-runtime",
      files: { "_docs/module/sales-crm/review.md": PASSING_REVIEW },
      respond: () => okResult({ usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } }),
    });

    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const orch = new Orchestrator("T-RUNTIME", classification);
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
      const runtime = new MockRuntimeAdapter({
        id: "claude-code",
        models: ["sonnet"],
        files: { "_docs/module/sales-crm/review.md": PASSING_REVIEW },
      });
      const orch = new Orchestrator(`T-COMPAT-${withRegistry ? "AFTER" : "BEFORE"}`, classification);
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
    const files = { "_docs/module/sales-crm/review.md": PASSING_REVIEW };
    const results: string[] = [];

    for (const id of ["claude-code", "codex"]) {
      const runtime = new MockRuntimeAdapter({ id, files });
      const orch = new Orchestrator(`T-${id}`, classifyTask({ isClearBugFix: true, touchesBackend: true }));
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

    const orch = new Orchestrator("T-UNAVAIL", classifyTask({ isClearBugFix: true, touchesBackend: true }));
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    });

    let status = await orch.step(executor);
    while (status.kind === "RUNNING") status = await orch.step(executor);

    expect(status.kind).toBe("BLOCKED");
    expect(orch.recovery?.kind).toBe("ESCALATE");
  });

  /**
   * Pinning a real limit rather than leaving it to be discovered later.
   *
   * The orchestrator consults a structured failure only at `qa-engineer` and
   * `security` (see `reportCompletion`'s `failureKind`); at any other stage a
   * FAIL simply advances the cursor. So the UNAVAILABLE/ERROR distinction is
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
  it("does not start a Target-write run when the runtime lacks a pre-tool guard", async () => {
    const runtime = new MockRuntimeAdapter({ id: "claude-code", capabilities: [RuntimeCapability.NAMED_AGENTS] });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const task = {
      taskId: "T-target",
      classification,
      targetBindings: { frontend_target: null, backend_target: "api" },
    } as never;
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      registry: new RuntimeRegistry([runtime]),
      threeRepoTask: () => ({ task, roots: { bindingRoot: "/framework", knowledgeRoot: "/knowledge", workRoots: [{ targetId: "api", path: "/api", access: "write" }] } }),
    });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-target", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain('runtime "claude-code"');
    expect(result.outcome.failure_reason).toContain(RuntimeCapability.PRE_TOOL_GUARD);
    expect(runtime.requests).toHaveLength(0);
  });

  it("passes canonical roots rather than using cwd as Target scope", async () => {
    const runtime = new MockRuntimeAdapter({ respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }) });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
    const task = { taskId: "T-target", classification, targetBindings: { frontend_target: null, backend_target: "api" } } as never;
    const executor = createRuntimeExecutor({ runtime, projectRoot: tmpProject(), moduleName: () => "sales-crm", guards: () => NO_GUARDS,
      threeRepoTask: () => ({ task, roots: { bindingRoot: "/framework", knowledgeRoot: "/knowledge", workRoots: [{ targetId: "api", path: "/api", access: "write" }] } }), });
    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-target", context: [] });
    expect(runtime.requests[0]).toMatchObject({ cwd: "/framework", bindingRoot: "/framework", knowledgeRoot: "/knowledge", workRoots: [{ targetId: "api", path: "/api", access: "write" }] });
    // T-WG7 — the Knowledge root rides on the env so hooks/prompts can name it.
    expect(runtime.requests[0]!.env).toMatchObject({ AGENTCLAUDE_ROLE: "backend-engineer", AGENTCLAUDE_KNOWLEDGE_ROOT: "/knowledge" });
  });

  it("T-V1-16 two-Target isolation: the guard env carries only the write-access root, never the read-only sibling", async () => {
    const runtime = new MockRuntimeAdapter({ respond: () => okResult({ guards: { enforced: [RuntimeCapability.PRE_TOOL_GUARD], unenforced: [] } }) });
    const classification = classifyTask({ isClearBugFix: true, touchesBackend: true, touchesFrontend: true });
    const task = { taskId: "T-two", classification, targetBindings: { frontend_target: "web", backend_target: "api" } } as never;
    const workRoots = [
      { targetId: "api", path: "/repos/api", access: "write" as const },
      { targetId: "web", path: "/repos/web", access: "read" as const },
    ];
    const executor = createRuntimeExecutor({
      runtime,
      projectRoot: tmpProject(),
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
      threeRepoTask: () => ({ task, roots: { bindingRoot: "/framework", knowledgeRoot: "/knowledge", workRoots } }),
    });
    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-two", context: [] });
    const writable = JSON.parse(runtime.requests[0]!.env!.AGENTCLAUDE_WRITABLE_WORK_ROOTS!);
    expect(writable).toEqual(["/repos/api"]);
    expect(JSON.stringify(writable)).not.toContain("/repos/web");
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
      routing_basis: "level-4",
      fallback_count: 0,
    });
  });

  it("keeps a cast task on its frontmatter model when model-tiers.yaml is absent", async () => {
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
    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-NO-TIER-TABLE", context: [] });
    expect(runtime.requests[0]).toMatchObject({ model: "sonnet", modelExplicit: false, effort: undefined });
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

  // T-V5-040 — the support-level gate survives the routing collapse: it now
  // guards the one automatic route (precedence 4, the named default runner),
  // which is the only route nobody chose explicitly.
  it("refuses an automatic preview route before either adapter starts", async () => {
    const projectRoot = tmpProject();
    const preview = new MockRuntimeAdapter({ id: "codex" });
    const other = new MockRuntimeAdapter({ id: "claude-code" });
    const result = await createRuntimeExecutor({
      runtime: preview,
      registry: new RuntimeRegistry([preview, other]),
      projectRoot,
      moduleName: () => "sales-crm",
      guards: () => NO_GUARDS,
    })({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-SUPPORT-GATE", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toContain('support level "preview"');
    expect(preview.requests).toEqual([]);
    expect(other.requests).toEqual([]);
  });

  it("lets routing.allow_below_supported opt one runtime past the automatic support gate", async () => {
    const projectRoot = tmpProject();
    fs.mkdirSync(path.join(projectRoot, ".sta"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".sta", "config.yaml"), "schema_version: 1\nrouting:\n  allow_below_supported: [codex]\n", "utf8");
    const preview = new MockRuntimeAdapter({ id: "codex" });
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

  // T-V5-040 — the handoff candidate chain is gone: an unavailable route stops
  // the stage rather than executing a different runtime, and the second
  // registered adapter is never reached.
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

  // T-V5-040 — the legacy `model_routing` spelling and its
  // unregistered-runtime-to-default fallback are removed. `routing.by_role`
  // naming a runtime nobody registered now fails closed before any adapter
  // starts, instead of quietly running somewhere the config did not ask for.
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
