import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { openCoreDb } from "../core/coreDb.js";
import { defaultMachineConfig } from "../core/machineConfig.js";
import { RuntimeHealthStore } from "../core/runtimeHealth.js";
import type SqliteDatabase from "../store/sqliteDatabase.js";
import { MockRuntimeAdapter } from "./mockAdapter.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { resolveRuntimeRoute } from "./runtimeRouting.js";
import {
  activeCoreRouteOverlay,
  assertPinnedKnowledge,
  CoreRouteOverlayError,
  deactivateCoreRouteOverlay,
  installCoreRouteOverlayForTest,
  parseCoreRouteOverlay,
  reportCoreRuntimeOutcome,
  type CoreRouteOverlay,
} from "./coreRouteOverlay.js";

describe("STA Core route overlay inside a bounded-run child", () => {
  let db: SqliteDatabase;
  let health: RuntimeHealthStore;
  let projectRoot: string;
  let knowledge: string;
  let registry: RuntimeRegistry;
  const overlay = (over: Partial<CoreRouteOverlay> = {}): CoreRouteOverlay => parseCoreRouteOverlay({
    schema_version: 1,
    run_id: "wr-test",
    knowledge: { name: "timetable", path: knowledge },
    module: "timetableai",
    role_orders: { engineer: ["codex", "claude-code"], reviewer: ["claude-code", "codex"], qa: ["codex", "claude-code"] },
    health_db: ":memory:",
    health_policy: defaultMachineConfig().health,
    ...over,
  });

  beforeEach(() => {
    db = openCoreDb(":memory:");
    health = new RuntimeHealthStore(db, defaultMachineConfig().health);
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-"));
    knowledge = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "overlay-k-")));
    registry = new RuntimeRegistry([
      new MockRuntimeAdapter({ id: "claude-code", models: ["sonnet"] }),
      new MockRuntimeAdapter({ id: "codex", models: ["sonnet"] }),
    ]);
  });
  afterEach(() => {
    deactivateCoreRouteOverlay();
    db.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(knowledge, { recursive: true, force: true });
  });

  const route = (stage: AgentStage, role: string) => resolveRuntimeRoute({
    role,
    stage,
    projectRoot,
    registry,
    config: null,
    modelPolicy: null,
    availability: { "claude-code": { available: true }, codex: { available: true } },
  });

  it("without an overlay nothing changes (one default candidate)", () => {
    expect(activeCoreRouteOverlay()).toBeNull();
    expect(route(AgentStage.QA_ENGINEER, "qa-engineer").candidates.map((c) => c.runtime.id)).toEqual(["claude-code"]);
  });

  it("orders each worker role by the Core's per-role route", () => {
    installCoreRouteOverlayForTest(overlay(), health);
    expect(route(AgentStage.QA_ENGINEER, "qa-engineer").candidates.map((c) => c.runtime.id)).toEqual(["codex", "claude-code"]);
    expect(route(AgentStage.REVIEWER, "reviewer").candidates.map((c) => c.runtime.id)).toEqual(["claude-code", "codex"]);
  });

  it("a runtime cooling down in shared health is skipped before dispatch — no repeated quota retry", () => {
    installCoreRouteOverlayForTest(overlay(), health);
    // The engineer stage hit Codex's quota; the later QA stage must not try Codex again.
    reportCoreRuntimeOutcome("codex", "backend-engineer", { status: "UNAVAILABLE", failureClass: "QUOTA_EXHAUSTED", diagnostics: ["usage limit"] });
    const qa = route(AgentStage.QA_ENGINEER, "qa-engineer");
    expect(qa.selected?.runtime.id).toBe("claude-code");
    expect(qa.attempts[0]).toMatchObject({ runtimeId: "codex", unavailable: true });
    expect(qa.attempts[0]!.skipReason).toMatch(/QUOTA_EXHAUSTED/);
    expect(health.eventsForRun("wr-test")[0]).toMatchObject({ runtimeId: "codex", kind: "failure", failureClass: "QUOTA_EXHAUSTED", role: "backend-engineer" });
  });

  it("known unavailability from the Core (sandbox not set up) is honored", () => {
    installCoreRouteOverlayForTest(overlay({ unavailable: { codex: "SANDBOX_SETUP_REQUIRED: no marker" } } as Partial<CoreRouteOverlay>), health);
    expect(route(AgentStage.QA_ENGINEER, "qa-engineer").selected?.runtime.id).toBe("claude-code");
  });

  it("a work failure reported by a stage never marks the runtime unhealthy", () => {
    installCoreRouteOverlayForTest(overlay(), health);
    reportCoreRuntimeOutcome("codex", "qa-engineer", { status: "ERROR", diagnostics: ["tests failed"] });
    expect(health.isUsable("codex")).toBe(true);
    expect(route(AgentStage.QA_ENGINEER, "qa-engineer").selected?.runtime.id).toBe("codex");
  });

  it("Knowledge pin: the child refuses a different root or name", () => {
    installCoreRouteOverlayForTest(overlay(), health);
    expect(() => assertPinnedKnowledge(knowledge, "timetable")).not.toThrow();
    expect(() => assertPinnedKnowledge(projectRoot, "timetable")).toThrow(CoreRouteOverlayError);
    expect(() => assertPinnedKnowledge(knowledge, "company-a")).toThrow(/pinned to Knowledge "timetable"/);
  });

  it("the overlay file is schema-validated", () => {
    expect(() => parseCoreRouteOverlay({ schema_version: 1 })).toThrow(CoreRouteOverlayError);
  });
});
