import { packetFixture } from "../runtime/packetFixture.testSupport.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPacketStorageOwnership,
  DEFAULT_RUNTIME_ARTIFACT_RETENTION,
  latestExecutionPacketPath,
  pruneRuntimeArtifacts,
  readExecutionPacket,
  readFindingRecord,
  readFindingsForTask,
  readRepairPacket,
  runtimeArtifactPaths,
  writeExecutionPacket,
  writeFinding,
  writeRepairPacket,
} from "./runtimeArtifacts.js";
import { AgentStage } from "../types.js";
import type { ExecutionPacket } from "../artifacts/schemas.js";
import { compileRepairPacket, deriveFinding, type Finding } from "../artifacts/finding.js";
import type { StructuredFailure } from "../orchestrator/failure.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-runtime-artifacts-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

let packetSourceRoot: string | undefined;
function packet(attempt = 1): ExecutionPacket {
  if (!packetSourceRoot || !fs.existsSync(packetSourceRoot)) packetSourceRoot = tempRoot();
  return packetFixture(packetSourceRoot, { attempt });
}

describe("T-V3R-003 runtime artifact contract", () => {
  it("declares packet, evidence and run homes below .workflow and creates none eagerly", () => {
    const root = tempRoot();
    const paths = runtimeArtifactPaths(root, "T-V3R-003");
    expect(paths).toEqual({
      packets: path.join(root, ".workflow", "packets", "T-V3R-003"),
      evidence: path.join(root, ".workflow", "evidence", "T-V3R-003"),
      runs: path.join(root, ".workflow", "runs", "T-V3R-003"),
      findings: path.join(root, ".workflow", "findings", "T-V3R-003"),
      repairPackets: path.join(root, ".workflow", "repair-packets", "T-V3R-003"),
    });
    expect(fs.existsSync(path.join(root, ".workflow"))).toBe(false);
  });

  it("T-V7-031 blocks path traversal from an id-derived runtime artifact path", () => {
    const root = tempRoot();
    const resolved = runtimeArtifactPaths(root, "../outside").packets;
    expect(path.relative(path.join(root, ".workflow", "packets"), resolved)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(resolved).toContain("..%2Foutside");
  });

  it("bounds growth deterministically while never pruning the current run artifact", () => {
    const root = tempRoot();
    const taskDirectory = runtimeArtifactPaths(root, "T-RETENTION").packets;
    fs.mkdirSync(taskDirectory, { recursive: true });
    const names = Array.from({ length: DEFAULT_RUNTIME_ARTIFACT_RETENTION + 2 }, (_, index) => `${String(index).padStart(2, "0")}.json`);
    for (const [index, name] of names.entries()) {
      const file = path.join(taskDirectory, name);
      fs.writeFileSync(file, name, "utf8");
      const time = new Date(1_000 + index * 1_000);
      fs.utimesSync(file, time, time);
    }
    const current = path.join(taskDirectory, names[0]); // deliberately oldest

    const removed = pruneRuntimeArtifacts({ taskDirectory, currentArtifact: current });
    const remaining = fs.readdirSync(taskDirectory).sort();
    expect(remaining).toHaveLength(DEFAULT_RUNTIME_ARTIFACT_RETENTION);
    expect(remaining).toContain(names[0]);
    expect(removed.map((file) => path.basename(file))).toEqual([names[1], names[2]]);
    expect(pruneRuntimeArtifacts({ taskDirectory, currentArtifact: current })).toEqual([]);
  });

  it("refuses an invalid bound or a current artifact outside the task directory before deleting anything", () => {
    const root = tempRoot();
    const taskDirectory = runtimeArtifactPaths(root, "T-SAFE").evidence;
    fs.mkdirSync(taskDirectory, { recursive: true });
    const current = path.join(taskDirectory, "current.json");
    fs.writeFileSync(current, "current", "utf8");
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, "outside", "utf8");

    expect(() => pruneRuntimeArtifacts({ taskDirectory, currentArtifact: current, maxRunsPerTask: 0 })).toThrow(/positive integer/);
    expect(() => pruneRuntimeArtifacts({ taskDirectory, currentArtifact: outside })).toThrow(/direct child/);
    expect(fs.readFileSync(current, "utf8")).toBe("current");
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it("never follows a symlink presented as the current artifact", () => {
    const root = tempRoot();
    const taskDirectory = runtimeArtifactPaths(root, "T-SYMLINK").runs;
    fs.mkdirSync(taskDirectory, { recursive: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sentinel.json"), "outside", "utf8");
    const linked = path.join(taskDirectory, "current.json");
    fs.symlinkSync(outside, linked, "junction");

    expect(() => pruneRuntimeArtifacts({ taskDirectory, currentArtifact: linked, maxRunsPerTask: 1 })).toThrow(/not a file/);
    expect(fs.readFileSync(path.join(outside, "sentinel.json"), "utf8")).toBe("outside");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
  });
});

describe("T-V3R-021 execution packet persistence", () => {
  it("round-trips through JSON and the public artifact schema", () => {
    const framework = tempRoot();
    const knowledge = tempRoot();
    const target = tempRoot();
    const written = writeExecutionPacket({
      projectRoot: framework,
      packet: packet(),
      forbiddenRoots: [knowledge, target],
    });

    expect(written.attempt).toBe(1);
    expect(written.path).toBe(path.join(framework, ".workflow", "packets", "T-PACKET", "backend-engineer-1.json"));
    expect(readExecutionPacket(written.path)).toEqual(packet());
    expect(latestExecutionPacketPath(framework, "T-PACKET", AgentStage.BACKEND_ENGINEER)).toBe(written.path);
  });

  it("refuses Knowledge or Target ownership before creating packet storage", () => {
    const knowledge = tempRoot();
    const target = tempRoot();
    const knowledgePacket = runtimeArtifactPaths(knowledge, "T-PACKET").packets;
    const targetPacket = runtimeArtifactPaths(target, "T-PACKET").packets;

    expect(() => writeExecutionPacket({ projectRoot: knowledge, packet: packet(), forbiddenRoots: [knowledge, target] })).toThrow(/Local Runtime State/);
    expect(() => writeExecutionPacket({ projectRoot: target, packet: packet(), forbiddenRoots: [knowledge, target] })).toThrow(/Local Runtime State/);
    expect(fs.existsSync(knowledgePacket)).toBe(false);
    expect(fs.existsSync(targetPacket)).toBe(false);
  });

  it("uses physical paths so a .workflow junction cannot redirect packets into a Target", () => {
    const framework = tempRoot();
    const target = tempRoot();
    fs.symlinkSync(target, path.join(framework, ".workflow"), "junction");

    expect(() => writeExecutionPacket({ projectRoot: framework, packet: packet(), forbiddenRoots: [target] })).toThrow(/escapes Local Runtime State root|resolves inside/);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("refuses a .workflow junction that escapes the Framework even when it is not a declared Target", () => {
    const framework = tempRoot();
    const outside = tempRoot();
    fs.symlinkSync(outside, path.join(framework, ".workflow"), "junction");

    expect(() => writeExecutionPacket({ projectRoot: framework, packet: packet() })).toThrow(/escapes Local Runtime State root/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("retains the current attempt while enforcing the per-task bound", () => {
    const framework = tempRoot();
    for (let attempt = 1; attempt <= 3; attempt++) {
      writeExecutionPacket({ projectRoot: framework, packet: packet(attempt), maxRunsPerTask: 2 });
    }
    const directory = runtimeArtifactPaths(framework, "T-PACKET").packets;
    expect(fs.readdirSync(directory).sort()).toEqual(["backend-engineer-2.json", "backend-engineer-3.json"]);
    expect(readExecutionPacket(path.join(directory, "backend-engineer-3.json")).task_id).toBe("T-PACKET");
  });

  it("exposes the ownership assertion for preflight-root boundary tests", () => {
    const root = tempRoot();
    expect(() => assertPacketStorageOwnership(path.join(root, ".workflow", "packets", "T", "stage-1.json"), [root])).toThrow(/Local Runtime State/);
  });
});

function structuredFailure(over: Partial<StructuredFailure> = {}): StructuredFailure {
  return {
    category: "implementation",
    owner: AgentStage.BACKEND_ENGINEER,
    severity: "medium",
    retryable: true,
    reason: "the selected import silently drops the discount field",
    affected: ["BE-001"],
    requiresHuman: false,
    ...over,
  };
}

function openFinding(over: Partial<Parameters<typeof deriveFinding>[1]> = {}): Finding {
  return deriveFinding(structuredFailure(), {
    run_id: "RUN-1",
    task_id: "T-FIND",
    attempt: 1,
    packet_hash: "a".repeat(64),
    raised_by: AgentStage.QA_ENGINEER,
    expected: "AC-001.1: the discount field is preserved",
    observed: "the discount field is dropped on import",
    evidence_refs: ["review.md#Round-1"],
    ...over,
  });
}

describe("T-V8-013 durable finding persistence", () => {
  it("persists a newly raised OPEN finding and reads it back unchanged", () => {
    const root = tempRoot();
    const finding = openFinding();
    const result = writeFinding({ projectRoot: root, finding, actor: AgentStage.QA_ENGINEER });
    expect(result.created).toBe(true);
    expect(readFindingRecord(result.path)).toEqual(finding);
  });

  it("refuses a first write that is not OPEN", () => {
    const root = tempRoot();
    const finding: Finding = { ...openFinding(), status: "VERIFIED" };
    expect(() => writeFinding({ projectRoot: root, finding, actor: AgentStage.QA_ENGINEER })).toThrow(/first persisted write must be OPEN/);
  });

  it("re-deriving the same defect resolves to the same file — resume never duplicates a finding", () => {
    const root = tempRoot();
    const first = writeFinding({ projectRoot: root, finding: openFinding({ run_id: "RUN-1", attempt: 1 }), actor: AgentStage.QA_ENGINEER });
    const resumed = writeFinding({ projectRoot: root, finding: openFinding({ run_id: "RUN-1", attempt: 2 }), actor: AgentStage.QA_ENGINEER });
    expect(resumed.path).toBe(first.path);
    expect(fs.readdirSync(runtimeArtifactPaths(root, "T-FIND").findings)).toHaveLength(1);
  });

  it("moves an existing finding through its lifecycle when the actor is authorized", () => {
    const root = tempRoot();
    const opened = openFinding();
    writeFinding({ projectRoot: root, finding: opened, actor: AgentStage.QA_ENGINEER });
    const claimed: Finding = { ...opened, status: "FIX_CLAIMED" };
    writeFinding({ projectRoot: root, finding: claimed, actor: AgentStage.BACKEND_ENGINEER });
    const verified: Finding = { ...claimed, status: "VERIFIED" };
    const result = writeFinding({ projectRoot: root, finding: verified, actor: AgentStage.QA_ENGINEER });
    expect(readFindingRecord(result.path).status).toBe("VERIFIED");
  });

  it("refuses to persist a close by the owner — enforced at the write boundary, not just in memory", () => {
    const root = tempRoot();
    const opened = openFinding();
    writeFinding({ projectRoot: root, finding: opened, actor: AgentStage.QA_ENGINEER });
    const claimed: Finding = { ...opened, status: "FIX_CLAIMED" };
    writeFinding({ projectRoot: root, finding: claimed, actor: AgentStage.BACKEND_ENGINEER });
    const closedByOwner: Finding = { ...claimed, status: "ACCEPTED" };
    expect(() => writeFinding({ projectRoot: root, finding: closedByOwner, actor: AgentStage.BACKEND_ENGINEER })).toThrow(/only .* may move it to ACCEPTED/);
  });

  it("refuses identity drift for a reused finding_id", () => {
    const root = tempRoot();
    const opened = openFinding();
    writeFinding({ projectRoot: root, finding: opened, actor: AgentStage.QA_ENGINEER });
    const tampered: Finding = { ...opened, severity: "critical" };
    expect(() => writeFinding({ projectRoot: root, finding: tampered, actor: AgentStage.QA_ENGINEER })).toThrow(/identity fields differ/);
  });

  it("lists every persisted finding for a task, sorted deterministically", () => {
    const root = tempRoot();
    const a = openFinding({ observed: "field A dropped" });
    const b = openFinding({ observed: "field B dropped" });
    writeFinding({ projectRoot: root, finding: a, actor: AgentStage.QA_ENGINEER });
    writeFinding({ projectRoot: root, finding: b, actor: AgentStage.QA_ENGINEER });
    const all = readFindingsForTask(root, "T-FIND");
    expect(all.map((f) => f.finding_id).sort()).toEqual([a.finding_id, b.finding_id].sort());
  });

  it("returns an empty list for a task with no persisted findings, never an error", () => {
    const root = tempRoot();
    expect(readFindingsForTask(root, "T-NONE")).toEqual([]);
  });
});

describe("T-V8-013 durable repair-packet persistence", () => {
  function repair(finding: Finding, diff = "diff --git a/src/import.ts b/src/import.ts\n+ fix") {
    return compileRepairPacket({
      originalPacket: { packet_hash: finding.packet_hash },
      finding, currentDiff: diff, invalidatedEvidence: ["review.md#Round-1"], allowedDelta: "src/import.ts",
    });
  }

  it("persists a repair packet and reads it back unchanged", () => {
    const root = tempRoot();
    const packet = repair(openFinding());
    const result = writeRepairPacket({ projectRoot: root, packet });
    expect(readRepairPacket(result.path)).toEqual(packet);
  });

  it("recompiling from identical inputs is idempotent — same file, no duplicate", () => {
    const root = tempRoot();
    const finding = openFinding();
    const first = writeRepairPacket({ projectRoot: root, packet: repair(finding) });
    const second = writeRepairPacket({ projectRoot: root, packet: repair(finding) });
    expect(second.path).toBe(first.path);
    expect(fs.readdirSync(runtimeArtifactPaths(root, "T-FIND").repairPackets)).toHaveLength(1);
  });

  it("a real change in the diff lands as a separate file, never overwriting the prior one", () => {
    const root = tempRoot();
    const finding = openFinding();
    writeRepairPacket({ projectRoot: root, packet: repair(finding, "diff-a") });
    writeRepairPacket({ projectRoot: root, packet: repair(finding, "diff-b") });
    expect(fs.readdirSync(runtimeArtifactPaths(root, "T-FIND").repairPackets)).toHaveLength(2);
  });

  it("retains the current repair packet while enforcing the per-task bound", () => {
    const root = tempRoot();
    const finding = openFinding();
    for (const diff of ["diff-1", "diff-2", "diff-3"]) {
      writeRepairPacket({ projectRoot: root, packet: repair(finding, diff), maxRunsPerTask: 2 });
    }
    expect(fs.readdirSync(runtimeArtifactPaths(root, "T-FIND").repairPackets)).toHaveLength(2);
  });
});
