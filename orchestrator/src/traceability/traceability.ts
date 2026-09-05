import { parseOpenIssues } from "../orchestrator/failureClassifier.js";

/**
 * Requirement traceability: Requirement -> Design -> Task -> Test -> QA, so
 * "does REQ-003 actually work" is a lookup instead of re-reading four
 * documents by hand.
 *
 * Built by following an id convention: `business-analyst` tags each Core
 * Feature `REQ-NNN`; `system-analyst` tags each Feasibility row `DES-NNN` and
 * names the `REQ-NNN` it covers on the same line; `project-manager` tags each
 * task `BE-NNN`/`FE-NNN` and names the `DES-NNN` it implements, also on the
 * same line. Same-line co-occurrence is the whole mechanism — no separate
 * mapping file to keep in sync.
 *
 * Reuses `failureClassifier.ts`'s `parseOpenIssues()` rather than re-parsing
 * `review.md`'s Open Issues ids a second way.
 *
 * `tests` is usually empty — automated tests are opt-in per CLAUDE.md's fixed
 * stack, so that's an expected state, not a hole in the chain. A `TEST-NNN`
 * id (from a Vitest suite naming one) is picked up the same way as everything
 * else: by appearing on a line with the ids it verifies.
 */

export type TraceStatus = "unplanned" | "planned" | "in-progress" | "blocked" | "verified";

export interface TraceEntry {
  requirement: string;
  design: string[];
  tasks: string[];
  tests: string[];
  status: TraceStatus;
}

export interface TraceInputs {
  requirementMd: string;
  designMd: string;
  planMd: string;
  reviewMd?: string;
}

function idPattern(prefix: string): RegExp {
  return new RegExp(`\\b${prefix}-\\d+\\b`, "gi");
}

/** Every id of one prefix in a document, deduped, in first-appearance order. */
export function extractIds(markdown: string, prefix: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of markdown.matchAll(idPattern(prefix))) {
    const id = match[0].toUpperCase();
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/**
 * Every id of `targetPrefix` that shares a line with at least one of
 * `anchors`, deduped, in the order those lines appear. Line-level rather
 * than section-level on purpose: a task bullet and a Feasibility row are
 * each one line, and that's the granularity the id convention above tags at.
 */
function idsOnSameLineAs(markdown: string, anchors: string[], targetPrefix: string): string[] {
  if (anchors.length === 0) return [];
  const anchorSet = new Set(anchors.map((a) => a.toUpperCase()));
  const target = idPattern(targetPrefix);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const lineIds = new Set([...line.matchAll(idPattern("[A-Z]+"))].map((m) => m[0].toUpperCase()));
    const hasAnchor = [...lineIds].some((id) => anchorSet.has(id));
    if (!hasAnchor) continue;
    for (const match of line.matchAll(target)) {
      const id = match[0].toUpperCase();
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  return ordered;
}

/** True when `taskId`'s row in `planMd`'s task table has Status `verified` — `qa-engineer`'s mark, per `policies/documentation.md` §4, that a task is actually done. */
function isTaskChecked(planMd: string, taskId: string): boolean {
  for (const line of planMd.split(/\r?\n/)) {
    if (!line.includes(taskId)) continue;
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    return (cells[1] ?? "").toLowerCase() === "verified";
  }
  return false;
}

/**
 * Builds the full trace chain, one entry per `REQ-NNN` found in
 * `requirementMd`, in the order requirements were written.
 */
export function buildTraceChain(inputs: TraceInputs): TraceEntry[] {
  const { requirementMd, designMd, planMd, reviewMd } = inputs;
  const requirementIds = extractIds(requirementMd, "REQ");

  const blockingIds = new Set<string>();
  if (reviewMd) {
    for (const row of parseOpenIssues(reviewMd)) {
      if (row.blocking) for (const id of row.affected) blockingIds.add(id.toUpperCase());
    }
  }

  return requirementIds.map((requirement) => {
    const design = idsOnSameLineAs(designMd, [requirement], "DES");
    if (design.length === 0) {
      return { requirement, design: [], tasks: [], tests: [], status: "unplanned" as const };
    }

    const anchors = [requirement, ...design];
    const backend = idsOnSameLineAs(planMd, anchors, "BE");
    const frontend = idsOnSameLineAs(planMd, anchors, "FE");
    const tasks = [...backend, ...frontend];
    const tests = idsOnSameLineAs(`${planMd}\n${reviewMd ?? ""}`, [requirement, ...design, ...tasks], "TEST");

    if (tasks.length === 0) {
      return { requirement, design, tasks, tests, status: "planned" as const };
    }

    const relevantIds = [requirement, ...design, ...tasks];
    const blocked = relevantIds.some((id) => blockingIds.has(id));
    if (blocked) {
      return { requirement, design, tasks, tests, status: "blocked" as const };
    }

    const allChecked = tasks.every((t) => isTaskChecked(planMd, t));
    return { requirement, design, tasks, tests, status: allChecked ? ("verified" as const) : ("in-progress" as const) };
  });
}

export interface TraceabilityCheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * The gap this whole chain exists to surface: a requirement nobody designed
 * for yet, or a design nobody planned tasks for yet. Not an error by itself
 * — early in a module's life every requirement is `unplanned` — but worth
 * naming so it can be checked deliberately rather than discovered by a
 * missing feature at QA time.
 */
export function checkTraceability(entries: TraceEntry[]): TraceabilityCheckResult {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.status === "unplanned") {
      problems.push(`${entry.requirement} has no design.md coverage yet (no DES-NNN row names it)`);
    } else if (entry.status === "planned") {
      problems.push(`${entry.requirement} is designed (${entry.design.join(", ")}) but plan.md has no task for it yet`);
    }
  }
  return { ok: problems.length === 0, problems };
}
