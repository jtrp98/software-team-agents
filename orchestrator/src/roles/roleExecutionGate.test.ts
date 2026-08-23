import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { KnowledgeBase } from "../knowledge/knowledgeBase.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { makeItem, sampleKnowledge } from "../knowledge/sampleKnowledge.js";
import type { KnowledgeItem } from "../knowledge/knowledgeModel.js";
import { laneOf } from "./roleLane.js";
import { recordSignoff } from "./roleApproval.js";
import { acknowledge, emptyWorkspace, writeRoleWorkspace } from "./roleWorkspace.js";
import { checkRoleExecutionGate } from "./roleExecutionGate.js";

const NOW = "2026-08-21T10:00:00Z";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "role-execution-gate-"));
}

function approvedKnowledge(root: string): KnowledgeBase {
  const items = sampleKnowledge().map((item) => ({ ...item, status: "approved" as const })) as KnowledgeItem[];
  for (const item of items) writeKnowledgeItem(item, root, { force: true });
  return new KnowledgeBase(items);
}

function approveLane(root: string, kb: KnowledgeBase, lane: "ba" | "sa"): string[] {
  const items = kb.query({ module: "sales-crm" }).filter((item) => laneOf(item.owner) === lane);
  writeRoleWorkspace(
    recordSignoff(emptyWorkspace(lane, "sales-crm", NOW), { approved: items, approve: true, by: "Nok", now: NOW }),
    root,
  );
  return items.map((item) => item.id);
}

function acknowledgeLane(root: string, kb: KnowledgeBase, lane: "sa" | "dev", ids: string[]): void {
  writeRoleWorkspace(acknowledge(emptyWorkspace(lane, "sales-crm", NOW), kb, ids, "Somchai", NOW), root);
}

describe("checkRoleExecutionGate (T114)", () => {
  it("keeps SA out until BA's human sign-off has been acknowledged", () => {
    const root = tmpProject();
    const kb = approvedKnowledge(root);
    const baItems = approveLane(root, kb, "ba");

    const waiting = checkRoleExecutionGate(root, "sales-crm", AgentStage.SYSTEM_ANALYST, NOW);
    expect(waiting.allowed).toBe(false);
    expect(waiting.reason).toMatch(/SA lane has not acknowledged/);

    acknowledgeLane(root, kb, "sa", baItems);
    expect(checkRoleExecutionGate(root, "sales-crm", AgentStage.SYSTEM_ANALYST, NOW)).toEqual({ allowed: true });
  });

  it("keeps both implementation stages out until SA hands its approved design to DEV", () => {
    const root = tmpProject();
    const kb = approvedKnowledge(root);
    const baItems = approveLane(root, kb, "ba");
    acknowledgeLane(root, kb, "sa", baItems);

    const waiting = checkRoleExecutionGate(root, "sales-crm", AgentStage.BACKEND_ENGINEER, NOW);
    expect(waiting.allowed).toBe(false);
    expect(waiting.reason).toMatch(/SA lane is awaiting-signoff/);

    const saItems = approveLane(root, kb, "sa");
    acknowledgeLane(root, kb, "dev", saItems);
    expect(checkRoleExecutionGate(root, "sales-crm", AgentStage.BACKEND_ENGINEER, NOW)).toEqual({ allowed: true });
    expect(checkRoleExecutionGate(root, "sales-crm", AgentStage.FRONTEND_ENGINEER, NOW)).toMatchObject({ allowed: false });
  });

  it("does not invent an acknowledgement when knowledge is missing", () => {
    const blocked = checkRoleExecutionGate(tmpProject(), "sales-crm", AgentStage.SYSTEM_ANALYST, NOW);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/no knowledge\/ directory/);
  });

  it("lets engineers through when the knowledge directory exists but holds nothing — `sta init` seeds it empty", () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
    expect(checkRoleExecutionGate(root, "demo", AgentStage.BACKEND_ENGINEER, NOW)).toEqual({ allowed: true });
    expect(checkRoleExecutionGate(root, "demo", AgentStage.FRONTEND_ENGINEER, NOW)).toEqual({ allowed: true });
  });

  it("gates frontend work on an approved current UX artifact plus its human sign-off (T146/T150)", () => {
    const root = tmpProject();
    const kb = approvedKnowledge(root);
    // Full SA handoff first, so the only remaining gate for FRONTEND is the UX/UI one.
    acknowledgeLane(root, kb, "sa", approveLane(root, kb, "ba"));
    acknowledgeLane(root, kb, "dev", approveLane(root, kb, "sa"));
    expect(checkRoleExecutionGate(root, "sales-crm", AgentStage.BACKEND_ENGINEER, NOW)).toEqual({ allowed: true });

    // No ux-design item at all → blocked, and the reason names the UX requirement.
    const noUx = checkRoleExecutionGate(root, "sales-crm", AgentStage.FRONTEND_ENGINEER, NOW);
    expect(noUx.allowed).toBe(false);
    expect(noUx.reason).toMatch(/UX artifact/);

    // An approved ux-design whose artifact file is missing on disk is still not current.
    const ux = makeItem(
      "ux-design",
      "UX-201",
      { artifact: "_docs/module/sales-crm/uxui/design.md", refines: ["DES-003"] },
      { owner: AgentStage.HUMAN, status: "approved" },
    );
    writeKnowledgeItem(ux, root, { force: true });
    expect(checkRoleExecutionGate(root, "sales-crm", AgentStage.FRONTEND_ENGINEER, NOW).allowed).toBe(false);

    // Artifact present but nobody in the uxui lane has signed anything off.
    fs.mkdirSync(path.join(root, "_docs", "module", "sales-crm", "uxui"), { recursive: true });
    fs.writeFileSync(path.join(root, "_docs", "module", "sales-crm", "uxui", "design.md"), "# ux ui\n");
    expect(checkRoleExecutionGate(root, "sales-crm", AgentStage.FRONTEND_ENGINEER, NOW).allowed).toBe(false);

    // A human in the uxui lane signs off on exactly this version of this artifact.
    writeRoleWorkspace(
      recordSignoff(emptyWorkspace("uxui", "sales-crm", NOW), { approved: [ux], approve: true, by: "Mina", now: NOW }),
      root,
    );
    expect(checkRoleExecutionGate(root, "sales-crm", AgentStage.FRONTEND_ENGINEER, NOW)).toEqual({ allowed: true });

    // The artifact moving to a new version invalidates that consent — fail closed again.
    const nextVersion = { ...ux, version: (ux.version as number) + 1 };
    writeKnowledgeItem(nextVersion, root, { force: true });
    const stale = checkRoleExecutionGate(root, "sales-crm", AgentStage.FRONTEND_ENGINEER, NOW);
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toMatch(/UX artifact/);
  });
});
