import { describe, expect, it } from "vitest";
import {
  ALL_STAGES,
  checkBootstrapState,
  computeStatus,
  newBootstrapState,
  type BootstrapState,
  type StageRecord,
} from "./bootstrapModel.js";

const NOW = "2026-08-20T09:00:00Z";

function settledStages(status: StageRecord["status"] = "done"): StageRecord[] {
  return ALL_STAGES.map((id) => ({ id, status, completed_at: NOW, knowledge_ids: [] }));
}

describe("newBootstrapState", () => {
  it("starts every stage pending and status discovering", () => {
    const state = newBootstrapState(null, NOW);
    expect(state.status).toBe("discovering");
    expect(state.stages).toHaveLength(ALL_STAGES.length);
    expect(state.stages.every((s) => s.status === "pending")).toBe(true);
    expect(state.validated_by).toBeNull();
    expect(checkBootstrapState(state)).toEqual([]);
  });

  it("carries the module it was started for", () => {
    expect(newBootstrapState("sales-crm", NOW).module).toBe("sales-crm");
  });
});

describe("computeStatus", () => {
  it("is discovering while any stage is pending or in_progress", () => {
    const stages = settledStages();
    stages[2] = { ...stages[2], status: "in_progress" };
    expect(computeStatus({ stages, validated_by: null, validated_at: null })).toBe("discovering");
  });

  it("is pending_validation once every stage is done or skipped but nobody has validated", () => {
    const stages = [...settledStages("done").slice(0, 3), ...settledStages("skipped").slice(3)];
    expect(computeStatus({ stages, validated_by: null, validated_at: null })).toBe("pending_validation");
  });

  it("is ready only once stages are settled AND validation is recorded", () => {
    const stages = settledStages();
    expect(computeStatus({ stages, validated_by: "Nok", validated_at: NOW })).toBe("ready");
  });

  it("does not go ready on validation alone — settlement is required too", () => {
    const stages = ALL_STAGES.map((id) => ({ id, status: "pending" as const, completed_at: null, knowledge_ids: [] }));
    expect(computeStatus({ stages, validated_by: "Nok", validated_at: NOW })).toBe("discovering");
  });
});

function validState(overrides: Partial<BootstrapState> = {}): BootstrapState {
  return { ...newBootstrapState(null, NOW), ...overrides };
}

describe("checkBootstrapState", () => {
  it("accepts a freshly created state", () => {
    expect(checkBootstrapState(newBootstrapState(null, NOW))).toEqual([]);
  });

  it("rejects extra top-level fields (schema strict mode)", () => {
    expect(checkBootstrapState({ ...newBootstrapState(null, NOW), extra: true })).not.toEqual([]);
  });

  it("rejects a duplicated stage id", () => {
    const state = newBootstrapState(null, NOW);
    state.stages[1] = { ...state.stages[0] };
    const problems = checkBootstrapState(state);
    expect(problems.some((p) => p.includes("appears more than once"))).toBe(true);
  });

  it("rejects a missing stage id", () => {
    const state = newBootstrapState(null, NOW);
    state.stages = state.stages.slice(1);
    const problems = checkBootstrapState(state);
    expect(problems.some((p) => p.includes("missing stage"))).toBe(true);
  });

  it("rejects validated_by set without validated_at", () => {
    const state = validState({ stages: settledStages(), validated_by: "Nok", validated_at: null });
    const problems = checkBootstrapState(state);
    expect(problems.some((p) => p.includes("validated_by and validated_at"))).toBe(true);
  });

  it("rejects a status field that disagrees with what the data derives", () => {
    const state = validState({ stages: settledStages(), status: "ready", validated_by: null, validated_at: null });
    const problems = checkBootstrapState(state);
    expect(problems.some((p) => p.includes("derive"))).toBe(true);
  });

  it("accepts a fully validated, settled state as ready", () => {
    const state = validState({ stages: settledStages(), status: "ready", validated_by: "Nok", validated_at: NOW });
    expect(checkBootstrapState(state)).toEqual([]);
  });
});
