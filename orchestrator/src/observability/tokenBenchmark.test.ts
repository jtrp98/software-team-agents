import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TOKEN_BENCHMARK_DOC_BYTES, createTokenBenchmarkFixture, renderTokenBenchmarkBaseline, runTokenBenchmark } from "./tokenBenchmark.js";

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
});
