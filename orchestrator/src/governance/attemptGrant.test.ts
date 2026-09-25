import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { AgentStage } from "../types.js";
import { isAttemptGrantRecord } from "./attemptGrant.js";
import {
  ATTEMPT_GRANT_TOKEN_PATH,
  AttemptGrantRejectedError,
  AttemptGrantTokenSchema,
  consumeAttemptGrant,
  issueAttemptGrant,
  loadOrCreateGrantKey,
  readAttemptGrantTokenFile,
  readGrantKey,
  signAttemptGrant,
  verifyAttemptGrantToken,
  verifyIssuedAttemptGrant,
} from "./attemptGrant.js";
import { UNASSIGNED_SESSION_DENY } from "../agents/pathPermissions.js";

/**
 * V13 TASK-012 — the STA-issued scoped attempt grant that replaced the
 * self-declared `.workflow/session-role.json` channel.
 *
 * Everything asserted here is a property a guard can check deterministically:
 * the token is signed, bounded, expiring and single-use; STA's own store is
 * the authority on issuance and consumption, so a token the in-band signature
 * accepts but STA never issued is still refused the moment it is presented
 * back.
 */

const KEY = "1".repeat(64);
const NOW = Date.parse("2026-09-25T08:00:00.000Z");
const SCOPE = {
  write: ["_docs/status.md"],
  deny: [],
  stack: { write: ["server/**"], deny: [] },
};

function newStore(): { store: SqliteTaskStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-attempt-grant-"));
  return { store: new SqliteTaskStore(path.join(root, "state.db")), root };
}

function issue(store: SqliteTaskStore, root: string, over: Partial<Parameters<typeof issueAttemptGrant>[1]> = {}) {
  return issueAttemptGrant(store, {
    stateRoot: root,
    taskId: "T-GRANT",
    stage: AgentStage.QA_ENGINEER,
    role: "qa-engineer",
    contractDigest: "a".repeat(64),
    scope: SCOPE,
    ttlMs: 3_600_000,
    now: NOW,
    random: (size) => Buffer.alloc(size, 7),
    ...over,
  });
}

describe("attempt grant issuance", () => {
  it("signs, records and writes the token, and provisions the key on first use", () => {
    const { store, root } = newStore();
    try {
      expect(readGrantKey(root)).toBeNull();
      const { token, tokenPath, evidence } = issue(store, root);
      expect(tokenPath).toBe(path.join(root, ...ATTEMPT_GRANT_TOKEN_PATH.split("/")));
      expect(fs.existsSync(tokenPath)).toBe(true);
      expect(readGrantKey(root)).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.kind).toBe("attempt-grant");
      expect(evidence.payload.kind === "attempt-grant" && evidence.payload.event === "issued").toBe(true);
      expect(store.evidenceForTask("T-GRANT").map((r) => r.evidenceId)).toContain(evidence.evidenceId);
      // The file holds the same signed bytes the record commits to.
      expect(readAttemptGrantTokenFile(root)).toEqual(token);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses the provisioned key, so grants issued across processes verify against one channel", () => {
    const { store, root } = newStore();
    try {
      const first = issue(store, root);
      const key = readGrantKey(root);
      store.close();
      const reopened = new SqliteTaskStore(path.join(root, "state.db"));
      const second = issue(reopened, root);
      expect(readGrantKey(root)).toBe(key);
      expect(verifyAttemptGrantToken(first.token, { keyHex: key!, now: NOW }).ok).toBe(true);
      expect(verifyAttemptGrantToken(second.token, { keyHex: key!, now: NOW }).ok).toBe(true);
      reopened.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a non-positive ttl outright", () => {
    const { store, root } = newStore();
    try {
      expect(() => issue(store, root, { ttlMs: 0 })).toThrow(AttemptGrantRejectedError);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("in-band token verification (what a guard hook can prove)", () => {
  it("a validly-signed, unexpired, registered token verifies", () => {
    const { store, root } = newStore();
    try {
      const { token } = issue(store, root);
      const result = verifyAttemptGrantToken(token, { keyHex: readGrantKey(root)!, now: NOW + 1000 });
      expect(result.ok).toBe(true);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a hand-written token — the old self-declaration reborn — is refused before any per-role layer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-attempt-grant-"));
    try {
      // Fully shaped, plausible, but signed by nobody: the signature field is
      // the one thing a hand-writer cannot produce without STA's key.
      const forged = {
        attempt_grant: 1,
        grant_id: `agr_${"0".repeat(32)}`,
        role: "backend-engineer",
        stage: "backend-engineer",
        task_id: "T-FORGED",
        contract_digest: "a".repeat(64),
        scope: { write: ["**"], deny: [], stack: { write: [], deny: [] } },
        work_roots: [],
        knowledge_root: null,
        issued_at: "2026-09-25T00:00:00.000Z",
        expires_at: "2027-01-01T00:00:00.000Z",
        nonce: "0".repeat(32),
        signature: "0".repeat(64),
      };
      const result = verifyAttemptGrantToken(forged, { keyHex: KEY, now: NOW });
      expect(result).toMatchObject({ ok: false, code: "bad-signature" });
      // And the bare retired declaration shape does not even parse.
      expect(verifyAttemptGrantToken({ role: "backend-engineer", declared_at: "2026-09-25T00:00:00Z" }, { keyHex: KEY, now: NOW })).toMatchObject({
        ok: false,
        code: "malformed",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tampering with any signed field breaks the signature", () => {
    const { store, root } = newStore();
    try {
      const { token } = issue(store, root);
      const widened = { ...token, scope: { ...token.scope, write: ["**"] } };
      const result = verifyAttemptGrantToken(widened, { keyHex: readGrantKey(root)!, now: NOW + 1000 });
      expect(result).toMatchObject({ ok: false, code: "bad-signature" });
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an expired token is rejected against the verification clock", () => {
    const { store, root } = newStore();
    try {
      const { token } = issue(store, root);
      expect(verifyAttemptGrantToken(token, { keyHex: readGrantKey(root)!, now: NOW + 3_600_000 }).ok).toBe(false);
      expect(verifyAttemptGrantToken(token, { keyHex: readGrantKey(root)!, now: NOW + 3_600_000 })).toMatchObject({ code: "expired" });
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a role the registry does not carry is rejected even with a valid signature", () => {
    const { store, root } = newStore();
    try {
      const { token } = issue(store, root, { role: "supreme-overlord" });
      expect(verifyAttemptGrantToken(token, { keyHex: readGrantKey(root)!, now: NOW + 1000 })).toMatchObject({ ok: false, code: "unregistered-role" });
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("off-schema input answers malformed, never throws", () => {
    for (const bad of [null, "string", 42, [], {}, { attempt_grant: 1 }]) {
      expect(verifyAttemptGrantToken(bad, { keyHex: KEY, now: NOW })).toMatchObject({ ok: false, code: "malformed" });
    }
  });
});

describe("authoritative verification against STA's store (out-of-band)", () => {
  it("an issued grant verifies against its own record", () => {
    const { store, root } = newStore();
    try {
      const { token } = issue(store, root);
      const result = verifyIssuedAttemptGrant(store, token, { keyHex: readGrantKey(root)!, now: NOW + 1000 });
      expect(result.ok).toBe(true);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a token signed with the real key but never issued is an unknown grant", () => {
    const { store, root } = newStore();
    try {
      const key = loadOrCreateGrantKey(root);
      const { token } = issue(store, root);
      // A different grant id, correctly signed with the workspace key: the
      // in-band signature holds, and the store check is what refuses it —
      // the signature alone is never authority, only the issuance record is.
      const reissued = signAttemptGrant(
        AttemptGrantTokenSchema.parse({ ...token, grant_id: `agr_${"e".repeat(32)}`, nonce: "f".repeat(32) }),
        key,
      );
      expect(verifyAttemptGrantToken(reissued, { keyHex: key, now: NOW + 1000 }).ok).toBe(true);
      expect(verifyIssuedAttemptGrant(store, reissued, { keyHex: key, now: NOW + 1000 })).toMatchObject({ ok: false, code: "unknown-grant" });
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a consumed grant is a replay: refused from the store, and the token file is gone", () => {
    const { store, root } = newStore();
    try {
      const { token } = issue(store, root);
      const key = readGrantKey(root)!;
      expect(fs.existsSync(path.join(root, ...ATTEMPT_GRANT_TOKEN_PATH.split("/")))).toBe(true);
      consumeAttemptGrant(store, token, { keyHex: key, now: NOW + 1000, grantRoot: root });
      expect(fs.existsSync(path.join(root, ...ATTEMPT_GRANT_TOKEN_PATH.split("/")))).toBe(false);
      // Replay: the same token presented again.
      expect(verifyIssuedAttemptGrant(store, token, { keyHex: key, now: NOW + 2000 })).toMatchObject({ ok: false, code: "already-consumed" });
      expect(() => consumeAttemptGrant(store, token, { keyHex: key, now: NOW + 2000, grantRoot: root })).toThrow(AttemptGrantRejectedError);
      // The consumption record is durable.
      const events = store.evidenceForTask("T-GRANT").filter(isAttemptGrantRecord).map((r) => r.payload.event);
      expect(events).toEqual(["issued", "consumed"]);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the unassigned floor denies the governed artifact tree while keeping the rest", () => {
    expect(UNASSIGNED_SESSION_DENY).toEqual(["_docs/**"]);
  });
});
