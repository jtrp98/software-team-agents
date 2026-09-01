import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveHandoff } from "../agents/moduleDocs.js";
import { ArtifactType, type HandoffArtifact } from "../artifacts/schemas.js";
import { renderTokenBenchmarkMarkdown } from "../codeintel/benchmark.js";
import { ContextManager } from "../context/contextManager.js";
import { estimateInputTokens } from "../context/contextBudget.js";
import { renderSlicedDocs, buildPromptParts, compileExecutionPacket, sliceModuleDocsWithSavings } from "../runtime/agentRunAssembly.js";
import type { RuntimeTask } from "../orchestrator/runtimeTask.js";
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

export interface LargeHandoffBenchmarkSnapshot {
  /** Raw authoritative document characters selected across the nine-stage pipeline. */
  docChars: number;
  /** Total input characters: managed static files plus buildPromptParts() output. */
  promptChars: number;
  /** HANDOFF plus rendered document context inside those prompts. */
  contextChars: number;
  handoffChars: number;
  designChars: number;
  requirementChars: number;
  totalAmplification: number;
  designAmplification: number;
  requirementAmplification: number;
  retries: number;
  routeBacks: number;
}

export interface LargeHandoffBenchmarkComparison {
  withoutHandoff: LargeHandoffBenchmarkSnapshot;
  withHandoff: LargeHandoffBenchmarkSnapshot;
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

function fixedMiddleDocument(prefix: string, suffix: string, bytes: number, fill = "x"): string {
  const padding = bytes - prefix.length - suffix.length;
  if (padding < 0) throw new Error(`fixture seed exceeds fixed size ${bytes}`);
  return `${prefix}${fill.repeat(padding)}${suffix}`;
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
    "test-plan.md": fixedDocument("# Test Plan\n\n## Coverage\nTP-001 covers DES-001.\n\n", TOKEN_BENCHMARK_DOC_BYTES.testPlan),
  };
  for (const [name, content] of Object.entries(docs)) fs.writeFileSync(path.join(dir, name), content, "utf8");
  return { root, moduleName };
}

/**
 * Same exact P0 document sizes, but with a complete REQ → DES → phase graph.
 * It also has an explicitly headed legacy appendix. P3B must keep that unknown
 * section; P6 may remove it only when a validated handoff supplies the
 * narrower task index, so the fixture measures both safety postures.
 */
export function createTraceableTokenBenchmarkFixture(
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-token-trace-benchmark-")),
  moduleName = "token-fixture",
): { root: string; moduleName: string } {
  const dir = path.join(root, "_docs", "module", moduleName);
  fs.mkdirSync(dir, { recursive: true });
  const requirementPrefix = [
    "# Requirement\n\n## Overview\nPinned.\n\n## Target Users & Roles\nAdmin.\n\n## Core Features\n| Rule | Detail |\n|---|---|\n| REQ-001 | selected import |\n| REQ-002 | ",
  ].join("");
  const requirementSuffix = [
    " |\n| REQ-003 | later archive |\n\n## Scope — MVP vs Nice-to-have\nPinned scope.\n\n## Constraints & Assumptions\nPinned.\n\n## Open Questions\nNone.\n\n## Declined / Not Pursuing\nNone.\n\n## References\nFixture.\n\n## Change Log\n- 2026-08-27\n",
  ].join("");
  const requirement = fixedMiddleDocument(requirementPrefix, requirementSuffix, TOKEN_BENCHMARK_DOC_BYTES.requirement, "q");

  const designPrefix = [
    "# Design\n\n## Feature-by-Feature Feasibility\nDES-001 covers REQ-001\nDES-002 covers REQ-002\nDES-003 covers REQ-003\n\n",
    "## Import Contract — DES-001\n", "i".repeat(8_000), "\n\n",
    "## Data Model\n", "d".repeat(5_000), "\n\n",
    `## Modules\n### ${moduleName}\nselected module\n### other-module\n`, "m".repeat(4_000), "\n\n",
    "## Risks & Dependencies\nPinned risks.\n\n## Open Questions\nNone.\n\n## Change Log\n- 2026-08-27\n\n",
    "## Legacy Design Appendix\n", "l".repeat(5_000), "\n\n",
    "## Reporting Contract — DES-002\n",
  ].join("");
  const design = fixedDocument(designPrefix, TOKEN_BENCHMARK_DOC_BYTES.design);

  const planPrefix = [
    "# Plan\n\n## Plan Summary\nPinned.\n\n",
    "## Phase 1: Import\n| Task | Status | Owner | Depends on | Produces | Consumes |\n|---|---|---|---|---|---|\n| BE-001 (DES-001) — import | pending | backend-engineer | — | design.md#Import-Contract-%E2%80%94-DES-001 | — |\n\n",
    "## Open Questions\nNone.\n\n",
    "## Phase 2: Reporting\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| BE-002 (DES-002) — report | pending | backend-engineer | BE-001 |\n| FE-003 (DES-003) — archive | pending | frontend-engineer | BE-002 |\n",
  ].join("");
  const plan = fixedDocument(planPrefix, TOKEN_BENCHMARK_DOC_BYTES.plan);
  const docs: Record<string, string> = {
    "requirement.md": requirement,
    "design.md": design,
    "plan.md": plan,
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
      const inputTokens = estimateInputTokens(inputChars);
      return { workload, inputTokens, outputTokens: null, totalTokens: inputTokens, modelCalls: WORKLOAD_STAGES[workload].length, filesOpened, docBytes, retries: 0, qualityGatesPassed: null };
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function largeHandoffs(fixture: { root: string; moduleName: string }): Partial<Record<AgentStage, HandoffArtifact>> {
  const moduleDir = path.join(fixture.root, "_docs", "module", fixture.moduleName);
  const read = (name: string): string => fs.readFileSync(path.join(moduleDir, name), "utf8");
  const options = { taskId: "BE-001", phases: [1] };
  const ba = deriveHandoff(AgentStage.BUSINESS_ANALYST, fixture.moduleName, read("requirement.md"), undefined, options).artifact;
  const sa = deriveHandoff(AgentStage.SYSTEM_ANALYST, fixture.moduleName, read("design.md"), undefined, options).artifact;
  const pm = deriveHandoff(AgentStage.PROJECT_MANAGER, fixture.moduleName, read("plan.md"), read("plan.md"), options).artifact;
  const tests = deriveHandoff(AgentStage.TEST_PLANNER, fixture.moduleName, read("test-plan.md"), undefined, options).artifact;
  const ux = deriveHandoff(AgentStage.UXUI_DESIGNER, fixture.moduleName, "# UX\n\n## Import flow UX-001\n", undefined, options).artifact;
  return {
    [AgentStage.SYSTEM_ANALYST]: ba,
    [AgentStage.PROJECT_MANAGER]: sa,
    [AgentStage.TEST_PLANNER]: pm,
    [AgentStage.BACKEND_ENGINEER]: tests,
    [AgentStage.UXUI_DESIGNER]: tests,
    [AgentStage.FRONTEND_ENGINEER]: ux,
    [AgentStage.QA_ENGINEER]: ux,
    [AgentStage.SECURITY]: ux,
  };
}

function largeSnapshot(
  frameworkRoot: string,
  fixture: { root: string; moduleName: string },
  handoffs: Partial<Record<AgentStage, HandoffArtifact>>,
): LargeHandoffBenchmarkSnapshot {
  let docChars = 0;
  let promptChars = 0;
  let contextChars = 0;
  let handoffChars = 0;
  let designChars = 0;
  let requirementChars = 0;
  for (const stage of WORKLOAD_STAGES.Large) {
    const handoff = handoffs[stage];
    const sliced = sliceModuleDocsWithSavings(stage, {
      projectRoot: fixture.root,
      moduleName: fixture.moduleName,
      phases: [1],
      taskId: "BE-001",
      handoff,
    });
    for (const selected of sliced.selected) {
      docChars += selected.text.length;
      if (selected.doc === "design") designChars += selected.text.length;
      if (selected.doc === "requirement") requirementChars += selected.text.length;
    }
    const context = handoff ? [{ source: ArtifactType.HANDOFF, content: JSON.stringify(handoff) }] : [];
    const prompt = buildPromptParts(
      { taskId: "BE-001", stage, context },
      undefined,
      { docs: sliced.docs },
    );
    promptChars += staticChars(frameworkRoot, stage) + prompt.text.length;
    handoffChars += prompt.composition.handoff_chars;
    contextChars += prompt.composition.handoff_chars + prompt.composition.doc_chars;
  }
  const totalSourceChars = Object.values(TOKEN_BENCHMARK_DOC_BYTES).reduce((sum, bytes) => sum + bytes, 0);
  return {
    docChars,
    promptChars,
    contextChars,
    handoffChars,
    designChars,
    requirementChars,
    totalAmplification: docChars / totalSourceChars,
    designAmplification: designChars / TOKEN_BENCHMARK_DOC_BYTES.design,
    requirementAmplification: requirementChars / TOKEN_BENCHMARK_DOC_BYTES.requirement,
    retries: 0,
    routeBacks: 0,
  };
}

/** Counterfactual no-handoff vs structured-handoff comparison on the pinned Large workload. */
export function runLargeHandoffBenchmark(frameworkRoot: string): LargeHandoffBenchmarkComparison {
  const fixture = createTraceableTokenBenchmarkFixture();
  try {
    return {
      withoutHandoff: largeSnapshot(frameworkRoot, fixture, {}),
      withHandoff: largeSnapshot(frameworkRoot, fixture, largeHandoffs(fixture)),
    };
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

export interface ExecutionPacketPromptBenchmark {
  beforePromptCharacters: number;
  afterPromptCharacters: number;
}

function benchmarkRuntimeTask(fixture: { root: string; moduleName: string }, stages: readonly AgentStage[]): RuntimeTask {
  const sourceRoot = path.join(fixture.root, "_docs", "module", fixture.moduleName);
  return {
    task_id: "BE-001",
    workflow: "feature",
    pm_mode: "full",
    why: "deliver the pinned benchmark task",
    goal: "deliver the pinned benchmark task",
    source_of_truth: {
      status: "resolved",
      paths: ["requirement.md", "design.md", "plan.md", "test-plan.md"].map((name) => path.join(sourceRoot, name)),
      reason: null,
    },
    dependencies: { task_ids: [], plan_readiness: "ready", waiting_on: [], reason: null },
    scope: {
      status: "resolved",
      work_roots: stages.map((stage) => ({
        stage,
        target_id: "benchmark-target",
        root: fixture.root,
        allow: [{ contract_glob: "**/*", effective_glob: path.join(fixture.root, "**", "*") }],
      })),
      reason: null,
    },
    do_not_touch: [".git/**"],
    acceptance_criteria: { status: "resolved", items: ["pinned acceptance criterion"], reason: null },
    required_verification: { status: "deferred", levels: [], reason: "test-pyramid selection is deferred" },
    evidence_required: ["record verification evidence"],
    stop_conditions: ["STOP on an unresolved business rule", "STOP before a state-changing git command"],
  };
}

/** Exact legacy prompt vs ExecutionPacket prompt on the pinned Large workload. */
export function runExecutionPacketPromptBenchmark(frameworkRoot: string): ExecutionPacketPromptBenchmark {
  const fixture = createTraceableTokenBenchmarkFixture();
  try {
    const handoffs = largeHandoffs(fixture);
    const runtimeTask = benchmarkRuntimeTask(fixture, WORKLOAD_STAGES.Large);
    let beforePromptCharacters = 0;
    let afterPromptCharacters = 0;
    for (const stage of WORKLOAD_STAGES.Large) {
      const handoff = handoffs[stage];
      const sliced = sliceModuleDocsWithSavings(stage, {
        projectRoot: fixture.root,
        moduleName: fixture.moduleName,
        phases: [1],
        taskId: "BE-001",
        handoff,
      });
      const context = handoff ? [{ source: ArtifactType.HANDOFF, content: JSON.stringify(handoff) }] : [];
      const req = { taskId: "BE-001", stage, context };
      const sources = { docs: sliced.docs };
      beforePromptCharacters += staticChars(frameworkRoot, stage) + buildPromptParts(req, undefined, sources).text.length;
      afterPromptCharacters += staticChars(frameworkRoot, stage) + compileExecutionPacket({
        req,
        role: stage,
        runtimeTask,
        contractScope: { allow: ["**/*"], deny: [".git/**"] },
        sources,
      }).text.length;
    }
    return { beforePromptCharacters, afterPromptCharacters };
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

export function renderTokenBenchmarkBaseline(frameworkRoot: string, date: string): string {
  return `${renderTokenBenchmarkMarkdown(runTokenBenchmark(frameworkRoot), { date })}\n`;
}
