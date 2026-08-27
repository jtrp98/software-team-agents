import { AgentStage } from "../types.js";
import { ArtifactType, validateArtifact, type HandoffArtifact } from "../artifacts/schemas.js";
import type { AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { parseQaReport, parseSecurityReport, readModuleDoc } from "../agents/moduleDocs.js";
import { parsePlanTasks } from "../docs/planGraph.js";
import {
  ContextManager,
  handoffReferencedSections,
  type SelectedContext,
} from "../context/contextManager.js";
import { ContextLeakageError, type ContextItem } from "../context/contextSelection.js";
import { classifyQaFailure, classifySecurityFailure } from "../orchestrator/failureClassifier.js";
import { codeIntelSlices } from "./codeIntelAssembly.js";
import { knowledgeBriefFor } from "./knowledgeBriefAssembly.js";
import { assertContextComposition, emptyContextBudgetComposition, type ContextBudgetComposition } from "../context/contextBudget.js";

/**
 * Everything about running a stage that is *this framework's* business rather
 * than any runtime's (T108).
 *
 * Extracted from `agents/claudeCliExecutor.ts`, where it sat next to the
 * `spawnSync("claude", ...)` call. That co-location is what made the framework
 * look Claude-Code-shaped when almost none of it was: assembling a prompt,
 * slicing module docs to the sections a stage may read, reading `review.md` back
 * into a QA artifact and routing a failed round by the owner the document names
 * are all rules from `policies/` — they would be identical if the process being
 * spawned were `codex`.
 *
 * Moved rather than copied. A second copy would drift from the first the moment
 * one of those policies changed, and the existing `claudeCliExecutor.test.ts`
 * cases are the guard that the move changed no behaviour: they still exercise
 * this code, through the same executor, and still pass unchanged.
 *
 * The artifact readback functions here are pure — they take the document text,
 * they do not read it. The caller reads it however its runtime lets it (the
 * Claude CLI executor synchronously off disk, an adapter-driven executor through
 * `RuntimeWorkspace`), and the parsing/classification that has to be identical
 * for both stays in one place.
 */

/** Everything T26/T28/T57 want logged, threaded as one bundle instead of a growing positional-argument list. */
export interface RunMetrics {
  model?: string;
  promptVersion?: number;
  tokens: number;
  cost: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  context_chars: number;
  runtime?: string;
  session_kind?: "orchestrated" | "interactive";
  static_chars?: number;
  handoff_chars?: number;
  doc_chars?: number;
  doc_chars_before?: number;
  knowledge_chars?: number;
  code_intel_chars?: number;
  tool_output_chars?: number;
  context_budget_chars?: number;
  context_budget_source?: "role" | "model_context_window";
  context_overflow_chars?: number;
  context_budget_warning?: boolean;
  context_base_chars?: number;
  context_task_chars?: number;
  context_safety_chars?: number;
  context_docs_chars?: number;
  context_knowledge_chars?: number;
  context_code_chars?: number;
  context_tool_output_chars?: number;
  context_reserve_chars?: number;
}

/**
 * T44 — what `req.deployPhase` means for the one stage that gets it (devops). The orchestrator
 * has already enforced the structural half (execute is unreachable without the DEPLOY approval
 * gate having passed — see `isAgentAssignedAt` in taskStatus.ts); this only tells the agent which
 * of the two runs it's in, since devops.md's own rules read differently depending on which.
 */
export const DEPLOY_PHASE_INSTRUCTION: Record<"prepare" | "execute", string> = {
  prepare:
    "Deploy phase: PREPARE. Do only what's safe to run unattended — Dockerfile/CI workflow/config, a migration dry-run, and — if this deploy includes a migration against a shared or production database — take and record a real, restorable backup before this run ends (T46: no backup, no migration). " +
    "Do NOT run the actual deploy or migration command in this run; that happens in a separate EXECUTE run, after the orchestrator's own human approval gate.",
  execute:
    "Deploy phase: EXECUTE. The orchestrator's structural approval gate for this deploy has already been granted — this run is what actually issues the deploy/migration command, then verifies the result (service health, and — for a migration — the schema/data actually match what was intended, T46). " +
    "Still follow your own agent instructions for what to confirm and verify; the gate having passed doesn't relax those. Report failure plainly if verification doesn't pass — do not soften it into a success.",
};

/**
 * Renders the sliced module docs, and — just as importantly — says what was cut.
 *
 * An agent that is handed a subset with no note of what is missing cannot tell a
 * section that was dropped from one that never existed, so it cannot ask for it.
 * Naming the skipped headings and the file they came from keeps the filter an
 * optimization the agent can undo, rather than a silent edit of its inputs.
 */
export interface HandoffSliceNotice {
  stage: AgentStage;
  moduleName: string;
  phases?: number[];
}

export function renderSlicedDocs(selected: SelectedContext[], cm: ContextManager, handoff?: HandoffSliceNotice): string[] {
  if (selected.length === 0) return [];

  const parts: string[] = ["", "Module documents, sliced to what this stage needs (`policies/documentation.md` §10):"];
  if (handoff) {
    const phase = handoff.phases?.length ? handoff.phases.join(",") : "<n>";
    parts.push(
      "",
      "_This is the slice pointed to by the structured HANDOFF, plus the always-read safety set. " +
        "References never widen CONTEXT_POLICY; broad or unresolved references fall back to normal §10 slicing. " +
        `For other allowed sections run \`sta context ${handoff.stage} --module ${handoff.moduleName} --phase ${phase}\`._`,
    );
  }
  for (const s of selected) {
    parts.push("", `### ${s.doc}.md`);
    if (!s.fullDocument && s.skipped.length > 0) {
      parts.push(
        `_Known-irrelevant sections not included: ${s.skipped.join(", ")}. ` +
          `The full file is at \`${cm.path(s.doc)}\` — read it if one of those turns out to matter._`,
        "",
      );
    }
    if (s.unknownSections.length > 0) {
      parts.push(
        `_Kept because relevance is unknown: ${s.unknownSections.join(", ")}. ` +
          `Nothing in this list was dropped; read the module's \`${s.doc}\` in the workspace for the full file._`,
        "",
      );
    }
    parts.push(s.text);
  }
  return parts;
}

export interface SliceOptions {
  projectRoot: string;
  moduleName: string;
  /** Which phases of `plan.md` this run touches. Undefined is safe: the plan then comes through whole rather than sliced wrong. */
  phases?: number[];
  taskId?: string;
  /** Validated machine-derived reference record from the prior stage. */
  handoff?: HandoffArtifact;
}

/**
 * The doc slice for one stage, or an empty slice if anything at all goes wrong.
 *
 * Additive by design (T05): a failure resolving or reading the docs leaves the
 * prompt exactly as it would have been without slicing, and the agent reads them
 * itself — slower, never wrong. Slicing is an optimization; completeness is the
 * correctness requirement.
 */
export function sliceModuleDocsFor(stage: AgentStage, opts: SliceOptions): string[] {
  return sliceModuleDocsWithSavings(stage, opts).docs;
}

/** Slices once and keeps the measured before/after bytes for run observability. */
export interface SlicedModuleDocs {
  docs: string[];
  selected: SelectedContext[];
  docCharsBefore: number;
  savings: { bytesBefore: number; bytesAfter: number; savedPct: number };
  directFileReads: number;
}

export function sliceModuleDocsWithSavings(stage: AgentStage, opts: SliceOptions): SlicedModuleDocs {
  try {
    const cm = new ContextManager({ projectRoot: opts.projectRoot, moduleName: opts.moduleName });
    const referenced = opts.handoff ? handoffReferencedSections(stage, opts.handoff) : undefined;
    const selected = cm.forStage(stage, opts.phases, opts.taskId, referenced);
    // `savings()` is the single source of the before/after calculation. The
    // after side is prompt composition's doc_chars; the before side is carried
    // into the run metric below, so token reports can show the actual slice.
    const savings = cm.savings(selected);
    return {
      docs: renderSlicedDocs(
        selected,
        cm,
        opts.handoff ? { stage, moduleName: opts.moduleName, phases: opts.phases } : undefined,
      ),
      selected,
      docCharsBefore: savings.bytesBefore,
      savings,
      directFileReads: cm.directFileReads(),
    };
  } catch (error) {
    // Authorization violations are not optional enrichment failures. A
    // malicious qualified reference must stop before the runtime starts.
    if (error instanceof ContextLeakageError) throw error;
    return {
      docs: [],
      selected: [],
      docCharsBefore: 0,
      savings: { bytesBefore: 0, bytesAfter: 0, savedPct: 0 },
      directFileReads: 0,
    };
  }
}

/** The one validated HANDOFF item in orchestrator context, if a prior doc stage produced one. */
export function handoffFromContext(context: readonly ContextItem[]): HandoffArtifact | null {
  const item = context.find((candidate) => candidate.source === ArtifactType.HANDOFF);
  if (!item) return null;
  return validateArtifact(ArtifactType.HANDOFF, JSON.parse(item.content));
}

export interface StageContextOptions extends SliceOptions {
  /** Root used for framework/legacy knowledge lookup; docs may live elsewhere. */
  projectRoot: string;
  /** Explicit module-doc root (Knowledge in three-repo mode, projectRoot otherwise). */
  docsRoot: string;
  taskId?: string;
  knowledgeRoot?: string;
  targetRoot?: string;
  targetId?: string;
}

export interface StageContextAssembly extends SlicedModuleDocs {
  knowledge: string[];
  codeIntel: string[];
}

/**
 * Design references from the authoritative task row.  Failure is deliberately
 * additive: the brief remains an index, rather than making stage context fail
 * because a plan is absent or still being authored.
 */
export function referencedKnowledgeIds(docsRoot: string, moduleName: string, taskId: string | undefined): string[] {
  if (!taskId) return [];
  try {
    const plan = readModuleDoc(docsRoot, moduleName, "plan.md");
    return plan === null ? [] : parsePlanTasks(plan).tasks.find((task) => task.id === taskId)?.designRefs ?? [];
  } catch {
    return [];
  }
}

/**
 * One context selection/rendering path for both `sta run` and `sta context`.
 * Optional sources keep their established additive posture: any failure yields
 * no enrichment, while document parser uncertainty is handled inside
 * ContextManager by returning the complete document.
 */
export async function assembleStageContext(stage: AgentStage, opts: StageContextOptions): Promise<StageContextAssembly> {
  const sliced = sliceModuleDocsWithSavings(stage, {
    projectRoot: opts.docsRoot,
    moduleName: opts.moduleName,
    phases: opts.phases,
    taskId: opts.taskId,
    handoff: opts.handoff,
  });
  const knowledge = knowledgeBriefFor(stage, {
    projectRoot: opts.projectRoot,
    knowledgeRoot: opts.knowledgeRoot,
    moduleName: opts.moduleName,
    referencedIds: referencedKnowledgeIds(opts.docsRoot, opts.moduleName, opts.taskId),
  });
  let codeIntel: string[] = [];
  try {
    codeIntel = await codeIntelSlices({
      stage,
      taskId: opts.taskId,
      moduleName: opts.moduleName,
      targetRoot: opts.targetRoot,
      targetId: opts.targetId,
    });
  } catch {
    codeIntel = [];
  }
  return { ...sliced, knowledge, codeIntel };
}

export interface PromptComposition {
  static_chars: number;
  handoff_chars: number;
  doc_chars: number;
  knowledge_chars: number;
  code_intel_chars: number;
  tool_output_chars: number;
}

export interface PromptPartsResult {
  text: string;
  composition: PromptComposition;
  budgetComposition: ContextBudgetComposition;
}

export interface PromptSources {
  /** Explicit safety/gate text, when a caller needs it in the assembled prompt. */
  safety?: string[];
  docs?: string[];
  knowledge?: string[];
  codeIntel?: string[];
  toolOutput?: string[];
}

type PromptPartKind = keyof PromptComposition;
interface PromptPart { kind: PromptPartKind; budgetKind?: keyof ContextBudgetComposition; text: string; }

function budgetClassFor(kind: PromptPartKind): keyof ContextBudgetComposition {
  switch (kind) {
    case "static_chars": return "base";
    case "handoff_chars": return "task";
    case "doc_chars": return "docs";
    case "knowledge_chars": return "knowledge";
    case "code_intel_chars": return "code";
    case "tool_output_chars": return "tool_output";
  }
}

/**
 * Assembles the prompt and records the source of every character while doing
 * so. `static_chars` is framework text generated here (header/footer/deploy
 * note/extra instruction); it deliberately excludes CLAUDE.md, role prompts,
 * and policies that an interactive runtime loads itself. Those are measured by
 * T-V3TOK-002's workspace session recorder instead.
 */
export function buildPromptParts(req: AgentExecutorRequest, extra?: string, sources: PromptSources = {}): PromptPartsResult {
  const parts: PromptPart[] = [
    // Vendor-neutral on purpose (OFF07): this prompt reaches every runtime, and
    // a provider-named document pointer would leak one vendor's naming into all
    // the others' context.
    { kind: "static_chars", text: `Task ${req.taskId} — you are running as the \`${req.stage}\` stage of this repo's pipeline (see the repo's own agent documentation).` },
    { kind: "static_chars", text: "" },
  ];
  if (req.context.length === 0) {
    parts.push({ kind: "handoff_chars", text: "No prior-stage context was supplied for this task — proceed from the repo's own docs (`_docs/status.md` first, per convention)." });
  } else {
    parts.push({ kind: "handoff_chars", text: "Context assembled for you by the orchestrator (already filtered to what this stage may read):" });
    for (const item of req.context) {
      parts.push({ kind: "handoff_chars", text: "" }, { kind: "handoff_chars", text: `### ${item.source}` }, { kind: "handoff_chars", text: item.content });
    }
  }
  // Safety is currently loaded by runtime bindings rather than appended here,
  // but this explicit source keeps a future injected gate from being folded
  // into misleading generic static accounting.
  for (const text of sources.safety ?? []) parts.push({ kind: "static_chars", budgetKind: "safety", text });
  for (const text of sources.docs ?? []) parts.push({ kind: "doc_chars", text });
  for (const text of sources.knowledge ?? []) parts.push({ kind: "knowledge_chars", text });
  for (const text of sources.codeIntel ?? []) parts.push({ kind: "code_intel_chars", text });
  for (const text of sources.toolOutput ?? []) parts.push({ kind: "tool_output_chars", text });
  if (req.deployPhase) parts.push({ kind: "static_chars", budgetKind: "task", text: "" }, { kind: "static_chars", budgetKind: "task", text: DEPLOY_PHASE_INSTRUCTION[req.deployPhase] });
  // `extra` is the task-specific operating instruction seam (production uses it for environment), not an unclassified static bucket.
  if (extra) parts.push({ kind: "static_chars", budgetKind: "task", text: "" }, { kind: "static_chars", budgetKind: "task", text: extra });
  parts.push(
    { kind: "static_chars", text: "" },
    { kind: "static_chars", text: "Finish by stating clearly what you completed and, per convention, what should happen next — the orchestrator reads your exit status and the docs you wrote, not a special reply format." },
  );
  const composition: PromptComposition = {
    static_chars: 0, handoff_chars: 0, doc_chars: 0, knowledge_chars: 0, code_intel_chars: 0, tool_output_chars: 0,
  };
  const budgetComposition = emptyContextBudgetComposition();
  const text = parts.map((part, index) => {
    // The delimiter belongs to the incoming source: no separate synthetic
    // bucket is needed, and the component sum stays exactly prompt.length.
    const rendered = `${index === 0 ? "" : "\n"}${part.text}`;
    composition[part.kind] += rendered.length;
    budgetComposition[part.budgetKind ?? budgetClassFor(part.kind)] += rendered.length;
    return rendered;
  }).join("");
  assertContextComposition(budgetComposition, text.length);
  return { text, composition, budgetComposition };
}

/** Compatibility wrapper for existing callers/tests using the old sliced array. */
export function buildPrompt(req: AgentExecutorRequest, extra?: string, sliced?: string[]): string {
  return buildPromptParts(req, extra, { docs: sliced }).text;
}

export function failResult(reason: string, metrics: Partial<RunMetrics> = {}): AgentExecutorResult {
  return { outcome: { tokens: 0, cost: 0, context_chars: 0, ...metrics, result: "FAIL", failure_reason: reason } };
}

/**
 * A qa-engineer run's result, from the `review.md` it wrote.
 *
 * Fails closed on a missing document even when the runtime reported success: a
 * round nobody can read is not a round that passed. The owner attached on a
 * failure is the one qa-engineer itself named in `## Open Issues` (T06), so a
 * schema gap is not routed to an engineer as though it were a bug; when the
 * document names no owner the classifier escalates rather than guessing.
 */
export function qaArtifactResult(
  req: AgentExecutorRequest,
  metrics: RunMetrics,
  moduleName: string,
  reviewMd: string | null,
): AgentExecutorResult {
  if (reviewMd === null) {
    return failResult(
      `qa-engineer reported success but _docs/module/${moduleName}/review.md doesn't exist — cannot confirm the round`,
      metrics,
    );
  }
  const { artifact } = parseQaReport(req.taskId, reviewMd);
  return {
    outcome: { ...metrics, result: artifact.status },
    artifactType: ArtifactType.QA_REPORT,
    artifact,
    failure: artifact.status === "FAIL" ? (classifyQaFailure(reviewMd) ?? undefined) : undefined,
  };
}

/** A security run's result, from the `security.md` it wrote. Same fail-closed rule as `qaArtifactResult`. */
export function securityArtifactResult(
  req: AgentExecutorRequest,
  metrics: RunMetrics,
  moduleName: string,
  securityMd: string | null,
): AgentExecutorResult {
  if (securityMd === null) {
    return failResult(
      `security reported success but _docs/module/${moduleName}/security.md doesn't exist — cannot confirm findings`,
      metrics,
    );
  }
  const artifact = parseSecurityReport(req.taskId, securityMd);
  return {
    outcome: { ...metrics, result: artifact.overallStatus },
    artifactType: ArtifactType.SECURITY_REPORT,
    artifact,
    failure:
      artifact.overallStatus === "FAIL" ? (classifySecurityFailure(securityMd, req.taskId) ?? undefined) : undefined,
  };
}

/** The two stages whose verdict lives in a document rather than in an exit status. */
export function isDocumentVerdictStage(stage: AgentStage): boolean {
  return stage === AgentStage.QA_ENGINEER || stage === AgentStage.SECURITY;
}
