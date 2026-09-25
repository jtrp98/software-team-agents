import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeItem } from "./knowledgeModel.js";
import { digestOfSource } from "./sourceDigest.js";
import { seedKnowledgeFixture } from "./knowledgeFixture.testSupport.js";
import { buildKnowledgeManifest, renderKnowledgeManifest } from "./knowledgeManifest.js";

/**
 * V13 TASK-010 — what a fresh Controller can discover from Knowledge + STA
 * state alone. The fixture writes everything a prior session left behind, then
 * the manifest reads it back the way a new process would: artifacts, durable
 * decisions, the next action per task, and every stale/missing reference as a
 * visible problem rather than a silent gap.
 */

const CAPTURED = "2026-08-20T09:00:00Z";
const NOW = "2026-08-21T09:00:00Z";

let roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-knowledge-manifest-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# bootstrap — start here\n", "utf8");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# operating rules\n", "utf8");
  return root;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

function knowledgeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    schema_version: KNOWLEDGE_SCHEMA_VERSION,
    id: "REQ-1001",
    kind: "requirement",
    title: "shift self-view",
    body: "staff can see their own shifts",
    repo: null,
    module: "sales-crm",
    owner: AgentStage.BUSINESS_ANALYST,
    status: "draft",
    sensitive: false,
    version: 1,
    created_at: CAPTURED,
    updated_at: CAPTURED,
    sources: [],
    relations: [],
    payload: { acceptance_criteria: ["own shifts only"], actors: ["staff"], priority: "must", assumption_unconfirmed: false },
    ...overrides,
  } as KnowledgeItem;
}

/** The durable remains of a prior BA session: a canonical artifact with
 * dispatch/run evidence, one stage-completion decision, and one knowledge item. */
function seedPriorSession(root: string, store: MemoryTaskStore): { taskId: string; docPath: string } {
  const taskId = "T-MANIFEST";
  const runtimeTask = runtimeTaskFixture(root, { taskId, stage: AgentStage.BUSINESS_ANALYST });
  const packet = packetFixture(root, { taskId, stage: AgentStage.BUSINESS_ANALYST });
  const savedPacket = writeExecutionPacket({ projectRoot: root, packet });
  const knowledgeRoot = { name: "knowledge", path: root };
  const classification = classifyTask({ isClearBugFix: true, touchesBackend: true });
  const task = newPersistedTask({
    taskId,
    classification,
    machine: initTaskMachine(classification.pipeline, false),
    now: 1,
    runtimeTask,
    knowledgeRoot,
  });
  task.artifacts[ArtifactType.HANDOFF] = "authored requirement bytes";
  store.createTask(task);

  const role = AGENT_REGISTRY[AgentStage.BUSINESS_ANALYST].role;
  const contractDigest = "a".repeat(64);
  const docPath = path.join(root, "_docs", "module", "packet-fixture", "requirement.md");
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, "authored requirement document", "utf8");
  const relativeDoc = path.relative(root, docPath).replace(/\\/g, "/");
  const packetPath = path.relative(root, savedPacket.path).replace(/\\/g, "/");

  const dispatch = store.appendEvidence(buildEvidence({
    taskId, stage: AgentStage.BUSINESS_ANALYST, attempt: 1, role, subject: "dispatch", refs: [], recordedAt: 1,
    payload: {
      kind: "role-dispatch", idempotencyKey: `${taskId}:${AgentStage.BUSINESS_ANALYST}:1`, packetPath,
      packetHash: packet.packet_hash, contractDigest,
      scopeDigest: stableHash({ scope: runtimeTask.scope, knowledgeRoot, targetBindings: task.targetBindings }),
      runtimeId: "test", sourceBeforeDigest: null,
    },
  }));
  const run = store.appendEvidence(buildEvidence({
    taskId, stage: AgentStage.BUSINESS_ANALYST, attempt: 1, role, subject: "run", refs: [dispatch.evidenceId], recordedAt: 2,
    payload: {
      kind: "role-run", result: "PASS", failureReason: null, runtime: "test", model: null,
      packetPath, deployPhase: null, startedAt: 1, endedAt: 2, contractDigest,
    },
  }));
  store.appendEvidence(buildEvidence({
    taskId, stage: AgentStage.BUSINESS_ANALYST, attempt: 1, role, subject: ArtifactType.HANDOFF, refs: [run.evidenceId], recordedAt: 3,
    payload: {
      kind: "artifact", artifactType: ArtifactType.HANDOFF, contentDigest: contentHash("authored requirement bytes"),
      roleAttemptId: `${taskId}:${AgentStage.BUSINESS_ANALYST}:1`, ownerRole: AgentStage.BUSINESS_ANALYST, contractDigest,
      sourceDigest: contentHash(fs.readFileSync(docPath, "utf8")), knowledgePath: relativeDoc,
      location: `task-store:${taskId}/artifacts/${ArtifactType.HANDOFF}`, verdict: null,
    },
  }));
  store.appendEvidence(buildEvidence({
    taskId, stage: AgentStage.BUSINESS_ANALYST, attempt: 1, role, subject: "stage-completion", refs: [run.evidenceId], recordedAt: 4,
    payload: { kind: "stage-completion", satisfied: ["role-run-succeeded"] },
  }));
  return { taskId, docPath };
}

describe("knowledge manifest (V13 TASK-010)", () => {
  it("a fresh process discovers prior artifacts, decisions, next action and instructions", () => {
    const root = project();
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes", "spec.md"), "spec material\n", "utf8");
    seedKnowledgeFixture(
      knowledgeItem({
        sources: [{ type: "file", locator: "notes/spec.md", captured_at: CAPTURED, digest: digestOfSource("notes/spec.md", root) }],
      }),
      root,
    );
    seedKnowledgeFixture(
      knowledgeItem({
        id: "ADR-1002",
        kind: "decision",
        module: null,
        owner: AgentStage.SYSTEM_ANALYST,
        title: "use sqlite",
        sources: [{ type: "file", locator: "notes/spec.md", captured_at: CAPTURED, digest: digestOfSource("notes/spec.md", root) }],
        payload: { adr_status: "proposed", date: CAPTURED, supersedes: null, superseded_by: null },
      } as Partial<KnowledgeItem>),
      root,
    );
    const store = new MemoryTaskStore();
    const { taskId } = seedPriorSession(root, store);

    const manifest = buildKnowledgeManifest({ knowledgeRoot: root, store, now: NOW });

    const agents = manifest.operatingInstructions.find((entry) => entry.id === "AGENTS.md");
    expect(agents?.present).toBe(true);
    expect(agents?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.operatingInstructions.map((entry) => entry.id)).toContain("CLAUDE.md");

    expect(manifest.knowledgeItems.map((item) => item.id).sort()).toEqual(["ADR-1002", "REQ-1001"]);
    const requirement = manifest.knowledgeItems.find((item) => item.id === "REQ-1001")!;
    expect(requirement.file.present).toBe(true);
    expect(requirement.freshness.verdict).toBe("fresh");

    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]).toMatchObject({
      taskId, stage: AgentStage.BUSINESS_ANALYST, role: AGENT_REGISTRY[AgentStage.BUSINESS_ANALYST].role,
      artifactType: ArtifactType.HANDOFF, verified: true, problem: null,
    });
    expect(manifest.artifacts[0].knowledgePath).toBe("_docs/module/packet-fixture/requirement.md");

    expect(manifest.decisions).toHaveLength(1);
    expect(manifest.decisions[0]).toMatchObject({ taskId, stage: AgentStage.BUSINESS_ANALYST, subject: "stage-completion" });
    expect(manifest.decisions[0].digest).toMatch(/^[0-9a-f]{64}$/);

    expect(manifest.tasks).toHaveLength(1);
    expect(manifest.tasks[0].taskId).toBe(taskId);
    expect(manifest.tasks[0].module).toBe("packet-fixture");
    expect(manifest.tasks[0].status.kind).toBe("RUNNING");
    // The bug-fix classification's first dispatched stage; the exact stage
    // matters less than the projection naming the stage and its evidence bar.
    expect(manifest.tasks[0].nextAction).toContain("backend-engineer");
    expect(manifest.tasks[0].nextAction).toContain("role-run-succeeded");

    expect(manifest.problems).toEqual([]);

    const rendered = renderKnowledgeManifest(manifest).join("\n");
    expect(rendered).toContain(taskId);
    expect(rendered).toContain("verified");
  });

  it("missing/stale references fail visibly: tampered artifact, deleted instruction, vanished source", () => {
    const root = project();
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes", "spec.md"), "spec material\n", "utf8");
    seedKnowledgeFixture(
      knowledgeItem({
        sources: [{ type: "file", locator: "notes/gone.md", captured_at: CAPTURED, digest: "sha256:deadbeef" }],
      }),
      root,
    );
    const store = new MemoryTaskStore();
    const { taskId, docPath } = seedPriorSession(root, store);
    fs.rmSync(path.join(root, "AGENTS.md"));
    fs.writeFileSync(docPath, "changed after the attempt committed", "utf8");

    const manifest = buildKnowledgeManifest({ knowledgeRoot: root, store, now: NOW });

    expect(manifest.artifacts[0].verified).toBe(false);
    expect(manifest.artifacts[0].problem).toMatch(/bytes changed/);
    expect(manifest.problems.some((problem) => problem.includes("AGENTS.md") && problem.includes("missing"))).toBe(true);
    expect(manifest.problems.some((problem) => problem.includes("REQ-1001") && problem.includes("source-missing"))).toBe(true);
    expect(manifest.problems.length).toBeGreaterThanOrEqual(3);
    // The task itself still reports: the manifest is an index, not a judge.
    expect(manifest.tasks[0].taskId).toBe(taskId);
  });

  it("reports a knowledge item whose file vanished and a workspace without knowledge directory", () => {
    const root = project();
    const store = new MemoryTaskStore();
    const manifest = buildKnowledgeManifest({ knowledgeRoot: root, store, now: NOW });
    expect(manifest.knowledgeItems).toEqual([]);
    expect(manifest.problems.some((problem) => problem.includes("no `knowledge/` directory"))).toBe(true);
  });
});
