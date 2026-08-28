import { AgentStage } from "../types.js";
import type { PersistedEvent, TaskStore } from "../store/taskStore.js";

/**
 * The audit trail (T37): WHO / WHAT / WHEN / WHY / INPUT / OUTPUT / DECISION for
 * every event a task produced.
 *
 * WHAT WAS MISSING
 *
 * Events have been stored since T01 — `task_id`, `at`, `type`, `payload`. That
 * is WHEN and WHAT, and the payload happens to contain the rest, buried in a
 * different shape per event type. So "why did this task go back to
 * backend-engineer three times?" was answerable only by someone who knew the
 * payload shape of every event type and was willing to read JSON by hand.
 *
 * The point of T37 is that the decision record is the deliverable, not a
 * by-product: an AI pipeline that cannot show why it did what it did is one
 * nobody can correct. So the seven fields are made first-class — derived here
 * once, from the one place that knows every payload shape, and written into
 * their own columns rather than left implicit.
 *
 * WHY DERIVED *AND* STORED
 *
 * Stored, so an external reader (a dashboard, a query, a person with `sqlite3`)
 * gets the answer without this module. Derived, so the trail still works on rows
 * written before those columns existed — a stored null means "not recorded",
 * and falling back to the derivation turns the whole existing history into a
 * readable trail instead of a wall of nulls with a cutoff date.
 */

export const ORCHESTRATOR_ACTOR = "orchestrator";
export const HUMAN_ACTOR = "human";

export interface AuditFields {
  /** WHO caused this — an agent role, a person's name, or the orchestrator itself. */
  actor: string | null;
  /** WHY it happened, in the words the event carried. */
  reason: string | null;
  /** What went in: the artifact categories an agent was handed, or the answer a person gave. */
  input: string | null;
  /** What came out: the artifact produced, the verdict, the cost. */
  output: string | null;
  /** The choice made, as a short stable token — this is the column you filter on to see only decisions. */
  decision: string | null;
}

export const EMPTY_AUDIT: AuditFields = { actor: null, reason: null, input: null, output: null, decision: null };

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function nested(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = payload[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" ? value : null;
}

/**
 * Reads the seven fields out of one stored event.
 *
 * Every branch here is a payload shape this repo actually emits. An unknown type
 * returns empty fields rather than guessing — an audit trail that invents an
 * actor is worse than one that admits it does not know, because the whole value
 * of the record is that it can be trusted when someone is trying to work out
 * what went wrong.
 */
export function describeEvent(type: string, payload: Record<string, unknown>): AuditFields {
  switch (type) {
    case "AGENT_ASSIGNED": {
      const stage = str(payload, "stage");
      const inputs = list(payload, "inputs");
      return {
        actor: ORCHESTRATOR_ACTOR,
        reason: null,
        input: inputs.length > 0 ? inputs.join(", ") : null,
        output: null,
        decision: stage ? `assign:${stage}` : null,
      };
    }

    case "AGENT_COMPLETED": {
      const outcome = nested(payload, "outcome") ?? {};
      const result = str(outcome, "result");
      const tokens = num(outcome, "tokens");
      const artifact = str(payload, "artifactType");
      const packetPath = str(payload, "packetPath");
      const parts = [artifact, result, tokens === null ? null : `${tokens} tokens`].filter((p) => p !== null);
      return {
        actor: str(payload, "stage"),
        reason: str(outcome, "failure_reason"),
        input: packetPath === null ? null : `execution-packet:${packetPath}`,
        output: parts.length > 0 ? parts.join(", ") : null,
        decision: null,
      };
    }

    case "QA_PASSED":
    case "SECURITY_PASSED": {
      const round = num(payload, "round");
      return {
        actor: str(payload, "stage"),
        reason: null,
        input: null,
        output: round === null ? "PASS" : `PASS (round ${round})`,
        // A verdict is a decision about someone else's work — that is exactly
        // what separates a reviewer's "passed" from a producer's (see T39).
        decision: "verdict:pass",
      };
    }

    case "QA_FAILED":
    case "SECURITY_FAILED": {
      const failure = nested(payload, "failure");
      const recovery = nested(payload, "recovery");
      const round = num(payload, "round");
      const owner = failure ? str(failure, "owner") : null;
      const kind = recovery ? str(recovery, "kind") : null;
      const strategy = recovery ? str(recovery, "strategy") : null;
      return {
        actor: str(payload, "stage"),
        reason: (failure ? str(failure, "reason") : null) ?? (recovery ? str(recovery, "reason") : null),
        input: null,
        output: round === null ? "FAIL" : `FAIL (round ${round})`,
        decision: kind ? `${kind.toLowerCase()}${owner ? `:${owner}` : strategy ? `:${strategy}` : ""}` : "verdict:fail",
      };
    }

    case "WAITING_FOR_HUMAN": {
      const approvalType = str(payload, "approvalType");
      const from = str(payload, "from");
      const to = str(payload, "to");
      return {
        actor: ORCHESTRATOR_ACTOR,
        reason: str(payload, "reason"),
        input: from && to ? `${from} -> ${to}` : null,
        output: null,
        decision: `wait:${approvalType ?? "gate"}`,
      };
    }

    case "APPROVAL_REQUIRED": {
      const approval = nested(payload, "approval") ?? {};
      const approvalType = str(approval, "type");
      const from = str(approval, "from");
      const to = str(approval, "to");
      return {
        actor: ORCHESTRATOR_ACTOR,
        reason: str(approval, "reason"),
        input: from && to ? `${from} -> ${to}` : null,
        output: null,
        decision: `ask:${approvalType ?? "approval"}`,
      };
    }

    case "APPROVAL_DECIDED": {
      const approved = payload["approved"] === true;
      const approvalType = str(payload, "type");
      return {
        // The one event a person, not the pipeline, is the author of.
        actor: str(payload, "by") ?? HUMAN_ACTOR,
        reason: str(payload, "note"),
        input: approvalType,
        output: approved ? "approved" : "rejected",
        decision: `${approved ? "approve" : "reject"}:${approvalType ?? "approval"}`,
      };
    }

    case "TASK_BLOCKED":
      return {
        actor: ORCHESTRATOR_ACTOR,
        reason: str(payload, "reason"),
        input: null,
        output: null,
        decision: "block",
      };

    // Code-intelligence provider events (T-GR13): the optional graphify-backed
    // context resolver reports through the same trail instead of a parallel
    // observability system. Payloads carry metadata only — never source text.
    case "CODE_INTELLIGENCE_QUERY":
    case "CODE_INTELLIGENCE_HIT":
    case "CODE_INTELLIGENCE_FALLBACK":
    case "CODE_INTELLIGENCE_STALE":
    case "CODE_INTELLIGENCE_ERROR":
    case "CODE_INTELLIGENCE_DENIED":
    case "CODE_INTELLIGENCE_SOURCE_VERIFIED": {
      const operation = str(payload, "operation");
      const reason = str(payload, "reason");
      const count = num(payload, "candidates");
      const role = str(payload, "role");
      let decision: string | null = null;
      if (type === "CODE_INTELLIGENCE_DENIED") decision = "deny:code-intelligence";
      else if (type === "CODE_INTELLIGENCE_FALLBACK") decision = "fallback:search";
      else if (type === "CODE_INTELLIGENCE_SOURCE_VERIFIED") decision = "source_verified";
      const output =
        type === "CODE_INTELLIGENCE_HIT" && count !== null ? `${count} candidate(s)` : null;
      return {
        actor: role ?? ORCHESTRATOR_ACTOR,
        reason,
        input: operation,
        output,
        decision,
      };
    }

    case "TASK_DEPLOYED":
      return { actor: ORCHESTRATOR_ACTOR, reason: null, input: null, output: null, decision: "deploy" };

    case "DEPLOY_COMPLETED": {
      const stages = list(payload, "stages");
      const runs = num(payload, "runs");
      const cost = num(payload, "totalCost");
      const tokens = num(payload, "totalTokens");
      const parts = [
        runs === null ? null : `${runs} run(s)`,
        tokens === null ? null : `${tokens} tokens`,
        cost === null ? null : `$${cost.toFixed(2)}`,
      ].filter((p) => p !== null);
      return {
        actor: ORCHESTRATOR_ACTOR,
        reason: null,
        input: stages.length > 0 ? stages.join(" -> ") : null,
        output: parts.length > 0 ? parts.join(", ") : null,
        decision: null,
      };
    }

    default:
      return { ...EMPTY_AUDIT };
  }
}

export interface AuditEntry extends AuditFields {
  taskId: string;
  /** WHEN. */
  at: number;
  /** WHAT. */
  type: string;
  payload: Record<string, unknown>;
}

/** Whichever of the two sources actually knows: a stored value wins, the derivation fills the gaps. */
function merge(stored: Partial<AuditFields>, derived: AuditFields): AuditFields {
  return {
    actor: stored.actor ?? derived.actor,
    reason: stored.reason ?? derived.reason,
    input: stored.input ?? derived.input,
    output: stored.output ?? derived.output,
    decision: stored.decision ?? derived.decision,
  };
}

export function toAuditEntry(event: PersistedEvent): AuditEntry {
  const derived = describeEvent(event.type, event.payload);
  return {
    taskId: event.taskId,
    at: event.at,
    type: event.type,
    payload: event.payload,
    ...merge(event, derived),
  };
}

/** The full trail for one task, oldest first — the order the store already returns them in. */
export function auditTrail(store: Pick<TaskStore, "eventsForTask">, taskId: string): AuditEntry[] {
  return store.eventsForTask(taskId).map(toAuditEntry);
}

/**
 * Only the entries that recorded a choice.
 *
 * This is the question T37 is actually for — "ย้อนดูการตัดสินใจของ AI" — and it
 * is a different list from "everything that happened": a completed agent run is
 * a fact, while routing a failure back to `system-analyst` is a decision that
 * could have gone another way and may have been wrong.
 */
export function decisionTrail(entries: readonly AuditEntry[]): AuditEntry[] {
  return entries.filter((e) => e.decision !== null);
}

/** Every actor that appears in a trail, in the order they first acted. */
export function actorsIn(entries: readonly AuditEntry[]): string[] {
  const seen: string[] = [];
  for (const entry of entries) {
    if (entry.actor && !seen.includes(entry.actor)) seen.push(entry.actor);
  }
  return seen;
}

/** True when a role that runs agents appears as an actor — used to tell agent activity from bookkeeping. */
export function isAgentActor(actor: string | null): boolean {
  return actor !== null && (Object.values(AgentStage) as string[]).includes(actor);
}

function timestamp(at: number): string {
  return new Date(at).toISOString();
}

export interface FormatAuditOptions {
  /** Show only entries that recorded a decision. */
  decisionsOnly?: boolean;
}

/**
 * Renders a trail for a person reading a terminal.
 *
 * One block per event rather than one line: `reason` is routinely a full
 * sentence from `review.md`, and a table that truncates the "why" column defeats
 * the purpose of having recorded it.
 */
export function formatAuditTrail(entries: readonly AuditEntry[], opts: FormatAuditOptions = {}): string {
  const shown = opts.decisionsOnly ? decisionTrail(entries) : entries;
  if (shown.length === 0) return "(no events recorded for this task)";

  const lines: string[] = [];
  for (const entry of shown) {
    lines.push(`${timestamp(entry.at)}  ${entry.type}${entry.actor ? `  who=${entry.actor}` : ""}`);
    if (entry.decision) lines.push(`    decision: ${entry.decision}`);
    if (entry.reason) lines.push(`    why:      ${entry.reason}`);
    if (entry.input) lines.push(`    in:       ${entry.input}`);
    if (entry.output) lines.push(`    out:      ${entry.output}`);
  }
  return lines.join("\n");
}
