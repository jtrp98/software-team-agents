import { AgentStage } from "../types.js";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { readModuleDoc, resolveModule } from "../agents/moduleDocs.js";
import { parsePlanTasks } from "../docs/planGraph.js";
import { resolveContextDocsRoot } from "../targetcli/roots.js";
import { assembleStageContext, type StageContextAssembly } from "../runtime/agentRunAssembly.js";

export interface ContextCommandInput {
  role: string;
  moduleHint?: string;
  phases?: number[];
  taskId?: string;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
}

export interface ContextComposition {
  doc_chars: number;
  doc_chars_before: number;
  doc_selected_chars: number;
  knowledge_chars: number;
  code_intel_chars: number;
  saved_pct: number;
  fallback_to_full_documents: number;
  direct_file_reads: number;
}

export interface ContextCommandResult {
  role: string;
  stage: AgentStage;
  module: string;
  projectRoot: string;
  docsRoot: string;
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

function stageForRole(role: string): AgentStage {
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
    const task = parsePlanTasks(plan).tasks.find((row) => row.id === taskId);
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
  const docsRoot = resolveContextDocsRoot(input.projectRoot, env);
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
  const context = await assembleStageContext(stage, {
    projectRoot: input.projectRoot,
    docsRoot,
    knowledgeRoot: docsRoot !== input.projectRoot ? docsRoot : undefined,
    moduleName: resolved.module,
    phases: phase.phases.length > 0 ? phase.phases : undefined,
    taskId: input.taskId,
    targetRoot: env.AGENTCLAUDE_TARGET_ROOT ?? (docsRoot !== input.projectRoot ? input.projectRoot : undefined),
  });
  return {
    role: input.role,
    stage,
    module: resolved.module,
    projectRoot: input.projectRoot,
    docsRoot,
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
      saved_pct: context.savings.savedPct,
      fallback_to_full_documents: context.selected.filter((doc) => doc.fullDocument).length,
      direct_file_reads: context.directFileReads,
    },
  };
}

/** Human-readable output: exact context fragments first, composition evidence last. */
export function renderContextCommand(result: ContextCommandResult): string {
  const body = [...result.context.docs, ...result.context.knowledge, ...result.context.codeIntel].join("\n");
  const c = result.composition;
  const scope = result.phases.length > 0 ? result.phases.join(",") : "full/fail-open";
  const report = [
    "",
    "Context composition:",
    `- role=${result.role} module=${result.module} phases=${scope} phase_source=${result.phaseResolution}`,
    `- docs=${c.doc_chars} chars rendered; selected=${c.doc_selected_chars}/${c.doc_chars_before} source chars; slicing_saved=${c.saved_pct}%`,
    `- knowledge=${c.knowledge_chars} chars; code_intel=${c.code_intel_chars} chars; direct_file_reads=${c.direct_file_reads}; fallback_to_full=${c.fallback_to_full_documents}`,
  ].join("\n");
  return `${body}${report}`;
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
    })),
    documents: result.context.docs,
    knowledge: result.context.knowledge,
    code_intel: result.context.codeIntel,
  };
}
