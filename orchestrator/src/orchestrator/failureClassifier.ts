import { AgentStage } from "../types.js";
import { sectionMap } from "../context/contextManager.js";
import { parseSecurityReport } from "../agents/moduleDocs.js";
import { routeByCategory, type FailureCategory } from "../routing/failureRouting.js";
import type { StructuredFailure } from "./failure.js";

/**
 * Turns a real `review.md` / `security.md` into the structured failure
 * `failure.ts` routes on.
 *
 * `failure.ts` (T01) defined the record and the routing but said in so many
 * words that producing one from a real document was T06's job and deliberately
 * absent. Until this existed the gap was silent rather than loud: the executor
 * simply omitted `failure`, and every failed round fell back to "send it to the
 * first implementation stage" — so a schema gap owned by `system-analyst` and a
 * genuine backend bug were routed identically, which is precisely the misrouting
 * `qa-engineer.md` warns produces rounds of an engineer guessing at a decision
 * that was never theirs.
 *
 * WHERE THE ANSWER COMES FROM
 *
 * Not from keyword-guessing at prose. `qa-engineer` already writes the routing
 * decision down: `## Open Issues — all phases` is a table whose columns are the
 * issue, its phase, **which agent it routes to**, whether it blocks, and **how
 * many re-check rounds it has had**. This reads those columns. The agent that
 * looked at the code decides the owner; this only transcribes that decision into
 * a form the orchestrator can act on.
 *
 * NEVER GUESS AN OWNER
 *
 * When the document does not name one — no table, a row with no role in it,
 * or blocking rows that disagree about who owns them — the result is
 * `category: "unknown"` with `requiresHuman: true`, and the task stops for a
 * person. That asymmetry is deliberate: a wrong owner costs two fresh-context
 * agent runs and produces a fix that was never the real problem, while stopping
 * costs one question. `qa-engineer.md`'s own two-round ceiling exists because
 * that failure mode is expensive and invisible from inside a single round.
 */

/** The five routing targets `qa-engineer.md` names, plus the two the pipeline can also own. */
const CATEGORY_BY_OWNER: Record<string, StructuredFailure["category"]> = {
  [AgentStage.BACKEND_ENGINEER]: "implementation",
  [AgentStage.FRONTEND_ENGINEER]: "implementation",
  [AgentStage.SYSTEM_ANALYST]: "contract",
  [AgentStage.BUSINESS_ANALYST]: "requirement",
  [AgentStage.DEVOPS]: "infrastructure",
  [AgentStage.QA_ENGINEER]: "test",
  [AgentStage.SETUP]: "infrastructure",
  [AgentStage.SECURITY]: "implementation",
  [AgentStage.PROJECT_MANAGER]: "contract",
};

/** Roles longest-first, so `backend-engineer` is never matched as `engineer` inside another name. */
const ROLE_SLUGS = Object.values(AgentStage)
  .filter((s) => s !== AgentStage.HUMAN)
  .sort((a, b) => b.length - a.length);

/** `qa-engineer.md`'s ceiling: after the second failed re-check, an item stops going back to an engineer. */
export const REROUTE_CEILING = 2;

const OPEN_ISSUES = /open\s+issues?/i;
const ID_PATTERN = /\b(?:BE|FE|QA|SA|BA|DO|SEC|REQ|DES|TEST)-\d+\b/gi;

export interface OpenIssueRow {
  raw: string;
  /**
   * The role the row routes to, or null when it names none.
   *
   * Was non-nullable before T38, because a line only became a row once it named
   * a role. A row that states the *category* and no role is now kept too — it
   * carries a real routing answer (see `category` below), and dropping it was
   * how a written-down decision got treated as silence.
   */
  owner: AgentStage | null;
  /** The problem type, when the row states one outright. Never inferred from the prose. */
  category: FailureCategory | null;
  blocking: boolean;
  /** Re-check rounds this item has already had, per the column `qa-engineer` maintains. */
  rounds: number;
  affected: string[];
}

function sectionText(markdown: string, match: RegExp): string | null {
  const lines = markdown.split(/\r?\n/);
  const sections = sectionMap(markdown);
  const found = sections.find((s) => match.test(s.heading));
  if (!found) return null;
  return lines.slice(found.start + 1, found.end).join("\n");
}

function ownerIn(line: string): AgentStage | null {
  const found = ROLE_SLUGS.find((role) => line.includes(role));
  return (found as AgentStage) ?? null;
}

/** The categories a row may state. `unknown` is not among them — it is what this module *produces*, never something a document declares. */
const STATED_CATEGORIES: FailureCategory[] = ["implementation", "contract", "requirement", "infrastructure", "test"];

const CATEGORY_LABEL = /\b(?:type|category|kind|ประเภท)\s*[:：]\s*([a-z]+)/i;

/**
 * The problem type a row states, or null.
 *
 * Held to the same standard as `ownerIn`: the word has to actually be there, as
 * a whole table cell or behind an explicit `Type:` label. Nothing here reads a
 * sentence and decides it sounds like a contract problem — that inference is
 * precisely what this module refuses to make about the owner, and the category
 * is not a softer question just because it has fewer possible answers.
 */
function categoryIn(line: string): FailureCategory | null {
  for (const cell of line.split("|")) {
    const text = cell.trim().toLowerCase();
    const stated = STATED_CATEGORIES.find((c) => c === text);
    if (stated) return stated;
    const labelled = text.match(CATEGORY_LABEL);
    if (labelled) {
      const named = STATED_CATEGORIES.find((c) => c === labelled[1].toLowerCase());
      if (named) return named;
    }
  }
  return null;
}

function roundsIn(line: string): number {
  // "3 rounds", "3 รอบ", or a cell holding nothing but a small integer.
  const labelled = line.match(/(\d+)\s*(rounds?|รอบ)/i);
  if (labelled) return Number(labelled[1]);
  for (const cell of line.split("|")) {
    const t = cell.trim();
    if (/^\d{1,2}$/.test(t)) return Number(t);
  }
  return 0;
}

function isBlocking(line: string): boolean {
  if (/non-?blocking|ไม่บล็อก|ไม่ block/i.test(line)) return false;
  return /blocking|บล็อก|blocker/i.test(line);
}

/**
 * Reads the rows of `## Open Issues — all phases`.
 *
 * A line counts as a row once it names a role *or* states a problem category
 * (T38) — a header or separator does neither. The category-only case is the one
 * T38 adds: it carries a real routing answer, just not one phrased as a role.
 */
export function parseOpenIssues(reviewMd: string): OpenIssueRow[] {
  const section = sectionText(reviewMd, OPEN_ISSUES);
  if (section === null) return [];

  const rows: OpenIssueRow[] = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || /^\|?\s*:?-{2,}/.test(trimmed)) continue; // table separator
    const owner = ownerIn(trimmed);
    const category = categoryIn(trimmed);
    if (!owner && !category) continue;

    rows.push({
      raw: trimmed,
      owner,
      category,
      blocking: isBlocking(trimmed),
      rounds: roundsIn(trimmed),
      affected: [...new Set((trimmed.match(ID_PATTERN) ?? []).map((s) => s.toUpperCase()))],
    });
  }
  return rows;
}

function unknownFailure(reason: string, affected: string[] = []): StructuredFailure {
  return {
    category: "unknown",
    owner: AgentStage.HUMAN,
    severity: "high",
    retryable: false,
    reason,
    affected,
    requiresHuman: true,
  };
}

export interface QaClassificationOptions {
  /** Overrides the ceiling for tests; `qa-engineer.md` fixes it at 2 in the real pipeline. */
  ceiling?: number;
  /**
   * The stages this task actually runs (T38). Given, a stated category resolves
   * to a stage the task can genuinely reach; withheld, it resolves to the
   * category's canonical destination and `routeFailure` still refuses it if this
   * pipeline has no such stage. Optional because the runtime executor is handed
   * a stage and a task id, not a pipeline.
   */
  pipeline?: readonly AgentStage[];
}

/**
 * Classifies a failed QA round.
 *
 * Returns null when the document reports nothing to route — a round with no open
 * issues is not a failure this can describe, and inventing one would send a task
 * backwards for no reason.
 */
export function classifyQaFailure(reviewMd: string, opts: QaClassificationOptions = {}): StructuredFailure | null {
  const ceiling = opts.ceiling ?? REROUTE_CEILING;
  const rows = parseOpenIssues(reviewMd);

  if (rows.length === 0) {
    // The doc failed, but nothing in it says who owns what. That is exactly the
    // case where guessing is most tempting and most expensive.
    const hasFailureMarker = /❌|⚠️/.test(reviewMd);
    if (!hasFailureMarker) return null;
    return unknownFailure(
      "review.md reports a failed round but `## Open Issues — all phases` names no agent to route it to — " +
        "the owner is a human decision, not something to infer from the prose",
    );
  }

  // Blocking rows decide the route; a non-blocking item does not stop a task.
  const blocking = rows.filter((r) => r.blocking);
  const deciding = blocking.length > 0 ? blocking : rows;

  const owners = [...new Set(deciding.map((r) => r.owner).filter((o): o is AgentStage => o !== null))];
  const affected = [...new Set(deciding.flatMap((r) => r.affected))];
  const worstRounds = Math.max(...deciding.map((r) => r.rounds));
  const reason = deciding[0].raw.replace(/\s+/g, " ").slice(0, 300);

  if (owners.length > 1) {
    return unknownFailure(
      `open issues route to more than one owner (${owners.join(", ")}) — the orchestrator drives one stage at a time, ` +
        "so which to send back first is a human decision",
      affected,
    );
  }

  // T38: no row named a role, but one may still have named the *kind* of problem.
  // A stated category is a written decision, not an inference, so it routes —
  // and anything less than a single agreed category still stops for a person.
  if (owners.length === 0) {
    // Never empty: a row with neither a role nor a category was not kept as a row
    // at all, so reaching here means every deciding row stated one.
    const stated = [...new Set(deciding.map((r) => r.category).filter((c): c is FailureCategory => c !== null))];
    if (stated.length > 1) {
      return unknownFailure(
        `open issues state more than one problem category (${stated.join(", ")}), which route to different agents — ` +
          "which to send back first is a human decision",
        affected,
      );
    }

    const decision = routeByCategory(stated[0], { pipeline: opts.pipeline, affected });
    if (!decision.stage) return unknownFailure(decision.reason, affected);

    return finishClassification({
      owner: decision.stage,
      category: stated[0],
      blocking: blocking.length > 0,
      worstRounds,
      ceiling,
      affected,
      reason: `${reason} [routed by category: ${decision.reason}]`,
    });
  }

  return finishClassification({
    owner: owners[0],
    category: CATEGORY_BY_OWNER[owners[0]] ?? "unknown",
    blocking: blocking.length > 0,
    worstRounds,
    ceiling,
    affected,
    reason,
  });
}

/**
 * The last step both routing paths share: apply `qa-engineer.md`'s two-round
 * ceiling, then report.
 *
 * Shared rather than repeated because the ceiling is the rule most easily lost
 * when a second path is added — an item that survives two honest fix attempts is
 * usually misrouted, and a category-routed item is if anything *more* likely to
 * be, since no person named its owner.
 */
function finishClassification(params: {
  owner: AgentStage;
  category: FailureCategory;
  blocking: boolean;
  worstRounds: number;
  ceiling: number;
  affected: string[];
  reason: string;
}): StructuredFailure {
  const { owner, category, blocking, worstRounds, ceiling, affected, reason } = params;

  if (worstRounds >= ceiling) {
    return {
      category,
      owner,
      severity: "high",
      retryable: false,
      reason:
        `item has had ${worstRounds} re-check rounds, at or past the ceiling of ${ceiling} — ` +
        `qa-engineer.md: an item that survives two honest fix attempts is usually misrouted, not badly implemented: ${reason}`,
      affected,
      requiresHuman: true,
    };
  }

  return {
    category,
    owner,
    severity: blocking ? "high" : "medium",
    // Re-running the owner can plausibly fix it. Whether the state machine has a
    // path back to that owner is routeFailure()'s call, not this one's — and it
    // escalates when there is none, rather than this pre-empting the question.
    retryable: true,
    reason,
    affected,
    requiresHuman: false,
  };
}

/**
 * Classifies a failed security audit.
 *
 * Every Critical/High finding that is still open is a hard stop for a person in
 * every mode (CLAUDE.md), so this reports `requiresHuman` rather than routing —
 * and it never marks a finding fixed, since only `security` closes one.
 */
export function classifySecurityFailure(securityMd: string, taskId = "task"): StructuredFailure | null {
  const report = parseSecurityReport(taskId, securityMd);
  const unresolved = report.findings.filter((f) => f.status === "OPEN" || f.status === "FIX_CLAIMED");
  if (unresolved.length === 0) return null;

  const blocking = unresolved.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH");
  const deciding = blocking.length > 0 ? blocking : unresolved;
  const affected = deciding.map((f) => f.id);

  return {
    category: "implementation",
    owner: AgentStage.HUMAN,
    severity: deciding.some((f) => f.severity === "CRITICAL") ? "critical" : blocking.length > 0 ? "high" : "medium",
    retryable: false,
    reason:
      `${deciding.length} unresolved security finding(s) (${affected.join(", ")}): ` +
      `${deciding[0].description.slice(0, 200)} — a Critical/Important finding stops the pipeline for a person in every mode, ` +
      "and only `security` may close one",
    affected,
    requiresHuman: true,
  };
}
