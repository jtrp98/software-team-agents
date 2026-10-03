import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCoreDb } from "./coreDb.js";
import { defaultMachineConfig } from "./machineConfig.js";
import { RuntimeHealthStore } from "./runtimeHealth.js";
import type SqliteDatabase from "../store/sqliteDatabase.js";

describe("STA Core runtime health", () => {
  let db: SqliteDatabase;
  let now: number;
  let health: RuntimeHealthStore;
  beforeEach(() => {
    db = openCoreDb(":memory:");
    now = 1_000_000;
    health = new RuntimeHealthStore(db, defaultMachineConfig().health, () => now);
  });
  afterEach(() => db.close());

  it("a quota-exhausted runtime is marked unusable with its reason, and the next stage skips it", () => {
    health.recordFailure({ runtimeId: "claude-code", failureClass: "QUOTA_EXHAUSTED", reason: "usage limit", runId: "wr-1", role: "commander" });
    const view = health.view("claude-code");
    expect(view.status).toBe("quota_exhausted");
    expect(view.usable).toBe(false);
    expect(view.skipReason).toMatch(/QUOTA_EXHAUSTED/);
    expect(health.isUsable("codex")).toBe(true);
  });

  it("cooldown ends on time (configured or provider-reported), then the runtime is usable again", () => {
    health.recordFailure({ runtimeId: "codex", failureClass: "RATE_LIMITED", reason: "429" });
    expect(health.isUsable("codex")).toBe(false);
    now += 5 * 60_000 + 1;
    expect(health.isUsable("codex")).toBe(true);
    health.recordFailure({ runtimeId: "codex", failureClass: "QUOTA_EXHAUSTED", reason: "plan", retryAt: now + 3 * 3_600_000 });
    expect(health.view("codex").cooldownUntil).toBe(now + 3 * 3_600_000);
    expect(health.earliestRecovery(["codex", "claude-code"])).toBe(now + 3 * 3_600_000);
  });

  it("TIMEOUT is a bounded retry: usable after the first, cooled down at the limit — never an endless loop", () => {
    health.recordFailure({ runtimeId: "agy", failureClass: "TIMEOUT", reason: "slow" });
    expect(health.view("agy").status).toBe("degraded");
    expect(health.isUsable("agy")).toBe(true);
    health.recordFailure({ runtimeId: "agy", failureClass: "TIMEOUT", reason: "slow again" });
    expect(health.isUsable("agy")).toBe(false);
    expect(health.view("agy").status).toBe("timeout");
  });

  it("a work failure (tests, lint, a bug) never changes health", () => {
    health.recordFailure({ runtimeId: "codex", failureClass: "TASK_FAILURE", reason: "unit test failed" });
    health.recordFailure({ runtimeId: "codex", failureClass: "EXECUTION_ERROR", reason: "lint failed" });
    expect(health.isUsable("codex")).toBe(true);
    expect(health.get("codex")).toBeNull();
    expect(health.eventsForRun("x")).toEqual([]);
  });

  it("success and an explicit clear end a cooldown; events are kept per run", () => {
    health.recordFailure({ runtimeId: "zcode", failureClass: "PROVIDER_UNAVAILABLE", reason: "down", runId: "wr-9", role: "qa-engineer" });
    health.clear("zcode");
    expect(health.isUsable("zcode")).toBe(true);
    health.recordSuccess("zcode", { runId: "wr-9", role: "qa-engineer" });
    expect(health.eventsForRun("wr-9").map((event) => event.kind)).toEqual(["failure", "success"]);
  });
});
