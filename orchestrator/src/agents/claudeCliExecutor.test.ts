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
