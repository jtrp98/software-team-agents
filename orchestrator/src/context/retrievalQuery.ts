import type { PlanTask } from "../docs/planTask.js";

/**
 * T-V8-011 — task-first retrieval, replacing bare `moduleName` queries.
 *
 * `codeIntelSlices` previously asked `findRelevantCode` with only the module
 * name (`orchestrator/src/runtime/codeIntelAssembly.ts` before this change).
 * PM already authors a task-specific `Hypothesis`/`Query`/`Provenance` triple
 * in `PlanTask.retrievalHints` (`policies/documentation.md` §… via
 * `validateCanonicalReferences` in `docs/planTask.ts`) — this module is the
 * read side of that same grammar, plus the deterministic query it feeds a
 * code-intelligence provider or any other retrieval mechanism.
 */

export interface RetrievalHint {
  hypothesis: string;
  query: string;
  provenanceIds: string[];
}

const hintLine = (label: string): RegExp => new RegExp(`(?:^|\\n|;\\s*)${label}:\\s*([^\\n;]+)`, "im");

/** Same grammar `validateCanonicalReferences` enforces at authoring time; this is the read side. Absent/malformed hints answer `null` rather than a guessed query. */
export function parseRetrievalHint(retrievalHints: string): RetrievalHint | null {
  const hypothesis = hintLine("Hypothesis").exec(retrievalHints)?.[1]?.trim();
  const query = hintLine("Query").exec(retrievalHints)?.[1]?.trim();
  if (!hypothesis || !query) return null;
  const provenanceLine = hintLine("Provenance").exec(retrievalHints)?.[1] ?? "";
  const provenanceIds = provenanceLine.match(/\b(?:DES|DEC)-\d+\b|Contract:[A-Za-z][A-Za-z0-9_.-]*\.v[1-9]\d*/g) ?? [];
  return { hypothesis, query, provenanceIds };
}

export type TaskRetrievalQuerySource = "task" | "module-fallback";

export interface TaskRetrievalQuery {
  /** "task" when built from resolved canonical task fields; "module-fallback" when nothing task-specific was resolvable. */
  source: TaskRetrievalQuerySource;
  /** Why this query looks the way it does — the provenance record acceptance criteria asks for. */
  reason: string;
  /** The exact free text a retrieval mechanism receives. Never blank when `source` is `"task"` and an objective exists. */
  description: string;
  /** Deduplicated task/REQ/AC/DES/contract IDs this query is scoped to, in selection order. */
  ids: string[];
  changedFiles: readonly string[];
}

export const MAX_RETRIEVAL_QUERY_IDS = 40;
export const MAX_RETRIEVAL_DESCRIPTION_CHARS = 4000;

export type RetrievalTaskFields = Pick<
  PlanTask,
  "id" | "objective" | "scopeAndConstraints" | "retrievalHints" | "traceability" | "produces" | "consumes"
>;

export interface BuildTaskRetrievalQueryOptions {
  moduleName?: string;
  changedFiles?: readonly string[];
}

/**
 * Builds one deterministic retrieval query from a canonical task's own
 * fields — never the module name alone. Absent task fields fall back to the
 * module name so a query still exists (`module-fallback`) instead of the
 * caller silently getting nothing; ids and description are both truncated
 * with the truncation named in `reason`, never dropped without a trace.
 */
export function buildTaskRetrievalQuery(
  task: RetrievalTaskFields | undefined,
  opts: BuildTaskRetrievalQueryOptions = {},
): TaskRetrievalQuery {
  const changedFiles = opts.changedFiles ?? [];
  if (!task) {
    const moduleName = opts.moduleName?.trim();
    return {
      source: "module-fallback",
      reason: moduleName
        ? "no canonical task fields were resolvable — falling back to the module name so retrieval still has a query"
        : "neither canonical task fields nor a module name were resolvable — retrieval has nothing to query",
      description: moduleName ?? "",
      ids: [],
      changedFiles,
    };
  }

  const hint = parseRetrievalHint(task.retrievalHints);
  const allIds = [...new Set([task.id, ...task.traceability, ...task.produces, ...task.consumes])];
  const idsTruncated = allIds.length > MAX_RETRIEVAL_QUERY_IDS;
  const ids = idsTruncated ? allIds.slice(0, MAX_RETRIEVAL_QUERY_IDS) : allIds;

  const parts = [
    task.objective,
    hint?.query,
    task.scopeAndConstraints,
    ids.length > 0 ? `Related IDs: ${ids.join(", ")}` : undefined,
    changedFiles.length > 0 ? `Changed files: ${changedFiles.join(", ")}` : undefined,
  ].filter((part): part is string => !!part && part.trim() !== "");
  let description = parts.join("\n");
  const descriptionTruncated = description.length > MAX_RETRIEVAL_DESCRIPTION_CHARS;
  if (descriptionTruncated) description = description.slice(0, MAX_RETRIEVAL_DESCRIPTION_CHARS);

  const truncationNotes = [
    idsTruncated ? `${allIds.length - MAX_RETRIEVAL_QUERY_IDS} id(s) truncated` : undefined,
    descriptionTruncated ? "description text truncated" : undefined,
  ].filter((note): note is string => !!note);
  const base = hint
    ? `constructed from task ${task.id}'s objective, constraints, ${ids.length} trace/contract id(s), and PM's Query hint`
    : `constructed from task ${task.id}'s objective, constraints and ${ids.length} trace/contract id(s); no parseable Query hint`;

  return {
    source: "task",
    reason: truncationNotes.length > 0 ? `${base} (${truncationNotes.join("; ")})` : base,
    description,
    ids,
    changedFiles,
  };
}
