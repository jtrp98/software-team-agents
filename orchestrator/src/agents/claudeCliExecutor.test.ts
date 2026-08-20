import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { createClaudeCliExecutor, type SpawnSync } from "./claudeCliExecutor.js";

function cliResult(status: number, stdout: string): SpawnSyncReturns<string> {
  return { status, stdout, stderr: "", error: undefined, pid: 1, output: [], signal: null } as unknown as SpawnSyncReturns<string>;
}

function fakeCli(result: object, status = 0): SpawnSync {
  return () => cliResult(status, JSON.stringify(result));
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-exec-"));
}

describe("createClaudeCliExecutor", () => {
  it("invokes `claude -p --agent <role>` and reports PASS on a doc-only stage", async () => {
    let capturedArgs: string[] = [];
    const spawnSync: SpawnSync = (_cmd, args) => {
      capturedArgs = args;
      return cliResult(0, JSON.stringify({ is_error: false, result: "done", total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 50 } }));
    };

    const root = tmpProject();
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.BUSINESS_ANALYST, taskId: "T-1", context: [] });

    expect(capturedArgs).toContain("--agent");
    expect(capturedArgs).toContain("business-analyst");
    expect(result.outcome.result).toBe("PASS");
    expect(result.outcome.tokens).toBe(150);
  });

  it("fails when the CLI exits non-zero", async () => {
    const spawnSync = fakeCli({ is_error: true, result: "boom" }, 1);
    const root = tmpProject();
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
    expect(result.outcome.result).toBe("FAIL");
  });

  it("qa-engineer stage reads review.md back and produces a validated QA_REPORT artifact", async () => {
    const root = tmpProject();
    const modDir = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, "review.md"),
      ["## Round 1 (FULL)", "- everything checks out ✅", "- 12 passed, 0 failed"].join("\n"),
    );

    const spawnSync = fakeCli({ is_error: false, result: "wrote review.md" });
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("PASS");
    expect(result.artifactType).toBe(ArtifactType.QA_REPORT);
    expect((result.artifact as { status: string }).status).toBe("PASS");
  });

  it("qa-engineer stage fails closed when review.md is missing even if the CLI reported success", async () => {
    const root = tmpProject();
    const spawnSync = fakeCli({ is_error: false, result: "claims done" });
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.artifactType).toBeUndefined();
  });

  it("security stage reads security.md back and produces a validated SECURITY_REPORT artifact", async () => {
    const root = tmpProject();
    const modDir = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, "security.md"),
      ["## Open Findings — all rounds", "- SEC-1 🟡 Minor — cosmetic — 🔵 Open"].join("\n"),
    );

    const spawnSync = fakeCli({ is_error: false, result: "wrote security.md" });
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.SECURITY, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("PASS");
    expect(result.artifactType).toBe(ArtifactType.SECURITY_REPORT);
  });

  it("propagates a spawn-level error as a FAIL instead of throwing", async () => {
    const spawnSync: SpawnSync = () => {
      throw new Error("ENOENT: claude not found");
    };
    const root = tmpProject();
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.SETUP, taskId: "T-1", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.failure_reason).toMatch(/failed to spawn/);
  });
});

describe("execution log metadata (T26/T28)", () => {
  function writeAgentFile(root: string, role: string, model: string) {
    const dir = path.join(root, ".claude", "agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${role}.md`), `---\nname: ${role}\nmodel: ${model}\n---\n\nbody\n`, "utf8");
  }

  it("resolves the stage's model from its own .claude/agents/<role>.md frontmatter", async () => {
    const root = tmpProject();
    writeAgentFile(root, "backend-engineer", "sonnet");
    const spawnSync = fakeCli({ is_error: false, result: "done", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } });
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
    expect(result.outcome.model).toBe("sonnet");
  });

  it("reports model: undefined (not a guess) when the agent file doesn't exist", async () => {
    const root = tmpProject();
    const spawnSync = fakeCli({ is_error: false, result: "done" });
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
    expect(result.outcome.model).toBeUndefined();
  });

  it("splits input/output tokens and carries cache_read_tokens through from the CLI's own usage report", async () => {
    const root = tmpProject();
    const spawnSync = fakeCli({
      is_error: false,
      result: "done",
      total_cost_usd: 0.05,
      usage: { input_tokens: 8000, output_tokens: 500, cache_read_input_tokens: 6000 },
    });
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.BUSINESS_ANALYST, taskId: "T-1", context: [] });
    expect(result.outcome.input_tokens).toBe(8000);
    expect(result.outcome.output_tokens).toBe(500);
    expect(result.outcome.cache_read_tokens).toBe(6000);
    expect(result.outcome.tokens).toBe(8500);
  });

  it("records context_chars as the length of the prompt actually sent", async () => {
    const root = tmpProject();
    const spawnSync = fakeCli({ is_error: false, result: "done" });
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.BUSINESS_ANALYST, taskId: "T-1", context: [{ source: ArtifactType.REQUIREMENTS, content: "x".repeat(500) }] });
    expect(result.outcome.context_chars).toBeGreaterThan(500);
  });

  it("still reports model/context_chars on a FAIL outcome, not just PASS", async () => {
    const root = tmpProject();
    writeAgentFile(root, "backend-engineer", "sonnet");
    const spawnSync = fakeCli({ is_error: true, result: "boom" }, 1);
    const executor = createClaudeCliExecutor({ projectRoot: root, moduleName: () => "sales-crm", spawnSync });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });
    expect(result.outcome.result).toBe("FAIL");
    expect(result.outcome.model).toBe("sonnet");
    expect(result.outcome.context_chars).toBeGreaterThan(0);
  });
});


describe("module-doc slicing in the prompt (T05)", () => {
  const PLAN = [
    "# แผนงาน sales-crm",
    "",
    "## Plan Summary",
    "สองเฟส",
    "",
    "## Phase 1: Auth",
    "- [x] BE-001 login",
    "",
    "## Phase 2: Import",
    "- [ ] BE-010 CSV import",
    "",
    "## Sequencing Notes",
    "Phase 2 รอ Phase 1",
    "",
    "## Change Log",
    "- 2026-08-01 created",
    "",
  ].join(String.fromCharCode(10));

  function projectWithPlan(): string {
    const root = tmpProject();
    const dir = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan.md"), PLAN, "utf8");
    return root;
  }

  /** Captures the prompt the CLI would have been given. */
  function capturePrompt(root: string, extra: Record<string, unknown> = {}) {
    let prompt = "";
    const spawnSync: SpawnSync = (_cmd, args) => {
      prompt = args[args.length - 1];
      return cliResult(0, JSON.stringify({ is_error: false, result: "ok" }));
    };
    const executor = createClaudeCliExecutor({
      projectRoot: root,
      moduleName: () => "sales-crm",
      spawnSync,
      ...extra,
    });
    return { executor, prompt: () => prompt };
  }

  it("sends this run's phase and withholds the others", async () => {
    const { executor, prompt } = capturePrompt(projectWithPlan(), { phases: () => [2] });
    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(prompt()).toContain("BE-010 CSV import");
    expect(prompt()).not.toContain("BE-001 login");
    expect(prompt()).toContain("Sequencing Notes");
  });

  /**
   * The safety valve: an agent handed a subset with no note of what is missing
   * cannot tell a dropped section from one that never existed.
   */
  it("names the sections it withheld, and where the full file is", async () => {
    const root = projectWithPlan();
    const { executor, prompt } = capturePrompt(root, { phases: () => [2] });
    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(prompt()).toContain("Sections not included:");
    expect(prompt()).toContain("Phase 1: Auth");
    expect(prompt()).toContain(path.join(root, "_docs", "module", "sales-crm", "plan.md"));
  });

  it("sends the plan whole when no phase is known, rather than slicing it wrong", async () => {
    const { executor, prompt } = capturePrompt(projectWithPlan());
    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(prompt()).toContain("BE-010 CSV import");
    expect(prompt()).toContain("BE-001 login");
  });

  it("sends no module docs at all when slicing is turned off", async () => {
    const { executor, prompt } = capturePrompt(projectWithPlan(), { sliceModuleDocs: false, phases: () => [2] });
    await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(prompt()).not.toContain("BE-010 CSV import");
  });

  it("still runs when the module folder has no docs — the context is additive, never required", async () => {
    const { executor, prompt } = capturePrompt(tmpProject(), { phases: () => [2] });
    const result = await executor({ stage: AgentStage.BACKEND_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("PASS");
    expect(prompt()).not.toContain("Module documents");
  });

  it("respects the stage's context policy — setup never receives plan.md", async () => {
    const { executor, prompt } = capturePrompt(projectWithPlan(), { phases: () => [2] });
    await executor({ stage: AgentStage.SETUP, taskId: "T-1", context: [] });

    expect(prompt()).not.toContain("BE-010 CSV import");
  });
});


describe("structured failure on a failed round (T06)", () => {
  function projectWithDocs(docs: Record<string, string>): string {
    const root = tmpProject();
    const dir = path.join(root, "_docs", "module", "sales-crm");
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(docs)) fs.writeFileSync(path.join(dir, name), body, "utf8");
    return root;
  }

  const FAILED_REVIEW = [
    "# review",
    "",
    "## Open Issues — all phases",
    "| issue | phase | routes to | blocking | rounds |",
    "|---|---|---|---|---|",
    "| BE-004 response shape ไม่ตรง design | Phase 2 | backend-engineer | blocking | 1 |",
    "",
    "## Verification Summary (current round)",
    "Phase 2 (FULL) ❌ ไม่ผ่าน",
    "",
  ].join(String.fromCharCode(10));

  it("attaches the owner qa-engineer named, so routing is not a guess", async () => {
    const root = projectWithDocs({ "review.md": FAILED_REVIEW });
    const executor = createClaudeCliExecutor({
      projectRoot: root,
      moduleName: () => "sales-crm",
      spawnSync: fakeCli({ is_error: false, result: "done" }),
    });
    const result = await executor({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.failure?.owner).toBe(AgentStage.BACKEND_ENGINEER);
    expect(result.failure?.category).toBe("implementation");
    expect(result.failure?.affected).toContain("BE-004");
  });

  it("attaches no failure when the round passed", async () => {
    const passing = ["# review", "", "## Open Issues — all phases", "(ไม่มี)", "", "## Round 1 (FULL)", "✅ ผ่าน 12 passed", ""].join(String.fromCharCode(10));
    const root = projectWithDocs({ "review.md": passing });
    const executor = createClaudeCliExecutor({
      projectRoot: root,
      moduleName: () => "sales-crm",
      spawnSync: fakeCli({ is_error: false, result: "done" }),
    });
    const result = await executor({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("PASS");
    expect(result.failure).toBeUndefined();
  });

  it("escalates instead of routing when review.md names no owner", async () => {
    const vague = ["# review", "", "## Open Issues — all phases", "", "## Round 1 (FULL)", "❌ ไม่ผ่าน", ""].join(String.fromCharCode(10));
    const root = projectWithDocs({ "review.md": vague });
    const executor = createClaudeCliExecutor({
      projectRoot: root,
      moduleName: () => "sales-crm",
      spawnSync: fakeCli({ is_error: false, result: "done" }),
    });
    const result = await executor({ stage: AgentStage.QA_ENGINEER, taskId: "T-1", context: [] });

    expect(result.failure?.category).toBe("unknown");
    expect(result.failure?.requiresHuman).toBe(true);
  });

  it("attaches an unresolved security finding as a human stop", async () => {
    const securityMd = ["# security", "", "## Open Findings — all rounds", "- 🔴 🔵 SEC-001 JWT ไม่ verify signature", ""].join(String.fromCharCode(10));
    const root = projectWithDocs({ "security.md": securityMd });
    const executor = createClaudeCliExecutor({
      projectRoot: root,
      moduleName: () => "sales-crm",
      spawnSync: fakeCli({ is_error: false, result: "done" }),
    });
    const result = await executor({ stage: AgentStage.SECURITY, taskId: "T-1", context: [] });

    expect(result.outcome.result).toBe("FAIL");
    expect(result.failure?.requiresHuman).toBe(true);
    expect(result.failure?.severity).toBe("critical");
  });
});
