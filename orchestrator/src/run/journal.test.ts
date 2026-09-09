import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanTaskRow } from "../docs/planGraph.js";
import {
  appendJournalRecord,
  createRunId,
  planHash,
  pruneWaveRunArtifacts,
  readJournal,
  readRunManifest,
  runArtifactPaths,
  type KnownJournalRecord,
  type RunManifest,
  writeRunManifest,
} from "./journal.js";
import { loadRunDiskSnapshot } from "./snapshot.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sta-wave-journal-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const RUN_ID = "01J00000000000000000000000";

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    run_id: RUN_ID,
    created_at: "2026-09-07T00:00:00.000Z",
    target_root: "C:/target",
    target_id: "target",
    knowledge_root: "C:/knowledge",
    module: "orders",
    wave: 2,
    plan_hash: "a".repeat(64),
    task_order: ["BE-1"],
    base_branch: "main",
    base_sha: "b".repeat(40),
    run_branch: "sta/run/orders/id",
    runtime_id: "claude-code",
    tier: "T3",
    model: "opus",
    max_tasks: 1,
    sta_version: "1.1.0",
    ...overrides,
  };
}

function task(overrides: Partial<PlanTaskRow> = {}): PlanTaskRow {
  return {
    id: "BE-1",
    phase: 1,
    designRefs: ["DES-1"],
    dependsOn: [],
    status: "pending",
    owner: "backend-engineer",
    wave: null,
    tier: "T3",
    description: "Implement orders",
    fromCheckbox: false,
    produces: ["orders-api"],
    consumes: [],
    ...overrides,
  };
}

describe("durable wave run journal", () => {
  it("uses the deliberate sibling namespace and writes the manifest exactly once", () => {
    const root = tempRoot();
    const file = writeRunManifest(root, manifest());
    expect(file).toBe(path.join(root, ".workflow", "wave-runs", RUN_ID, "manifest.json"));
    expect(readRunManifest(root, RUN_ID)).toEqual(manifest());
    expect(() => writeRunManifest(root, manifest({ module: "changed" }))).toThrow(/EEXIST/);
    expect(readRunManifest(root, RUN_ID).module).toBe("orders");
  });

  it("T-V8-005 persists effective route policy while old manifests remain readable without re-resolution", () => {
    const currentRoot = tempRoot();
    const current = manifest({
      effort: "high",
      route_basis: "tier=T4,model=task-tier:T4,effort=task-tier:T4",
      route_requested: { taskTier: "T4", roleDefaultTier: "T5" },
    });
    writeRunManifest(currentRoot, current);
    expect(readRunManifest(currentRoot, RUN_ID)).toEqual(current);

    const legacyRoot = tempRoot();
    const legacy = manifest();
    writeRunManifest(legacyRoot, legacy);
    expect(readRunManifest(legacyRoot, RUN_ID)).toEqual(legacy);
    expect(readRunManifest(legacyRoot, RUN_ID)).not.toHaveProperty("effort");
    expect(readRunManifest(legacyRoot, RUN_ID)).not.toHaveProperty("route_basis");
  });

  it("generates sortable ULID-style run ids", () => {
    const random = () => Buffer.alloc(10);
    const first = createRunId(() => 1_000, random);
    const second = createRunId(() => 1_001, random);
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first < second).toBe(true);
  });

  it("round-trips every known record kind and preserves an unknown future kind", () => {
    const root = tempRoot();
    writeRunManifest(root, manifest());
    const ts = "2026-09-07T00:00:00.000Z";
    const records: KnownJournalRecord[] = [
      { ts, kind: "RUN_STARTED" },
      { ts, kind: "RUN_ISOLATED" },
      { ts, kind: "TASK_READY", task_id: "BE-1" },
      { ts, kind: "TASK_STARTED", task_id: "BE-1" },
      { ts, kind: "TASK_AGENT_DONE", task_id: "BE-1" },
      { ts, kind: "GATE_RESULT", task_id: "BE-1", result: "passed", summary: "unit" },
      { ts, kind: "TASK_CHECKPOINTED", task_id: "BE-1", sha: "a".repeat(40) },
      { ts, kind: "TASK_FAILED", task_id: "BE-1", reason: "failed", class: "runtime" },
      { ts, kind: "RUN_HALTED", reason: "failed" },
      { ts, kind: "RUN_COMPLETED" },
      { ts, kind: "HUMAN_REVIEW_REQUIRED" },
      { ts, kind: "RUN_REFUSED", reason: "preflight" },
      { ts, kind: "RUN_RESUMED", reason: "human fixed" },
      { ts, kind: "RUN_STALE", reason: "plan hash drift" },
      { ts, kind: "RUN_ABANDONED", reason: "human abandoned" },
    ];
    for (const record of records) appendJournalRecord(root, RUN_ID, record);
    fs.appendFileSync(runArtifactPaths(root, RUN_ID).journal, `${JSON.stringify({ ts, kind: "FUTURE_KIND", payload: 1 })}\n`, "utf8");
    expect(readJournal(root, RUN_ID)).toEqual({ records: [...records, { ts, kind: "FUTURE_KIND", payload: 1 }], truncatedFinalLine: false });
  });

  it("discards and reports only a truncated final line", () => {
    const root = tempRoot();
    writeRunManifest(root, manifest());
    appendJournalRecord(root, RUN_ID, { ts: "now", kind: "RUN_STARTED" });
    fs.appendFileSync(runArtifactPaths(root, RUN_ID).journal, '{"ts":"later","kind":"TASK_STAR', "utf8");
    expect(readJournal(root, RUN_ID)).toEqual({ records: [{ ts: "now", kind: "RUN_STARTED" }], truncatedFinalLine: true });

    fs.appendFileSync(runArtifactPaths(root, RUN_ID).journal, '}\n', "utf8");
    expect(() => readJournal(root, RUN_ID)).toThrow(/invalid journal record at line 2/);
  });

  it("changes plan_hash for description, dependency, owner, or status drift", () => {
    const original = planHash([task()]);
    expect(planHash([task({ description: "Changed" })])).not.toBe(original);
    expect(planHash([task({ dependsOn: ["BE-0"] })])).not.toBe(original);
    expect(planHash([task({ owner: "frontend-engineer" })])).not.toBe(original);
    expect(planHash([task({ status: "verified" })])).not.toBe(original);
  });

  it("reconstructs manifest and current state from disk alone", () => {
    const root = tempRoot();
    writeRunManifest(root, manifest());
    const records: KnownJournalRecord[] = [
      { ts: "1", kind: "RUN_STARTED" },
      { ts: "2", kind: "RUN_ISOLATED" },
      { ts: "3", kind: "TASK_READY", task_id: "BE-1" },
      { ts: "4", kind: "TASK_STARTED", task_id: "BE-1" },
      { ts: "5", kind: "TASK_FAILED", task_id: "BE-1", reason: "adapter error", class: "runtime" },
      { ts: "6", kind: "RUN_HALTED", reason: "adapter error" },
    ];
    for (const entry of records) appendJournalRecord(root, RUN_ID, entry);
    expect(loadRunDiskSnapshot(root, RUN_ID)).toEqual({
      manifest: manifest(), records, state: "HALTED", truncatedFinalLine: false,
    });
  });

  it("prunes only old wave-run directories and keeps unrelated filesystem evidence", () => {
    const root = tempRoot();
    const ids = Array.from({ length: 4 }, (_, index) => `01J0000000000000000000000${index}`);
    for (const [index, id] of ids.entries()) {
      const dir = runArtifactPaths(root, id).directory;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "manifest.json"), id, "utf8");
      const time = new Date(1_000 + index * 1_000);
      fs.utimesSync(dir, time, time);
    }
    const branchEvidence = path.join(root, "branch-and-commit-evidence.txt");
    fs.writeFileSync(branchEvidence, "untouched", "utf8");

    const removed = pruneWaveRunArtifacts(root, ids[0], 2);
    expect(removed.map((entry) => path.basename(entry)).sort()).toEqual([ids[1], ids[2]]);
    expect(fs.readdirSync(path.dirname(runArtifactPaths(root, ids[0]).directory)).sort()).toEqual([ids[0], ids[3]]);
    expect(fs.readFileSync(branchEvidence, "utf8")).toBe("untouched");
  });
});
