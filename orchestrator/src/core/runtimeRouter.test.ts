import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCoreDb } from "./coreDb.js";
import { parseMachineConfig, type MachineConfig } from "./machineConfig.js";
import { RuntimeHealthStore } from "./runtimeHealth.js";
import { overlayOrderFor, securityEligibility, selectRuntime } from "./runtimeRouter.js";
import type SqliteDatabase from "../store/sqliteDatabase.js";

const ALL = ["claude-code", "codex", "antigravity", "zcode"];

describe("STA Core runtime router", () => {
  let db: SqliteDatabase;
  let health: RuntimeHealthStore;
  let config: MachineConfig;
  let now = 5_000_000;
  beforeEach(() => {
    db = openCoreDb(":memory:");
    config = parseMachineConfig({});
    health = new RuntimeHealthStore(db, config.health, () => now);
  });
  afterEach(() => db.close());
  const snapshot = () => health.snapshot(ALL);
  // A world where every runtime's security boundary were verified — the router
  // logic itself is provider-neutral; certification is a separate input.
  const allCertified = () => ({ eligible: true });

  it("Commander is a role: the first configured runtime serves it", () => {
    const decision = selectRuntime("commander", { config, health: snapshot() });
    expect(decision.selected).toBe("claude-code");
    expect(decision.exhausted).toBe(false);
  });

  it("Claude quota → Codex commander", () => {
    health.recordFailure({ runtimeId: "claude-code", failureClass: "QUOTA_EXHAUSTED", reason: "usage limit" });
    const decision = selectRuntime("commander", { config, health: snapshot() });
    expect(decision.selected).toBe("codex");
    expect(decision.attempts[0]).toMatchObject({ runtimeId: "claude-code", outcome: "skipped" });
  });

  it("multi-hop: Claude quota → Codex quota → AGY unavailable → ZCode serves; all down → recoverable pause", () => {
    health.recordFailure({ runtimeId: "claude-code", failureClass: "QUOTA_EXHAUSTED", reason: "q" });
    health.recordFailure({ runtimeId: "codex", failureClass: "QUOTA_EXHAUSTED", reason: "q" });
    health.recordFailure({ runtimeId: "antigravity", failureClass: "PROVIDER_UNAVAILABLE", reason: "down" });
    const hop = selectRuntime("commander", { config, health: snapshot(), eligibility: allCertified });
    expect(hop.selected).toBe("zcode");
    expect(hop.attempts.map((a) => a.outcome)).toEqual(["skipped", "skipped", "skipped", "selected"]);
    health.recordFailure({ runtimeId: "zcode", failureClass: "RATE_LIMITED", reason: "429" });
    const none = selectRuntime("commander", { config, health: snapshot(), eligibility: allCertified });
    expect(none.exhausted).toBe(true);
    expect(none.recoverable).toBe(true);
    expect(none.recoverAt).not.toBeNull();
  });

  it("Claude quota falls back to Codex engineer with its admitted post-run write guard", () => {
    health.recordFailure({ runtimeId: "claude-code", failureClass: "QUOTA_EXHAUSTED", reason: "q" });
    const decision = selectRuntime("engineer", { config, health: snapshot() });
    expect(decision.selected).toBe("codex");
    expect(decision.attempts.map((a) => a.runtimeId)).toEqual(["codex"]);
    // Exhausted by quota, not by security alone: the run pauses and comes back.
    expect(decision.recoverable).toBe(true);
    expect(securityEligibility("codex", "engineer").eligible).toBe(true);
    expect(securityEligibility("claude-code", "engineer").eligible).toBe(true);
    // Non-writing roles have no certification requirement.
    expect(securityEligibility("antigravity", "qa").eligible).toBe(true);
    expect(securityEligibility("zcode", "commander").eligible).toBe(true);
  });

  it("Codex quota falls back to Claude engineer; when both are down the run pauses", () => {
    health.recordFailure({ runtimeId: "codex", failureClass: "QUOTA_EXHAUSTED", reason: "q" });
    expect(selectRuntime("engineer", { config, health: snapshot() }).selected).toBe("claude-code");
    health.recordFailure({ runtimeId: "claude-code", failureClass: "QUOTA_EXHAUSTED", reason: "q" });
    const decision = selectRuntime("engineer", { config, health: snapshot() });
    expect(decision.selected).toBeUndefined();
    expect(decision.recoverable).toBe(true);
    expect(decision.attempts.filter((a) => a.reason.startsWith("SECURITY")).map((a) => a.runtimeId)).toEqual(["antigravity", "zcode"]);
  });

  it("a pool with only uncertified runtimes for the engineer is not recoverable by waiting", () => {
    const narrow = parseMachineConfig({ roles: { engineer: { order: ["antigravity", "zcode"] } } });
    const decision = selectRuntime("engineer", { config: narrow, health: health.snapshot(["antigravity", "zcode"]) });
    expect(decision.exhausted).toBe(true);
    expect(decision.recoverable).toBe(false);
  });

  it("QA follows its configured order across all four runtimes: AGY quota → ZCode", () => {
    health.recordFailure({ runtimeId: "antigravity", failureClass: "QUOTA_EXHAUSTED", reason: "q" });
    expect(selectRuntime("qa", { config, health: snapshot() }).selected).toBe("zcode");
  });

  it("worker failover is independent of the commander route", () => {
    health.recordFailure({ runtimeId: "codex", failureClass: "QUOTA_EXHAUSTED", reason: "q" });
    expect(selectRuntime("engineer", { config, health: snapshot() }).selected).toBe("claude-code");
    expect(selectRuntime("commander", { config, health: snapshot() }).selected).toBe("claude-code");
  });

  it("exclusive (fallback:false) never moves to another runtime; preferred does", () => {
    const exclusive = parseMachineConfig({ roles: { reviewer: { order: ["claude-code", "codex"], fallback: false } } });
    health.recordFailure({ runtimeId: "claude-code", failureClass: "QUOTA_EXHAUSTED", reason: "q" });
    const locked = selectRuntime("reviewer", { config: exclusive, health: snapshot() });
    expect(locked.selected).toBeUndefined();
    expect(locked.attempts).toHaveLength(1);
    expect(overlayOrderFor(exclusive, "reviewer")).toEqual(["claude-code"]);
    const preferred = parseMachineConfig({ roles: { reviewer: { order: ["claude-code", "codex"], fallback: true } } });
    expect(selectRuntime("reviewer", { config: preferred, health: snapshot() }).selected).toBe("codex");
  });

  it("known unavailability (e.g. login required) is skipped with its reason", () => {
    const decision = selectRuntime("commander", { config, health: snapshot(), extraUnavailable: { "claude-code": "AUTH_REQUIRED: claude reports not logged in" } });
    expect(decision.selected).toBe("codex");
    expect(decision.attempts[0]!.reason).toMatch(/AUTH_REQUIRED/);
    now += 1;
  });
});
