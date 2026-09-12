import { z } from "zod";
import { AgentStage } from "../types.js";
import { stableHash, Sha256Schema } from "./executionPacket.js";
import type { StructuredFailure } from "../orchestrator/failure.js";

/**
 * T-V8-013 — durable finding and repair-packet identity.
 *
 * `StructuredFailure` (`orchestrator/failure.ts`) already answers "what broke,
 * who owns it, can it be retried" for one moment in the pipeline, but it
 * carries no identity of its own: nothing ties one occurrence of a defect to
 * the next, to the exact acceptance/design ids it violates, to the files a fix
 * must touch, or to the packet/attempt that produced it. `deriveHandoff`'s
 * `open_findings` (`agents/moduleDocs.ts`) is a compact *pointer*, by design —
 * useful as an index, not as the record a repair round replays against.
 *
 * `Finding` is that missing record. Its `finding_id` is a content hash of the
 * defect itself (task, category, owner, expected/observed, files) —
 * deliberately excluding `run_id`/`attempt`/`packet_hash`, so the *same*
 * defect recurring across attempts (or reported twice in one round) resolves
 * to the *same* id, and a rewritten `review.md`/`security.md` or an archive
 * move (`review.md` -> `review/phase-N.md`) cannot mint a new one for an issue
 * nobody touched. `run_id`/`attempt`/`packet_hash` still live on the record —
 * they answer "which attempt raised this", a different question from "which
 * defect is this".
 */

export const FindingCategorySchema = z.enum(["implementation", "contract", "requirement", "test", "infrastructure", "unknown"]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

/**
 * OPEN -> FIX_CLAIMED -> VERIFIED -> ACCEPTED, matching `security.md`'s own
 * vocabulary (`SecurityFindingSchema`'s OPEN/FIX_CLAIMED/FIXED/ACCEPTED) one
 * name apart (VERIFIED here where security says FIXED) because this schema
 * also covers QA-raised findings, and "verified" is what a re-check actually
 * does — it does not itself fix anything.
 */
export const FindingStatusSchema = z.enum(["OPEN", "FIX_CLAIMED", "VERIFIED", "ACCEPTED"]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FindingSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingFileRefSchema = z.strictObject({
  path: z.string().min(1),
  symbol: z.string().min(1).optional(),
  /** Free-text range ("12-40"); this module reads what a finding names, it never computes ranges itself. */
  lines: z.string().min(1).optional(),
});
export type FindingFileRef = z.infer<typeof FindingFileRefSchema>;

export const FindingSchema = z.strictObject({
  finding_id: z.string().regex(/^FIND-[0-9a-f]{16}$/),
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  attempt: z.number().int().positive(),
  packet_hash: Sha256Schema,
  category: FindingCategorySchema,
  /** The agent whose work must change — same meaning as `StructuredFailure.owner`. */
  owner: z.enum(AgentStage),
  /** Who reported it, and therefore the only role (besides a human) with authority to close it — see `assertCanTransitionFinding`. */
  raised_by: z.enum(AgentStage),
  severity: FindingSeveritySchema,
  acceptance_ids: z.array(z.string().min(1)),
  design_ids: z.array(z.string().min(1)),
  files: z.array(FindingFileRefSchema),
  expected: z.string().min(1),
  observed: z.string().min(1),
  evidence_refs: z.array(z.string().min(1)).min(1),
  retryable: z.boolean(),
  requires_human: z.boolean(),
  status: FindingStatusSchema,
});
export type Finding = z.infer<typeof FindingSchema>;

/** Identity input: exactly the fields that describe the defect, never the attempt that found it. */
export interface FindingIdentityInput {
  task_id: string;
  category: FindingCategory;
  owner: AgentStage;
  expected: string;
  observed: string;
  files: readonly Pick<FindingFileRef, "path" | "symbol">[];
}

/** Deterministic, content-addressed — the same defect always resolves to the same id; a changed defect always mints a new one. */
export function findingId(input: FindingIdentityInput): string {
  const files = [...input.files]
    .map((f) => ({ path: f.path, symbol: f.symbol }))
    .sort((a, b) => a.path.localeCompare(b.path) || (a.symbol ?? "").localeCompare(b.symbol ?? ""));
  return `FIND-${stableHash({ task_id: input.task_id, category: input.category, owner: input.owner, expected: input.expected, observed: input.observed, files }).slice(0, 16)}`;
}

export class InfrastructureFindingError extends Error {
  constructor(reason: string) {
    super(
      `refusing to create a Finding for an infrastructure/quota failure (${reason}) — ` +
        "that is not a defect with a fix-verify-close lifecycle, and modeling it as one would let it " +
        "silently consume a defect retry budget it was never supposed to touch. Route it through the " +
        "runtime's own UNAVAILABLE handling instead.",
    );
    this.name = "InfrastructureFindingError";
  }
}

export interface DeriveFindingContext {
  run_id: string;
  task_id: string;
  attempt: number;
  packet_hash: string;
  raised_by: AgentStage;
  expected: string;
  observed: string;
  evidence_refs: readonly string[];
  files?: readonly FindingFileRef[];
  acceptance_ids?: readonly string[];
  design_ids?: readonly string[];
}

/**
 * Compiles one OPEN `Finding` from a `StructuredFailure` plus the attempt
 * context that raised it. Refuses outright for `category: "infrastructure"`
 * — see `InfrastructureFindingError`.
 */
export function deriveFinding(failure: StructuredFailure, context: DeriveFindingContext): Finding {
  if (failure.category === "infrastructure") throw new InfrastructureFindingError(failure.reason);
  const files = context.files ?? [];
  return FindingSchema.parse({
    finding_id: findingId({ task_id: context.task_id, category: failure.category, owner: failure.owner, expected: context.expected, observed: context.observed, files }),
    run_id: context.run_id,
    task_id: context.task_id,
    attempt: context.attempt,
    packet_hash: context.packet_hash,
    category: failure.category,
    owner: failure.owner,
    raised_by: context.raised_by,
    severity: failure.severity,
    acceptance_ids: context.acceptance_ids ?? [],
    design_ids: context.design_ids ?? [],
    files,
    expected: context.expected,
    observed: context.observed,
    evidence_refs: context.evidence_refs,
    retryable: failure.retryable,
    requires_human: failure.requiresHuman,
    status: "OPEN",
  });
}

export class FindingTransitionError extends Error {}

const ALLOWED_FROM: Record<FindingStatus, readonly FindingStatus[]> = {
  OPEN: [],
  FIX_CLAIMED: ["OPEN"],
  VERIFIED: ["OPEN", "FIX_CLAIMED"],
  ACCEPTED: ["OPEN", "FIX_CLAIMED", "VERIFIED"],
};

/**
 * The one authority rule this schema exists to make mechanical rather than
 * conventional: an engineer's fix *claims* a finding, it never *closes* one.
 * Closing (VERIFIED/ACCEPTED) is reserved for whichever role raised the
 * finding in the first place (`Finding.raised_by` — QA for its own findings,
 * security for its own), exactly mirroring `security.md`'s existing
 * "only security itself ever moves a finding to FIXED" rule, generalized to
 * every category this schema covers. A human may always override, since
 * approvals are a human act everywhere else in this pipeline.
 */
export function assertCanTransitionFinding(finding: Finding, to: FindingStatus, actor: AgentStage | "human"): void {
  if (finding.status === to) return;
  if (!ALLOWED_FROM[to].includes(finding.status)) {
    throw new FindingTransitionError(`finding ${finding.finding_id}: cannot move ${finding.status} -> ${to}`);
  }
  if (to === "FIX_CLAIMED") {
    if (actor !== finding.owner) {
      throw new FindingTransitionError(`finding ${finding.finding_id}: only its owner (${finding.owner}) may claim a fix, not ${actor}`);
    }
    return;
  }
  // to === "VERIFIED" || to === "ACCEPTED"
  if (actor === "human") return;
  if (actor !== finding.raised_by) {
    throw new FindingTransitionError(
      `finding ${finding.finding_id}: only ${finding.raised_by} (who raised it) may move it to ${to}, not ${actor} — an owner's fix claims a finding, it does not close it`,
    );
  }
}

/**
 * The pre-T-V8-013 shape (`HandoffArtifact.open_findings[number]`): a compact,
 * positionally-derived pointer with no attempt/packet identity at all. Kept
 * distinct from `Finding` on purpose — migrating one into the other would
 * have to invent a `run_id`/`attempt`/`packet_hash` that never existed, which
 * is exactly the kind of fabricated identity this task refuses to produce.
 */
export const LegacyFindingPointerSchema = z.strictObject({
  id: z.string().min(1),
  owner: z.string().min(1),
  summary: z.string().min(1),
});
export type LegacyFindingPointer = z.infer<typeof LegacyFindingPointerSchema>;

export type FindingOrLegacy =
  | { kind: "v2"; finding: Finding }
  | { kind: "legacy"; pointer: LegacyFindingPointer };

/**
 * Reads either shape without guessing: a v2 `Finding` parses as one, a legacy
 * pointer parses as read-only history, and anything else throws rather than
 * silently treating unrecognized data as either.
 */
export function readFinding(value: unknown): FindingOrLegacy {
  const asFinding = FindingSchema.safeParse(value);
  if (asFinding.success) return { kind: "v2", finding: asFinding.data };
  const asLegacy = LegacyFindingPointerSchema.safeParse(value);
  if (asLegacy.success) return { kind: "legacy", pointer: asLegacy.data };
  throw new Error(`value is neither a v2 Finding nor a legacy open_findings pointer: ${JSON.stringify(value)}`);
}

/**
 * Original packet + exact finding + current diff + invalidated evidence +
 * allowed delta — the composition rule `V8-PROBLEM-ANALYSIS.md` §14 names for
 * repair. Immutable per compilation: `repair_packet_hash` covers every field,
 * so a caller can detect drift the same way `ExecutionPacket.packet_hash`
 * already does for the original.
 */
export const RepairPacketSchema = z.strictObject({
  original_packet_hash: Sha256Schema,
  finding: FindingSchema,
  current_diff: z.string(),
  invalidated_evidence: z.array(z.string()),
  allowed_delta: z.string().min(1),
  repair_packet_hash: Sha256Schema,
});
export type RepairPacket = z.infer<typeof RepairPacketSchema>;

export class RepairPacketDriftError extends Error {}

export interface CompileRepairPacketInput {
  /** Only the one field a repair packet actually needs to verify against — callers pass the real `ExecutionPacket`. */
  originalPacket: { packet_hash: string };
  finding: Finding;
  currentDiff: string;
  invalidatedEvidence: readonly string[];
  allowedDelta: string;
}

/**
 * Refuses to compile when the finding does not (still) belong to an open
 * repair lifecycle, or was raised against a different packet than the one
 * supplied — a repair packet that silently repointed to the wrong original
 * would let a fix drift outside the scope QA actually flagged.
 */
export function compileRepairPacket(input: CompileRepairPacketInput): RepairPacket {
  if (input.finding.status !== "OPEN" && input.finding.status !== "FIX_CLAIMED") {
    throw new RepairPacketDriftError(
      `cannot compile a repair packet for finding ${input.finding.finding_id}: status is ${input.finding.status}, not OPEN/FIX_CLAIMED`,
    );
  }
  if (input.finding.packet_hash !== input.originalPacket.packet_hash) {
    throw new RepairPacketDriftError(
      `repair packet drift: finding ${input.finding.finding_id} was raised against packet ${input.finding.packet_hash}, not ${input.originalPacket.packet_hash}`,
    );
  }
  const payload = {
    original_packet_hash: input.originalPacket.packet_hash,
    finding: input.finding,
    current_diff: input.currentDiff,
    invalidated_evidence: [...input.invalidatedEvidence],
    allowed_delta: input.allowedDelta,
  };
  return RepairPacketSchema.parse({ ...payload, repair_packet_hash: stableHash(payload) });
}
