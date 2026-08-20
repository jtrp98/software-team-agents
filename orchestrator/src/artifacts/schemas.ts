import { z } from "zod";

/**
 * Required-field schemas for every artifact type in the pipeline. An agent's
 * output is never accepted as free-form Markdown here — it must parse
 * against one of these before the next stage is allowed to read it.
 */
export enum ArtifactType {
  REQUIREMENTS = "requirements",
  DESIGN = "design",
  PLAN = "plan",
  TEST_PLAN = "test-plan",
  QA_REPORT = "qa-report",
  SECURITY_REPORT = "security-report",
}

export const RequirementsArtifactSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1),
  businessGoal: z.string().min(1),
  scope: z.object({
    inScope: z.array(z.string()).min(1),
    outScope: z.array(z.string()),
  }),
  actors: z.array(z.string()).min(1),
  // What QA checks the delivered work against — never optional, never empty.
  acceptanceCriteria: z.array(z.string()).min(1),
  // CLAUDE.md's rule carried forward: an unsourced fact is an assumption, in writing.
  assumptions: z.array(
    z.object({
      statement: z.string().min(1),
      confirmed: z.boolean(),
    }),
  ),
  references: z.array(
    z.object({
      fact: z.string().min(1),
      source: z.string().min(1),
    }),
  ),
});
export type RequirementsArtifact = z.infer<typeof RequirementsArtifactSchema>;

export const DesignArtifactSchema = z.object({
  taskId: z.string().min(1),
  feasibility: z.string().min(1),
  // Empty only when the task genuinely doesn't touch the data model.
  dataModel: z.array(
    z.object({
      model: z.string().min(1),
      fields: z.array(z.object({ name: z.string().min(1), type: z.string().min(1) })),
    }),
  ),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
  // Rules an engineer implements or stops on — never decides itself.
  contract: z.array(z.string()).min(1),
});
export type DesignArtifact = z.infer<typeof DesignArtifactSchema>;

export const PlanArtifactSchema = z.object({
  taskId: z.string().min(1),
  phases: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        securityGate: z.boolean(),
        tasks: z.array(
          z.object({
            id: z.string().min(1),
            description: z.string().min(1),
            tag: z.enum(["frontend", "backend"]),
            done: z.boolean(),
          }),
        ),
      }),
    )
    .min(1),
});
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;

export const TestPlanArtifactSchema = z.object({
  taskId: z.string().min(1),
  // One entry per requirement this test strategy covers — the REQ-NNN traceability id (T19),
  // so a task's tests can be traced back to the requirement they verify.
  items: z
    .array(
      z.object({
        requirementId: z.string().min(1),
        levels: z.array(z.enum(["unit", "integration", "api", "e2e"])).min(1),
        rationale: z.string().min(1),
      }),
    )
    .min(1),
  // True only if the project actually has an automated test framework (opt-in per CLAUDE.md).
  // False is a normal, expected value — most projects never opt in — and does not invalidate the plan:
  // it still tells engineers/qa-engineer what *should* be exercised, by reading if nothing else.
  hasAutomatedTests: z.boolean(),
});
export type TestPlanArtifact = z.infer<typeof TestPlanArtifactSchema>;

export const QaReportArtifactSchema = z
  .object({
    taskId: z.string().min(1),
    status: z.enum(["PASS", "FAIL"]),
    // FULL closes a phase; TARGETED only re-checks named fixes + blast radius.
    mode: z.enum(["FULL", "TARGETED"]),
    requirements: z.record(z.string(), z.enum(["PASS", "FAIL"])),
    tests: z.object({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    // Evidence-based QA (item 4): never accept a bare verbal PASS/FAIL —
    // each entry must be a real, checkable pointer (log excerpt, coverage report path, etc).
    evidence: z.array(z.string().min(1)).min(1),
    risks: z.array(z.string()),
    // True only if an actual automated suite (opt-in per CLAUDE.md) ran.
    hasAutomatedTests: z.boolean(),
    // Rules QA could only read, not execute, because no test suite covers them.
    unverifiedBehaviour: z.array(z.string()),
  })
  .refine(
    (report) => {
      const allReqsPass = Object.values(report.requirements).every((r) => r === "PASS");
      return report.status !== "PASS" || (allReqsPass && report.tests.failed === 0);
    },
    { message: "status PASS requires every requirement PASS and zero failed tests" },
  )
  .refine(
    (report) => report.hasAutomatedTests || report.unverifiedBehaviour.length > 0,
    {
      message:
        "when hasAutomatedTests is false, unverifiedBehaviour must list what could only be read, not executed",
      path: ["unverifiedBehaviour"],
    },
  );
export type QaReportArtifact = z.infer<typeof QaReportArtifactSchema>;

const SecurityFindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  // Only `security` itself ever moves a finding to FIXED — an engineer's fix claims it, no further.
  status: z.enum(["OPEN", "FIX_CLAIMED", "FIXED", "ACCEPTED"]),
  description: z.string().min(1),
});

export const SecurityReportArtifactSchema = z
  .object({
    taskId: z.string().min(1),
    findings: z.array(SecurityFindingSchema),
    overallStatus: z.enum(["PASS", "FAIL"]),
  })
  .refine(
    (report) => {
      const blocking = report.findings.some(
        (f) => (f.severity === "CRITICAL" || f.severity === "HIGH") && f.status !== "ACCEPTED" && f.status !== "FIXED",
      );
      return report.overallStatus !== "PASS" || !blocking;
    },
    { message: "overallStatus PASS requires no open/fix-claimed CRITICAL or HIGH finding" },
  );
export type SecurityReportArtifact = z.infer<typeof SecurityReportArtifactSchema>;

export const ARTIFACT_SCHEMAS = {
  [ArtifactType.REQUIREMENTS]: RequirementsArtifactSchema,
  [ArtifactType.DESIGN]: DesignArtifactSchema,
  [ArtifactType.PLAN]: PlanArtifactSchema,
  [ArtifactType.TEST_PLAN]: TestPlanArtifactSchema,
  [ArtifactType.QA_REPORT]: QaReportArtifactSchema,
  [ArtifactType.SECURITY_REPORT]: SecurityReportArtifactSchema,
} as const;

export class ArtifactValidationError extends Error {
  constructor(
    public readonly artifactType: ArtifactType,
    public readonly issues: string[],
  ) {
    super(`${artifactType} failed contract validation:\n- ${issues.join("\n- ")}`);
    this.name = "ArtifactValidationError";
  }
}

interface ArtifactDataMap {
  [ArtifactType.REQUIREMENTS]: RequirementsArtifact;
  [ArtifactType.DESIGN]: DesignArtifact;
  [ArtifactType.PLAN]: PlanArtifact;
  [ArtifactType.TEST_PLAN]: TestPlanArtifact;
  [ArtifactType.QA_REPORT]: QaReportArtifact;
  [ArtifactType.SECURITY_REPORT]: SecurityReportArtifact;
}

/**
 * Validates raw data against an artifact type's contract. Throws
 * ArtifactValidationError with every failing field listed, not just the first —
 * the point of a fixed schema is that the next stage never has to guess why
 * a doc was rejected.
 */
export function validateArtifact<T extends ArtifactType>(
  type: T,
  data: unknown,
): ArtifactDataMap[T] {
  const schema: z.ZodTypeAny = ARTIFACT_SCHEMAS[type];
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ArtifactValidationError(type, issues);
  }
  return result.data as ArtifactDataMap[T];
}
