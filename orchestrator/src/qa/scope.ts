/**
 * QA01 — Change-Aware QA Scope.
 *
 * Before this module, a qa-engineer round started from the role's whole
 * context policy (requirements + design + plan + test plan + both code
 * trees) regardless of what the implementation round actually touched. For
 * a scoped change that is most of the token cost of the round spent on
 * files no verdict will ever mention.
 *
 * This computes the bounded scope first: what changed, what transitively
 * depends on it, and which knowledge items document exactly those files.
 * Everything outside the scope is not handed to QA by default — QA can
 * still widen (the prompt says how), it just does not start wide.
 *
 * Fail-closed rule: a scope that cannot be bounded (no change list at all,
 * or more files than the budget) reports `bounded: false`, and mode
 * selection (`qa/mode.ts`) turns that into FULL. An unbounded scope never
 * silently becomes "verify everything you can find".
 */

export interface QaKnowledgeRef {
  /** Knowledge item id (e.g. `knowledge/decisions/D-014` or an item path). */
  id: string;
  /** Files this item documents; relevance = intersection with the scope's files. */
  files: readonly string[];
}

export interface QaScopeInput {
  taskId: string;
  /**
   * Files the implementation round actually changed, relative to the Target
   * root, any separator. Empty means "the caller could not say what changed"
   * — which is itself a finding, not a free pass to read everything.
   */
  changedFiles: readonly string[];
  /** Reverse-dependency edges: file → files known to import/rely on it. */
  dependents?: Readonly<Record<string, readonly string[]>>;
  /** Candidate knowledge items; only relevant ones survive into the scope. */
  knowledge?: readonly QaKnowledgeRef[];
  /** Task-graph impact (`graph/changeImpact.ts`), carried through for the report. */
  affectedTaskIds?: readonly string[];
  affectedPhases?: readonly number[];
  /** Budget on changed+impacted files before the scope is declared unbounded. */
  maxFiles?: number;
}

export interface QaScope {
  taskId: string;
  changedFiles: string[];
  /** Transitive dependents of the changed files, excluding the changed files themselves. */
  impactedFiles: string[];
  /** Knowledge items whose files intersect the scope — the only ones QA loads by default. */
  knowledgeRefs: string[];
  affectedTaskIds: string[];
  affectedPhases: number[];
  bounded: boolean;
  /** Set only when `bounded` is false; names why mode selection must escalate. */
  unboundedReason?: string;
}

export const DEFAULT_QA_SCOPE_MAX_FILES = 50;

function normalize(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "");
}

function uniqueSorted(paths: Iterable<string>): string[] {
  return [...new Set([...paths].map(normalize))].sort();
}

function intersects(a: ReadonlySet<string>, files: readonly string[]): boolean {
  return files.some((f) => a.has(normalize(f)));
}

export function buildQaScope(input: QaScopeInput): QaScope {
  const maxFiles = input.maxFiles ?? DEFAULT_QA_SCOPE_MAX_FILES;
  const changedFiles = uniqueSorted(input.changedFiles);

  if (changedFiles.length === 0) {
    return {
      taskId: input.taskId,
      changedFiles,
      impactedFiles: [],
      knowledgeRefs: [],
      affectedTaskIds: [...(input.affectedTaskIds ?? [])],
      affectedPhases: [...(input.affectedPhases ?? [])].sort((a, b) => a - b),
      bounded: false,
      unboundedReason:
        "no changed-file list was produced for this round — cannot bound the verification scope",
    };
  }

  // BFS over reverse dependencies: impact spreads one import hop at a time,
  // and cycles must not loop forever, so visited-set semantics like changeImpact.ts.
  const changedSet = new Set(changedFiles);
  const impactedSet = new Set<string>();
  const queue = [...changedFiles];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of input.dependents?.[current] ?? []) {
      const n = normalize(next);
      if (changedSet.has(n) || impactedSet.has(n)) continue;
      impactedSet.add(n);
      queue.push(n);
    }
  }

  const allFiles = new Set([...changedSet, ...impactedSet]);
  const knowledgeRefs = (input.knowledge ?? [])
    .filter((k) => intersects(allFiles, k.files))
    .map((k) => k.id)
    .sort();

  const scope: QaScope = {
    taskId: input.taskId,
    changedFiles,
    impactedFiles: [...impactedSet].sort(),
    knowledgeRefs,
    affectedTaskIds: [...new Set(input.affectedTaskIds ?? [])],
    affectedPhases: [...new Set(input.affectedPhases ?? [])].sort((a, b) => a - b),
    bounded: true,
  };

  if (allFiles.size > maxFiles) {
    return {
      ...scope,
      bounded: false,
      unboundedReason: `change scope spans ${allFiles.size} files, over the QA scope budget of ${maxFiles} — treat as full-surface verification`,
    };
  }
  return scope;
}

/** Prompt-ready rendering of the scope — what QA is told it owns this round. */
export function renderQaScope(scope: QaScope): string[] {
  const lines: string[] = ["QA scope (change-aware — verify these, not the whole project):"];
  lines.push(`- changed files (${scope.changedFiles.length}): ${scope.changedFiles.join(", ")}`);
  if (scope.impactedFiles.length > 0) {
    lines.push(`- impacted dependents (${scope.impactedFiles.length}): ${scope.impactedFiles.join(", ")}`);
  }
  if (scope.knowledgeRefs.length > 0) {
    lines.push(`- relevant knowledge: ${scope.knowledgeRefs.join(", ")}`);
  }
  if (scope.affectedTaskIds.length > 0) lines.push(`- affected tasks: ${scope.affectedTaskIds.join(", ")}`);
  if (scope.affectedPhases.length > 0) lines.push(`- phases needing re-verification: ${scope.affectedPhases.join(", ")}`);
  if (!scope.bounded) lines.push(`- SCOPE NOT BOUNDED: ${scope.unboundedReason ?? "unknown"} — verify accordingly`);
  return lines;
}
