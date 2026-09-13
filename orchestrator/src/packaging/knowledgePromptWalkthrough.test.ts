import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { validateKnowledgeItem } from "../knowledge/knowledgeModel.js";

function sha256(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

describe("T-V9-024 — setup and knowledge-refresh walkthrough fixtures", () => {
  it("Fixture 1 — existing-project setup creates canonical multi-Target knowledge and leaves reference docs untouched", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-v9-setup-walkthrough-"));
    try {
      const knowledgeDir = path.join(tempDir, "knowledge-repo");
      const targetWeb = path.join(tempDir, "web-client");
      const targetApi = path.join(tempDir, "api-server");
      const targetAdmin = path.join(tempDir, "admin-portal");
      const refDocsDir = path.join(tempDir, "legacy-reference-docs");

      fs.mkdirSync(knowledgeDir, { recursive: true });
      fs.mkdirSync(path.join(targetWeb, "src"), { recursive: true });
      fs.mkdirSync(path.join(targetApi, "src"), { recursive: true });
      fs.mkdirSync(path.join(targetAdmin, "src"), { recursive: true });
      fs.mkdirSync(refDocsDir, { recursive: true });

      // Code reality in targets
      fs.writeFileSync(path.join(targetWeb, "package.json"), JSON.stringify({ name: "web-client" }));
      fs.writeFileSync(path.join(targetApi, "src", "routes.ts"), "export const USERS_ROUTE = '/api/v1/users';");
      fs.writeFileSync(path.join(targetAdmin, "src", "admin.ts"), "export const ADMIN_ROLE = 'system_admin';");

      // Reference docs (optional read-only evidence)
      const refDoc1Path = path.join(refDocsDir, "v0-spec.txt");
      const refDoc2Path = path.join(refDocsDir, "historical-architecture.md");
      const refDoc1Content = "Historical spec from 2024: single monolithic server architecture.";
      const refDoc2Content = "# Old System\nOutdated assumptions and legacy endpoints.";
      fs.writeFileSync(refDoc1Path, refDoc1Content, "utf8");
      fs.writeFileSync(refDoc2Path, refDoc2Content, "utf8");

      const refDoc1HashBefore = sha256(fs.readFileSync(refDoc1Path));
      const refDoc2HashBefore = sha256(fs.readFileSync(refDoc2Path));

      // Execution of prompt-setup.md canonical knowledge derivation
      // 1. Derive targets.yaml with types (CR-1, CR-3, AD-1)
      const targetsYaml = `targets:
  - id: web-client
    remote: https://github.com/org/web-client.git
    type: frontend
  - id: api-server
    remote: https://github.com/org/api-server.git
    type: backend
  - id: admin-portal
    remote: https://github.com/org/admin-portal.git
    type: fullstack
`;
      fs.writeFileSync(path.join(knowledgeDir, "targets.yaml"), targetsYaml, "utf8");

      // 2. Derive canonical knowledge envelopes (schema v2 with target_ids)
      const now = "2026-09-13T12:00:00Z";
      const moduleDir = path.join(knowledgeDir, "knowledge", "users");
      fs.mkdirSync(path.join(moduleDir, "requirement"), { recursive: true });
      fs.mkdirSync(path.join(moduleDir, "api"), { recursive: true });
      fs.mkdirSync(path.join(moduleDir, "domain"), { recursive: true });

      // Module-wide item: target_ids: []
      const reqItem = {
        schema_version: 2,
        id: "REQ-001",
        kind: "requirement" as const,
        title: "User Account Management",
        body: "Users must be able to view and update account profiles.",
        repo: null,
        target_ids: [], // module-wide across all targets
        module: "users",
        owner: AgentStage.BUSINESS_ANALYST,
        status: "approved" as const,
        sensitive: false,
        version: 1,
        created_at: now,
        updated_at: now,
        sources: [{
          type: "code" as const,
          locator: "api-server/src/routes.ts#L1",
          captured_at: now,
          digest: null,
          origin: { root: "target" as const, target_id: "api-server" },
        }],
        relations: [],
        payload: {
          acceptance_criteria: ["profile update returns 200"],
          actors: ["user"],
          priority: "must" as const,
          assumption_unconfirmed: false,
        },
      };

      // Target-specific item: target_ids: ["api-server"]
      const apiItem = {
        schema_version: 2,
        id: "API-001",
        kind: "api" as const,
        title: "User Management API",
        body: "API endpoint for listing and retrieving users.",
        repo: null,
        target_ids: ["api-server"],
        module: "users",
        owner: AgentStage.SYSTEM_ANALYST,
        status: "approved" as const,
        sensitive: false,
        version: 1,
        created_at: now,
        updated_at: now,
        sources: [{
          type: "code" as const,
          locator: "api-server/src/routes.ts#L1",
          captured_at: now,
          digest: null,
          origin: { root: "target" as const, target_id: "api-server" },
        }],
        relations: [{ type: "references" as const, to: "REQ-001" }],
        payload: {
          method: "GET",
          path: "/api/v1/users",
          contract_name: "users.get",
          request_shape: null,
          response_shape: "User[]",
        },
      };

      // Multi-target item (frontend + fullstack): target_ids: ["web-client", "admin-portal"]
      const domainItem = {
        schema_version: 2,
        id: "DOM-001",
        kind: "domain" as const,
        title: "User Identity Domain Term",
        body: "Shared representation of user identity in client interfaces.",
        repo: null,
        target_ids: ["web-client", "admin-portal"],
        module: "users",
        owner: AgentStage.SYSTEM_ANALYST,
        status: "approved" as const,
        sensitive: false,
        version: 1,
        created_at: now,
        updated_at: now,
        sources: [{
          type: "code" as const,
          locator: "web-client/package.json#L1",
          captured_at: now,
          digest: null,
          origin: { root: "target" as const, target_id: "web-client" },
        }],
        relations: [],
        payload: {
          term: "UserIdentity",
          definition: "Identity claim bundle rendered across client applications",
          aliases: ["UserAccount"],
        },
      };

      // Validate all items against canonical schema
      validateKnowledgeItem(reqItem, "reqItem");
      validateKnowledgeItem(apiItem, "apiItem");
      validateKnowledgeItem(domainItem, "domainItem");

      // Verify multi-Target representations
      expect(reqItem.target_ids).toEqual([]);
      expect(apiItem.target_ids).toEqual(["api-server"]);
      expect(domainItem.target_ids).toEqual(["web-client", "admin-portal"]);

      // Verify reference docs are 100% untouched (CR-6, AD-11)
      expect(sha256(fs.readFileSync(refDoc1Path))).toBe(refDoc1HashBefore);
      expect(sha256(fs.readFileSync(refDoc2Path))).toBe(refDoc2HashBefore);
      expect(fs.readFileSync(refDoc1Path, "utf8")).toBe(refDoc1Content);
      expect(fs.readFileSync(refDoc2Path, "utf8")).toBe(refDoc2Content);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("Fixture 2 — incremental refresh updates affected item, retains valid business intent & future requirements, ignores stale reference", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sta-v9-refresh-walkthrough-"));
    try {
      const knowledgeDir = path.join(tempDir, "knowledge-repo");
      const targetApi = path.join(tempDir, "api-server");
      const targetMobile = path.join(tempDir, "mobile-app");
      const refDocsDir = path.join(tempDir, "legacy-reference-docs");

      fs.mkdirSync(knowledgeDir, { recursive: true });
      fs.mkdirSync(path.join(targetApi, "src"), { recursive: true });
      fs.mkdirSync(path.join(targetMobile, "src"), { recursive: true });
      fs.mkdirSync(refDocsDir, { recursive: true });

      // Stale reference doc claiming legacy /api/v0/users (lowest priority, AD-12)
      const staleRefReadme = path.join(refDocsDir, "README.old");
      const staleRefContent = "Documentation: User endpoint is at GET /api/v0/users (stale legacy).";
      fs.writeFileSync(staleRefReadme, staleRefContent, "utf8");
      const staleRefHashBefore = sha256(fs.readFileSync(staleRefReadme));

      // 1. Initial State before refresh
      const now1 = "2026-08-01T10:00:00Z";
      const initialApiItem = {
        schema_version: 2,
        id: "API-001",
        kind: "api" as const,
        title: "User Management API",
        body: "Active endpoint: /api/v1/users",
        repo: null,
        target_ids: ["api-server"],
        module: "users",
        owner: AgentStage.SYSTEM_ANALYST,
        status: "approved" as const,
        sensitive: false,
        version: 1,
        created_at: now1,
        updated_at: now1,
        sources: [{
          type: "code" as const,
          locator: "api-server/src/routes.ts#L1",
          captured_at: now1,
          digest: null,
          origin: { root: "target" as const, target_id: "api-server" },
        }],
        relations: [{ type: "references" as const, to: "REQ-001" }],
        payload: {
          method: "GET",
          path: "/api/v1/users",
          contract_name: "users.get",
          request_shape: null,
          response_shape: "User[]",
        },
      };

      // Unchanged valid business requirement
      const unchangedReqItem = {
        schema_version: 2,
        id: "REQ-001",
        kind: "requirement" as const,
        title: "User Authentication Requirement",
        body: "Users must be authenticated before accessing resources.",
        repo: null,
        target_ids: [],
        module: "users",
        owner: AgentStage.BUSINESS_ANALYST,
        status: "approved" as const,
        sensitive: true,
        version: 1,
        created_at: now1,
        updated_at: now1,
        sources: [{
          type: "file" as const,
          locator: "_docs/module/users/requirement.md#L1",
          captured_at: now1,
          digest: null,
          origin: { root: "knowledge" as const, target_id: null },
        }],
        relations: [],
        payload: {
          acceptance_criteria: ["unauthorized access returns 401"],
          actors: ["user"],
          priority: "must" as const,
          assumption_unconfirmed: false,
        },
      };

      // Explicit approved future / planned requirement (not in code yet, MUST be preserved!)
      const futureReqItem = {
        schema_version: 2,
        id: "REQ-FUTURE-001",
        kind: "requirement" as const,
        title: "Biometric Login Support (Planned Phase 9)",
        body: "Support WebAuthn and passkeys for biometric login. Approved planned future requirement.",
        repo: null,
        target_ids: ["mobile-app"],
        module: "users",
        owner: AgentStage.BUSINESS_ANALYST,
        status: "approved" as const,
        sensitive: true,
        version: 1,
        created_at: now1,
        updated_at: now1,
        sources: [{
          type: "file" as const,
          locator: "_docs/module/users/requirement.md#L45",
          captured_at: now1,
          digest: null,
          origin: { root: "knowledge" as const, target_id: null },
        }],
        relations: [{ type: "refines" as const, to: "REQ-001" }],
        payload: {
          acceptance_criteria: ["user can register passkey on mobile device"],
          actors: ["mobile_user"],
          priority: "should" as const,
          assumption_unconfirmed: false,
        },
      };

      validateKnowledgeItem(initialApiItem, "initialApiItem");
      validateKnowledgeItem(unchangedReqItem, "unchangedReqItem");
      validateKnowledgeItem(futureReqItem, "futureReqItem");

      // 2. Simulate Project Reality Change:
      // Code in api-server changes route to /api/v2/users
      fs.writeFileSync(path.join(targetApi, "src", "routes.ts"), "export const USERS_ROUTE = '/api/v2/users';");
      // New target mobile-app added
      fs.writeFileSync(path.join(targetMobile, "src", "app.ts"), "export const APP = 'mobile';");

      // 3. Execution of prompt-update-knowledge.md incremental refresh:
      // - Code outranks stale reference doc (AD-12): /api/v2/users wins over /api/v0/users and old /api/v1/users
      // - Detect diff: API-001 path changed from /api/v1/users to /api/v2/users
      // - Stale statement "/api/v1/users" removed
      // - Version bumped from 1 to 2
      // - Unchanged REQ-001 is retained untouched
      // - Future requirement REQ-FUTURE-001 is retained untouched (absence from code != deleted!)
      // - Stale reference doc is untouched
      const now2 = "2026-09-13T13:00:00Z";
      const refreshedApiItem = {
        ...initialApiItem,
        body: "Active endpoint: /api/v2/users", // stale /api/v1/users removed
        version: 2, // version incremented
        updated_at: now2,
        sources: [{
          type: "code" as const,
          locator: "api-server/src/routes.ts#L1",
          captured_at: now2,
          digest: null,
          origin: { root: "target" as const, target_id: "api-server" },
        }],
        payload: {
          ...initialApiItem.payload,
          path: "/api/v2/users", // code reality wins
        },
      };

      validateKnowledgeItem(refreshedApiItem, "refreshedApiItem");

      // Assertions:
      // (a) Affected item updated and version bumped
      expect(refreshedApiItem.version).toBe(2);
      expect(refreshedApiItem.payload.path).toBe("/api/v2/users");
      expect(refreshedApiItem.body).not.toContain("/api/v1/users");

      // (b) Unchanged requirement remained version 1 and untouched
      expect(unchangedReqItem.version).toBe(1);
      expect(unchangedReqItem.payload.acceptance_criteria).toEqual(["unauthorized access returns 401"]);

      // (c) Explicit future requirement PRESERVED even though no code exists yet
      expect(futureReqItem.version).toBe(1);
      expect(futureReqItem.title).toContain("Biometric Login Support");
      expect(futureReqItem.target_ids).toEqual(["mobile-app"]);

      // (d) Stale reference README remains completely untouched (lowest priority, read-only)
      expect(sha256(fs.readFileSync(staleRefReadme))).toBe(staleRefHashBefore);
      expect(fs.readFileSync(staleRefReadme, "utf8")).toBe(staleRefContent);
      expect(fs.readFileSync(staleRefReadme, "utf8")).toContain("/api/v0/users"); // stale text still in ref doc, untouched
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
