import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionPacketSchema, LegacyExecutionPacketSchema } from "../artifacts/schemas.js";
import { stableHash, contentHash, renderPacketText } from "../artifacts/executionPacket.js";
import { assertRuntimeTaskFresh, buildRuntimeTask } from "../orchestrator/runtimeTask.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { defaultProjectRoot } from "../agents/agentContract.js";
import { parseCanonicalPlan, renderCanonicalTasks } from "../docs/planTask.js";
import { AgentStage } from "../types.js";
import { writeExecutionPacket, readExecutionPacket, readExecutionPacketForAudit } from "../state/runtimeArtifacts.js";
import { compileExecutionPacket } from "./agentRunAssembly.js";
import { FIXTURE_REVISION, packetFixture, runtimeTaskFixture } from "./packetFixture.testSupport.js";

const roots: string[] = [];
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-packet-")); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("T-V8-004 manual-grade packet", () => {
  it.each([AgentStage.BACKEND_ENGINEER, AgentStage.QA_ENGINEER])("round-trips complete %s semantics and a golden model-visible view", stage => {
    const dir = root();
    const packet = packetFixture(dir, { stage });
    expect(ExecutionPacketSchema.parse(JSON.parse(JSON.stringify(packet)))).toEqual(packet);
    expect(packet.text).toBe(renderPacketText(packet));
    expect(packet.text).not.toMatch(/UNRELATED|routing|goal/);
    expect(packet.selected_traces.map(r => r.id)).toEqual(packet.contract.traceability);
    expect(packet.contract.objective).not.toBe(packet.contract.why);
    for (const key of ["objective", "why", "scopeAndConstraints", "doNotModify", "retrievalHints", "acceptanceCriteria", "validationAndEvidence", "compatibility"] as const) {
      expect(packet.text.split(packet.contract[key]).length - 1, key).toBe(1);
    }
    expect(packet.text.replaceAll("\\", "/").replaceAll(dir.replaceAll("\\", "/"), "<fixture>")).toMatchSnapshot();
  });

  it("requires each normative field, exact selected references, semantic/render parity and the immutable hash", () => {
    const packet = packetFixture(root());
    for (const key of Object.keys(packet.contract).filter(k => k !== "tier")) {
      const contract = { ...packet.contract } as Record<string, unknown>; delete contract[key];
      expect(ExecutionPacketSchema.safeParse({ ...packet, contract }).success, key).toBe(false);
    }
    for (const mutation of [
      { text: packet.text + "\nDifferent instructions" },
      { contract: { ...packet.contract, why: "drift" } },
      { packet_hash: "0".repeat(64) },
      { selected_traces: packet.selected_traces.slice(1) },
      { selected_traces: [...packet.selected_traces, { ...packet.selected_traces[0], id: "REQ-999" }] },
    ]) expect(ExecutionPacketSchema.safeParse({ ...packet, ...mutation }).success).toBe(false);
  });

  it("binds every resolved dependency and its exact outputs; excludes other task evidence", () => {
    const task = runtimeTaskFixture(root(), { overrides: { dependsOn: ["BE-UPSTREAM"] } });
    const input = { req: { stage: AgentStage.BACKEND_ENGINEER, taskId: task.task_id, context: [] }, role: AgentStage.BACKEND_ENGINEER, runtimeTask: task, baseRevision: FIXTURE_REVISION, contractScope: { allow: ["server/**"], deny: [".git/**"] } };
    expect(() => compileExecutionPacket(input)).toThrow(/BE-UPSTREAM.*completion\/output/);
    const evidence = { task_id: "BE-UPSTREAM", status: "complete" as const, source: "task-store:BE-UPSTREAM", hash: stableHash("completion"), outputs: [{ source: "task-store:BE-UPSTREAM/artifacts/handoff", hash: stableHash("output") }] };
    const packet = compileExecutionPacket({ ...input, dependencyEvidence: [evidence, { ...evidence, task_id: "UNRELATED", source: "UNRELATED OUTPUT SENTINEL" }] });
    expect(packet.dependencies.map(d => d.evidence)).toEqual([evidence]);
    expect(packet.text).not.toContain("UNRELATED");
    expect(packet.text).toContain(evidence.outputs[0].hash);
  });

  it("uses current-stage grants/denies and excludes every other stage's roots and restrictions", () => {
    const task = runtimeTaskFixture(root());
    task.scope.work_roots.push({ ...task.scope.work_roots[0], stage: AgentStage.QA_ENGINEER, root: "OTHER-STAGE-ROOT", allow: [{ contract_glob: "OTHER-STAGE-ALLOW", effective_glob: "OTHER-STAGE-ALLOW" }] });
    const packet = compileExecutionPacket({ req: { stage: AgentStage.BACKEND_ENGINEER, taskId: task.task_id, context: [] }, role: AgentStage.BACKEND_ENGINEER, runtimeTask: task, baseRevision: FIXTURE_REVISION, contractScope: { allow: ["server/**"], deny: [".git/**", "current-stage-deny/**"] } });
    expect(packet.scope.deny).toEqual([".git/**", "current-stage-deny/**"]);
    expect(packet.text).not.toContain("OTHER-STAGE");
    for (const glob of [...packet.scope.allow, ...packet.scope.deny]) expect(packet.text).toContain(glob);
  });

  it("is stable for repeated compilation, object key order and Status-only changes; detects semantic/artifact drift", () => {
    const dir = root(), task = runtimeTaskFixture(dir);
    const input = { req: { stage: AgentStage.BACKEND_ENGINEER, taskId: task.task_id, context: [] }, role: AgentStage.BACKEND_ENGINEER, runtimeTask: task, baseRevision: FIXTURE_REVISION, contractScope: { allow: ["server/**"], deny: [".git/**"] } };
    const before = compileExecutionPacket(input);
    expect(compileExecutionPacket(input)).toEqual(before);
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }));
    fs.writeFileSync(task.plan_source, fs.readFileSync(task.plan_source, "utf8").replace("Status: pending", "Status: verified"));
    expect(compileExecutionPacket(input)).toEqual(before);
    fs.appendFileSync(task.artifact_hashes[0].source, "\nChanged business rule");
    expect(() => compileExecutionPacket(input)).toThrow(/artifact hash drift/);
    const task2 = runtimeTaskFixture(dir);
    fs.writeFileSync(task2.plan_source, fs.readFileSync(task2.plan_source, "utf8").replace("Clients need", "Operators need"));
    expect(() => assertRuntimeTaskFresh(task2)).toThrow(/plan hash drift/);
  });

  it("persists once per attempt, is idempotent for the same bytes, and rejects same-attempt drift", () => {
    const dir = root(), packet = packetFixture(root());
    const first = writeExecutionPacket({ projectRoot: dir, packet });
    expect(writeExecutionPacket({ projectRoot: dir, packet }).path).toBe(first.path);
    const changed = { ...packet, identity: { ...packet.identity, base_revision: "b".repeat(40) } };
    const { packet_hash: _hash, ...payload } = changed;
    const drift = { ...payload, packet_hash: stableHash(payload) };
    expect(() => writeExecutionPacket({ projectRoot: dir, packet: drift })).toThrow(/immutable packet drift/);
    expect(readExecutionPacket(first.path)).toEqual(packet);
    for (const expected of [{ baseRevision: "b".repeat(40) }, { packetHash: "0".repeat(64) }, { planHash: "0".repeat(64) }, { configHash: "0".repeat(64) }, { compilerHash: "0".repeat(64) }]) expect(() => readExecutionPacket(first.path, expected)).toThrow(/drift/);
    fs.writeFileSync(first.path, JSON.stringify({ ...packet, text: packet.text + " edited" }));
    expect(() => readExecutionPacket(first.path)).toThrow(/diverges|hash drift/);
  });

  it("legacy packets are audit-only; thin plans and missing semantics never collapse to a description", () => {
    const dir = root(), text = "old packet";
    const legacy = LegacyExecutionPacketSchema.parse({ text, task_id: "T-OLD", stage: "backend-engineer", role: "backend-engineer", acceptance_criteria: [], required_verification: [], stop_conditions: [], scope: { allow: [], deny: [] }, sources: [], composition: { static_chars: text.length, handoff_chars: 0, doc_chars: 0, knowledge_chars: 0, code_intel_chars: 0, tool_output_chars: 0 }, budgetComposition: { base: text.length, task: 0, safety: 0, docs: 0, knowledge: 0, code: 0, tool_output: 0, reserve: 0 } });
    const file = path.join(dir, "old.json"); fs.writeFileSync(file, JSON.stringify(legacy));
    expect(readExecutionPacketForAudit(file)).toEqual(legacy);
    expect(() => readExecutionPacket(file)).toThrow(/audit-only/);
    const task = runtimeTaskFixture(dir);
    fs.writeFileSync(task.plan_source, "## Phase 1\n| Task | Status | Owner | Depends on |\n|---|---|---|---|\n| T-PACKET — description | pending | backend-engineer | — |\n");
    expect(() => buildRuntimeTask({ taskId: "T-PACKET", workflow: "bugfix", projectRoot: defaultProjectRoot(), docsRoot: dir, moduleName: "packet-fixture", classification: classifyTask({ isClearBugFix: true, touchesBackend: true }), taskText: "description" })).toThrow(/legacy plan.*migrateLegacyTaskTable/);
    const source = fs.readFileSync(new URL("../orchestrator/runtimeTask.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/return \{ why: input\.taskId|why: input\.taskText|extractAcceptanceCriteria\(requirementMd\)/);
  });

  it("verifies retrieval provenance, current revision and file hash without injecting a raw graph", () => {
    const dir = root(), task = runtimeTaskFixture(dir), file = path.join(dir, "orders.ts");
    fs.writeFileSync(file, "export const emptyTotal = 0;");
    const candidate = { path: file, symbol: "emptyTotal", provenance: "fixture native search + file read", revision: FIXTURE_REVISION, hash: contentHash(fs.readFileSync(file)) };
    const input = { req: { stage: AgentStage.BACKEND_ENGINEER, taskId: task.task_id, context: [] }, role: AgentStage.BACKEND_ENGINEER, runtimeTask: task, baseRevision: FIXTURE_REVISION, contractScope: { allow: ["server/**"], deny: [] } };
    expect(compileExecutionPacket({ ...input, retrievalCandidates: [candidate] }).retrieval_candidates).toEqual([candidate]);
    expect(() => compileExecutionPacket({ ...input, retrievalCandidates: [{ ...candidate, revision: "b".repeat(40) }] })).toThrow(/retrieval evidence drift/);
    fs.appendFileSync(file, "// drift");
    expect(() => compileExecutionPacket({ ...input, retrievalCandidates: [candidate] })).toThrow(/retrieval evidence drift/);
  });
});
