import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunId,
  readJournal,
  readRunManifest,
  runArtifactPaths,
  type KnownJournalRecord,
  type RunManifest,
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

/**
 * T-V8-029 — the production writers are gone, so a *test* is the only thing
 * left that can produce a legacy record. That is the point: these fixtures
 * stand in for directories an earlier STA version wrote, and the assertions
 * below are about reading them, never about resuming them.
 */
function writeLegacyRun(root: string, value: RunManifest, records: readonly KnownJournalRecord[] = []): void {
  const paths = runArtifactPaths(root, value.run_id);
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.manifest, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (const record of records) fs.appendFileSync(paths.journal, `${JSON.stringify(record)}\n`, "utf8");
}

describe("legacy wave-run record reader", () => {
  it("reads a manifest from the deliberate sibling namespace", () => {
    const root = tempRoot();
    writeLegacyRun(root, manifest());
    expect(runArtifactPaths(root, RUN_ID).manifest).toBe(path.join(root, ".workflow", "wave-runs", RUN_ID, "manifest.json"));
    expect(readRunManifest(root, RUN_ID)).toEqual(manifest());
  });

  it("exports no writer, so an old record can be inspected but never appended to", async () => {
    const module = await import("./journal.js");
    for (const removed of ["writeRunManifest", "appendJournalRecord", "repairTruncatedJournal", "pruneWaveRunArtifacts", "planHash"]) {
      expect(Object.keys(module)).not.toContain(removed);
    }
  });

  it("T-V8-005 keeps route policy readable while older manifests stay readable without re-resolution", () => {
    const currentRoot = tempRoot();
    const current = manifest({
      effort: "high",
      route_basis: "tier=T4,model=task-tier:T4,effort=task-tier:T4",
      route_requested: { taskTier: "T4", roleDefaultTier: "T5" },
    });
    writeLegacyRun(currentRoot, current);
    expect(readRunManifest(currentRoot, RUN_ID)).toEqual(current);

    const legacyRoot = tempRoot();
    writeLegacyRun(legacyRoot, manifest());
    expect(readRunManifest(legacyRoot, RUN_ID)).toEqual(manifest());
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
    writeLegacyRun(root, manifest(), records);
    fs.appendFileSync(runArtifactPaths(root, RUN_ID).journal, `${JSON.stringify({ ts, kind: "FUTURE_KIND", payload: 1 })}\n`, "utf8");
    expect(readJournal(root, RUN_ID)).toEqual({ records: [...records, { ts, kind: "FUTURE_KIND", payload: 1 }], truncatedFinalLine: false });
  });

  it("reports a truncated final line instead of repairing it", () => {
    const root = tempRoot();
    writeLegacyRun(root, manifest(), [{ ts: "now", kind: "RUN_STARTED" }]);
    fs.appendFileSync(runArtifactPaths(root, RUN_ID).journal, '{"ts":"later","kind":"TASK_STAR', "utf8");
    expect(readJournal(root, RUN_ID)).toEqual({ records: [{ ts: "now", kind: "RUN_STARTED" }], truncatedFinalLine: true });

    // Nothing truncates the file back: repair belonged to the retired wave resume.
    fs.appendFileSync(runArtifactPaths(root, RUN_ID).journal, '}\n', "utf8");
    expect(() => readJournal(root, RUN_ID)).toThrow(/invalid journal record at line 2/);
  });

  it("reconstructs manifest and final state from disk alone", () => {
    const root = tempRoot();
    const records: KnownJournalRecord[] = [
      { ts: "1", kind: "RUN_STARTED" },
      { ts: "2", kind: "RUN_ISOLATED" },
      { ts: "3", kind: "TASK_READY", task_id: "BE-1" },
      { ts: "4", kind: "TASK_STARTED", task_id: "BE-1" },
      { ts: "5", kind: "TASK_FAILED", task_id: "BE-1", reason: "adapter error", class: "runtime" },
      { ts: "6", kind: "RUN_HALTED", reason: "adapter error" },
    ];
    writeLegacyRun(root, manifest(), records);
    expect(loadRunDiskSnapshot(root, RUN_ID)).toEqual({
      manifest: manifest(), records, state: "HALTED", truncatedFinalLine: false,
    });
  });
});
