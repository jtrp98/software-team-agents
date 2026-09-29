import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ApprovalDecisionError, type HumanDecisionRecord } from "../gates/approval.js";
import {
  UntrustedHumanDecisionError,
  assertVerifierOutput,
  type ApprovalPublication,
  type HumanDecisionSubmission,
  type HumanDecisionVerifier,
} from "../gates/humanDecision.js";
import {
  LaneApprovalRecordSchema,
  LaneApprovalScopeSchema,
  applyLaneDecision,
  decidedLaneRecords,
  laneApprovalType,
  pendingLaneRequest,
  planLaneRequest,
  sameLaneScope,
  type LaneAction,
  type LaneApprovalRecord,
  type LaneApprovalScope,
  type LaneDecisionStore,
  type LaneItemRef,
  type LaneKey,
} from "../gates/laneApproval.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { knowledgeSubjectDigest, loadKnowledge } from "../knowledge/knowledgeStore.js";
import { LANE_LABEL, ROLE_LANES, laneOf, type RoleLane } from "./roleLane.js";
import { emptyWorkspace, type LaneSignoff, type RoleWorkspace, type SeenRef } from "./roleWorkspace.js";
import { type WorkspaceLookup, workflowFor } from "./roleWorkflow.js";

/**
 * Where lane authority is read from and written to (V13 TASK-028).
 *
 * Reading: `loadGovernedKnowledge` loads `knowledge/` and replaces every
 * item's `approved` status with what the lane ledger says. An item is
 * `approved` exactly when its lane's latest decided sign-off (a trusted
 * human decision) is an approval covering it at its current version and
 * content digest; a file that says `approved` without that is read as
 * `reviewed`. Downgrades a file states (`draft`, `deprecated`) are kept —
 * they only ever take authority away. `laneWorkspaces` projects the same
 * ledger into each lane's watermark and sign-off history. No
 * `knowledge/_roles/**` file, `status:` field or typed name is read as
 * authority anywhere.
 *
 * Writing: `LaneDecisionService` opens a lane request with an STA-minted id
 * over the exact current subject, announces it on the trusted channel, and
 * records a decision only when the channel verifies it. With no channel
 * configured, every decision fails closed.
 */

/** The one spelling of a Knowledge root the ledger keys on: its real path. */
export function canonicalKnowledgeRoot(knowledgeRoot: string): string {
  const resolved = path.resolve(knowledgeRoot);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The UX artifact a `ux-design` item points at, when it is a real file inside
 * `_docs/module/<module>/uxui/` of this Knowledge root (after resolving links).
 * Null otherwise — an artifact that is not there cannot be signed off.
 */
export function uxArtifactFile(item: KnowledgeItem, knowledgeRoot: string): string | null {
  if (item.kind !== "ux-design" || item.module === null) return null;
  const relative = item.payload.artifact;
  if (!relative.startsWith(`_docs/module/${item.module}/uxui/`)) return null;
  const root = canonicalKnowledgeRoot(knowledgeRoot);
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  const real = fs.realpathSync.native(candidate);
  return real.startsWith(`${root}${path.sep}`) ? real : null;
}

/**
 * What a lane decision binds one item to: its content without `status`
 * (`knowledgeSubjectDigest`) and, for a UX item, the bytes of the artifact it
 * names — so editing the UX file after sign-off makes the sign-off stale.
 */
export function laneItemDigest(item: KnowledgeItem, knowledgeRoot: string): string {
  const content = knowledgeSubjectDigest(item);
  if (item.kind !== "ux-design") return content;
  const artifact = uxArtifactFile(item, knowledgeRoot);
  return sha256(`${content}\nartifact:${artifact === null ? "missing" : sha256(fs.readFileSync(artifact))}`);
}

export function laneItemRefs(items: readonly KnowledgeItem[], knowledgeRoot: string): LaneItemRef[] {
  return items
    .map((item) => ({ id: item.id, version: item.version, digest: laneItemDigest(item, knowledgeRoot) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Decided records of one lane act, in the order they were decided. Every
 * reader of "the latest answer" goes through this one ordering, so the
 * status overlay and the projected sign-off can never disagree about it.
 */
export function decidedInOrder(records: readonly LaneApprovalRecord[], key: LaneKey): LaneApprovalRecord[] {
  return decidedLaneRecords(records, key)
    .map((record, seq) => ({ record, seq }))
    .sort((a, b) => a.record.decision!.decidedAt - b.record.decision!.decidedAt || a.seq - b.seq)
    .map(({ record }) => record);
}

function key(knowledgeRoot: string, module: string, lane: RoleLane, action: LaneAction): LaneKey {
  return { knowledgeRoot, module, lane, action };
}

function covers(record: LaneApprovalRecord | undefined, ref: LaneItemRef): boolean {
  return (
    record?.status === "approved" &&
    record.scope.items.some((item) => item.id === ref.id && item.version === ref.version && item.digest === ref.digest)
  );
}

/** The records of one module under one (canonical) Knowledge root. */
export type LaneRecordsFor = (module: string) => readonly LaneApprovalRecord[];

/**
 * Every item with the status the lane ledger gives it. Pure apart from
 * reading a UX artifact's bytes for its digest.
 */
export function governKnowledge(items: readonly KnowledgeItem[], knowledgeRoot: string, recordsFor: LaneRecordsFor): KnowledgeItem[] {
  const root = canonicalKnowledgeRoot(knowledgeRoot);
  const latest = new Map<string, LaneApprovalRecord | undefined>();
  const latestSignoff = (module: string, lane: RoleLane): LaneApprovalRecord | undefined => {
    const cacheKey = `${module}\u0000${lane}`;
    if (!latest.has(cacheKey)) latest.set(cacheKey, decidedInOrder(recordsFor(module), key(root, module, lane, "signoff")).at(-1));
    return latest.get(cacheKey);
  };
  return items.map((item) => {
    if (item.status !== "approved" && item.status !== "reviewed") return item;
    const lane = laneOf(item.owner);
    const covered =
      lane !== null &&
      item.module !== null &&
      covers(latestSignoff(item.module, lane), { id: item.id, version: item.version, digest: laneItemDigest(item, root) });
    const status = covered ? "approved" : "reviewed";
    return status === item.status ? item : ({ ...item, status } as KnowledgeItem);
  });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** One lane's watermark and sign-off history, built only from decided lane-ledger records. */
export function projectLaneWorkspace(
  records: readonly LaneApprovalRecord[],
  knowledgeRoot: string,
  module: string,
  lane: RoleLane,
  now: string,
): RoleWorkspace {
  const root = canonicalKnowledgeRoot(knowledgeRoot);
  const signoffs: LaneSignoff[] = decidedInOrder(records, key(root, module, lane, "signoff")).map((record) => {
    const decision = record.decision as HumanDecisionRecord;
    return {
      type: record.scope.type,
      status: record.status as "approved" | "rejected",
      items: record.scope.items.map((item) => ({ ...item })),
      at: iso(decision.decidedAt),
      by: decision.actor.id,
      ...(decision.actor.id === null ? { actorUnavailableReason: decision.actor.unavailableReason } : {}),
      note: decision.note,
      requestId: record.requestId,
      decisionId: decision.decisionId,
    };
  });
  // Per id, the latest decided acknowledgement wins; a rejected one means "not seen".
  const latestAck = new Map<string, { record: LaneApprovalRecord; ref: LaneItemRef }>();
  for (const record of decidedInOrder(records, key(root, module, lane, "ack"))) {
    for (const ref of record.scope.items) latestAck.set(ref.id, { record, ref });
  }
  const seen: SeenRef[] = [...latestAck.values()]
    .filter(({ record }) => record.status === "approved")
    .map(({ record, ref }) => {
      const actor = (record.decision as HumanDecisionRecord).actor;
      return {
        id: ref.id,
        version: ref.version,
        digest: ref.digest,
        at: iso((record.decision as HumanDecisionRecord).decidedAt),
        by: actor.id,
        ...(actor.id === null ? { actorUnavailableReason: actor.unavailableReason } : {}),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...emptyWorkspace(lane, module, now), seen, signoffs };
}

/** The lookup every lane reader uses: each lane's projection for one module. A project-wide (null) module has no lane decisions. */
export function laneWorkspaces(recordsFor: LaneRecordsFor, knowledgeRoot: string, module: string | null, now: string): WorkspaceLookup {
  return (lane) => (module === null ? emptyWorkspace(lane, null, now) : projectLaneWorkspace(recordsFor(module), knowledgeRoot, module, lane, now));
}

export interface GovernedKnowledge {
  /** The canonical Knowledge root the ledger is keyed on. */
  root: string;
  missing: boolean;
  problems: string[];
  items: KnowledgeItem[];
  kb: KnowledgeBase;
  recordsFor: LaneRecordsFor;
}

/** Knowledge with lane-ledger authority applied. Reads only; the ledger is queried once per module. */
export function loadGovernedKnowledge(knowledgeRoot: string, ledger: Pick<LaneDecisionStore, "laneRequests">): GovernedKnowledge {
  const root = canonicalKnowledgeRoot(knowledgeRoot);
  const loaded = loadKnowledge(root);
  const cache = new Map<string, readonly LaneApprovalRecord[]>();
  const recordsFor: LaneRecordsFor = (module) => {
    if (!cache.has(module)) cache.set(module, ledger.laneRequests(root, module));
    return cache.get(module)!;
  };
  const items = governKnowledge(loaded.items, root, recordsFor);
  return { root, missing: loaded.missing, problems: loaded.problems, items, kb: new KnowledgeBase(items), recordsFor };
}

/** Why STA will not open a lane request right now. A refusal names what must happen first; it is not a failure of the channel. */
export class LaneActRefusedError extends Error {
  constructor(
    public readonly code: "invalid-knowledge" | "intake" | "drafting" | "blocked" | "unknown-item" | "nothing-to-decide" | "item-list",
    message: string,
  ) {
    super(message);
    this.name = "LaneActRefusedError";
  }
}

/** The approved items the lanes handing off *to* `lane` carry, in this module — what an acknowledgement covers by default. */
export function handedOffTo(lane: RoleLane, module: string, kb: KnowledgeBase): KnowledgeItem[] {
  const senders = ROLE_LANES.filter((sender) => workflowFor(sender)?.handoffTo === lane);
  return kb
    .query({ module, status: "approved" })
    .filter((item) => {
      const owner = laneOf(item.owner);
      return owner !== null && senders.includes(owner);
    });
}

/**
 * The exact subject a lane act would cover now, or a refusal.
 *
 * A sign-off covers everything the lane owns in the module that is past
 * draft, and is refused while the lane has not started, still drafts, or has
 * a lane blocker — asking a person to sign off work already known to be
 * unusable wastes the one step that cannot be automated. An acknowledgement
 * covers the named ids (default: what the sending lanes hand off to it).
 */
export function laneSubject(
  governed: GovernedKnowledge,
  module: string,
  lane: RoleLane,
  action: LaneAction,
  ids?: readonly string[],
): LaneApprovalScope {
  if (governed.missing || governed.problems.length > 0) {
    throw new LaneActRefusedError(
      "invalid-knowledge",
      governed.missing ? `no knowledge/ directory under ${governed.root}` : `knowledge under ${governed.root} is invalid (${governed.problems.join("; ")})`,
    );
  }
  const { kb } = governed;
  let items: KnowledgeItem[];
  if (action === "signoff") {
    if (ids && ids.length > 0) {
      throw new LaneActRefusedError("item-list", "a sign-off covers everything the lane owns in the module; it takes no item list");
    }
    const spec = workflowFor(lane);
    const owned = kb.query({ module }).filter((item) => laneOf(item.owner) === lane && item.status !== "deprecated");
    if (!spec || !owned.some((item) => item.kind === spec.primaryKind)) {
      throw new LaneActRefusedError("intake", `the ${LANE_LABEL[lane]} lane has no ${spec?.primaryKind ?? "primary"} item in module ${module} yet`);
    }
    const drafts = owned.filter((item) => item.status === "draft");
    if (drafts.length > 0) {
      throw new LaneActRefusedError(
        "drafting",
        `${drafts.map((d) => d.id).sort().join(", ")} ${drafts.length === 1 ? "is" : "are"} still draft — somebody other than the owner reviews ${drafts.length === 1 ? "it" : "them"} before the lane can be signed off`,
      );
    }
    items = owned;
    const blockers = spec.blockers(items, kb);
    if (lane === "uxui") {
      for (const item of items) {
        if (item.kind === "ux-design" && uxArtifactFile(item, governed.root) === null) {
          blockers.push(`${item.id} names ${item.payload.artifact}, which is not a file under _docs/module/${module}/uxui/ of this Knowledge root`);
        }
      }
    }
    if (blockers.length > 0) throw new LaneActRefusedError("blocked", blockers.join("; "));
  } else {
    if (ids && ids.length > 0) {
      const unknown = ids.filter((id) => kb.resolve(id, module) === null);
      if (unknown.length > 0) throw new LaneActRefusedError("unknown-item", `no knowledge item ${unknown.join(", ")} in module ${module}`);
      items = [...new Map(ids.map((id) => kb.resolve(id, module) as KnowledgeItem).map((item) => [item.id, item])).values()];
    } else {
      items = handedOffTo(lane, module, kb);
    }
  }
  if (items.length === 0) {
    throw new LaneActRefusedError("nothing-to-decide", `there is nothing for the ${LANE_LABEL[lane]} lane to ${action === "signoff" ? "sign off" : "acknowledge"} in module ${module}`);
  }
  return LaneApprovalScopeSchema.parse({
    kind: "lane",
    knowledgeRoot: governed.root,
    module,
    lane,
    action,
    type: laneApprovalType(lane, action),
    items: laneItemRefs(items, governed.root),
  });
}

export interface LaneDecisionServiceOptions {
  store: LaneDecisionStore & { transaction<T>(fn: () => T): T };
  verifier: HumanDecisionVerifier;
  now?: () => number;
}

/**
 * The only writer of the lane ledger. Every entry point that lets a person
 * sign off or acknowledge a lane — `sta roles signoff|ack`, the Controller
 * API — goes through this, with the same production channel `approve` uses.
 */
export class LaneDecisionService {
  private readonly store: LaneDecisionServiceOptions["store"];
  private readonly verifier: HumanDecisionVerifier;
  private readonly now: () => number;

  constructor(options: LaneDecisionServiceOptions) {
    this.store = options.store;
    this.verifier = options.verifier;
    this.now = options.now ?? Date.now;
  }

  get channel(): string {
    return this.verifier.channel;
  }

  /**
   * Opens the pending request for this lane act over its current subject, or
   * returns the one already pending for exactly that subject. A pending
   * request whose subject moved is withdrawn in the same transaction.
   */
  request(knowledgeRoot: string, module: string, lane: RoleLane, action: LaneAction, ids?: readonly string[]): LaneApprovalRecord {
    const scope = laneSubject(loadGovernedKnowledge(knowledgeRoot, this.store), module, lane, action, ids);
    const reason =
      action === "signoff"
        ? `the ${LANE_LABEL[lane]} lane asks to be signed off for module ${module}; the sign-off makes ${scope.items.map((i) => i.id).join(", ")} binding`
        : `the ${LANE_LABEL[lane]} lane acknowledges ${scope.items.map((i) => i.id).join(", ")} in module ${module}`;
    return this.store.transaction(() => {
      const plan = planLaneRequest(this.store.laneRequests(scope.knowledgeRoot, module), { scope, reason, now: this.now() });
      if (plan.withdraw) this.store.updateLaneRequest(plan.withdraw);
      if (plan.insert) this.store.insertLaneRequest(plan.insert);
      return plan.request;
    });
  }

  private pendingRecord(requestId: string): LaneApprovalRecord {
    const record = this.store.loadLaneRequest(requestId);
    if (!record) throw new ApprovalDecisionError("unknown-request", `no lane request ${requestId} was opened — a decision cannot precede the question`);
    if (record.status !== "pending") throw new ApprovalDecisionError("not-pending", `lane request ${requestId} is already ${record.status}`);
    const latest = pendingLaneRequest(this.store.laneRequests(record.scope.knowledgeRoot, record.scope.module), record.scope);
    if (latest?.requestId !== requestId) throw new ApprovalDecisionError("superseded", `lane request ${requestId} was superseded by a newer ${record.scope.type} request`);
    return record;
  }

  /**
   * Refuses — and withdraws — a pending request whose subject changed since it
   * was opened: the person would be answering about versions that are no
   * longer there.
   */
  private assertSubjectCurrent(record: LaneApprovalRecord): void {
    const { knowledgeRoot, module, lane, action, items } = record.scope;
    let current: LaneApprovalScope | null = null;
    try {
      current = laneSubject(loadGovernedKnowledge(knowledgeRoot, this.store), module, lane, action, action === "ack" ? items.map((i) => i.id) : undefined);
    } catch (e) {
      if (!(e instanceof LaneActRefusedError)) throw e;
    }
    if (current && sameLaneScope(current, record.scope)) return;
    this.store.transaction(() => {
      const onDisk = this.store.loadLaneRequest(record.requestId);
      if (onDisk?.status !== "pending") return;
      this.store.updateLaneRequest(
        LaneApprovalRecordSchema.parse({
          ...onDisk,
          status: "withdrawn",
          withdrawal: { at: this.now(), reason: "what the request covered changed before the decision was recorded" },
        }),
      );
    });
    throw new ApprovalDecisionError(
      "stale",
      `lane request ${record.requestId} is stale: ${module}'s ${lane} items changed since it was opened, so it was withdrawn — ask again`,
    );
  }

  /**
   * Announces the pending request on the trusted channel (github-app: opens
   * one Issue) and persists where, once per request. Null when the channel
   * has nothing to announce (unconfigured). The request stays pending either way.
   */
  async publish(requestId: string): Promise<(ApprovalPublication & { requestId: string; fresh: boolean }) | null> {
    const record = this.pendingRecord(requestId);
    if (record.publication && record.publication.channel === this.verifier.channel) {
      return { ...record.publication, requestId, fresh: false };
    }
    if (!this.verifier.publish) return null;
    const published = await this.verifier.publish({ request: record, artifacts: [] });
    if (published.channel !== this.verifier.channel) {
      throw new UntrustedHumanDecisionError(`channel ${this.verifier.channel} reported a publication on channel ${published.channel}`);
    }
    this.store.transaction(() => {
      const onDisk = this.store.loadLaneRequest(requestId);
      if (onDisk?.status !== "pending") {
        throw new ApprovalDecisionError("not-pending", `lane request ${requestId} stopped being pending while it was being published`);
      }
      this.store.updateLaneRequest(LaneApprovalRecordSchema.parse({ ...onDisk, publication: { ...published } }));
    });
    return { ...published, requestId, fresh: true };
  }

  /**
   * Records a person's answer to one pending lane request — the only way a
   * lane is ever signed off or acknowledged. The channel must authenticate
   * it (the unconfigured channel refuses everything); the ledger then
   * refuses an unknown, settled, superseded, stale, wrong-scope or replayed
   * decision. Nothing is written unless every check passes.
   */
  async submit(submission: HumanDecisionSubmission): Promise<{ record: LaneApprovalRecord; settleError: string | null }> {
    const request = this.pendingRecord(submission.requestId);
    this.assertSubjectCurrent(request);
    const publication = request.publication && request.publication.channel === this.verifier.channel ? request.publication : null;
    const verified = assertVerifierOutput(
      this.verifier,
      submission,
      await this.verifier.verify(request, submission, { now: this.now(), publication }),
    );
    const decided = this.store.transaction(() => {
      const updated = applyLaneDecision(
        this.store.laneRequests(request.scope.knowledgeRoot, request.scope.module),
        verified,
        (decisionId) => this.store.laneDecisionIdExists(decisionId),
      );
      this.store.updateLaneRequest(updated);
      return updated;
    });
    let settleError: string | null = null;
    if (this.verifier.settle) {
      try {
        await this.verifier.settle(decided, decided.decision as HumanDecisionRecord, publication);
      } catch (e) {
        settleError = e instanceof Error ? e.message : String(e);
      }
    }
    return { record: decided, settleError };
  }
}
