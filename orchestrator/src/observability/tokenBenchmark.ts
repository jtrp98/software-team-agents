import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderTokenBenchmarkMarkdown } from "../codeintel/benchmark.js";
import { ContextManager } from "../context/contextManager.js";
import { renderSlicedDocs, buildPromptParts } from "../runtime/agentRunAssembly.js";
import { AgentStage } from "../types.js";

export const TOKEN_BENCHMARK_DOC_BYTES = {
  design: 67_000,
  plan: 17_000,
  requirement: 12_000,
  review: 3_400,
  testPlan: 1_200,
} as const;

export interface TokenBenchmarkRow {
  workload: "Small" | "Medium" | "Large";
  inputTokens: number;
  outputTokens: null;
  totalTokens: number;
  modelCalls: number;
  filesOpened: number;
  docBytes: number;
  retries: number;
  qualityGatesPassed: null;
}

const WORKLOAD_STAGES: Record<TokenBenchmarkRow["workload"], readonly AgentStage[]> = {
  Small: [AgentStage.BACKEND_ENGINEER], // workflows/typo.yml, backend branch
  Medium: [AgentStage.SYSTEM_ANALYST, AgentStage.TEST_PLANNER, AgentStage.BACKEND_ENGINEER, AgentStage.UXUI_DESIGNER, AgentStage.FRONTEND_ENGINEER, AgentStage.QA_ENGINEER, AgentStage.SECURITY],
  Large: [AgentStage.BUSINESS_ANALYST, AgentStage.SYSTEM_ANALYST, AgentStage.PROJECT_MANAGER, AgentStage.TEST_PLANNER, AgentStage.BACKEND_ENGINEER, AgentStage.UXUI_DESIGNER, AgentStage.FRONTEND_ENGINEER, AgentStage.QA_ENGINEER, AgentStage.SECURITY],
};

function fixedDocument(seed: string, bytes: number): string {
  if (seed.length > bytes) throw new Error(`fixture seed exceeds fixed size ${bytes}`);
  return `${seed}${"x".repeat(bytes - seed.length)}`;
}

function fixedDesignDocument(bytes: number): string {
  // 19 KB is a Data Model block (not read by BE/FE); 21 KB is a Feasibility
  // Summary (not read by any consumer under the current slicer). The rest is
  // retained module content. This pins the audit's observed slice behaviour
  // instead of accidentally benchmarking either an all-kept or all-dropped
  // synthetic design document.
  return fixedDocument(
    `# Design\n\n## Feature-by-feature\nPinned feature contract.\n\n## Data Model\n${"d".repeat(19_000)}\n\n## Risks & Dependencies\nPinned risks.\n\n## Open Questions\nNone.\n\n## Feasibility Summary\n${"f".repeat(21_000)}\n\n## Modules\n`,
    bytes,
  );
}

/** Materializes the five pinned module-doc fixtures at their exact byte/character counts. */
export function createTokenBenchmarkFixture(root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-token-benchmark-")), moduleName = "token-fixture"): { root: string; moduleName: string } {
  const dir = path.join(root, "_docs", "module", moduleName);
  fs.mkdirSync(dir, { recursive: true });
  const docs: Record<string, string> = {
    "requirement.md": fixedDocument("# Requirement\n\n## Scope\nPinned benchmark requirement.\n\n## References\nFixture.\n\n", TOKEN_BENCHMARK_DOC_BYTES.requirement),
    "design.md": fixedDesignDocument(TOKEN_BENCHMARK_DOC_BYTES.design),
    "plan.md": fixedDocument("# Plan\n\n## Plan Summary\nPinned plan.\n\n## Phase 1: Delivery\nPinned work.\n\n## Sequencing Notes\nPinned.\n\n## Open Questions\nNone.\n\n", TOKEN_BENCHMARK_DOC_BYTES.plan),
    "review.md": fixedDocument("# Review\n\n## Open Issues\nNone.\n\n## Round 1\nPinned review.\n\n", TOKEN_BENCHMARK_DOC_BYTES.review),
    "test-plan.md": fixedDocument("# Test Plan\n\n## Coverage\nPinned tests.\n\n", TOKEN_BENCHMARK_DOC_BYTES.testPlan),
  };
  for (const [name, content] of Object.entries(docs)) fs.writeFileSync(path.join(dir, name), content, "utf8");
  return { root, moduleName };
}

function staticChars(frameworkRoot: string, stage: AgentStage): number {
  const chars = (file: string): number => fs.readFileSync(file, "utf8").length;
  const policyRoot = path.join(frameworkRoot, "policies");
  const policies = fs.readdirSync(policyRoot, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).reduce((sum, entry) => sum + chars(path.join(policyRoot, entry.name)), 0);
  return chars(path.join(frameworkRoot, "CLAUDE.md")) + policies + chars(path.join(frameworkRoot, ".claude", "agents", `${stage}.md`));
}

/** Deterministically estimates the current pipeline's input floor from pinned docs and current managed sources. */
export function runTokenBenchmark(frameworkRoot: string): TokenBenchmarkRow[] {
  const fixture = createTokenBenchmarkFixture();
  try {
    return (Object.keys(WORKLOAD_STAGES) as TokenBenchmarkRow["workload"][]).map((workload) => {
      let inputChars = 0;
      let docBytes = 0;
      let filesOpened = 0;
      for (const stage of WORKLOAD_STAGES[workload]) {
        const cm = new ContextManager({ projectRoot: fixture.root, moduleName: fixture.moduleName });
        const selected = cm.forStage(stage);
        const renderedDocs = renderSlicedDocs(selected, cm);
        docBytes += selected.reduce((sum, doc) => sum + doc.text.length, 0);
        filesOpened += selected.length;
        inputChars += staticChars(frameworkRoot, stage) + buildPromptParts({ taskId: `${workload}-fixture`, stage, context: [] }, undefined, { docs: renderedDocs }).text.length;
      }
      const inputTokens = Math.ceil(inputChars / 4);
      return { workload, inputTokens, outputTokens: null, totalTokens: inputTokens, modelCalls: WORKLOAD_STAGES[workload].length, filesOpened, docBytes, retries: 0, qualityGatesPassed: null };
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

export function renderTokenBenchmarkBaseline(frameworkRoot: string, date: string): string {
  return `${renderTokenBenchmarkMarkdown(runTokenBenchmark(frameworkRoot), { date })}\n`;
}
