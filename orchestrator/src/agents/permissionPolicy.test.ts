import { describe, expect, it } from "vitest";
import { PermissionDeniedError, assertPermission, hasPermission } from "./permissionPolicy.js";
import { Permission } from "./permissions.js";
import { AgentStage } from "../types.js";

describe("permission enforcement", () => {
  it("backend-engineer cannot deploy", () => {
    expect(hasPermission(AgentStage.BACKEND_ENGINEER, Permission.DEPLOY)).toBe(false);
    expect(() => assertPermission(AgentStage.BACKEND_ENGINEER, Permission.DEPLOY)).toThrow(
      PermissionDeniedError,
    );
  });

  it("devops can deploy and rollback", () => {
    expect(() => assertPermission(AgentStage.DEVOPS, Permission.DEPLOY)).not.toThrow();
    expect(() => assertPermission(AgentStage.DEVOPS, Permission.ROLLBACK)).not.toThrow();
  });

  it("qa-engineer cannot write_code (it verifies, it doesn't implement)", () => {
    expect(hasPermission(AgentStage.QA_ENGINEER, Permission.WRITE_CODE)).toBe(false);
  });

  it("business-analyst cannot deploy, build, or write_code", () => {
    for (const p of [Permission.DEPLOY, Permission.BUILD, Permission.WRITE_CODE, Permission.ROLLBACK]) {
      expect(hasPermission(AgentStage.BUSINESS_ANALYST, p)).toBe(false);
    }
  });
});
