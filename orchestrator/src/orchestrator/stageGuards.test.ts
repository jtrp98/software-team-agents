import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage, TaskLevel } from "../types.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { makeItem } from "../knowledge/sampleKnowledge.js";
import { recordSignoff } from "../roles/roleApproval.js";
import { emptyWorkspace, writeRoleWorkspace } from "../roles/roleWorkspace.js";
import { checkRoleLaneEntry, createRoleLaneStageGuard, knowledgeRootForTask, moduleOfRuntimeTask, type StageEntryRequest } from "./stageGuards.js";
import {
  LANE_FIXTURE_MODULE as MODULE,
  LANE_FIXTURE_NOW as NOW,
  acknowledgeLane,
  signOffLane,
  writeApprovedKnowledge,
} from "./stageGuards.testSupport.js";
import type { RuntimeTask } from "./runtimeTask.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stage-guards-"));
}

function entry(root: string, stage: AgentStage, level: TaskLevel = TaskLevel.MEDIUM, moduleName = MODULE) {
  return checkRoleLaneEntry({ knowledgeRoot: root, moduleName, stage, level, now: NOW });
}

describe("checkRoleLaneEntry — the role-lane stage guard (T114, moved from roles/roleExecutionGate.ts in V13 TASK-007)", () => {
  it("keeps SA out until BA's human sign-off has been acknowledged, naming the ack a person must record", () => {
    const root = tmpProject();
    const kb = writeApprovedKnowledge(root);
    const baItems = signOffLane(root, kb, "ba");

    const waiting = entry(root, AgentStage.SYSTEM_ANALYST);
    expect(waiting.allowed).toBe(false);
    if (!waiting.allowed) {
      expect(waiting.reason).toMatch(/SA lane has not acknowledged/);
      expect(waiting.reason).toContain(`sta roles ack sa ${baItems.join(",")} --module ${MODULE} --by <name>`);
    }

    acknowledgeLane(root, kb, "sa", baItems);
    expect(entry(root, AgentStage.SYSTEM_ANALYST)).toEqual({ allowed: true });
  });

  it("keeps both implementation stages out until SA hands its approved design to DEV", () => {
    const root = tmpProject();
    const kb = writeApprovedKnowledge(root);
    acknowledgeLane(root, kb, "sa", signOffLane(root, kb, "ba"));

    const waiting = entry(root, AgentStage.BACKEND_ENGINEER);
    expect(waiting.allowed).toBe(false);
    if (!waiting.allowed) {
      expect(waiting.reason).toMatch(/SA lane is awaiting-signoff/);
      expect(waiting.reason).toMatch(/sta roles signoff sa/);
    }

    acknowledgeLane(root, kb, "dev", signOffLane(root, kb, "sa"));
    expect(entry(root, AgentStage.BACKEND_ENGINEER)).toEqual({ allowed: true });
    expect(entry(root, AgentStage.FRONTEND_ENGINEER)).toMatchObject({ allowed: false });
  });

  it("never gates a stage no lane owns", () => {
    const root = tmpProject();
    for (const stage of [AgentStage.BUSINESS_ANALYST, AgentStage.REVIEWER, AgentStage.QA_ENGINEER, AgentStage.SECURITY, AgentStage.DEVOPS]) {
      expect(entry(root, stage)).toEqual({ allowed: true });
    }
  });

  it("refuses when the knowledge/ directory is missing", () => {
    const blocked = entry(tmpProject(), AgentStage.SYSTEM_ANALYST);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.reason).toMatch(/no knowledge\/ directory/);
      expect(blocked.reason).toContain(`sta roles signoff ba --module ${MODULE} --by <name>`);
    }
  });

  it("refuses when the knowledge/ directory exists but holds nothing — an empty model is not an approved handoff", () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
    for (const stage of [AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]) {
      const refused = entry(root, stage, TaskLevel.SMALL, "demo");
      expect(refused.allowed).toBe(false);
      if (!refused.allowed) {
        expect(refused.reason).toMatch(/holds no items/);
        expect(refused.reason).toMatch(/sta roles (signoff|ack)/);
      }
    }
  });

  it("refuses when Knowledge is invalid", () => {
    const root = tmpProject();
    writeApprovedKnowledge(root);
    const broken = path.join(root, "knowledge", MODULE, "requirement", "REQ-999.yaml");
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, "id: [unterminated\n");
    const refused = entry(root, AgentStage.BACKEND_ENGINEER);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toMatch(/knowledge under .* is invalid/);
  });

  it("gates frontend work on an approved current UX artifact plus its human sign-off (T146/T150)", () => {
    const root = tmpProject();
    const kb = writeApprovedKnowledge(root);
    acknowledgeLane(root, kb, "sa", signOffLane(root, kb, "ba"));
    acknowledgeLane(root, kb, "dev", signOffLane(root, kb, "sa"));
    expect(entry(root, AgentStage.BACKEND_ENGINEER)).toEqual({ allowed: true });

    const noUx = entry(root, AgentStage.FRONTEND_ENGINEER);
    expect(noUx.allowed).toBe(false);
    if (!noUx.allowed) expect(noUx.reason).toMatch(/UX artifact/);

    const ux = makeItem(
      "ux-design",
      "UX-201",
      { artifact: `_docs/module/${MODULE}/uxui/design.md`, refines: ["DES-003"] },
      { owner: AgentStage.HUMAN, status: "approved" },
    );
    writeKnowledgeItem(ux, root, { force: true });
    expect(entry(root, AgentStage.FRONTEND_ENGINEER).allowed).toBe(false);

    fs.mkdirSync(path.join(root, "_docs", "module", MODULE, "uxui"), { recursive: true });
    fs.writeFileSync(path.join(root, "_docs", "module", MODULE, "uxui", "design.md"), "# ux ui\n");
    expect(entry(root, AgentStage.FRONTEND_ENGINEER).allowed).toBe(false);

    writeRoleWorkspace(
      recordSignoff(emptyWorkspace("uxui", MODULE, NOW), { approved: [ux], approve: true, by: "Mina", now: NOW }),
      root,
    );
    expect(entry(root, AgentStage.FRONTEND_ENGINEER)).toEqual({ allowed: true });

    writeKnowledgeItem({ ...ux, version: (ux.version as number) + 1 }, root, { force: true });
    const stale = entry(root, AgentStage.FRONTEND_ENGINEER);
    expect(stale.allowed).toBe(false);
    if (!stale.allowed) expect(stale.reason).toMatch(/UX artifact/);
  });

  it("skips the UX-artifact precondition for TRIVIAL/SMALL tasks but keeps it for MEDIUM+ and UNKNOWN (T-UX12)", () => {
    const root = tmpProject();
    const kb = writeApprovedKnowledge(root);
    acknowledgeLane(root, kb, "sa", signOffLane(root, kb, "ba"));
    acknowledgeLane(root, kb, "dev", signOffLane(root, kb, "sa"));

    expect(entry(root, AgentStage.FRONTEND_ENGINEER, TaskLevel.TRIVIAL)).toEqual({ allowed: true });
    expect(entry(root, AgentStage.FRONTEND_ENGINEER, TaskLevel.SMALL)).toEqual({ allowed: true });
    expect(entry(root, AgentStage.FRONTEND_ENGINEER, TaskLevel.MEDIUM).allowed).toBe(false);
    expect(entry(root, AgentStage.FRONTEND_ENGINEER, TaskLevel.LARGE_CRITICAL).allowed).toBe(false);
    expect(entry(root, AgentStage.FRONTEND_ENGINEER, TaskLevel.UNKNOWN).allowed).toBe(false);

    // The SA→DEV handoff itself is never waived by level — only the UX precondition is.
    const saNotAcknowledged = tmpProject();
    signOffLane(saNotAcknowledged, writeApprovedKnowledge(saNotAcknowledged), "ba");
    expect(entry(saNotAcknowledged, AgentStage.FRONTEND_ENGINEER, TaskLevel.SMALL).allowed).toBe(false);
  });
});

describe("createRoleLaneStageGuard — the production guard's Knowledge root and module", () => {
  const request = (overrides: Partial<StageEntryRequest> = {}): StageEntryRequest => ({
    taskId: "T-G",
    stage: AgentStage.BACKEND_ENGINEER,
    level: TaskLevel.MEDIUM,
    knowledgeRoot: null,
    runtimeTask: null,
    ...overrides,
  });

  it("reads the task's frozen Knowledge root, not the project root, when one was frozen at intake", () => {
    const project = tmpProject();
    const knowledge = tmpProject();
    const kb = writeApprovedKnowledge(knowledge);
    acknowledgeLane(knowledge, kb, "sa", signOffLane(knowledge, kb, "ba"));
    acknowledgeLane(knowledge, kb, "dev", signOffLane(knowledge, kb, "sa"));
    const guard = createRoleLaneStageGuard({ projectRoot: project, moduleName: MODULE });

    expect(knowledgeRootForTask({ knowledgeRoot: { name: "k", path: knowledge } }, project)).toBe(knowledge);
    expect(knowledgeRootForTask({ knowledgeRoot: null }, project)).toBe(project);
    expect(guard(request({ knowledgeRoot: { name: "k", path: knowledge } }))).toEqual({ allowed: true });
    expect(guard(request()).allowed).toBe(false); // the project root has no Knowledge at all
  });

  it("takes the module from the task's canonical RuntimeTask when the invocation names none, and refuses when neither does", () => {
    const root = tmpProject();
    const kb = writeApprovedKnowledge(root);
    acknowledgeLane(root, kb, "sa", signOffLane(root, kb, "ba"));
    acknowledgeLane(root, kb, "dev", signOffLane(root, kb, "sa"));
    const runtimeTask = { version: 2, plan_source: path.join(root, "_docs", "module", MODULE, "plan.md") } as unknown as RuntimeTask;
    expect(moduleOfRuntimeTask(runtimeTask)).toBe(MODULE);

    const guard = createRoleLaneStageGuard({ projectRoot: root });
    expect(guard(request({ runtimeTask }))).toEqual({ allowed: true });
    const unbound = guard(request());
    expect(unbound.allowed).toBe(false);
    if (!unbound.allowed) expect(unbound.reason).toMatch(/bound to no module/);
  });
});
