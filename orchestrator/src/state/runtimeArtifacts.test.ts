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
  runtimeArtifactPaths,
  writeExecutionPacket,
} from "./runtimeArtifacts.js";
import { AgentStage } from "../types.js";
import type { ExecutionPacket } from "../artifacts/schemas.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-runtime-artifacts-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function packet(overrides: Partial<ExecutionPacket> = {}): ExecutionPacket {
  const text = "Task T-PACKET\n## Acceptance Criteria\n- round trip";
  return {
    text,
    composition: { static_chars: text.length, handoff_chars: 0, doc_chars: 0, knowledge_chars: 0, code_intel_chars: 0, tool_output_chars: 0 },
    budgetComposition: { base: text.length, task: 0, safety: 0, docs: 0, knowledge: 0, code: 0, tool_output: 0, reserve: 0 },
    task_id: "T-PACKET",
    stage: AgentStage.BACKEND_ENGINEER,
    role: "backend-engineer",
    acceptance_criteria: ["round trip"],
    required_verification: ["unit"],
    stop_conditions: ["STOP on ambiguity"],
    scope: { allow: ["server/**"], deny: [".git/**"] },
    sources: ["runtime-task"],
    ...overrides,
  };
}

describe("T-V3R-003 runtime artifact contract", () => {
  it("declares packet, evidence and run homes below .workflow and creates none eagerly", () => {
    const root = tempRoot();
    const paths = runtimeArtifactPaths(root, "T-V3R-003");
    expect(paths).toEqual({
      packets: path.join(root, ".workflow", "packets", "T-V3R-003"),
      evidence: path.join(root, ".workflow", "evidence", "T-V3R-003"),
      runs: path.join(root, ".workflow", "runs", "T-V3R-003"),
    });
    expect(fs.existsSync(path.join(root, ".workflow"))).toBe(false);
  });

  it("encodes task ids so path-like input cannot escape the runtime-state home", () => {
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
      writeExecutionPacket({ projectRoot: framework, packet: packet(), maxRunsPerTask: 2 });
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
