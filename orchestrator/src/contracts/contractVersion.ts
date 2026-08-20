import type { TaskNode } from "../graph/taskGraph.js";

/**
 * Contract Version (T18) — `design.md`'s Data Model and Contract sections are
 * what `backend-engineer` implements verbatim and `frontend-engineer` derives
 * types from (CLAUDE.md's "design.md's Data Model is the contract" rule).
 * Nothing previously said whether a given `plan.md` task was written against
 * the schema as it stands today or against an earlier shape an amendment
 * later changed underneath it — an engineer had to notice the drift by
 * memory, or not notice it at all.
 *
 * `.claude/agents/system-analyst.md`'s Output template now requires a
 * `**Contract Version:** <N>` line, bumped by 1 whenever an amendment changes
 * the Data Model or a Contract section (never for a wording-only edit, since
 * nothing an engineer built against actually changed shape). `plan.md`
 * records the version it was written against the same way. This module reads
 * both and says which tasks are stale — planned against a number lower than
 * the design's current one.
 *
 * Deliberately not wired to real files yet: there is no live `_docs/module/`
 * in this repo to read from, and `TaskNode.contractVersion` (the per-task
 * half of this) has nowhere to be populated from until `plan.md` is actually
 * ingested into a `TaskGraph` (T52, still open) — the same gap `changeImpact.ts`
 * (T17) is waiting on. This is the checkable half, ready for T52 to call.
 */

const VERSION_LINE = /\*\*Contract Version:?\*\*:?\s*`?(\d+)`?/i;

export class ContractVersionError extends Error {
  constructor(
    public readonly label: string,
    message: string,
  ) {
    super(`${label}: ${message}`);
    this.name = "ContractVersionError";
  }
}

/**
 * Extracts the `**Contract Version:** N` line from a `design.md` or
 * `plan.md`'s raw text. Throws rather than defaulting to 1 on a miss — a
 * document written before T18 landed and a document that genuinely says "1"
 * must not read as the same thing, or drift becomes undetectable exactly
 * where it matters.
 */
export function parseContractVersion(markdown: string, label: string = "document"): number {
  const match = VERSION_LINE.exec(markdown);
  if (!match) {
    throw new ContractVersionError(label, "no \"**Contract Version:** <N>\" line found");
  }
  return Number(match[1]);
}

export interface ContractVersionCheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * Flags every task whose declared `contractVersion` is behind the design's
 * current one — planned against a Data Model an amendment has since changed.
 * A task with no `contractVersion` at all is not flagged: that's a task this
 * convention hasn't reached yet (an older plan, or one from before T18),
 * which is a gap to close going forward, not a drift to report every run.
 */
export function checkTaskContractVersions(nodes: TaskNode[], currentVersion: number): ContractVersionCheckResult {
  const problems: string[] = [];
  for (const node of nodes) {
    if (node.contractVersion === undefined) continue;
    if (node.contractVersion < currentVersion) {
      problems.push(
        `${node.id} was planned against Contract Version ${node.contractVersion}, but design.md is now at ` +
          `${currentVersion} — the Data Model or a Contract section changed since this task was planned; ` +
          "re-check it before implementing rather than assuming it's still accurate",
      );
    } else if (node.contractVersion > currentVersion) {
      problems.push(
        `${node.id} declares Contract Version ${node.contractVersion}, which is newer than design.md's ` +
          `current ${currentVersion} — that can only mean the two are out of sync, not that the task is ahead`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}
