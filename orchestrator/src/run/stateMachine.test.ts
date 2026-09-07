import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { KnownJournalRecord } from "./journal.js";
import { applyRunJournalRecord, reconstructRunState, RUN_STATES, type RunState } from "./stateMachine.js";

const ts = "now";
const record = (kind: KnownJournalRecord["kind"]): KnownJournalRecord => {
  const base = { ts, kind } as KnownJournalRecord;
  if (["TASK_READY", "TASK_STARTED", "TASK_AGENT_DONE"].includes(kind)) return { ...base, task_id: "BE-1" } as KnownJournalRecord;
  if (kind === "GATE_RESULT") return { ...base, task_id: "BE-1", result: "passed" } as KnownJournalRecord;
  if (kind === "TASK_CHECKPOINTED") return { ...base, task_id: "BE-1", sha: "a" } as KnownJournalRecord;
  if (kind === "TASK_FAILED") return { ...base, task_id: "BE-1", reason: "x", class: "runtime" } as KnownJournalRecord;
  if (["RUN_HALTED", "RUN_REFUSED", "RUN_RESUMED", "RUN_STALE", "RUN_ABANDONED"].includes(kind)) {
    return { ...base, reason: "x" } as KnownJournalRecord;
  }
  return base;
};

describe("run state machine", () => {
  it("accepts every canonical forward transition", () => {
    const cases: Array<[RunState, KnownJournalRecord["kind"], RunState]> = [
      ["CREATED", "RUN_STARTED", "PREFLIGHT"],
      ["PREFLIGHT", "RUN_ISOLATED", "ISOLATED"],
      ["ISOLATED", "TASK_READY", "TASK_READY"],
      ["TASK_READY", "TASK_STARTED", "TASK_RUNNING"],
      ["TASK_READY", "RUN_HALTED", "HALTED"],
      ["TASK_RUNNING", "TASK_AGENT_DONE", "VALIDATING"],
      ["TASK_RUNNING", "TASK_FAILED", "HALTED"],
      ["TASK_RUNNING", "RUN_HALTED", "HALTED"],
      ["VALIDATING", "GATE_RESULT", "VALIDATING"],
      ["VALIDATING", "TASK_FAILED", "HALTED"],
      ["VALIDATING", "RUN_HALTED", "HALTED"],
      ["VALIDATING", "TASK_CHECKPOINTED", "CHECKPOINTED"],
      ["CHECKPOINTED", "TASK_READY", "TASK_READY"],
      ["CHECKPOINTED", "RUN_COMPLETED", "WAVE_COMPLETE"],
      ["WAVE_COMPLETE", "HUMAN_REVIEW_REQUIRED", "HUMAN_REVIEW"],
      ["PREFLIGHT", "RUN_REFUSED", "REFUSED"],
      ["HALTED", "RUN_RESUMED", "TASK_READY"],
      ["HALTED", "RUN_HALTED", "HALTED"],
      ["HALTED", "RUN_STALE", "STALE"],
      ["PREFLIGHT", "RUN_ABANDONED", "CANCELLED"],
      ["ISOLATED", "RUN_ABANDONED", "CANCELLED"],
      ["TASK_READY", "RUN_ABANDONED", "CANCELLED"],
      ["TASK_RUNNING", "RUN_ABANDONED", "CANCELLED"],
      ["VALIDATING", "RUN_ABANDONED", "CANCELLED"],
      ["CHECKPOINTED", "RUN_ABANDONED", "CANCELLED"],
      ["HALTED", "RUN_ABANDONED", "CANCELLED"],
    ];
    for (const [from, kind, to] of cases) {
      expect(applyRunJournalRecord(from, record(kind))).toMatchObject({ previous: from, current: to, record: { kind } });
    }
  });

  it("reconstructs a complete run from journal records alone", () => {
    const records = ["RUN_STARTED", "RUN_ISOLATED", "TASK_READY", "TASK_STARTED", "TASK_AGENT_DONE", "GATE_RESULT", "TASK_CHECKPOINTED", "RUN_COMPLETED", "HUMAN_REVIEW_REQUIRED"]
      .map((kind) => record(kind as KnownJournalRecord["kind"]));
    expect(reconstructRunState(records)).toBe("HUMAN_REVIEW");
  });

  it.each([
    ["TASK_RUNNING", "TASK_CHECKPOINTED"],
    ["HALTED", "RUN_COMPLETED"],
    ["REFUSED", "RUN_STARTED"],
    ["CANCELLED", "RUN_STARTED"],
    ["STALE", "TASK_READY"],
    ["HUMAN_REVIEW", "RUN_STARTED"],
  ] as const)("rejects illegal %s + %s", (state, kind) => {
    expect(() => applyRunJournalRecord(state, record(kind))).toThrow(/cannot be applied/);
  });

  it("allows HALTED to re-enter only with the explicit resume record", () => {
    expect(applyRunJournalRecord("HALTED", record("RUN_RESUMED")).current).toBe("TASK_READY");
    expect(() => applyRunJournalRecord("HALTED", record("TASK_READY"))).toThrow();
  });

  it("declares exactly the validated states and stays pure", () => {
    expect(RUN_STATES).toEqual([
      "CREATED", "PREFLIGHT", "ISOLATED", "TASK_READY", "TASK_RUNNING", "VALIDATING", "CHECKPOINTED",
      "WAVE_COMPLETE", "HUMAN_REVIEW", "REFUSED", "HALTED", "CANCELLED", "STALE",
    ]);
    expect(RUN_STATES).not.toContain("MERGE_READY");
    expect(RUN_STATES).not.toContain("MERGED");
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "stateMachine.ts"), "utf8");
    expect(source).not.toMatch(/node:fs|node:path|src[\\/]git|\.\.\/git/);
  });
});
