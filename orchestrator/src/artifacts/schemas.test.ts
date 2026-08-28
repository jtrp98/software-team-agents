import { describe, expect, it } from "vitest";
import {
  ArtifactType,
  ArtifactValidationError,
  HANDOFF_MAX_BYTES,
  validateArtifact,
} from "./schemas.js";

describe("HandoffArtifact", () => {
  const valid = {
    task_id: "T-V3TOK-090",
    implements: ["REQ-001"],
    module: "sales-crm",
    phase: 1,
    constraint_refs: ["requirement.md#Business-Rules"],
    contract_refs: { produces: ["orders/create"], consumes: [] },
    decision_refs: ["ADR-005"],
    test_refs: ["test-plan.md#TP-009"],
    artifact_refs: ["uxui/design.md#UX-001"],
    open_findings: [{ id: "OPEN-001", owner: "business-analyst", summary: "requirement.md#Open-Questions" }],
    budget: null,
  };

  it("accepts a bounded reference record", () => {
    expect(validateArtifact(ArtifactType.HANDOFF, valid)).toEqual(valid);
    expect(Buffer.byteLength(JSON.stringify(valid), "utf8")).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);
  });

  it("rejects prose and unknown fields instead of silently accepting a malformed handoff", () => {
    expect(() => validateArtifact(ArtifactType.HANDOFF, {
      ...valid,
      constraint_refs: ["copy all of the business rules into this field"],
      summary: "not part of the contract",
    })).toThrow(ArtifactValidationError);
  });

  it("enforces the 2048-byte serialized record cap even when each field is individually bounded", () => {
    const oversized = {
      ...valid,
      constraint_refs: Array.from({ length: 32 }, (_, index) => `requirement.md#${index}-${"x".repeat(150)}`),
    };
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(HANDOFF_MAX_BYTES);
    expect(() => validateArtifact(ArtifactType.HANDOFF, oversized)).toThrow(/maximum is 2048/);
  });
});

describe("ExecutionPacket", () => {
  const text = "Task T-V3R-020\n## Acceptance Criteria\n- packet validates";
  const valid = {
    text,
    composition: {
      static_chars: text.length, handoff_chars: 0, doc_chars: 0,
      knowledge_chars: 0, code_intel_chars: 0, tool_output_chars: 0,
    },
    budgetComposition: {
      base: text.length, task: 0, safety: 0, docs: 0, knowledge: 0,
      code: 0, tool_output: 0, reserve: 0,
    },
    task_id: "T-V3R-020",
    stage: "backend-engineer",
    role: "backend-engineer",
    acceptance_criteria: ["packet validates"],
    required_verification: ["unit", "typecheck"],
    stop_conditions: ["STOP on an unresolved rule"],
    scope: { allow: ["orchestrator/src/**"], deny: [".git/**"] },
    sources: ["runtime-task", "module-docs"],
  };

  it("validates the complete deterministic execution handoff", () => {
    expect(validateArtifact(ArtifactType.EXECUTION_PACKET, valid)).toEqual(valid);
  });

  it("rejects unknown fields and malformed scope", () => {
    expect(() => validateArtifact(ArtifactType.EXECUTION_PACKET, { ...valid, runtime: "claude-code" })).toThrow(ArtifactValidationError);
    expect(() => validateArtifact(ArtifactType.EXECUTION_PACKET, { ...valid, scope: { allow: [""], deny: [] } })).toThrow(ArtifactValidationError);
  });
});

describe("RequirementsArtifact", () => {
  const valid = {
    taskId: "T-1",
    title: "Add refund flow",
    businessGoal: "Let support staff issue refunds",
    scope: { inScope: ["refund by order id"], outScope: ["partial refunds"] },
    actors: ["support-staff"],
    acceptanceCriteria: ["a refunded order shows status=REFUNDED"],
    assumptions: [{ statement: "refund limit is 100000 THB", confirmed: false }],
    references: [],
  };

  it("accepts a well-formed requirements doc", () => {
    expect(validateArtifact(ArtifactType.REQUIREMENTS, valid)).toEqual(valid);
  });

  it("rejects a requirements doc with no acceptance criteria", () => {
    expect(() =>
      validateArtifact(ArtifactType.REQUIREMENTS, { ...valid, acceptanceCriteria: [] }),
    ).toThrow(ArtifactValidationError);
  });

  it("lists every failing field, not just the first", () => {
    try {
      validateArtifact(ArtifactType.REQUIREMENTS, { ...valid, acceptanceCriteria: [], actors: [] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArtifactValidationError);
      const err = e as ArtifactValidationError;
      expect(err.issues.some((i) => i.includes("acceptanceCriteria"))).toBe(true);
      expect(err.issues.some((i) => i.includes("actors"))).toBe(true);
    }
  });
});

describe("DesignArtifact", () => {
  it("accepts an empty dataModel for a non-schema task but requires a contract", () => {
    const valid = {
      taskId: "T-1",
      feasibility: "feasible, no schema change",
      dataModel: [],
      risks: [],
      openQuestions: [],
      contract: ["refund status must be REFUNDED, no other string"],
    };
    expect(validateArtifact(ArtifactType.DESIGN, valid)).toEqual(valid);
  });

  it("rejects a design doc with no contract clauses", () => {
    expect(() =>
      validateArtifact(ArtifactType.DESIGN, {
        taskId: "T-1",
        feasibility: "ok",
        dataModel: [],
        risks: [],
        openQuestions: [],
        contract: [],
      }),
    ).toThrow(ArtifactValidationError);
  });
});

describe("QaReportArtifact — evidence-based QA", () => {
  const base = {
    taskId: "T-1",
    mode: "FULL" as const,
    requirements: { "REQ-001": "PASS" as const },
    tests: { passed: 24, failed: 0 },
    evidence: ["test_log: ..."],
    risks: [],
    hasAutomatedTests: true,
    unverifiedBehaviour: [],
  };

  it("accepts a PASS report backed by evidence and all-PASS requirements", () => {
    const report = { ...base, status: "PASS" as const };
    expect(validateArtifact(ArtifactType.QA_REPORT, report)).toEqual(report);
  });

  it("rejects a report with no evidence array entries (no bare verbal PASS)", () => {
    expect(() =>
      validateArtifact(ArtifactType.QA_REPORT, { ...base, status: "PASS", evidence: [] }),
    ).toThrow(ArtifactValidationError);
  });

  it("rejects status PASS when a requirement is FAIL", () => {
    expect(() =>
      validateArtifact(ArtifactType.QA_REPORT, {
        ...base,
        status: "PASS",
        requirements: { "REQ-001": "FAIL" },
      }),
    ).toThrow(ArtifactValidationError);
  });

  it("rejects status PASS when tests.failed > 0", () => {
    expect(() =>
      validateArtifact(ArtifactType.QA_REPORT, {
        ...base,
        status: "PASS",
        tests: { passed: 20, failed: 1 },
      }),
    ).toThrow(ArtifactValidationError);
  });

  it("allows status FAIL even with failing tests", () => {
    const report = { ...base, status: "FAIL" as const, tests: { passed: 20, failed: 4 } };
    expect(validateArtifact(ArtifactType.QA_REPORT, report)).toEqual(report);
  });

  it("rejects a no-test-suite report that doesn't list unverified behaviour", () => {
    expect(() =>
      validateArtifact(ArtifactType.QA_REPORT, {
        ...base,
        status: "FAIL",
        hasAutomatedTests: false,
        unverifiedBehaviour: [],
      }),
    ).toThrow(ArtifactValidationError);
  });

  it("accepts a no-test-suite report that does list unverified behaviour", () => {
    const report = {
      ...base,
      status: "FAIL" as const,
      hasAutomatedTests: false,
      unverifiedBehaviour: ["refund limit enforcement was only read, not executed"],
    };
    expect(validateArtifact(ArtifactType.QA_REPORT, report)).toEqual(report);
  });
});

describe("SecurityReportArtifact", () => {
  it("rejects overallStatus PASS while a CRITICAL finding is still OPEN", () => {
    expect(() =>
      validateArtifact(ArtifactType.SECURITY_REPORT, {
        taskId: "T-1",
        overallStatus: "PASS",
        findings: [
          { id: "F-1", severity: "CRITICAL", status: "OPEN", description: "sql injection in search" },
        ],
      }),
    ).toThrow(ArtifactValidationError);
  });

  it("allows overallStatus PASS once the CRITICAL finding is FIXED", () => {
    const report = {
      taskId: "T-1",
      overallStatus: "PASS" as const,
      findings: [
        { id: "F-1", severity: "CRITICAL" as const, status: "FIXED" as const, description: "sql injection in search" },
      ],
    };
    expect(validateArtifact(ArtifactType.SECURITY_REPORT, report)).toEqual(report);
  });

  it("a FIX_CLAIMED finding still blocks PASS — only security closes a finding", () => {
    expect(() =>
      validateArtifact(ArtifactType.SECURITY_REPORT, {
        taskId: "T-1",
        overallStatus: "PASS",
        findings: [
          { id: "F-1", severity: "HIGH", status: "FIX_CLAIMED", description: "missing authz check" },
        ],
      }),
    ).toThrow(ArtifactValidationError);
  });
});

describe("PlanArtifact", () => {
  it("requires at least one phase", () => {
    expect(() => validateArtifact(ArtifactType.PLAN, { taskId: "T-1", phases: [] })).toThrow(
      ArtifactValidationError,
    );
  });

  it("accepts a phase with a security gate flag", () => {
    const plan = {
      taskId: "T-1",
      phases: [
        {
          id: "P1",
          name: "Phase 1: refund flow",
          securityGate: true,
          tasks: [{ id: "T1", description: "refund endpoint", tag: "backend" as const, done: false }],
        },
      ],
    };
    expect(validateArtifact(ArtifactType.PLAN, plan)).toEqual(plan);
  });
});
