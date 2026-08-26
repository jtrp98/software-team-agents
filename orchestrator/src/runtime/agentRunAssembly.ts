import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import type { AgentExecutorRequest, AgentExecutorResult } from "../orchestrator/orchestrator.js";
import { parseQaReport, parseSecurityReport } from "../agents/moduleDocs.js";
import { ContextManager, type SelectedContext } from "../context/contextManager.js";
import { classifyQaFailure, classifySecurityFailure } from "../orchestrator/failureClassifier.js";

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
  knowledge_chars?: number;
  code_intel_chars?: number;
  tool_output_chars?: number;
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
export function renderSlicedDocs(selected: SelectedContext[], cm: ContextManager): string[] {
  if (selected.length === 0) return [];

  const parts: string[] = ["", "Module documents, sliced to what this stage needs (`policies/documentation.md` §10):"];
  for (const s of selected) {
    parts.push("", `### ${s.doc}.md`);
    if (!s.fullDocument && s.skipped.length > 0) {
      parts.push(
        `_Sections not included: ${s.skipped.join(", ")}. ` +
          `The full file is at \`${cm.path(s.doc)}\` — read it if one of those turns out to matter._`,
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
  try {
    const cm = new ContextManager({ projectRoot: opts.projectRoot, moduleName: opts.moduleName });
    return renderSlicedDocs(cm.forStage(stage, opts.phases), cm);
  } catch {
    return [];
  }
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
}

export interface PromptSources {
  docs?: string[];
  knowledge?: string[];
  codeIntel?: string[];
  toolOutput?: string[];
}

type PromptPartKind = keyof PromptComposition;
interface PromptPart { kind: PromptPartKind; text: string; }

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
  for (const text of sources.docs ?? []) parts.push({ kind: "doc_chars", text });
  for (const text of sources.knowledge ?? []) parts.push({ kind: "knowledge_chars", text });
  for (const text of sources.codeIntel ?? []) parts.push({ kind: "code_intel_chars", text });
  for (const text of sources.toolOutput ?? []) parts.push({ kind: "tool_output_chars", text });
  if (req.deployPhase) parts.push({ kind: "static_chars", text: "" }, { kind: "static_chars", text: DEPLOY_PHASE_INSTRUCTION[req.deployPhase] });
  if (extra) parts.push({ kind: "static_chars", text: "" }, { kind: "static_chars", text: extra });
  parts.push(
    { kind: "static_chars", text: "" },
    { kind: "static_chars", text: "Finish by stating clearly what you completed and, per convention, what should happen next — the orchestrator reads your exit status and the docs you wrote, not a special reply format." },
  );
  const composition: PromptComposition = {
    static_chars: 0, handoff_chars: 0, doc_chars: 0, knowledge_chars: 0, code_intel_chars: 0, tool_output_chars: 0,
  };
  const text = parts.map((part, index) => {
    // The delimiter belongs to the incoming source: no separate synthetic
    // bucket is needed, and the component sum stays exactly prompt.length.
    const rendered = `${index === 0 ? "" : "\n"}${part.text}`;
    composition[part.kind] += rendered.length;
    return rendered;
  }).join("");
  return { text, composition };
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
