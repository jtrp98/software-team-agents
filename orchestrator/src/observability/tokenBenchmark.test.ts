import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ContextManager } from "../context/contextManager.js";
import { AgentStage } from "../types.js";
import { TOKEN_BENCHMARK_DOC_BYTES, createTokenBenchmarkFixture, createTraceableTokenBenchmarkFixture, renderTokenBenchmarkBaseline, runExecutionPacketPromptBenchmark, runLargeHandoffBenchmark, runTokenBenchmark } from "./tokenBenchmark.js";
import { compareTokenBaselines } from "../qa/metrics.js";

function frameworkFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-token-framework-"));
  fs.mkdirSync(path.join(root, "policies"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "c".repeat(40));
  fs.writeFileSync(path.join(root, "policies", "policy.md"), "p".repeat(20));
  for (const agent of ["business-analyst", "system-analyst", "project-manager", "test-planner", "backend-engineer", "uxui-designer", "frontend-engineer", "qa-engineer", "security"]) fs.writeFileSync(path.join(root, ".claude", "agents", `${agent}.md`), "a".repeat(10));
  return root;
}

describe("T-V3TOK-004 token benchmark", () => {
  it("materializes exact, repeatable module-doc fixture sizes", () => {
    const fixture = createTokenBenchmarkFixture();
    try {
      const dir = path.join(fixture.root, "_docs", "module", fixture.moduleName);
      expect(fs.readFileSync(path.join(dir, "design.md"), "utf8").length).toBe(TOKEN_BENCHMARK_DOC_BYTES.design);
      expect(fs.readFileSync(path.join(dir, "plan.md"), "utf8").length).toBe(TOKEN_BENCHMARK_DOC_BYTES.plan);
      expect(fs.readFileSync(path.join(dir, "requirement.md"), "utf8").length).toBe(TOKEN_BENCHMARK_DOC_BYTES.requirement);
      expect(fs.readFileSync(path.join(dir, "review.md"), "utf8").length).toBe(TOKEN_BENCHMARK_DOC_BYTES.review);
      expect(fs.readFileSync(path.join(dir, "test-plan.md"), "utf8").length).toBe(TOKEN_BENCHMARK_DOC_BYTES.testPlan);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("produces the three workload baselines deterministically with unknown live-only metrics left null", () => {
    const root = frameworkFixture();
    try {
      expect(runTokenBenchmark(root)).toEqual(runTokenBenchmark(root));
      const output = renderTokenBenchmarkBaseline(root, "2026-08-26");
      expect(output).toContain("| Large |");
      expect(output).toContain("not reported");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("P3B traceable fixture meets design and requirement targets without changing P0 file sizes", () => {
    const fixture = createTraceableTokenBenchmarkFixture();
    try {
      const cm = new ContextManager({ projectRoot: fixture.root, moduleName: fixture.moduleName });
      const design = cm.read(AgentStage.BACKEND_ENGINEER, "design", [1])!;
      const requirement = cm.read(AgentStage.BACKEND_ENGINEER, "requirement", [1])!;
      expect(design.bytesBefore).toBe(TOKEN_BENCHMARK_DOC_BYTES.design);
      expect(requirement.bytesBefore).toBe(TOKEN_BENCHMARK_DOC_BYTES.requirement);
      expect(design.bytesAfter / design.bytesBefore).toBeLessThanOrEqual(0.45);
      expect(requirement.bytesAfter / requirement.bytesBefore).toBeLessThanOrEqual(0.6);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("P6 Large workload measures the real handoff prompt path and meets amplification limits", () => {
    const root = frameworkFixture();
    try {
      const comparison = runLargeHandoffBenchmark(root);
      expect(comparison).toEqual(runLargeHandoffBenchmark(root));
      expect(comparison.withHandoff.docChars).toBeLessThan(comparison.withoutHandoff.docChars);
      expect(comparison.withHandoff.designAmplification).toBeLessThanOrEqual(2);
      expect(comparison.withHandoff.requirementAmplification).toBeLessThanOrEqual(3);
      expect(comparison.withHandoff.totalAmplification).toBeLessThanOrEqual(2.5);
      expect(comparison.withHandoff.retries).toBe(0);
      expect(comparison.withHandoff.routeBacks).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("T-V3R-020 keeps the ExecutionPacket prompt-character regression within 3%", () => {
    const root = frameworkFixture();
    try {
      const benchmark = runExecutionPacketPromptBenchmark(root);
      const repeat = runExecutionPacketPromptBenchmark(root);
      const delta = compareTokenBaselines(
        { promptCharacters: benchmark.beforePromptCharacters },
        { promptCharacters: benchmark.afterPromptCharacters },
      );

      expect(benchmark).toEqual(repeat);
      expect(benchmark.afterPromptCharacters).toBeGreaterThan(benchmark.beforePromptCharacters);
      expect(delta.promptCharacterDeltaPct).not.toBeNull();
      expect(delta.promptCharacterDeltaPct!).toBeLessThanOrEqual(3);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
