import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import { ROLE_LANES, type RoleLane, laneOf } from "./roleLane.js";
import { type RoleWorkspace, emptyWorkspace } from "./roleWorkspace.js";
import { recordSignoff } from "./roleApproval.js";
import { lanesAffectedBy, notificationsFor, propagate } from "./changePropagation.js";

const NOW = "2026-08-21T10:00:00Z";

function bump(id: string, items: KnowledgeItem[] = sampleKnowledge()): KnowledgeItem[] {
  return items.map((i) => (i.id === id ? { ...i, version: i.version + 1 } : i));
}

function ws(lane: RoleLane, seen: Record<string, number> = {}): RoleWorkspace {
  return {
    ...emptyWorkspace(lane, "sales-crm", NOW),
    seen: Object.entries(seen).map(([id, version]) => ({ id, version, at: NOW, by: "Nan" })),
  };
}

describe("notificationsFor — direct dependencies (T105/T106)", () => {
  const kb = new KnowledgeBase(sampleKnowledge());

  it("tells a lane about a dependency it has never acknowledged", () => {
    const notifications = notificationsFor("dev", "sales-crm", kb, ws("dev"));
    expect(notifications.map((n) => n.id)).toEqual(["API-shifts.list", "DES-003"]);
    expect(notifications.every((n) => n.reason === "never-acknowledged")).toBe(true);
  });

  it("tells a lane when a dependency moved under it, with both versions", () => {
    const after = new KnowledgeBase(bump("DES-003"));
    const notifications = notificationsFor("dev", "sales-crm", after, ws("dev", { "DES-003": 1, "API-shifts.list": 1 }));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      reason: "dependency-changed",
      id: "DES-003",
      acknowledgedVersion: 1,
      currentVersion: 2,
    });
    expect(notifications[0].message).toMatch(/DES-003 moved v1 -> v2 since DEV last acknowledged it/);
  });

  it("says nothing when the lane is caught up", () => {
    expect(notificationsFor("dev", "sales-crm", kb, ws("dev", { "DES-003": 1, "API-shifts.list": 1 }))).toEqual([]);
  });
});

describe("notificationsFor — transitive reach, which is what T106 adds over T99", () => {
  /**
   * DEV points at the API and the design, not at the requirement. A direct-only
   * walk leaves DEV uninformed about the amendment that just invalidated its
   * work.
   */
  it("tells DEV about a requirement change it does not directly depend on", () => {
    const after = new KnowledgeBase(bump("REQ-003"));
    // DEV acknowledged REQ-003 at some point (a handoff), but nothing DEV owns points at it.
    const notifications = notificationsFor("dev", "sales-crm", after, ws("dev", { "REQ-003": 1, "DES-003": 1, "API-shifts.list": 1 }));

    const upstream = notifications.find((n) => n.reason === "upstream-changed");
    expect(upstream).toBeDefined();
    expect(upstream?.id).toBe("REQ-003");
    expect(upstream?.via).toContain("REQ-003");
    expect(upstream?.message).toMatch(/hop\(s\) away, so it will not show up as a direct dependency/);
  });

  it("does not report the same change twice as both direct and upstream", () => {
    const after = new KnowledgeBase(bump("DES-003"));
    const notifications = notificationsFor("dev", "sales-crm", after, ws("dev", { "DES-003": 1, "API-shifts.list": 1 }));
    expect(notifications.filter((n) => n.id === "DES-003")).toHaveLength(1);
  });

  it("stays quiet about an upstream item the lane already re-acknowledged", () => {
    const after = new KnowledgeBase(bump("REQ-003"));
    const notifications = notificationsFor("dev", "sales-crm", after, ws("dev", { "REQ-003": 2, "DES-003": 1, "API-shifts.list": 1 }));
    expect(notifications.filter((n) => n.reason === "upstream-changed")).toEqual([]);
  });
});

describe("notificationsFor — sign-off invalidation", () => {
  it("reports the lane's own gate reopening as a consequence of the change", () => {
    const approvedBase = sampleKnowledge().map((i) =>
      laneOf(i.owner) === "ba" && i.module === "sales-crm" ? ({ ...i, status: "approved" } as KnowledgeItem) : i,
    );
    const before = new KnowledgeBase(approvedBase);
    const signed = recordSignoff(ws("ba"), {
      approved: before.query({ module: "sales-crm" }).filter((i) => laneOf(i.owner) === "ba"),
      approve: true,
      by: "Jaturapat",
      now: NOW,
    });

    const after = new KnowledgeBase(bump("REQ-003", approvedBase));
    const notifications = notificationsFor("ba", "sales-crm", after, signed);
    const invalidated = notifications.find((n) => n.reason === "signoff-invalidated");
    expect(invalidated?.id).toBe("REQ-003");
    expect(invalidated?.message).toMatch(/the gate has reopened/);
  });

  it("ranks the reopened gate above everything else", () => {
    const approvedBase = sampleKnowledge().map((i) =>
      laneOf(i.owner) === "ba" && i.module === "sales-crm" ? ({ ...i, status: "approved" } as KnowledgeItem) : i,
    );
    const before = new KnowledgeBase(approvedBase);
    const signed = recordSignoff(ws("ba"), {
      approved: before.query({ module: "sales-crm" }).filter((i) => laneOf(i.owner) === "ba"),
      approve: true,
      by: "Jaturapat",
      now: NOW,
    });
    const after = new KnowledgeBase(bump("REQ-003", approvedBase));
    expect(notificationsFor("ba", "sales-crm", after, signed)[0].reason).toBe("signoff-invalidated");
  });
});

describe("propagate", () => {
  /** The user's hard rule: every affected lane is told, always — not a shortlist somebody could get wrong. */
  it("asks every lane, every time", () => {
    const result = propagate("sales-crm", new KnowledgeBase(sampleKnowledge()), (lane) => ws(lane));
    expect(result.map((r) => r.lane)).toEqual([...ROLE_LANES]);
  });

  it("returns an empty list for a quiet lane, which is different from not asking it", () => {
    const result = propagate("sales-crm", new KnowledgeBase(sampleKnowledge()), (lane) =>
      lane === "dev" ? ws("dev", { "DES-003": 1, "API-shifts.list": 1 }) : ws(lane),
    );
    expect(result.find((r) => r.lane === "dev")?.notifications).toEqual([]);
    expect(result.find((r) => r.lane === "sa")?.notifications.length).toBeGreaterThan(0);
  });
});

describe("lanesAffectedBy — the question to ask before amending", () => {
  const kb = new KnowledgeBase(sampleKnowledge());

  it("reaches every lane downstream of a requirement", () => {
    const affected = lanesAffectedBy(kb, ["REQ-003"]);
    expect(affected.get("ba")?.map((i) => i.id)).toContain("REQ-003");
    expect(affected.get("sa")?.map((i) => i.id)).toEqual(expect.arrayContaining(["DES-003", "API-shifts.list", "DB-Shift"]));
    expect(affected.get("dev")?.map((i) => i.id)).toEqual(expect.arrayContaining(["BE-014", "FE-020"]));
  });

  /** Amending your own approved work is exactly what invalidates your own sign-off, so the changed item's lane counts. */
  it("includes the changed item's own lane", () => {
    expect(lanesAffectedBy(kb, ["DES-003"]).get("sa")?.map((i) => i.id)).toContain("DES-003");
  });

  it("reaches nothing downstream of a leaf", () => {
    const affected = lanesAffectedBy(kb, ["FE-020"]);
    expect(affected.get("dev")?.map((i) => i.id)).toEqual(["FE-020"]);
    expect(affected.get("ba")).toBeUndefined();
  });

  it("ignores an unknown id rather than throwing mid-report", () => {
    expect(lanesAffectedBy(kb, ["REQ-999"]).size).toBe(0);
  });

  it("does not double-count an item reached from two changes", () => {
    const affected = lanesAffectedBy(kb, ["REQ-003", "DES-003"]);
    const saIds = affected.get("sa")?.map((i) => i.id) ?? [];
    expect(new Set(saIds).size).toBe(saIds.length);
  });
});
