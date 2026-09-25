import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { ATTEMPT_GRANT_KEY_PATH, ATTEMPT_GRANT_TOKEN_PATH, type GuardTargetWorkRoot } from "../agents/pathPermissions.js";
import { stableHash } from "../artifacts/executionPacket.js";
import type { AgentStage } from "../types.js";
import { buildEvidence, type EvidencePayload, type EvidenceRecord, type EvidenceStore } from "../evidence/evidenceStore.js";

/** Hook-facing token/key paths — owned by `pathPermissions.ts` (they render into every guard host), re-exported here. */
export { ATTEMPT_GRANT_KEY_PATH, ATTEMPT_GRANT_TOKEN_PATH };

/** The payload shape of every `attempt-grant` evidence record, narrowed once for the store queries below. */
type AttemptGrantPayload = Extract<EvidencePayload, { kind: typeof GRANT_EVIDENCE_KIND }>;
type AttemptGrantRecord = EvidenceRecord & { payload: AttemptGrantPayload };

function isAttemptGrantRecord(record: EvidenceRecord): record is AttemptGrantRecord {
  return record.kind === GRANT_EVIDENCE_KIND && record.payload.kind === GRANT_EVIDENCE_KIND;
}
export { isAttemptGrantRecord };

/**
 * V13 TASK-012 — the STA-issued scoped attempt grant.
 *
 * Direct mode used to let a desktop role-play session *declare* the role it
 * was playing (`.workflow/session-role.json`, the retired `session-role`
 * verb): whoever could write the file held the authority. This module is the
 * replacement channel: the grant is a signed token STA issues after its own
 * dispatch decision — the task exists, the stage is the one the workflow
 * state says is assigned right now, and the contract resolves — and it binds
 * role, contract digest, task, scope and expiry to one attempt.
 *
 * WHO VERIFIES WHAT, AND WHY BOTH HALVES EXIST
 *
 *   The guard hook (dependency-free, in-band) verifies the token's shape,
 *   HMAC signature, expiry and scope before it applies the per-role layer.
 *   The signature key lives in the workspace's own `.workflow/` state
 *   (co-located by necessity: a hook imports nothing), which bounds what the
 *   in-band check can prove on a machine where every file is readable.
 *
 *   STA (out-of-band, authoritative) verifies the grant against its own
 *   durable evidence store: a token the hook accepts but STA never issued —
 *   or one already consumed — is refused the moment it is presented back.
 *   No governed write *completes* on a grant STA did not record; the hook is
 *   defense in depth, never the authority.
 *
 * The token file sits under `.workflow/`, which `UNIVERSAL_DENY` refuses to
 * every agent's file tools; `consume` removes it, so an attempt grant is
 * single-use at the file layer as well as the store layer.
 */

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

const GrantScopeSchema = z.strictObject({
  /** Repo-relative write globs the granted role's contract + stack layout resolve to. */
  write: z.array(z.string()).readonly(),
  deny: z.array(z.string()).readonly(),
  /** The pre-resolved stack half, the same shape the orchestrated env channel carries. */
  stack: z.strictObject({ write: z.array(z.string()).readonly(), deny: z.array(z.string()).readonly() }).readonly(),
});
export type GrantScope = z.infer<typeof GrantScopeSchema>;

export const AttemptGrantTokenSchema = z.strictObject({
  /** Version, so a future shape is rejected rather than half-read. */
  attempt_grant: z.literal(1),
  grant_id: z.string().regex(/^agr_[0-9a-f]{32}$/),
  role: z.string().regex(/^[a-z][a-z0-9-]*$/),
  stage: z.string().min(1),
  task_id: z.string().min(1),
  contract_digest: z.string().regex(HEX_64),
  scope: GrantScopeSchema,
  /** Bound Targets the attempt may touch; empty for a Knowledge-side grant. */
  work_roots: z
    .array(z.strictObject({ targetId: z.string().min(1), path: z.string().min(1), access: z.enum(["read", "write"]) }).readonly())
    .readonly(),
  knowledge_root: z.string().min(1).nullable(),
  issued_at: z.string().min(1),
  expires_at: z.string().min(1),
  nonce: z.string().regex(HEX_32),
  /** HMAC-SHA256 (hex) over the canonical JSON of every other field. */
  signature: z.string().regex(HEX_64),
});
export type AttemptGrantToken = z.infer<typeof AttemptGrantTokenSchema>;

/** Why a grant is not authority. `bad-signature`/`expired`/`malformed` are checkable in-band; the rest only STA can answer. */
export type AttemptGrantRejection =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "unregistered-role"
  | "unknown-grant"
  | "already-consumed"
  | "content-mismatch";

export class AttemptGrantRejectedError extends Error {
  constructor(
    public readonly code: AttemptGrantRejection,
    public readonly grantId: string | null,
    reason: string,
  ) {
    super(`attempt grant${grantId ? ` ${grantId}` : ""} rejected (${code}): ${reason}`);
    this.name = "AttemptGrantRejectedError";
  }
}

/**
 * Canonical JSON: sorted keys, undefined dropped — the exact normalization
 * `stableHash` uses, so the same bytes hash the same way everywhere STA talks
 * about this grant. The hook re-implements it (generated block), so it stays
 * this small on purpose.
 */
function canonicalGrantJson(value: unknown): string {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, val]) => val !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, val]) => [key, normalize(val)]),
          )
        : v;
  return JSON.stringify(normalize(value));
}

/** The bytes the signature commits to: the whole token minus `signature`. */
function unsignedGrant(token: AttemptGrantToken): Record<string, unknown> {
  const { signature: _signature, ...rest } = token;
  return rest;
}

export function signAttemptGrant(token: Omit<AttemptGrantToken, "signature">, keyHex: string): AttemptGrantToken {
  const signature = createHmac("sha256", keyHex).update(canonicalGrantJson(unsignedGrant(token as AttemptGrantToken))).digest("hex");
  return { ...token, signature };
}

/**
 * Loads the workspace grant key, provisioning one on first use. The key file
 * lives beside the state it authorizes for; everything durable about the
 * grant (issuance, consumption) is checked against STA's evidence store, so
 * the key's job is tamper-evidence for the hook, not secrecy from the disk.
 */
export function loadOrCreateGrantKey(stateRoot: string, random: (size: number) => Buffer = randomBytes): string {
  const keyPath = path.join(stateRoot, ...ATTEMPT_GRANT_KEY_PATH.split("/"));
  try {
    const existing = fs.readFileSync(keyPath, "utf8").trim();
    if (HEX_64.test(existing)) return existing;
  } catch {
    // First use — provision below.
  }
  const key = random(32).toString("hex");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, `${key}\n`, "utf8");
  return key;
}

export function readGrantKey(stateRoot: string): string | null {
  try {
    const existing = fs.readFileSync(path.join(stateRoot, ...ATTEMPT_GRANT_KEY_PATH.split("/")), "utf8").trim();
    return HEX_64.test(existing) ? existing : null;
  } catch {
    return null;
  }
}

export interface IssueAttemptGrantInput {
  /** The workspace STA state lives in (and the token is written to, unless grantRoot names another). */
  stateRoot: string;
  grantRoot?: string;
  taskId: string;
  stage: AgentStage;
  role: string;
  contractDigest: string;
  scope: GrantScope;
  workRoots?: readonly GuardTargetWorkRoot[];
  knowledgeRoot?: string;
  /** Grant lifetime in milliseconds; the CLI defaults it and bounds it. */
  ttlMs: number;
  now: number;
  random?: (size: number) => Buffer;
}

export interface IssuedAttemptGrant {
  token: AttemptGrantToken;
  /** Absolute path the signed token was written to. */
  tokenPath: string;
  evidence: EvidenceRecord;
}

export const GRANT_EVIDENCE_KIND = "attempt-grant";

/** The evidence record for one grant event, built identically for issue and consume. */
export function grantEvidence(input: {
  taskId: string;
  stage: AgentStage;
  event: "issued" | "consumed";
  token: AttemptGrantToken;
  recordedAt: number;
}): EvidenceRecord {
  // buildEvidence derives the id and digest, so the record a forged token
  // would have to match is exactly the record this store re-derives on read.
  return buildEvidence({
    taskId: input.taskId,
    stage: input.stage,
    // A grant is not a role-run attempt; its identity is the grant id and the
    // event (the subject below), so the attempt field carries no stage-attempt
    // meaning.
    attempt: 1,
    role: input.token.role,
    kind: GRANT_EVIDENCE_KIND,
    subject: `${input.event}:${input.token.grant_id}`,
    payload: {
      kind: GRANT_EVIDENCE_KIND,
      event: input.event,
      grantId: input.token.grant_id,
      role: input.token.role,
      contractDigest: input.token.contract_digest,
      scopeDigest: stableHash(input.token.scope),
      expiresAt: Date.parse(input.token.expires_at),
    },
    refs: [],
    recordedAt: input.recordedAt,
  });
}

/**
 * Issues one scoped attempt grant: signs the token, appends the durable
 * `attempt-grant` issuance record through the supplied store, then writes the
 * signed token file. Evidence first — a grant whose file never lands is a
 * record without a holder, never a holder without a record.
 */
export function issueAttemptGrant(store: EvidenceStore, input: IssueAttemptGrantInput): IssuedAttemptGrant {
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new AttemptGrantRejectedError("malformed", null, `ttlMs must be positive (got ${input.ttlMs})`);
  }
  const issuedAt = new Date(input.now).toISOString();
  const expiresAt = new Date(input.now + input.ttlMs).toISOString();
  const unsigned: Omit<AttemptGrantToken, "signature"> = {
    attempt_grant: 1,
    grant_id: "",
    role: input.role,
    stage: input.stage,
    task_id: input.taskId,
    contract_digest: input.contractDigest,
    scope: input.scope,
    work_roots: (input.workRoots ?? []).map((root) => ({ targetId: root.targetId, path: root.path, access: root.access })),
    knowledge_root: input.knowledgeRoot ?? null,
    issued_at: issuedAt,
    expires_at: expiresAt,
    nonce: (input.random ?? randomBytes)(16).toString("hex"),
  };
  // The id derives from the whole grant content, so two issuances never share
  // an id and a re-issued identical grant is a new grant, not a silent reuse.
  unsigned.grant_id = `agr_${stableHash(unsigned).slice(0, 32)}`;
  const token = signAttemptGrant(unsigned, loadOrCreateGrantKey(input.stateRoot, input.random));

  const record = store.appendEvidence(
    grantEvidence({ taskId: input.taskId, stage: input.stage, event: "issued", token, recordedAt: input.now }),
  );
  const tokenPath = writeAttemptGrantTokenFile(input.grantRoot ?? input.stateRoot, token);
  return { token, tokenPath, evidence: record };
}

/** Absolute path of the token file under `root`. */
export function attemptGrantTokenPathFor(root: string): string {
  return path.join(root, ...ATTEMPT_GRANT_TOKEN_PATH.split("/"));
}

export function writeAttemptGrantTokenFile(root: string, token: AttemptGrantToken): string {
  const tokenPath = attemptGrantTokenPathFor(root);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${JSON.stringify(token, null, 2)}\n`, "utf8");
  return tokenPath;
}

export function readAttemptGrantTokenFile(root: string): AttemptGrantToken | null {
  try {
    return AttemptGrantTokenSchema.parse(JSON.parse(fs.readFileSync(attemptGrantTokenPathFor(root), "utf8")));
  } catch {
    return null;
  }
}

export function removeAttemptGrantTokenFile(root: string): boolean {
  try {
    fs.rmSync(attemptGrantTokenPathFor(root));
    return true;
  } catch {
    return false;
  }
}

/** Pure, clock-injected token check — the exact logic the generated guard block mirrors. */
export function verifyAttemptGrantToken(
  token: unknown,
  options: { keyHex: string; now: number },
): { ok: true; grant: AttemptGrantToken } | { ok: false; code: AttemptGrantRejection; reason: string } {
  const parsed = AttemptGrantTokenSchema.safeParse(token);
  if (!parsed.success) {
    return { ok: false, code: "malformed", reason: parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ") || "shape" };
  }
  const grant = parsed.data;
  const expected = createHmac("sha256", options.keyHex).update(canonicalGrantJson(unsignedGrant(grant))).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(grant.signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: "bad-signature", reason: "HMAC does not cover the presented bytes" };
  }
  if (!Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= options.now) {
    return { ok: false, code: "expired", reason: `expires_at ${grant.expires_at} is at or before the verification clock` };
  }
  if (!Object.values(AGENT_REGISTRY).some((entry) => entry.role === grant.role)) {
    return { ok: false, code: "unregistered-role", reason: `role "${grant.role}" is not in the agent registry` };
  }
  return { ok: true, grant };
}

/**
 * The authoritative check: the token must verify in-band *and* carry an
 * issuance record in STA's own store with the same content, and must not have
 * been consumed. A token the hook accepts but this function refuses never
 * completes a governed write.
 */
export function verifyIssuedAttemptGrant(
  store: EvidenceStore,
  token: unknown,
  options: { keyHex: string; now: number },
): { ok: true; grant: AttemptGrantToken; issuance: EvidenceRecord } | { ok: false; code: AttemptGrantRejection; reason: string } {
  const inBand = verifyAttemptGrantToken(token, options);
  if (!inBand.ok) return inBand;
  const grant = inBand.grant;
  const records = store.evidenceForTask(grant.task_id).filter(isAttemptGrantRecord);
  const issuance = records.find((r) => r.payload.grantId === grant.grant_id && r.payload.event === "issued");
  if (!issuance) {
    return { ok: false, code: "unknown-grant", reason: `no issuance record for ${grant.grant_id} on task ${grant.task_id}` };
  }
  const scopeDigest = stableHash(grant.scope);
  if (
    issuance.payload.contractDigest !== grant.contract_digest ||
    issuance.payload.scopeDigest !== scopeDigest ||
    issuance.payload.expiresAt !== Date.parse(grant.expires_at)
  ) {
    return { ok: false, code: "content-mismatch", reason: "presented grant content differs from its issuance record" };
  }
  const consumed = records.find((r) => r.payload.grantId === grant.grant_id && r.payload.event === "consumed");
  if (consumed) {
    return { ok: false, code: "already-consumed", reason: `grant ${grant.grant_id} was already consumed` };
  }
  return { ok: true, grant, issuance };
}

/**
 * Consumes a single-use grant: re-verifies it authoritatively, appends the
 * consumption record and removes the token file. A replay — the same
 * presented a second time — answers `already-consumed` from the store, not
 * from anything the holder controls.
 */
export function consumeAttemptGrant(
  store: EvidenceStore,
  token: unknown,
  options: { keyHex: string; now: number; grantRoot: string },
): { grant: AttemptGrantToken; evidence: EvidenceRecord } {
  const verified = verifyIssuedAttemptGrant(store, token, { keyHex: options.keyHex, now: options.now });
  if (!verified.ok) throw new AttemptGrantRejectedError(verified.code, verified.code === "malformed" ? null : grantIdOf(token), verified.reason);
  const evidence = store.appendEvidence(
    grantEvidence({ taskId: verified.grant.task_id, stage: verified.grant.stage as AgentStage, event: "consumed", token: verified.grant, recordedAt: options.now }),
  );
  removeAttemptGrantTokenFile(options.grantRoot);
  return { grant: verified.grant, evidence };
}

function grantIdOf(token: unknown): string | null {
  const parsed = AttemptGrantTokenSchema.safeParse(token);
  return parsed.success ? parsed.data.grant_id : null;
}
