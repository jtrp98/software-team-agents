import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStage } from "../types.js";
import { ArtifactType } from "../artifacts/schemas.js";
import { contentHash, stableHash } from "../artifacts/executionPacket.js";
import { classifyTask } from "../classification/taskClassifier.js";
import { buildEvidence } from "../evidence/evidenceStore.js";
import { AGENT_REGISTRY } from "../agents/registry.js";
import { initTaskMachine } from "../state/taskState.js";
import { MemoryTaskStore } from "../store/memoryStore.js";
import { newPersistedTask } from "../store/taskStore.js";
import { packetFixture, runtimeTaskFixture } from "../runtime/packetFixture.testSupport.js";
import { writeExecutionPacket } from "../state/runtimeArtifacts.js";
import { verifiedArtifactProvenance, verifiedRoleAttemptProvenance } from "./artifactProvenance.js";

function fixture(stage: AgentStage, artifactType?: ArtifactType) {
  const store = new MemoryTaskStore();
  const taskId = `T-PROVENANCE-${stage}`;
  const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
  const task = newPersistedTask({ taskId, classification, machine: initTaskMachine(classification.pipeline, false), now: 1 });
  if (artifactType) task.artifacts[artifactType] = "verified bytes";
  store.createTask(task);
  const role = AGENT_REGISTRY[stage].role;
  const contractDigest = "a".repeat(64);
  const dispatch = store.appendEvidence(buildEvidence({
    taskId, stage, attempt: 1, role, subject: "dispatch", refs: [], recordedAt: 0,
    payload: { kind: "role-dispatch", idempotencyKey: `${taskId}:${stage}:1`, packetPath: ".workflow/packet.json",
      packetHash: "b".repeat(64), contractDigest, scopeDigest: "c".repeat(64), runtimeId: "test", sourceBeforeDigest: null },
  }));
  const run = store.appendEvidence(buildEvidence({
    taskId, stage, attempt: 1, role, subject: "run", refs: [dispatch.evidenceId], recordedAt: 1,
    payload: { kind: "role-run", result: "PASS", failureReason: null, runtime: "test", model: null,
      packetPath: ".workflow/packet.json", deployPhase: null, startedAt: 1, endedAt: 2, contractDigest },
  }));
  const artifact = artifactType ? store.appendEvidence(buildEvidence({
    taskId, stage, attempt: 1, role, subject: artifactType, refs: [run.evidenceId], recordedAt: 2,
    payload: { kind: "artifact", artifactType, contentDigest: contentHash("verified bytes"),
      roleAttemptId: `${taskId}:${stage}:1`, ownerRole: stage, contractDigest, sourceDigest: null,
      knowledgePath: null, location: `task-store:${taskId}/artifacts/${artifactType}`, verdict: null },
  })) : null;
  return { store, dispatch, run, artifact, taskId, contractDigest };
}

describe("role artifact provenance", () => {
  it.each([
    [AgentStage.BUSINESS_ANALYST, ArtifactType.HANDOFF, "requirement.md"],
    [AgentStage.SYSTEM_ANALYST, ArtifactType.HANDOFF, "design.md"],
    [AgentStage.REVIEWER, ArtifactType.REVIEW_REPORT, "review.md"],
    [AgentStage.QA_ENGINEER, ArtifactType.QA_REPORT, "qa.md"],
  ] as const)("verifies canonical %s artifact against pre-dispatch packet and changed Knowledge bytes", (stage, kind, doc) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-canonical-provenance-"));
    try {
      const taskId = `T-CANONICAL-${stage}`;
      const runtimeTask = runtimeTaskFixture(root, { taskId, stage });
      const packet = packetFixture(root, { taskId, stage });
      const savedPacket = writeExecutionPacket({ projectRoot: root, packet });
      const knowledgeRoot = { name: "knowledge", path: root };
      const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
      const task = newPersistedTask({ taskId, classification, machine: initTaskMachine(classification.pipeline, false),
        now: 1, runtimeTask, knowledgeRoot });
      task.artifacts[kind] = "verified bytes";
      const store = new MemoryTaskStore();
      store.createTask(task);
      const role = AGENT_REGISTRY[stage].role;
      const contractDigest = "a".repeat(64);
      const docPath = path.join(root, "_docs", "module", "packet-fixture", doc);
      const before = fs.existsSync(docPath) ? contentHash(fs.readFileSync(docPath)) : null;
      fs.writeFileSync(docPath, `authored by ${stage} in this attempt`);
      const relativeDoc = path.relative(root, docPath).replace(/\\/g, "/");
      const packetPath = path.relative(root, savedPacket.path).replace(/\\/g, "/");
      const dispatch = store.appendEvidence(buildEvidence({ taskId, stage, attempt: 1, role,
        subject: "dispatch", refs: [], recordedAt: 1,
        payload: { kind: "role-dispatch", idempotencyKey: `${taskId}:${stage}:1`, packetPath,
          packetHash: packet.packet_hash, contractDigest,
          scopeDigest: stableHash({ scope: runtimeTask.scope, knowledgeRoot, targetBindings: task.targetBindings }),
          runtimeId: "test", sourceBeforeDigest: before },
      }));
      const run = store.appendEvidence(buildEvidence({ taskId, stage, attempt: 1, role, subject: "run",
        refs: [dispatch.evidenceId], recordedAt: 2,
        payload: { kind: "role-run", result: "PASS", failureReason: null, runtime: "test", model: null,
          packetPath, deployPhase: null, startedAt: 1, endedAt: 2, contractDigest },
      }));
      const artifact = store.appendEvidence(buildEvidence({ taskId, stage, attempt: 1, role, subject: kind,
        refs: [run.evidenceId], recordedAt: 3,
        payload: { kind: "artifact", artifactType: kind, contentDigest: contentHash("verified bytes"),
          roleAttemptId: `${taskId}:${stage}:1`, ownerRole: stage, contractDigest,
          sourceDigest: contentHash(fs.readFileSync(docPath)), knowledgePath: relativeDoc,
          location: `task-store:${taskId}/artifacts/${kind}`, verdict: null },
      }));
      expect(verifiedArtifactProvenance(store, artifact.evidenceId)).toMatchObject({
        stage, attempt: 1, role, dispatchEvidenceId: dispatch.evidenceId, roleRunEvidenceId: run.evidenceId,
        knowledgePath: relativeDoc,
      });
      fs.writeFileSync(savedPacket.path, "{}");
      expect(() => verifiedArtifactProvenance(store, artifact.evidenceId)).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    [AgentStage.BUSINESS_ANALYST, ArtifactType.HANDOFF],
    [AgentStage.SYSTEM_ANALYST, ArtifactType.HANDOFF],
    [AgentStage.REVIEWER, ArtifactType.REVIEW_REPORT],
    [AgentStage.QA_ENGINEER, ArtifactType.QA_REPORT],
  ] as const)("queries %s artifact with role, attempt, contract and content digest", (stage, kind) => {
    const { store, artifact, dispatch, run, contractDigest } = fixture(stage, kind);
    const provenance = verifiedArtifactProvenance(store, artifact!.evidenceId);
    expect(provenance).toMatchObject({ stage, role: AGENT_REGISTRY[stage].role, attempt: 1,
      contractDigest, contentDigest: contentHash("verified bytes"), dispatchEvidenceId: dispatch.evidenceId,
      roleRunEvidenceId: run.evidenceId });
  });

  it("queries an Engineer implementation attempt from its dispatch evidence", () => {
    const { store, run } = fixture(AgentStage.BACKEND_ENGINEER);
    expect(verifiedRoleAttemptProvenance(store, run.evidenceId)).toMatchObject({ stage: AgentStage.BACKEND_ENGINEER, attempt: 1 });
  });

  it("refuses a role run without pre-dispatch evidence even on a legacy task row", () => {
    const { store, run, taskId } = fixture(AgentStage.BACKEND_ENGINEER);
    const forged = store.appendEvidence(buildEvidence({ taskId, stage: AgentStage.BACKEND_ENGINEER,
      attempt: 1, role: AGENT_REGISTRY[AgentStage.BACKEND_ENGINEER].role, subject: "run-without-dispatch",
      refs: [], recordedAt: 3, payload: run.payload }));
    expect(() => verifiedRoleAttemptProvenance(store, forged.evidenceId)).toThrow(/no pre-dispatch evidence/);
  });

  it("rejects unregistered artifact, wrong role, forged attempt and altered bytes", () => {
    const { store, artifact, taskId } = fixture(AgentStage.BUSINESS_ANALYST, ArtifactType.HANDOFF);
    const original = artifact!;
    const append = (subject: string, changes: Record<string, unknown>) => store.appendEvidence(buildEvidence({
      taskId, stage: AgentStage.BUSINESS_ANALYST, attempt: 1, role: AGENT_REGISTRY[AgentStage.BUSINESS_ANALYST].role,
      subject, refs: original.refs, recordedAt: 3,
      payload: { ...original.payload, ...changes } as typeof original.payload,
    }));
    const wrong = append("wrong-owner", { ownerRole: AgentStage.QA_ENGINEER });
    expect(() => verifiedArtifactProvenance(store, wrong.evidenceId)).toThrow(/forged role/);
    const forged = append("wrong-attempt", { roleAttemptId: "T-OTHER:business-analyst:1" });
    expect(() => verifiedArtifactProvenance(store, forged.evidenceId)).toThrow(/forged role/);
    const unregistered = append("unregistered", { artifactType: ArtifactType.QA_REPORT });
    expect(() => verifiedArtifactProvenance(store, unregistered.evidenceId)).toThrow(/not registered/);
    const task = store.loadTask(taskId)!;
    task.artifacts[ArtifactType.HANDOFF] = "tampered";
    store.saveTask(task);
    expect(() => verifiedArtifactProvenance(store, original.evidenceId)).toThrow(/does not match persisted artifact bytes/);
  });

  it("checks the current Knowledge document bytes against the committed source digest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-artifact-source-"));
    try {
      const { store, artifact, taskId } = fixture(AgentStage.BUSINESS_ANALYST, ArtifactType.HANDOFF);
      const relative = "_docs/module/sales/requirement.md";
      const docPath = path.join(root, relative);
      fs.mkdirSync(path.dirname(docPath), { recursive: true });
      fs.writeFileSync(docPath, "approved source bytes");
      const task = store.loadTask(taskId)!;
      task.knowledgeRoot = { name: "knowledge", path: root };
      store.saveTask(task);
      if (artifact!.payload.kind !== "artifact") throw new Error("fixture did not create an artifact");
      const sourced = store.appendEvidence(buildEvidence({
        taskId, stage: AgentStage.BUSINESS_ANALYST, attempt: 1,
        role: AGENT_REGISTRY[AgentStage.BUSINESS_ANALYST].role, subject: "sourced-handoff",
        refs: artifact!.refs, recordedAt: 3,
        payload: { ...artifact!.payload, knowledgePath: relative, sourceDigest: contentHash("approved source bytes") },
      }));
      expect(verifiedArtifactProvenance(store, sourced.evidenceId).knowledgePath).toBe(relative);
      fs.writeFileSync(docPath, "changed after commit");
      expect(() => verifiedArtifactProvenance(store, sourced.evidenceId)).toThrow(/bytes changed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
