import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStage, TaskLevel } from "../types.js";
import { writeKnowledgeItem } from "../knowledge/knowledgeStore.js";
import { makeItem } from "../knowledge/sampleKnowledge.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import type { TaskStore } from "../store/taskStore.js";
import { checkRoleLaneEntry, createRoleLaneStageGuard, knowledgeRootForTask, moduleOfRuntimeTask, type StageEntryRequest } from "./stageGuards.js";
import {
  LANE_FIXTURE_MODULE as MODULE,
  LANE_FIXTURE_NOW as NOW,
  acknowledgeLane as acknowledgeLaneIn,
  decideLane,
  signOffLane as signOffLaneIn,
  writeApprovedKnowledge,
} from "./stageGuards.testSupport.js";
import type { RuntimeTask } from "./runtimeTask.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stage-guards-"));
}

/** One lane ledger per Knowledge root in this file — the store the guard under test reads. */
const ledgers = new Map<string, TaskStore>();
function ledgerFor(root: string): TaskStore {
  if (!ledgers.has(root)) ledgers.set(root, new MemoryTaskStore());
  return ledgers.get(root)!;
}

function entry(root: string, stage: AgentStage, level: TaskLevel = TaskLevel.MEDIUM, moduleName = MODULE) {
  return checkRoleLaneEntry({ knowledgeRoot: root, ledger: ledgerFor(root), moduleName, stage, level, now: NOW });
}

/** A person's sign-off / acknowledgement through the test-only trusted channel, persisted in `root`'s ledger. */
const signOffLane = (root: string, lane: "ba" | "sa") => signOffLaneIn(root, lane, MODULE, ledgerFor(root));
const acknowledgeLane = (root: string, lane: "sa" | "dev", ids: readonly string[]) => acknowledgeLaneIn(root, lane, ids, MODULE, ledgerFor(root));

describe("checkRoleLaneEntry — the role-lane stage guard (T114, moved from roles/roleExecutionGate.ts in V13 TASK-007)", () => {
  it("keeps SA out until BA's human sign-off has been acknowledged, naming the ack a person must record", async () => {
    const root = tmpProject();
    writeApprovedKnowledge(root);
    const baItems = await signOffLane(root, "ba");

    const waiting = entry(root, AgentStage.SYSTEM_ANALYST);
    expect(waiting.allowed).toBe(false);
    if (!waiting.allowed) {
      expect(waiting.reason).toMatch(/SA lane has not acknowledged/);
      expect(waiting.reason).toContain("trusted human decision channel (`sta roles ack sa --module sales-crm`)");
      expect(waiting.reason).toContain(baItems.join(", "));
    }

    await acknowledgeLane(root, "sa", baItems);
    expect(entry(root, AgentStage.SYSTEM_ANALYST)).toEqual({ allowed: true });
  });

  it("keeps both implementation stages out until SA hands its approved design to DEV", async () => {
    const root = tmpProject();
    writeApprovedKnowledge(root);
    await acknowledgeLane(root, "sa", await signOffLane(root, "ba"));

    const waiting = entry(root, AgentStage.BACKEND_ENGINEER);
    expect(waiting.allowed).toBe(false);
    if (!waiting.allowed) {
      expect(waiting.reason).toMatch(/SA lane is awaiting-signoff/);
      expect(waiting.reason).toMatch(/trusted human decision channel/);
    }

    await acknowledgeLane(root, "dev", await signOffLane(root, "sa"));
    expect(entry(root, AgentStage.BACKEND_ENGINEER)).toEqual({ allowed: true });
    expect(entry(root, AgentStage.FRONTEND_ENGINEER)).toMatchObject({ allowed: false });
  });

  it("never gates a stage no lane owns", async () => {
    const root = tmpProject();
    for (const stage of [AgentStage.BUSINESS_ANALYST, AgentStage.REVIEWER, AgentStage.QA_ENGINEER, AgentStage.SECURITY, AgentStage.DEVOPS]) {
      expect(entry(root, stage)).toEqual({ allowed: true });
    }
  });

  it("refuses when the knowledge/ directory is missing", async () => {
    const blocked = entry(tmpProject(), AgentStage.SYSTEM_ANALYST);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.reason).toMatch(/no knowledge\/ directory/);
      expect(blocked.reason).toContain("trusted human decision channel");
    }
  });

  it("refuses when the knowledge/ directory exists but holds nothing — an empty model is not an approved handoff", async () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
    for (const stage of [AgentStage.SYSTEM_ANALYST, AgentStage.BACKEND_ENGINEER, AgentStage.FRONTEND_ENGINEER]) {
      const refused = entry(root, stage, TaskLevel.SMALL, "demo");
      expect(refused.allowed).toBe(false);
      if (!refused.allowed) {
        expect(refused.reason).toMatch(/holds no items/);
        expect(refused.reason).toMatch(/trusted human decision channel/);
      }
    }
  });

  it("refuses when Knowledge is invalid", async () => {
    const root = tmpProject();
    writeApprovedKnowledge(root);
    const broken = path.join(root, "knowledge", MODULE, "requirement", "REQ-999.yaml");
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, "id: [unterminated\n");
    const refused = entry(root, AgentStage.BACKEND_ENGINEER);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toMatch(/knowledge under .* is invalid/);
  });

  it("gates frontend work on an approved current UX artifact plus its human sign-off (T146/T150)", async () => {
    const root = tmpProject();
    writeApprovedKnowledge(root);
    await acknowledgeLane(root, "sa", await signOffLane(root, "ba"));
    await acknowledgeLane(root, "dev", await signOffLane(root, "sa"));
    expect(entry(root, AgentStage.BACKEND_ENGINEER)).toEqual({ allowed: true });

    const noUx = entry(root, AgentStage.FRONTEND_ENGINEER);
    expect(noUx.allowed).toBe(false);
    if (!noUx.allowed) expect(noUx.reason).toMatch(/UX artifact/);

    const ux = makeItem(
      "ux-design",
      "UX-201",
      { artifact: `_docs/module/${MODULE}/uxui/design.md`, refines: ["DES-003"] },
      { owner: AgentStage.UXUI_DESIGNER, status: "approved" },
    );
    writeKnowledgeItem(ux, root, { force: true });
    expect(entry(root, AgentStage.FRONTEND_ENGINEER).allowed).toBe(false);

    fs.mkdirSync(path.join(root, "_docs", "module", MODULE, "uxui"), { recursive: true });
    fs.writeFileSync(path.join(root, "_docs", "module", MODULE, "uxui", "design.md"), "# ux ui\n");
    expect(entry(root, AgentStage.FRONTEND_ENGINEER).allowed).toBe(false);

    await decideLane(ledgerFor(root), root, MODULE, "uxui", "signoff");
    expect(entry(root, AgentStage.FRONTEND_ENGINEER)).toEqual({ allowed: true });

    // The UX file's bytes are part of what was signed: editing it makes the sign-off stale.
    fs.writeFileSync(path.join(root, "_docs", "module", MODULE, "uxui", "design.md"), "# ux ui (edited after sign-off)\n");
    const editedArtifact = entry(root, AgentStage.FRONTEND_ENGINEER);
    expect(editedArtifact.allowed).toBe(false);
    if (!editedArtifact.allowed) expect(editedArtifact.reason).toMatch(/UX artifact/);
    fs.writeFileSync(path.join(root, "_docs", "module", MODULE, "uxui", "design.md"), "# ux ui\n");
    expect(entry(root, AgentStage.FRONTEND_ENGINEER)).toEqual({ allowed: true });

    writeKnowledgeItem({ ...ux, version: (ux.version as number) + 1 }, root, { force: true });
    const stale = entry(root, AgentStage.FRONTEND_ENGINEER);
    expect(stale.allowed).toBe(false);
    if (!stale.allowed) expect(stale.reason).toMatch(/UX artifact/);
  });

  it("skips the UX-artifact precondition for TRIVIAL/SMALL tasks but keeps it for MEDIUM+ and UNKNOWN (T-UX12)", async () => {
    const root = tmpProject();
    writeApprovedKnowledge(root);
    await acknowledgeLane(root, "sa", await signOffLane(root, "ba"));
    await acknowledgeLane(root, "dev", await signOffLane(root, "sa"));

    expect(entry(root, AgentStage.FRONTEND_ENGINEER, TaskLevel.TRIVIAL)).toEqual({ allowed: true });
    expect(entry(root, AgentStage.FRONTEND_ENGINEER, TaskLevel.SMALL)).toEqual({ allowed: true });
    expect(entry(root, AgentStage.FRONTEND_ENGINEER, TaskLevel.MEDIUM).allowed).toBe(false);
    expect(entry(root, AgentStage.FRONTEND_ENGINEER, TaskLevel.LARGE_CRITICAL).allowed).toBe(false);
    expect(entry(root, AgentStage.FRONTEND_ENGINEER, TaskLevel.UNKNOWN).allowed).toBe(false);

    // The SA→DEV handoff itself is never waived by level — only the UX precondition is.
    const saNotAcknowledged = tmpProject();
    writeApprovedKnowledge(saNotAcknowledged);
    await signOffLane(saNotAcknowledged, "ba");
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

  it("reads the task's frozen Knowledge root, not the project root, when one was frozen at intake", async () => {
    const project = tmpProject();
    const knowledge = tmpProject();
    writeApprovedKnowledge(knowledge);
    await acknowledgeLane(knowledge, "sa", await signOffLane(knowledge, "ba"));
    await acknowledgeLane(knowledge, "dev", await signOffLane(knowledge, "sa"));
    const guard = createRoleLaneStageGuard({ projectRoot: project, moduleName: MODULE, ledger: ledgerFor(knowledge) });

    expect(knowledgeRootForTask({ knowledgeRoot: { name: "k", path: knowledge } }, project)).toBe(knowledge);
    expect(knowledgeRootForTask({ knowledgeRoot: null }, project)).toBe(project);
    expect(guard(request({ knowledgeRoot: { name: "k", path: knowledge } }))).toEqual({ allowed: true });
    expect(guard(request()).allowed).toBe(false); // the project root has no Knowledge at all
  });

  it("takes the module from the task's canonical RuntimeTask when the invocation names none, and refuses when neither does", async () => {
    const root = tmpProject();
    writeApprovedKnowledge(root);
    await acknowledgeLane(root, "sa", await signOffLane(root, "ba"));
    await acknowledgeLane(root, "dev", await signOffLane(root, "sa"));
    const runtimeTask = { version: 2, plan_source: path.join(root, "_docs", "module", MODULE, "plan.md") } as unknown as RuntimeTask;
    expect(moduleOfRuntimeTask(runtimeTask)).toBe(MODULE);

    const guard = createRoleLaneStageGuard({ projectRoot: root, ledger: ledgerFor(root) });
    expect(guard(request({ runtimeTask }))).toEqual({ allowed: true });
    const unbound = guard(request());
    expect(unbound.allowed).toBe(false);
    if (!unbound.allowed) expect(unbound.reason).toMatch(/bound to no module/);
  });
});
