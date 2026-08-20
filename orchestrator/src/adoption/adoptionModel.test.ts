import { describe, expect, it } from "vitest";
import {
  ALL_ADOPTION_STAGES,
  checkAdoptionState,
  computeAdoptionStatus,
  needsApproval,
  newAdoptionState,
  unapprovedStages,
  type AdoptionState,
  type AdoptionStageRecord,
} from "./adoptionModel.js";

const NOW = "2026-08-20T09:00:00Z";

function stage(overrides: Partial<AdoptionStageRecord> = {}): AdoptionStageRecord {
  return {
    id: "legacy-agents",
    status: "done",
    completed_at: NOW,
    knowledge_ids: [],
    approved_by: null,
    approved_at: null,
    ...overrides,
  };
}

function settled(options: { approved?: boolean } = {}): AdoptionStageRecord[] {
  return ALL_ADOPTION_STAGES.map((id) =>
    stage({
      id,
      approved_by: options.approved ? "Jaturapat" : null,
      approved_at: options.approved ? NOW : null,
    }),
  );
}

function state(overrides: Partial<AdoptionState> = {}): AdoptionState {
  const base: AdoptionState = {
    ...newAdoptionState(NOW),
    preflight: { detected_at: NOW, blockers: [], notes: ["checked"], acknowledged_by: null, acknowledged_at: null },
  };
  const merged = { ...base, ...overrides };
  return { ...merged, status: computeAdoptionStatus(merged) };
}

describe("computeAdoptionStatus", () => {
  it("blocks a fresh adoption until the preflight check has run", () => {
    expect(newAdoptionState(NOW).status).toBe("blocked");
  });

  it("blocks while a person has not acknowledged what the project has in flight", () => {
    const blocked = state({
      preflight: {
        detected_at: NOW,
        blockers: ["task \"t-1\" is at QA"],
        notes: [],
        acknowledged_by: null,
        acknowledged_at: null,
      },
      stages: settled({ approved: true }),
      validated_by: "Jaturapat",
      validated_at: NOW,
    });

    // Every later gate is satisfied and it is still blocked: approvals do not
    // retroactively make an unknown known.
    expect(blocked.status).toBe("blocked");
  });

  it("moves to importing once the blockers are acknowledged", () => {
    expect(
      state({
        preflight: { detected_at: NOW, blockers: ["something"], notes: [], acknowledged_by: "Jaturapat", acknowledged_at: NOW },
      }).status,
    ).toBe("importing");
  });

  it("stays importing while any stage has not run", () => {
    expect(state({ stages: [stage({ id: "legacy-agents" }), ...settled().slice(1).map((s) => ({ ...s, status: "pending" as const }))] }).status).toBe(
      "importing",
    );
  });

  it("waits for an approval on every stage that actually did something", () => {
    expect(state({ stages: settled() }).status).toBe("pending_approval");
    expect(state({ stages: settled({ approved: true }) }).status).toBe("pending_validation");
  });

  it("does not ask anyone to approve a stage that found nothing", () => {
    const skipped = settled().map((s) => ({ ...s, status: "skipped" as const }));

    expect(unapprovedStages(skipped)).toEqual([]);
    expect(state({ stages: skipped }).status).toBe("pending_validation");
    expect(needsApproval(stage({ status: "skipped" }))).toBe(false);
  });

  it("reaches adopted only with every approval and a validation", () => {
    expect(state({ stages: settled({ approved: true }), validated_by: "Jaturapat", validated_at: NOW }).status).toBe("adopted");
  });
});

describe("checkAdoptionState", () => {
  it("accepts a state it built itself", () => {
    expect(checkAdoptionState(state({ stages: settled({ approved: true }) }))).toEqual([]);
  });

  it("rejects a hand-edited file that claims adopted before its stages say so", () => {
    const lying = { ...state({ stages: settled() }), status: "adopted" };

    expect(checkAdoptionState(lying)).toEqual([
      'status is "adopted" but the preflight/stages/validation on this file derive "pending_approval"',
    ]);
  });

  it("rejects a half-recorded approval", () => {
    const half = state({ stages: [{ ...stage(), approved_by: "Jaturapat" }, ...settled().slice(1)] });

    expect(checkAdoptionState({ ...half, status: computeAdoptionStatus(half) })).toContain(
      'stage "legacy-agents": approved_by and approved_at must be set together, or both null',
    );
  });

  it("rejects an approval on a stage that has not run — an approval is for work somebody could look at", () => {
    const impossible = state({
      stages: [stage({ status: "pending", completed_at: null, approved_by: "Jaturapat", approved_at: NOW }), ...settled().slice(1)],
    });

    expect(checkAdoptionState(impossible)).toContain(
      'stage "legacy-agents" is approved but has not run — an approval is for work somebody could look at',
    );
  });

  it("rejects a missing stage and an unknown one", () => {
    const short = state({ stages: settled().slice(1) });
    expect(checkAdoptionState(short)).toContain('missing stage "legacy-agents"');

    // A stage id outside the four is caught by the schema's enum, before the
    // structural checks run — so the report points at the row rather than
    // naming the value. Asserted as it behaves, not as it might read best.
    const bogus = { ...state(), stages: [...settled(), stage({ id: "legacy-everything" as never })] };
    expect(checkAdoptionState(bogus)).toContain("/stages/4/id must be equal to one of the allowed values");
  });

  it("rejects a half-recorded validation", () => {
    expect(checkAdoptionState({ ...state({ stages: settled({ approved: true }) }), validated_by: "Jaturapat" })).toContain(
      "validated_by and validated_at must be set together, or both null",
    );
  });

  it("rejects an unknown field rather than ignoring it", () => {
    expect(checkAdoptionState({ ...state(), adopted_anyway: true }).join(" ")).toContain("adopted_anyway");
  });
});
