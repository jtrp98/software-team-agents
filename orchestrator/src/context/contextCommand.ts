import { AgentStage } from "../types.js";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { readModuleDoc, resolveModule } from "../agents/moduleDocs.js";
import { readWorkPlan } from "../docs/planGraph.js";
import { resolveContextDocsRoot } from "../targetcli/roots.js";
import { loadTargetConfig } from "../targetcli/targetMeta.js";
import { detectWorkspaceKind, resolveTargetBinding, workspaceShapeOf } from "../targetcli/roleWorkspace.js";
import { assembleStageContext, type StageContextAssembly } from "../runtime/agentRunAssembly.js";
import type { ExecutionPacket } from "../artifacts/schemas.js";
import { summarizeKnowledgeSelection, type KnowledgeSelectionSummary } from "../threeRepo/rootSelector.js";

export interface ContextCommandInput {
  role: string;
  moduleHint?: string;
  phases?: number[];
  taskId?: string;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  /** `--root <name>` — the named Knowledge root this read resolves through (DR §4). */
  rootName?: string;
}

export interface ContextComposition {
  doc_chars: number;
  doc_chars_before: number;
  doc_selected_chars: number;
  knowledge_chars: number;
  code_intel_chars: number;
  /** V10 TASK-018 — why code-intel answered nothing; null when it answered (or had no reason to give). */
  code_intel_fallback_reason: string | null;
  saved_pct: number;
  fallback_to_full_documents: number;
  fallback_documents: { doc: string; reason: string }[];
  direct_file_reads: number;
  /** T-V8-011 — provenance for the retrieval query codeIntel was actually queried with. */
  retrieval_query_source: "task" | "module-fallback";
  retrieval_query_reason: string;
}

/**
 * The three human-distinct "why is code-intel silent" cases (V10 TASK-018):
 * switched off on this machine / index needs a rebuild (with the command) /
 * it answered and there was nothing to surface. Any other reason is still
 * shown verbatim — the point is that a person never has to guess which of
 * the three actions (flip the switch, reindex, accept the miss) applies.
 */
export function describeCodeIntelFallback(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case "disabled":
      return "switched off on this machine (STA_CODE_INTEL=off|false|0; unset it for the default-on behaviour)";
    case "stale":
    case "missing-index":
    case "index-error":
      return `index needs attention (${reason}) — build/refresh it with: node scripts/reindex-code-intel.mjs <target-id> <target-root>`;
    case "empty-result":
    case "no-allowed-candidates":
      return `answered but nothing usable surfaced for this task (${reason})`;
    default:
      return `unavailable this run (${reason})`;
  }
}

export interface ContextCommandResult {
  role: string;
  stage: AgentStage;
  module: string;
  projectRoot: string;
  docsRoot: string;
  /** DR §7.4 — the Knowledge-root selection this read resolved through: name, canonical path, source and the default (read-only). Absent when no installation config exists and no launch env applies. */
  knowledgeSelection?: KnowledgeSelectionSummary;
  taskId?: string;
  phases: number[];
  phaseResolution: "explicit" | "task" | "none" | "task-not-found";
  context: StageContextAssembly;
  composition: ContextComposition;
}

export class ContextCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "ContextCommandError";
  }
}

export function stageForRole(role: string): AgentStage {
  const entry = Object.values(AGENT_REGISTRY).find((candidate) => candidate.role === role);
  if (!entry || entry.name === AgentStage.HUMAN) {
    throw new ContextCommandError(
      `unknown agent role "${role}" — use one of: ${Object.values(AGENT_REGISTRY)
        .filter((candidate) => candidate.name !== AgentStage.HUMAN)
        .map((candidate) => candidate.role)
        .sort()
        .join(", ")}`,
      64,
    );
  }
  return entry.name;
}

function sourceChars(parts: readonly string[]): number {
  return parts.length === 0 ? 0 : parts.join("\n").length;
}

function phasesFor(
  docsRoot: string,
  moduleName: string,
  explicit: readonly number[] | undefined,
  taskId: string | undefined,
): { phases: number[]; resolution: ContextCommandResult["phaseResolution"] } {
  if (explicit && explicit.length > 0) return { phases: [...new Set(explicit)].sort((a, b) => a - b), resolution: "explicit" };
  if (!taskId) return { phases: [], resolution: "none" };
  const plan = readModuleDoc(docsRoot, moduleName, "plan.md");
  if (plan !== null) {
    const task = readWorkPlan(plan).tasks.find((row) => row.id === taskId);
    if (task) return { phases: [task.phase], resolution: "task" };
  }
  // Unknown task scope must not be guessed. An empty phase set makes plan and
  // traceability-based slicing return full documents.
  return { phases: [], resolution: "task-not-found" };
}

/** Resolves and assembles the exact context fragments used by `sta run`. */
export async function buildContextCommand(input: ContextCommandInput): Promise<ContextCommandResult> {
  const stage = stageForRole(input.role);
  const env = input.env ?? process.env;
  const docsRoot = resolveContextDocsRoot(input.projectRoot, env, input.rootName);
  // DR §7.4: the selection line names the very resolution the docs read just
  // used (env → installation → legacy), so what the command reads is what it
  // names. Display-only: a broken installation file surfaces through the docs
  // resolution above (which reads the same file without an env root), so the
  // summary only needs to stay out of the way — it degrades to absent rather
  // than turning a readable session into a crashed one.
  const knowledgeSelection = (() => {
    try {
      return summarizeKnowledgeSelection({
        requestedName: input.rootName,
        env: { STA_KNOWLEDGE_ROOT: env.STA_KNOWLEDGE_ROOT, STA_KNOWLEDGE_ROOT_NAME: env.STA_KNOWLEDGE_ROOT_NAME },
      });
    } catch {
      return undefined;
    }
  })();
  const resolved = resolveModule(docsRoot, input.moduleHint);
  if (resolved.status === "many") {
    throw new ContextCommandError(
      `more than one module exists under ${docsRoot}; rerun with --module <name>. Candidates: ${resolved.candidates.join(", ")}`,
      2,
    );
  }
  if (resolved.status === "none") {
    const available = resolved.candidates.length > 0 ? ` Available modules: ${resolved.candidates.join(", ")}.` : "";
    throw new ContextCommandError(
      `no matching module document set was found under ${docsRoot}.${available} Start with business-analyst to establish requirement.md, or pass an exact --module <name>.`,
      3,
    );
  }

  const phase = phasesFor(docsRoot, resolved.module, input.phases, input.taskId);
  const targetConfig = loadTargetConfig(input.projectRoot);
  // Resolve targetRoot + targetId TOGETHER, from what the workspace IS (its
  // kind; a legacy recorded role only classifies a checkout the markers cannot
  // place) — without both, codeIntelContext always falls back to
  // "missing-inputs" and `sta context` can never show Graphify evidence, even
  // with the feature fully configured (this silently broke it before).
  // `docsRoot !== projectRoot` alone cannot tell the Knowledge workspace from
  // a Target checkout: the global installation config resolves the SAME
  // Knowledge docsRoot from either, so it is only ever "equal" when standing
  // directly inside the Knowledge checkout itself.
  const shape = workspaceShapeOf(detectWorkspaceKind(input.projectRoot), targetConfig?.role);
  let resolvedTargetRoot: string | undefined;
  let resolvedTargetId: string | undefined;
  if (shape === "knowledge") {
    // Knowledge workspace: projectRoot IS the Knowledge root, not a Target checkout — the
    // bound Target's local path+id must come from the same read-only binding
    // `software-team-agents open` uses (targets.yaml + .workflow/targets.local.yaml), keyed by
    // `target.target_id` (NOT the top-level `target_id`, which is the Knowledge repo's own
    // identity, not a Target).
    try {
      const binding = resolveTargetBinding({ knowledgeRoot: input.projectRoot, configTargetId: targetConfig?.target?.target_id });
      if (binding?.via === "local-mapping") {
        resolvedTargetRoot = binding.targetRoot;
        resolvedTargetId = binding.targetId;
      }
    } catch {
      // No usable binding (unregistered/unmapped Target) — degrade to no code-intel, same as today.
    }
  } else if (shape === "target") {
    // Target checkout: projectRoot itself is the one Target it was initialized for.
    resolvedTargetRoot = input.projectRoot;
    resolvedTargetId = targetConfig?.target_id;
  } else {
    // No recorded workspace role — a pre-role config, or no `.agent-team/` at all (legacy
    // single-repo). Keep the exact original heuristic here for byte-identical parity with
    // `sta run`'s own resolution (T-V3TOK-052 property 8): `targetId` has no source in this
    // case, so code-intel keeps degrading to "missing-inputs", same as before this fix.
    resolvedTargetRoot = docsRoot !== input.projectRoot ? input.projectRoot : undefined;
    resolvedTargetId = targetConfig?.target_id;
  }
  const context = await assembleStageContext(stage, {
    projectRoot: input.projectRoot,
    docsRoot,
    knowledgeRoot: docsRoot !== input.projectRoot ? docsRoot : undefined,
    moduleName: resolved.module,
    phases: phase.phases.length > 0 ? phase.phases : undefined,
    taskId: input.taskId,
    targetRoot: env.STA_TARGET_ROOT ?? resolvedTargetRoot,
    targetId: env.STA_TARGET_ID ?? resolvedTargetId,
    env,
  });
  return {
    role: input.role,
    stage,
    module: resolved.module,
    projectRoot: input.projectRoot,
    docsRoot,
    knowledgeSelection,
    taskId: input.taskId,
    phases: phase.phases,
    phaseResolution: phase.resolution,
    context,
    composition: {
      doc_chars: sourceChars(context.docs),
      doc_chars_before: context.savings.bytesBefore,
      doc_selected_chars: context.savings.bytesAfter,
      knowledge_chars: sourceChars(context.knowledge),
      code_intel_chars: sourceChars(context.codeIntel),
      code_intel_fallback_reason: context.codeIntelFallbackReason,
      saved_pct: context.savings.savedPct,
      fallback_to_full_documents: context.selected.filter((doc) => doc.fullDocument).length,
      fallback_documents: context.selected
        .filter((doc) => doc.fullDocument)
        .map((doc) => ({ doc: doc.doc, reason: doc.reason })),
      direct_file_reads: context.directFileReads,
      retrieval_query_source: context.retrievalQuery.source,
      retrieval_query_reason: context.retrievalQuery.reason,
    },
  };
}

/** Human-readable output: exact context fragments first, composition evidence last. */
export function renderContextCommand(result: ContextCommandResult): string {
  const body = [...result.context.docs, ...result.context.knowledge, ...result.context.codeIntel].join("\n");
  const c = result.composition;
  const scope = result.phases.length > 0 ? result.phases.join(",") : "full/fail-open";
  const fallbackUnknownLines = c.fallback_documents.flatMap((f) => {
    const selected = result.context.selected.find((doc) => doc.doc === f.doc);
    return (selected?.unknownSectionReasons ?? []).map(
      (entry) => `    - unknown: "${entry.heading}" — ${entry.reason}`,
    );
  });
  const codeIntelFallback = describeCodeIntelFallback(c.code_intel_fallback_reason);
  const selection = result.knowledgeSelection;
  const knowledgeRootLine =
    selection === undefined
      ? []
      : [
          `- knowledge_root: ${selection.name ?? "(unnamed launch env)"} → ${selection.path}` +
            ` (source=${selection.source}${selection.defaultRootName !== undefined ? `; default: ${selection.defaultRootName}` : ""}; read-only)`,
        ];
  const report = [
    "",
    "Context composition:",
    `- role=${result.role} module=${result.module} phases=${scope} phase_source=${result.phaseResolution}`,
    ...knowledgeRootLine,
    `- docs=${c.doc_chars} chars rendered; selected=${c.doc_selected_chars}/${c.doc_chars_before} source chars; slicing_saved=${c.saved_pct}%`,
    `- knowledge=${c.knowledge_chars} chars; code_intel=${c.code_intel_chars} chars; direct_file_reads=${c.direct_file_reads}; fallback_to_full=${c.fallback_to_full_documents}`,
    ...(codeIntelFallback ? [`- code_intel_fallback: ${codeIntelFallback}`] : []),
    `- retrieval_query: source=${c.retrieval_query_source} — ${c.retrieval_query_reason}`,
    ...c.fallback_documents.map((f) => `  - fallback: ${f.doc} — ${f.reason}`),
    ...fallbackUnknownLines,
  ].join("\n");
  return `${body}${report}`;
}

/** `sta context --packet` renders the exact validated prompt handed to a runtime. */
export function renderContextPacket(packet: Pick<ExecutionPacket, "text">): string {
  return packet.text;
}

export function contextCommandJson(result: ContextCommandResult): object {
  return {
    role: result.role,
    stage: result.stage,
    module: result.module,
    project_root: result.projectRoot,
    docs_root: result.docsRoot,
    task_id: result.taskId ?? null,
    phases: result.phases,
    phase_resolution: result.phaseResolution,
    knowledge_root: result.knowledgeSelection
      ? {
          selected_root_name: result.knowledgeSelection.name ?? null,
          canonical_path: result.knowledgeSelection.path,
          selection_source: result.knowledgeSelection.source,
          default_root_name: result.knowledgeSelection.defaultRootName ?? null,
        }
      : undefined,
    composition: result.composition,
    savings_by_document: result.context.selected.map((doc) => ({
      doc: doc.doc,
      bytes_before: doc.bytesBefore,
      bytes_after: doc.bytesAfter,
      saved_pct: doc.bytesBefore === 0 ? 0 : Math.round(((doc.bytesBefore - doc.bytesAfter) / doc.bytesBefore) * 100),
      full_document: doc.fullDocument,
      reason: doc.reason,
      kept: doc.kept,
      skipped: doc.skipped,
      kept_as_unknown: doc.unknownSections,
      kept_as_unknown_reasons: doc.unknownSectionReasons,
    })),
    documents: result.context.docs,
    knowledge: result.context.knowledge,
    code_intel: result.context.codeIntel,
  };
}
