import * as path from "node:path";
import type { KnowledgeItem, SourceRef } from "./knowledgeModel.js";
import { KnowledgeBase } from "./knowledgeBase.js";
import { detectConflicts } from "./knowledgeConflicts.js";
import { freshnessOf } from "./freshness.js";
import { digestOfSource, parseLocator } from "./sourceDigest.js";
import { resolveSource } from "./sourceResolver.js";
import { loadKnowledge } from "./knowledgeStore.js";
import { loadTargetRegistry, targetById } from "../threeRepo/targets.js";
import { loadLocalTargetMapping } from "../threeRepo/localTargets.js";

export const RECONCILIATION_VERDICTS = [
  "match", "knowledge-stale", "target-stale", "pending-requirement", "implementation-drift",
  "target-specific", "global-fact", "conflict", "unknown",
] as const;
export type ReconciliationVerdict = (typeof RECONCILIATION_VERDICTS)[number];

export type EvidenceDigestState = "unchanged" | "changed" | "missing" | "unhashable" | "external" | "invalid" | "unmapped";
export interface ReconciliationEvidence {
  locator: string;
  origin: SourceRef["origin"] | null;
  stored_digest: string | null;
  current_digest: string | null;
  digest_state: EvidenceDigestState;
  reason: string;
}
export interface ReconciledItem {
  id: string;
  module: string | null;
  kind: KnowledgeItem["kind"];
  target_ids: string[];
  axis: "current" | "desired" | "mixed" | "external" | "unknown";
  verdict: ReconciliationVerdict;
  route_to: "system-analyst" | "human" | null;
  reason: string;
  evidence: ReconciliationEvidence[];
}
export interface ReconciliationReport {
  schema_version: 1;
  target_id: string;
  target_path: string;
  knowledge_root: string;
  counts: Record<ReconciliationVerdict, number>;
  items: ReconciledItem[];
}

export function axisFromOrigin(item: KnowledgeItem): ReconciledItem["axis"] {
  const roots = new Set(item.sources.map((source) => source.origin?.root).filter(Boolean));
  if (roots.size === 0) return "unknown";
  if (roots.size > 1) return "mixed";
  const root = [...roots][0];
  return root === "target" ? "current" : root === "knowledge" ? "desired" : "external";
}

function evidenceFor(source: SourceRef, knowledgeRoot: string, targetPaths: ReadonlyMap<string, string>): ReconciliationEvidence {
  const base = { locator: source.locator, origin: source.origin ?? null, stored_digest: source.digest };
  if (!source.origin) return { ...base, current_digest: null, digest_state: "unmapped", reason: "schema v1 source has no declared origin" };
  if (source.digest === null) return { ...base, current_digest: null, digest_state: "unhashable", reason: "source has no stored digest" };
  let resolved: ReturnType<typeof resolveSource>;
  try { resolved = resolveSource(source, knowledgeRoot, targetPaths); }
  catch (error) { return { ...base, current_digest: null, digest_state: "invalid", reason: error instanceof Error ? error.message : String(error) }; }
  if (resolved.state === "external") return { ...base, current_digest: null, digest_state: "external", reason: resolved.reason };
  if (resolved.state === "unavailable") return { ...base, current_digest: null, digest_state: "unmapped", reason: resolved.reason };
  if (resolved.state === "invalid") return { ...base, current_digest: null, digest_state: "invalid", reason: resolved.reason };
  if (resolved.state !== "resolved") return { ...base, current_digest: null, digest_state: "invalid", reason: "source resolution produced no local path" };
  const { from, to } = parseLocator(source.locator);
  const range = from === undefined ? "" : to === undefined || to === from ? `#L${from}` : `#L${from}-L${to}`;
  const current = digestOfSource(`${resolved.path}${range}`, ".");
  if (current === null) return { ...base, current_digest: null, digest_state: "missing", reason: "resolved source cannot be read" };
  return {
    ...base,
    current_digest: current,
    digest_state: current === source.digest ? "unchanged" : "changed",
    reason: current === source.digest ? "stored and current digests match" : "current digest differs from the captured digest",
  };
}

function isDesignContract(item: KnowledgeItem): boolean {
  return (item.kind === "api" || item.kind === "db-schema") && item.sources.some((source) => /(^|\/)design\.md(?:#|$)/i.test(source.locator));
}

export function classifyReconciliationItem(
  item: KnowledgeItem,
  evidence: readonly ReconciliationEvidence[],
  conflict: string | undefined,
  allTargetIds: ReadonlySet<string>,
): Pick<ReconciledItem, "verdict" | "route_to" | "reason"> {
  if (conflict) return { verdict: "conflict", route_to: "human", reason: conflict };
  if (item.schema_version < 2 || item.sources.some((source) => !source.origin)) {
    return { verdict: "unknown", route_to: "human", reason: "schema v2 origin evidence is missing; migrate before reconciling" };
  }
  const unusable = evidence.filter((entry) => ["missing", "unhashable", "external", "invalid", "unmapped"].includes(entry.digest_state));
  const targetEvidence = evidence.filter((entry) => entry.origin?.root === "target");
  const desiredEvidence = evidence.filter((entry) => entry.origin?.root === "knowledge");
  const targetChanged = targetEvidence.some((entry) => entry.digest_state === "changed");
  const desiredChanged = desiredEvidence.some((entry) => entry.digest_state === "changed");
  if (targetChanged && desiredChanged) return { verdict: "conflict", route_to: "human", reason: "current and desired evidence both changed; authority is insufficient to guess a winner" };
  if (isDesignContract(item) && targetChanged) {
    return { verdict: "implementation-drift", route_to: "system-analyst", reason: "Target evidence moved away from the design.md contract; system-analyst reconciles the design contract" };
  }
  if (targetChanged) return { verdict: "knowledge-stale", route_to: "human", reason: "Target-origin current-state evidence changed after this descriptive item was captured" };
  if (desiredChanged && (item.kind === "requirement" || item.kind === "business-rule" || item.kind === "domain") && targetEvidence.length === 0) {
    return { verdict: "pending-requirement", route_to: "human", reason: "desired-state requirement changed and has no Target-origin implementation counterpart; keep it as backlog" };
  }
  if (desiredChanged) return { verdict: "target-stale", route_to: isDesignContract(item) ? "system-analyst" : "human", reason: "Knowledge-origin desired contract changed and Target evidence has not followed" };
  if (unusable.length > 0) return { verdict: "unknown", route_to: "human", reason: `insufficient evidence: ${unusable.map((entry) => `${entry.locator} (${entry.digest_state})`).join(", ")}` };
  if ((item.kind === "requirement" || item.kind === "business-rule") && desiredEvidence.length > 0 && targetEvidence.length === 0) {
    return { verdict: "pending-requirement", route_to: "human", reason: "desired-state item has no Target-origin counterpart; it must never be reconciled toward Target" };
  }
  if ((item.target_ids ?? []).length === 1) return { verdict: "target-specific", route_to: null, reason: `fact is scoped only to Target ${item.target_ids![0]}` };
  const targetOrigins = new Set(targetEvidence.map((entry) => entry.origin?.target_id).filter((id): id is string => Boolean(id)));
  if (allTargetIds.size > 0 && targetOrigins.size === allTargetIds.size && [...allTargetIds].every((id) => targetOrigins.has(id))) {
    return { verdict: "global-fact", route_to: null, reason: "unchanged Target evidence covers every bound Target" };
  }
  if (evidence.length > 0 && evidence.every((entry) => entry.digest_state === "unchanged")) return { verdict: "match", route_to: null, reason: "no meaningful digest delta" };
  return { verdict: "unknown", route_to: "human", reason: "no checkable evidence establishes a safe classification" };
}

/** Pure read-only classifier. It has no import from any Knowledge writer. */
export function reconcileKnowledge(options: { knowledgeRoot: string; frameworkRoot: string; targetId: string; now: string }): ReconciliationReport {
  const registry = loadTargetRegistry(options.knowledgeRoot);
  targetById(registry, options.targetId);
  const mapped = loadLocalTargetMapping(options.knowledgeRoot, registry, options.frameworkRoot);
  const target = mapped.find((entry) => entry.target_id === options.targetId);
  if (!target) throw new Error(`Target "${options.targetId}" has no local path in .workflow/targets.local.yaml`);
  const targetPaths = new Map(mapped.map((entry) => [entry.target_id, entry.path]));
  const loaded = loadKnowledge(options.knowledgeRoot);
  if (loaded.problems.length > 0) throw new Error(`Knowledge cannot be reconciled: ${loaded.problems.join("; ")}`);
  const kb = new KnowledgeBase(loaded.items);
  const scoped = kb.query({ target_ids: [options.targetId] }).sort((a, b) => `${a.module}/${a.id}`.localeCompare(`${b.module}/${b.id}`));
  const conflictByItem = new Map<string, string>();
  for (const conflict of detectConflicts(kb)) {
    const members = conflict.items.map((id) => kb.get(id)).filter((item): item is KnowledgeItem => item !== null);
    const disjointSpecific = members.length > 1 && members.every((item) => (item.target_ids ?? []).length > 0) &&
      members.every((item, index) => members.slice(index + 1).every((other) => !(item.target_ids ?? []).some((id) => (other.target_ids ?? []).includes(id))));
    if (disjointSpecific) continue;
    if (members.length > 0 && members.every((item) => item.status === "approved")) {
      for (const item of members) conflictByItem.set(item.id, conflict.summary);
    }
  }
  const allTargetIds = new Set(mapped.map((entry) => entry.target_id));
  const items = scoped.map((item): ReconciledItem => {
    // freshnessOf is deliberately invoked as the single aggregate freshness
    // mechanism; evidence detail below composes the same resolver/digest tools.
    freshnessOf(item, { now: options.now, projectRoot: options.knowledgeRoot, knowledgeRoot: options.knowledgeRoot, targetPaths });
    const evidence = item.sources.map((source) => evidenceFor(source, options.knowledgeRoot, targetPaths));
    return { id: item.id, module: item.module, kind: item.kind, target_ids: item.target_ids ?? [], axis: axisFromOrigin(item), ...classifyReconciliationItem(item, evidence, conflictByItem.get(item.id), allTargetIds), evidence };
  });
  const counts = Object.fromEntries(RECONCILIATION_VERDICTS.map((verdict) => [verdict, items.filter((item) => item.verdict === verdict).length])) as Record<ReconciliationVerdict, number>;
  return { schema_version: 1, target_id: options.targetId, target_path: target.path, knowledge_root: path.resolve(options.knowledgeRoot), counts, items };
}

export function renderReconciliationReport(report: ReconciliationReport): string {
  const lines = [`Knowledge reconciliation for Target ${report.target_id}: ${report.items.length} item(s).`];
  const matches = report.counts.match;
  if (matches > 0) lines.push(`${matches} item(s) match with no meaningful delta.`);
  for (const item of report.items.filter((entry) => entry.verdict !== "match")) {
    lines.push(`- ${item.module ?? "_project"}/${item.id}: ${item.verdict} — ${item.reason}`);
    for (const evidence of item.evidence) lines.push(`  evidence: ${evidence.locator} [${evidence.digest_state}] stored=${evidence.stored_digest ?? "null"} current=${evidence.current_digest ?? "null"}`);
    if (item.route_to) lines.push(`  route: ${item.route_to}`);
  }
  return lines.join("\n");
}
