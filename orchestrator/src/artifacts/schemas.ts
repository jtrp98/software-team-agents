import { z } from "zod";
import { AgentStage } from "../types.js";
import { PacketFieldsSchema, renderPacketText, stableHash, Sha256Schema, contentHash } from "./executionPacket.js";
import { planTaskHash } from "../docs/planTask.js";

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
  HANDOFF = "handoff",
  EXECUTION_PACKET = "execution-packet",
}

const PromptCompositionSchema = z
  .object({
    static_chars: z.number().int().nonnegative(),
    handoff_chars: z.number().int().nonnegative(),
    doc_chars: z.number().int().nonnegative(),
    knowledge_chars: z.number().int().nonnegative(),
    code_intel_chars: z.number().int().nonnegative(),
    tool_output_chars: z.number().int().nonnegative(),
  })
  .strict();

const ContextBudgetCompositionSchema = z
  .object({
    base: z.number().int().nonnegative(),
    task: z.number().int().nonnegative(),
    safety: z.number().int().nonnegative(),
    docs: z.number().int().nonnegative(),
    knowledge: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    tool_output: z.number().int().nonnegative(),
    reserve: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The deterministic handoff from Task Compiler to runtime execution. It is a
 * regenerable Local Runtime State artifact, never an authored module document.
 */
export const LegacyExecutionPacketSchema = z
  .object({
    text: z.string().min(1),
    composition: PromptCompositionSchema,
    budgetComposition: ContextBudgetCompositionSchema,
    task_id: z.string().min(1),
    stage: z.enum(AgentStage),
    role: z.string().min(1),
    acceptance_criteria: z.array(z.string().min(1)),
    required_verification: z.array(z.string().min(1)),
    stop_conditions: z.array(z.string().min(1)),
    scope: z
      .object({
        allow: z.array(z.string().min(1)),
        deny: z.array(z.string().min(1)),
      })
      .strict(),
    sources: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((packet, ctx) => {
    const compositionChars = Object.values(packet.composition).reduce((sum, chars) => sum + chars, 0);
    const budgetChars = Object.values(packet.budgetComposition).reduce((sum, chars) => sum + chars, 0);
    if (compositionChars !== packet.text.length) {
      ctx.addIssue({ code: "custom", path: ["composition"], message: `composition totals ${compositionChars}, expected text length ${packet.text.length}` });
    }
    if (budgetChars !== packet.text.length) {
      ctx.addIssue({ code: "custom", path: ["budgetComposition"], message: `budget composition totals ${budgetChars}, expected text length ${packet.text.length}` });
    }
  });
export type LegacyExecutionPacket = z.infer<typeof LegacyExecutionPacketSchema>;

export const ExecutionPacketSchema = PacketFieldsSchema.extend({
  text: z.string().min(1), composition: PromptCompositionSchema,
  budgetComposition: ContextBudgetCompositionSchema, packet_hash: Sha256Schema,
}).superRefine((packet, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (packet.text !== renderPacketText(packet)) fail("packet text diverges from its semantic fields");
  const { packet_hash, ...payload } = packet;
  if (packet_hash !== stableHash(payload)) fail("packet hash drift");
  if (packet.identity.task_hash !== planTaskHash({ ...packet.contract, status: "pending" })) fail("canonical task hash drift");
  if (packet.task_id !== packet.contract.id || packet.role !== packet.stage) fail("packet task/stage identity mismatch");
  for (const composition of [packet.composition, packet.budgetComposition]) if (Object.values(composition).reduce((sum, n) => sum + n, 0) !== packet.text.length) fail("packet composition does not cover the rendered text");
  const selected = packet.selected_traces.map(t => t.id);
  const expected = new Set([...packet.contract.traceability, ...packet.contract.produces, ...packet.contract.consumes]);
  if (selected.length !== expected.size || new Set(selected).size !== selected.length || selected.some(id => !expected.has(id))) fail("selected references differ from exact task trace/contract set");
  for (const reference of packet.selected_traces) if (reference.hash !== contentHash(reference.text)) fail(`selected reference text hash drift: ${reference.id}`);
  if (packet.design_evidence) {
    const expectedDesign = new Set([...packet.contract.traceability.filter(id => /^(?:DES|DEC)-/.test(id)), ...packet.contract.produces, ...packet.contract.consumes]);
    const evidenced = new Set(packet.design_evidence.map(ref => ref.claim));
    for (const id of expectedDesign) if (!evidenced.has(id)) fail(`selected design evidence omits ${id}`);
    for (const id of evidenced) if (!expectedDesign.has(id)) fail(`selected design evidence includes unrelated ${id}`);
  }
  if (new Set(packet.dependencies.map(d => d.task_id)).size !== packet.dependencies.length) fail("duplicate dependency output");
  for (const d of packet.dependencies) if (d.task_id !== d.evidence.task_id) fail("dependency evidence identity mismatch");
});
export type ExecutionPacket = z.infer<typeof ExecutionPacketSchema>;

/**
 * The artifact types an agent's completion can actually carry a validated
 * structured payload for. `REQUIREMENTS`/`DESIGN`/`PLAN`/`TEST_PLAN` are not
 * here — T-V8-028 found no production path ever constructs one (the five
 * doc-producing stages emit `HANDOFF` derived from their real Markdown file;
 * see `runtime/runtimeExecutor.ts`'s `ownedDoc` branch). Those enum members
 * still exist on `ArtifactType` because `ContextCategory` reuses them to tag
 * which module document a context slice came from.
 */
export type ValidatableArtifactType =
  | ArtifactType.HANDOFF
  | ArtifactType.EXECUTION_PACKET
  | ArtifactType.QA_REPORT
  | ArtifactType.SECURITY_REPORT;

/** Handoffs are compact indexes, never another authored document. */
export const HANDOFF_MAX_BYTES = 2_048;
const HandoffIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const HandoffModuleSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^/\\\r\n]+$/)
  .refine((value) => value !== "." && value !== ".." && !/^[A-Za-z]:/.test(value), "must be a safe module folder name");
const HandoffReferenceSchema = z
  .string()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9%][A-Za-z0-9%._~:/#-]*$/, "must be a compact reference, not prose");
const HandoffImplementationSchema = z.string().min(1).max(64).regex(/^(?:REQ|DES)-[A-Za-z0-9._-]+$/);
const HandoffDecisionSchema = z.string().min(1).max(64).regex(/^(?:ADR|RULE|DEC)-[A-Za-z0-9._-]+$/);
const HandoffTestSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?:TP-[A-Za-z0-9._-]+|test-plan\.md#TP-[A-Za-z0-9._-]+)$/);

export const HandoffArtifactSchema = z
  .object({
    task_id: HandoffIdSchema,
    implements: z.array(HandoffImplementationSchema).max(64),
    module: HandoffModuleSchema,
    phase: z.number().int().nonnegative().max(10_000).nullable(),
    constraint_refs: z.array(HandoffReferenceSchema).max(32),
    contract_refs: z
      .object({
        produces: z.array(HandoffReferenceSchema).max(32),
        consumes: z.array(HandoffReferenceSchema).max(32),
      })
      .strict(),
    decision_refs: z.array(HandoffDecisionSchema).max(32),
    test_refs: z.array(HandoffTestSchema).max(64),
    artifact_refs: z.array(HandoffReferenceSchema).max(32),
    open_findings: z
      .array(
        z
          .object({
            id: HandoffIdSchema,
            owner: HandoffReferenceSchema,
            // Despite the legacy field name, this stores a resolvable pointer,
            // not a copied finding summary.
            summary: HandoffReferenceSchema,
          })
          .strict(),
      )
      .max(16),
    budget: z.number().int().nonnegative().max(1_000_000).nullable(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    if (bytes > HANDOFF_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `serialized handoff is ${bytes} bytes; maximum is ${HANDOFF_MAX_BYTES}`,
      });
    }
  });
export type HandoffArtifact = z.infer<typeof HandoffArtifactSchema>;

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
    // Never accept a bare verbal PASS/FAIL — each entry must be a real,
    // checkable pointer (log excerpt, coverage report path, etc).
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
  // T-V8-014: no bare PASS. `Object.values({}).every(...)` is vacuously true,
  // so the refine above accepted a PASS that named no requirement at all - a
  // status without a verdict. Which ids specifically must appear is the
  // round's own contract (`requiredVerdictIds`, enforced by
  // `checkQaVerdictCoverage`); this is the floor that makes the omission
  // impossible to express in the first place.
  .refine((report) => report.status !== "PASS" || Object.keys(report.requirements).length > 0, {
    message:
      "status PASS requires at least one requirement verdict - a PASS that maps no task/AC/DES id to a result is an assertion, not a verdict",
    path: ["requirements"],
  })
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
  [ArtifactType.QA_REPORT]: QaReportArtifactSchema,
  [ArtifactType.SECURITY_REPORT]: SecurityReportArtifactSchema,
  [ArtifactType.HANDOFF]: HandoffArtifactSchema,
  [ArtifactType.EXECUTION_PACKET]: ExecutionPacketSchema,
} as const satisfies Record<ValidatableArtifactType, z.ZodTypeAny>;

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
  [ArtifactType.QA_REPORT]: QaReportArtifact;
  [ArtifactType.SECURITY_REPORT]: SecurityReportArtifact;
  [ArtifactType.HANDOFF]: HandoffArtifact;
  [ArtifactType.EXECUTION_PACKET]: ExecutionPacket;
}

/**
 * Validates raw data against an artifact type's contract. Throws
 * ArtifactValidationError with every failing field listed, not just the first —
 * the point of a fixed schema is that the next stage never has to guess why
 * a doc was rejected.
 */
export function validateArtifact<T extends ValidatableArtifactType>(
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
