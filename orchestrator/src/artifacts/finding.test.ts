import { describe, expect, it } from "vitest";
import { AgentStage } from "../types.js";
import type { StructuredFailure } from "../orchestrator/failure.js";
import {
  FindingSchema,
  FindingTransitionError,
  InfrastructureFindingError,
  RepairPacketDriftError,
  assertCanTransitionFinding,
  compileRepairPacket,
  deriveFinding,
  findingId,
  readFinding,
  type Finding,
} from "./finding.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function failure(over: Partial<StructuredFailure> = {}): StructuredFailure {
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

function context(over: Partial<Parameters<typeof deriveFinding>[1]> = {}): Parameters<typeof deriveFinding>[1] {
  return {
    run_id: "RUN-1",
    task_id: "BE-001",
    attempt: 1,
    packet_hash: HASH_A,
    raised_by: AgentStage.QA_ENGINEER,
    expected: "AC-001.1: the discount field is preserved",
    observed: "the discount field is dropped on import",
    evidence_refs: ["review.md#Round-1"],
    ...over,
  };
}

describe("findingId / deriveFinding (T-V8-013)", () => {
  it("produces a stable id for the same defect regardless of run/attempt/packet", () => {
    const a = deriveFinding(failure(), context({ run_id: "RUN-1", attempt: 1, packet_hash: HASH_A }));
    const b = deriveFinding(failure(), context({ run_id: "RUN-2", attempt: 3, packet_hash: HASH_B }));
    expect(a.finding_id).toBe(b.finding_id);
    expect(a.run_id).not.toBe(b.run_id);
    expect(a.attempt).not.toBe(b.attempt);
  });

  it("mints a different id when the defect's own expected/observed text differs", () => {
    const a = deriveFinding(failure(), context({ observed: "the discount field is dropped on import" }));
    const b = deriveFinding(failure(), context({ observed: "the tax field is dropped on import" }));
    expect(a.finding_id).not.toBe(b.finding_id);
  });

  it("mints a different id for the same text under a different owner or category", () => {
    const implementation = deriveFinding(failure({ category: "implementation" }), context());
    const contract = deriveFinding(failure({ category: "contract", owner: AgentStage.SYSTEM_ANALYST }), context());
    expect(implementation.finding_id).not.toBe(contract.finding_id);
  });

  it("dedups on file+symbol regardless of the order files were reported in", () => {
    const files = [{ path: "src/a.ts" }, { path: "src/b.ts", symbol: "run" }];
    const a = findingId({ task_id: "BE-001", category: "implementation", owner: AgentStage.BACKEND_ENGINEER, expected: "e", observed: "o", files });
    const b = findingId({ task_id: "BE-001", category: "implementation", owner: AgentStage.BACKEND_ENGINEER, expected: "e", observed: "o", files: [...files].reverse() });
    expect(a).toBe(b);
  });

  it("starts every derived finding OPEN and validates against the strict schema", () => {
    const finding = deriveFinding(failure(), context());
    expect(finding.status).toBe("OPEN");
    expect(() => FindingSchema.parse(finding)).not.toThrow();
    expect(finding.finding_id).toMatch(/^FIND-[0-9a-f]{16}$/);
  });

  it("refuses to model an infrastructure/quota failure as a defect Finding", () => {
    expect(() => deriveFinding(failure({ category: "infrastructure", reason: "provider quota exceeded" }), context()))
      .toThrow(InfrastructureFindingError);
  });
});

describe("assertCanTransitionFinding (T-V8-013 security/QA close authority)", () => {
  function opened(): Finding {
    return deriveFinding(failure(), context());
  }

  it("lets only the owner claim a fix", () => {
    const finding = opened();
    expect(() => assertCanTransitionFinding(finding, "FIX_CLAIMED", AgentStage.BACKEND_ENGINEER)).not.toThrow();
    expect(() => assertCanTransitionFinding(finding, "FIX_CLAIMED", AgentStage.FRONTEND_ENGINEER)).toThrow(FindingTransitionError);
  });

  it("refuses the owner (DEV) closing its own finding — a fix claims it, it never closes it", () => {
    const finding: Finding = { ...opened(), status: "FIX_CLAIMED" };
    expect(() => assertCanTransitionFinding(finding, "VERIFIED", finding.owner)).toThrow(FindingTransitionError);
    expect(() => assertCanTransitionFinding(finding, "ACCEPTED", finding.owner)).toThrow(FindingTransitionError);
  });

  it("lets only the raising role verify or accept", () => {
    const finding: Finding = { ...opened(), status: "FIX_CLAIMED" };
    expect(() => assertCanTransitionFinding(finding, "VERIFIED", AgentStage.QA_ENGINEER)).not.toThrow();
    expect(() => assertCanTransitionFinding({ ...finding, raised_by: AgentStage.SECURITY }, "VERIFIED", AgentStage.QA_ENGINEER)).toThrow(FindingTransitionError);
  });

  it("lets a security-raised finding close only through security, never through QA", () => {
    const finding: Finding = { ...opened(), raised_by: AgentStage.SECURITY, status: "FIX_CLAIMED" };
    expect(() => assertCanTransitionFinding(finding, "ACCEPTED", AgentStage.QA_ENGINEER)).toThrow(FindingTransitionError);
    expect(() => assertCanTransitionFinding(finding, "ACCEPTED", AgentStage.SECURITY)).not.toThrow();
  });

  it("lets a human override any close", () => {
    const finding: Finding = { ...opened(), status: "FIX_CLAIMED" };
    expect(() => assertCanTransitionFinding(finding, "ACCEPTED", "human")).not.toThrow();
  });

  it("refuses a transition the state machine has no edge for", () => {
    const finding: Finding = { ...opened(), status: "ACCEPTED" };
    expect(() => assertCanTransitionFinding(finding, "OPEN", "human")).toThrow(FindingTransitionError);
  });

  it("treats a same-state request as a harmless no-op", () => {
    const finding = opened();
    expect(() => assertCanTransitionFinding(finding, "OPEN", AgentStage.FRONTEND_ENGINEER)).not.toThrow();
  });
});

describe("readFinding — v2 vs legacy pointer (T-V8-013 compatibility reads)", () => {
  it("reads a v2 Finding as v2", () => {
    const finding = deriveFinding(failure(), context());
    const result = readFinding(finding);
    expect(result.kind).toBe("v2");
  });

  it("reads a pre-T-V8-013 open_findings pointer as legacy, without inventing run/attempt/packet identity", () => {
    const legacy = { id: "OPEN-abc123", owner: "backend-engineer", summary: "requirement.md#Open-Questions:1" };
    const result = readFinding(legacy);
    expect(result).toEqual({ kind: "legacy", pointer: legacy });
  });

  it("throws rather than guessing on data that matches neither shape", () => {
    expect(() => readFinding({ nonsense: true })).toThrow();
  });
});

describe("compileRepairPacket (T-V8-013)", () => {
  it("composes the original packet hash, exact finding, diff, invalidated evidence and delta", () => {
    const finding = deriveFinding(failure(), context({ packet_hash: HASH_A }));
    const repair = compileRepairPacket({
      originalPacket: { packet_hash: HASH_A },
      finding,
      currentDiff: "diff --git a/src/import.ts b/src/import.ts\n+ preserve discount",
      invalidatedEvidence: ["review.md#Round-1"],
      allowedDelta: "src/import.ts only",
    });
    expect(repair.original_packet_hash).toBe(HASH_A);
    expect(repair.finding.finding_id).toBe(finding.finding_id);
    expect(repair.repair_packet_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is immutable per compilation: any changed input field changes the hash", () => {
    const finding = deriveFinding(failure(), context({ packet_hash: HASH_A }));
    const base = { originalPacket: { packet_hash: HASH_A }, finding, currentDiff: "diff-a", invalidatedEvidence: ["e1"], allowedDelta: "src/a.ts" };
    const repairA = compileRepairPacket(base);
    const repairB = compileRepairPacket({ ...base, currentDiff: "diff-b" });
    expect(repairA.repair_packet_hash).not.toBe(repairB.repair_packet_hash);
  });

  it("refuses when the finding was raised against a different packet than the one supplied", () => {
    const finding = deriveFinding(failure(), context({ packet_hash: HASH_A }));
    expect(() => compileRepairPacket({
      originalPacket: { packet_hash: HASH_B },
      finding, currentDiff: "", invalidatedEvidence: [], allowedDelta: "src/a.ts",
    })).toThrow(RepairPacketDriftError);
  });

  it("refuses to compile a repair packet for a finding that is already closed", () => {
    const finding: Finding = { ...deriveFinding(failure(), context({ packet_hash: HASH_A })), status: "ACCEPTED" };
    expect(() => compileRepairPacket({
      originalPacket: { packet_hash: HASH_A },
      finding, currentDiff: "", invalidatedEvidence: [], allowedDelta: "src/a.ts",
    })).toThrow(RepairPacketDriftError);
  });

  it("allows a repair packet against a FIX_CLAIMED finding — a repair round after an owner claimed but did not finish", () => {
    const finding: Finding = { ...deriveFinding(failure(), context({ packet_hash: HASH_A })), status: "FIX_CLAIMED" };
    expect(() => compileRepairPacket({
      originalPacket: { packet_hash: HASH_A },
      finding, currentDiff: "diff", invalidatedEvidence: [], allowedDelta: "src/a.ts",
    })).not.toThrow();
  });
});

describe("T-V8-013 full lifecycle + resume", () => {
  it("raises, claims, verifies, and accepts one finding end to end, then resumes identically from a persisted snapshot", () => {
    let finding = deriveFinding(failure(), context({ run_id: "RUN-1", attempt: 1 }));
    expect(finding.status).toBe("OPEN");

    assertCanTransitionFinding(finding, "FIX_CLAIMED", finding.owner);
    finding = { ...finding, status: "FIX_CLAIMED" };

    const repair = compileRepairPacket({
      originalPacket: { packet_hash: finding.packet_hash },
      finding, currentDiff: "diff --git a/src/import.ts b/src/import.ts\n+ fix", invalidatedEvidence: ["review.md#Round-1"], allowedDelta: "src/import.ts",
    });

    assertCanTransitionFinding(finding, "VERIFIED", finding.raised_by);
    finding = { ...finding, status: "VERIFIED" };
    assertCanTransitionFinding(finding, "ACCEPTED", finding.raised_by);
    finding = { ...finding, status: "ACCEPTED" };

    // Resume: re-deriving the same defect from a second attempt's context
    // (e.g. after a crash mid-round) must resolve to the identical finding_id,
    // never a duplicate — this is the dedup/resume guarantee this task adds.
    const resumed = deriveFinding(failure(), context({ run_id: "RUN-1", attempt: 2 }));
    expect(resumed.finding_id).toBe(finding.finding_id);
    expect(repair.finding.finding_id).toBe(finding.finding_id);
  });
});
