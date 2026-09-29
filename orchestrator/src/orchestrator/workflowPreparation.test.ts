/** Deterministic regression tests, not real executor certification. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { defaultProjectRoot, resolveAuthoritativeContract } from "../agents/agentContract.js";
import { pathRulesFor } from "../agents/pathPermissions.js";
import { deriveHandoff } from "../agents/moduleDocs.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { contentHash } from "../artifacts/executionPacket.js";
import { fixtureTask, FIXTURE_REVISION, writePacketPlan } from "../runtime/packetFixture.testSupport.js";
import { compileExecutionPacket } from "../runtime/agentRunAssembly.js";
import { writeExecutionPacket } from "../state/runtimeArtifacts.js";
import { SqliteTaskStore } from "../store/sqliteStore.js";
import { verifiedArtifactProvenance } from "../knowledge/artifactProvenance.js";
import { decidePending, testHumanVerifier } from "../gates/humanDecision.testSupport.js";
import { ALLOW_EVERY_STAGE_TEST_GUARD } from "./stageGuards.testSupport.js";
import { TaskRegistry } from "./taskRegistry.js";
import { acceptWorkflowDocument, assertRuntimeTaskFresh, buildRuntimeTask, type RuntimeTask } from "./runtimeTask.js";
import type { Orchestrator } from "./orchestrator.js";

const roots: string[] = [];
const stores: SqliteTaskStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const input = { isNewFeatureModuleOrProject: true, touchesBackend: true };
const classification = classifyTask(input);
const taskId = "BE-BOOTSTRAP";
const moduleName = "orders";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-workflow-preparation-")); roots.push(root);
  const target = path.join(root, "target");
  const donor = path.join(root, "fixture-docs");
  writePacketPlan(donor, [fixtureTask({ id: taskId, tier: undefined })], moduleName, target);
  const donorDir = path.join(donor, "_docs", "module", moduleName);
  const read = (name: string) => fs.readFileSync(path.join(donorDir, name), "utf8");
  const headers = (titles: string[]) => titles.map(title => `\n## ${title}\nTest fixture.\n`).join("");
  const docs = {
    "requirement.md": read("requirement.md") + headers(["Overview", "Target Users & Roles", "Core Features", "Scope", "Constraints & Assumptions", "Open Questions", "Declined / Not Pursuing", "References", "Change Log"]),
    "design.md": read("design.md") + "\n## Targets\n- product\n" + headers(["Feasibility Summary", "Feature-by-Feature Feasibility", "Data Model", "Risks & Dependencies", "Unresolved Open Questions", "Change Log"]),
    "plan.md": read("plan.md") + headers(["Plan Summary", "Sequencing Notes", "Unresolved Open Questions", "Change Log"]),
  };
  const knowledge = path.join(root, "knowledge");
  const dir = path.join(knowledge, "_docs", "module", moduleName); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "requirement.md"), docs["requirement.md"] + "\nInitial Human input.\n");
  const args = { taskId, moduleName, projectRoot: defaultProjectRoot(), docsRoot: knowledge, classification, classificationInput: input,
    workflow: "feature", taskText: "Implement the fixture order rule.", knowledgeRoot: { name: "test-knowledge", path: knowledge },
    targetWorkRoots: [{ stage: AgentStage.BACKEND_ENGINEER, targetId: "product", path: target, access: "write" as const }],
  };
  let store = new SqliteTaskStore(path.join(root, "state.db")); stores.push(store);
  const registry = () => new TaskRegistry({ store, now: () => 10, contractRoot: defaultProjectRoot(), stageEntryGuard: ALLOW_EVERY_STAGE_TEST_GUARD, humanDecisionVerifier: testHumanVerifier() });
  const restart = () => { stores.splice(stores.indexOf(store), 1); store.close(); store = new SqliteTaskStore(path.join(root, "state.db")); stores.push(store); return registry().open(taskId); };
  return { root, target, knowledge, dir, docs, args, get store() { return store; }, registry, restart, task: buildRuntimeTask(args)! };
}

function packet(task: RuntimeTask, stage: AgentStage) {
  const rules = pathRulesFor(stage, defaultProjectRoot());
  const contract = resolveAuthoritativeContract(stage, defaultProjectRoot());
  return compileExecutionPacket({ req: { taskId, stage, context: [] }, role: stage, runtimeTask: task,
    contractScope: { allow: rules.write, deny: rules.deny }, baseRevision: FIXTURE_REVISION,
    authoritativeContract: contract.contract, contractDigest: contract.digest });
}

async function dispatch(f: ReturnType<typeof fixture>, orch: Orchestrator, stage: AgentStage) {
  const compiled = packet(orch.runtimeTask!, stage);
  const saved = writeExecutionPacket({ projectRoot: f.knowledge, packet: compiled });
  const packetPath = path.relative(f.knowledge, saved.path).replaceAll("\\", "/");
  const contractDigest = resolveAuthoritativeContract(stage, defaultProjectRoot()).digest;
  const key = `${taskId}:${stage}:1`;
  const interrupted = new Error("test fixture: process stopped after durable dispatch");
  try {
    await orch.step(req => {
      expect(req.stage).toBe(stage);
      req.recordDispatch!({ packetPath, packetHash: compiled.packet_hash, contractDigest, runtimeId: "regression-fixture" });
      throw interrupted;
    });
    throw new Error("stage was not dispatched");
  } catch (error) { if (error !== interrupted) throw error; }
  return { packetPath, contractDigest, key };
}

async function complete(f: ReturnType<typeof fixture>, orch: Orchestrator, stage: AgentStage, file: keyof ReturnType<typeof fixture>["docs"]) {
  const sent = await dispatch(f, orch, stage);
  fs.writeFileSync(path.join(f.dir, file), f.docs[file]);
  const handoff = deriveHandoff(stage, moduleName, f.docs[file], file === "plan.md" ? f.docs[file] : undefined, { taskId });
  return orch.reportCompletion(stage, { outcome: { result: "PASS", tokens: 1, cost: 0, runtime: "regression-fixture", contract_digest: sent.contractDigest },
    packetPath: sent.packetPath, artifactType: ArtifactType.HANDOFF, artifact: handoff.artifact,
    sourceArtifact: { path: `_docs/module/${moduleName}/${file}` },
  }, { start: 1, end: 2 }, sent.key);
}

describe("canonical workflow preparation", () => {
  it("compiles BA from Human input without inventing a plan or granting Product writes", () => {
    const f = fixture();
    expect(f.task.contract.version).toBe("workflow-1");
    const compiled = packet(f.task, AgentStage.BUSINESS_ANALYST);
    expect(compiled.scope.roots).toEqual([]);
    expect(compiled.scope.allow).toContain("_docs/module/*/requirement.md");
    expect(compiled.scope.allow.some(glob => glob.startsWith("src/"))).toBe(false);
    expect(fs.existsSync(f.task.plan_source)).toBe(false);
    expect(() => packet(f.task, AgentStage.SYSTEM_ANALYST)).toThrow(/next unaccepted/);
    expect(() => packet(f.task, AgentStage.BACKEND_ENGINEER)).toThrow(/next unaccepted/);
    expect(buildRuntimeTask({ ...f.args, taskText: undefined })!.contract.objective).toContain(contentHash(fs.readFileSync(path.join(f.dir, "requirement.md"))));
    const malicious = compileExecutionPacket({ req: { taskId, stage: AgentStage.BUSINESS_ANALYST, context: [] }, role: AgentStage.BUSINESS_ANALYST, runtimeTask: f.task,
      contractScope: { allow: ["src/**", "_docs/module/*/requirement.md"], deny: [] }, baseRevision: FIXTURE_REVISION });
    expect(malicious.scope.allow).toEqual(["_docs/module/*/requirement.md"]);
  });

  it("refuses drift and unsolicited future documents before dispatch", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, "design.md"), "unsolicited design");
    expect(() => packet(f.task, AgentStage.BUSINESS_ANALYST)).toThrow(/outside an accepted/);
    fs.unlinkSync(path.join(f.dir, "design.md"));
    fs.appendFileSync(path.join(f.dir, "requirement.md"), "unsolicited change");
    expect(() => packet(f.task, AgentStage.BUSINESS_ANALYST)).toThrow(/artifact hash drift/);
  });

  it("atomically accepts BA/SA/PM with SQLite restart, preserves historical artifacts, then compiles Engineer", async () => {
    const f = fixture();
    let orch = f.registry().create(f.args);
    expect(f.registry().open(taskId).runtimeTask!.contract.version).toBe("workflow-1");
    expect(orch.status()).toMatchObject({ kind: "RUNNING", stage: AgentStage.BUSINESS_ANALYST });
    expect((await complete(f, orch, AgentStage.BUSINESS_ANALYST, "requirement.md")).kind).toBe("WAITING_FOR_HUMAN");
    const ba = orch.runtimeTask!.workflow_origin!.accepted[0];
    const baHash = orch.runtimeTask!.plan_hash;
    orch = f.restart();
    expect(orch.status().kind).toBe("WAITING_FOR_HUMAN");
    await decidePending(orch, true); // Test channel only, never UAT evidence.
    expect((await complete(f, orch, AgentStage.SYSTEM_ANALYST, "design.md")).kind).toBe("WAITING_FOR_HUMAN");
    expect(orch.runtimeTask!.plan_hash).not.toBe(baHash);
    expect(verifiedArtifactProvenance(f.store, ba.evidence_id).stage).toBe(AgentStage.BUSINESS_ANALYST);
    orch = f.restart();
    await decidePending(orch, true);
    await complete(f, orch, AgentStage.PROJECT_MANAGER, "plan.md");
    orch = f.restart();
    expect(orch.runtimeTask!.contract.version).toBe(1);
    expect(orch.runtimeTask!.workflow_origin!.accepted.map(x => x.stage)).toEqual([AgentStage.BUSINESS_ANALYST, AgentStage.SYSTEM_ANALYST, AgentStage.PROJECT_MANAGER]);
    expect(() => assertRuntimeTaskFresh(orch.runtimeTask!)).not.toThrow();
    expect(packet(orch.runtimeTask!, AgentStage.BACKEND_ENGINEER).scope.roots).toEqual([f.target]);
    expect(verifiedArtifactProvenance(f.store, ba.evidence_id).sourceDigest).toBe(ba.hash);
  });

  it("refuses an executor's PASS and rolls back state when its changed BA file fails document validation", async () => {
    const f = fixture(); const orch = f.registry().create(f.args); orch.status();
    const sent = await dispatch(f, orch, AgentStage.BUSINESS_ANALYST);
    const before = orch.snapshot(); const count = f.store.evidenceForTask(taskId).length;
    fs.writeFileSync(path.join(f.dir, "requirement.md"), "invalid document");
    const handoff = deriveHandoff(AgentStage.BUSINESS_ANALYST, moduleName, "invalid document", undefined, { taskId });
    expect(() => orch.reportCompletion(AgentStage.BUSINESS_ANALYST, { outcome: { result: "PASS", tokens: 0, cost: 0, runtime: "regression-fixture", contract_digest: sent.contractDigest, document_gate: "enabled" }, packetPath: sent.packetPath,
      artifactType: ArtifactType.HANDOFF, artifact: handoff.artifact, sourceArtifact: { path: `_docs/module/${moduleName}/requirement.md` },
    }, { start: 1, end: 2 }, sent.key)).toThrow(/document verification failed/);
    expect(orch.snapshot()).toEqual(before);
    expect(f.store.evidenceForTask(taskId)).toHaveLength(count);
  });

  it("refuses other input mutations during an owned output transition", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, "requirement.md"), f.docs["requirement.md"]);
    fs.writeFileSync(path.join(f.dir, "plan.md"), f.docs["plan.md"]);
    expect(() => acceptWorkflowDocument(f.task, AgentStage.BUSINESS_ANALYST, { source: path.join(f.dir, "requirement.md"), hash: contentHash(f.docs["requirement.md"]), evidence_id: "fixture-only" }, classification)).toThrow(/outside an accepted/);
  });

  it("refuses SA completion when design omits the frozen Product binding", async () => {
    const f = fixture(); const orch = f.registry().create(f.args);
    await complete(f, orch, AgentStage.BUSINESS_ANALYST, "requirement.md");
    await decidePending(orch, true);
    f.docs["design.md"] = f.docs["design.md"].replace("\n## Targets\n- product\n", "\n## Targets\n- another-product\n");
    await expect(complete(f, orch, AgentStage.SYSTEM_ANALYST, "design.md")).rejects.toThrow(/SA design must declare the frozen Target/);
    expect(orch.runtimeTask!.workflow_origin!.accepted.map(output => output.stage)).toEqual([AgentStage.BUSINESS_ANALYST]);
    expect(f.restart().runtimeTask!.contract.version).toBe("workflow-1");
  });

  it("refuses a tampered predecessor artifact before recording the next dispatch", async () => {
    const f = fixture(); const orch = f.registry().create(f.args);
    await complete(f, orch, AgentStage.BUSINESS_ANALYST, "requirement.md");
    await decidePending(orch, true);
    const stored = f.store.loadTask(taskId)!;
    stored.artifacts[`${AgentStage.BUSINESS_ANALYST}/1/${ArtifactType.HANDOFF}`] = "forged artifact";
    f.store.saveTask(stored);
    const before = f.store.evidenceForTask(taskId).length;
    await expect(dispatch(f, f.restart(), AgentStage.SYSTEM_ANALYST)).rejects.toThrow(/persisted artifact bytes/);
    expect(f.store.evidenceForTask(taskId)).toHaveLength(before);
  });

  it("keeps the pre-plan contract and cursor when PM omits the current task", async () => {
    const f = fixture(); let orch = f.registry().create(f.args);
    await complete(f, orch, AgentStage.BUSINESS_ANALYST, "requirement.md"); await decidePending(orch, true);
    await complete(f, orch, AgentStage.SYSTEM_ANALYST, "design.md"); await decidePending(orch, true);
    const before = orch.runtimeTask;
    f.docs["plan.md"] = f.docs["plan.md"].replaceAll(taskId, "BE-OTHER");
    await expect(complete(f, orch, AgentStage.PROJECT_MANAGER, "plan.md")).rejects.toThrow(/this task's canonical PlanTask/);
    orch = f.restart();
    expect(orch.runtimeTask).toEqual(before);
    expect(orch.snapshot().pipelineCursor).toBe(2);
  });
});
